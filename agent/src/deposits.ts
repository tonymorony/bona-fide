import {
  authorizationNonce,
  DEPOSIT_STATUSES,
  escrowAbi,
  keyOf,
  kindCode,
  refusalIn,
  relayDepositRoute,
  repoIdOf,
  USDC_DECIMALS,
  usdcAbi,
  type AppRefusal,
  type DepositStatus,
  type Kind,
  type SignedDeposit,
  type Wire,
} from "@bona-fide/sdk";
import {
  encodeFunctionData,
  formatUnits,
  getAddress,
  isAddressEqual,
  parseEventLogs,
  toHex,
  WaitForTransactionReceiptTimeoutError,
  zeroAddress,
  type Address,
  type Hex,
  type PublicClient,
} from "viem";
import { circleChain, executeCommand, signTypedDataCommand } from "./circle.ts";
import { addressLink, capitalized, itemName, settled, timeLeft } from "./copy.ts";

const STATUS_ACTIVE = DEPOSIT_STATUSES.indexOf("active");
const DAY_SECONDS = 86_400;
/** How long a signed authorization stays valid. Anyone holding it can submit it until then. */
const SIGNATURE_WINDOW_SECONDS = 600n;
// Relative, so an APP_URL with a path keeps it.
const RELAY_PATH = relayDepositRoute.path.replace(/^\//, "");
const RECEIPT_TIMEOUT_MS = 60_000;
const RECEIPT_POLL_MS = 500;

/** A reason the tools won't prepare or submit a Deposit, written for the agent. */
export class Refusal extends Error {}

/** The PR or issue a Deposit is for. */
export interface Target {
  repo: string;
  kind: Kind;
  number: number;
}

/** A Binding's terms, as the agent sees them. Amounts are USDC base units, as decimal strings. */
export interface Terms {
  amount: string;
  amountUsdc: string;
  forfeitPercent: number;
  timeoutDays: number;
}

export interface DepositRules extends Target {
  key: Hex;
  repoId: Hex;
  chainId: number;
  escrow: Address;
  usdc: Address;
  binding: (Terms & { maintainer: Address }) | null;
  pendingBinding: (Terms & { effectiveAt: string }) | null;
  activeDeposit: { depositor: Address; amount: string; amountUsdc: string; deadline: string } | null;
  /** MAX_DEPOSIT_USDC: the most the tools will prepare or submit for one Deposit. */
  limitUsdc: string;
  /** Whether the active Binding's amount is within the limit, or null without a Binding. */
  withinLimit: boolean | null;
}

/** What submit_signed_deposit needs, besides the signature: the relay's body, as the App reads it. */
export type SignedDepositFields = Omit<Wire<SignedDeposit>, "signature">;

export interface SignedDepositPlan {
  /** USDC's EIP-3009 ReceiveWithAuthorization, as EIP-712 typed data JSON. */
  typedData: typeof RECEIVE_WITH_AUTHORIZATION_TYPES & {
    primaryType: "ReceiveWithAuthorization";
    domain: { name: "USDC"; version: "2"; chainId: number; verifyingContract: Address };
    message: { from: Address; to: Address; value: string; validAfter: string; validBefore: string; nonce: Hex };
  };
  /** Signs the typed data with a Circle agent wallet, or null off Arc. */
  circleCommand: string | null;
  submit: SignedDepositFields;
  amountUsdc: string;
  expiresAt: string;
}

const RECEIVE_WITH_AUTHORIZATION_TYPES = {
  types: {
    EIP712Domain: [
      { name: "name", type: "string" },
      { name: "version", type: "string" },
      { name: "chainId", type: "uint256" },
      { name: "verifyingContract", type: "address" },
    ],
    ReceiveWithAuthorization: [
      { name: "from", type: "address" },
      { name: "to", type: "address" },
      { name: "value", type: "uint256" },
      { name: "validAfter", type: "uint256" },
      { name: "validBefore", type: "uint256" },
      { name: "nonce", type: "bytes32" },
    ],
  },
};

/** One transaction the agent sends from its own wallet. */
export interface Step {
  description: string;
  to: Address;
  data: Hex;
  /** The same call from a Circle agent wallet, or null off Arc. */
  circleCommand: string | null;
}

export interface TwoStepPlan {
  from: Address;
  steps: [Step, Step];
}

/** A Deposit the escrow recorded, as its Deposited event shows it. */
export interface MadeDeposit extends Target {
  txHash: Hex;
  depositor: Address;
  amount: string;
  amountUsdc: string;
  /** When the Timeout ends: after it, anyone can Refund the Deposit. */
  deadline: string;
}

/** An item's Deposit as the escrow holds it now. */
export interface DepositState extends Target {
  key: Hex;
  escrow: Address;
  status: DepositStatus;
  /** Null while the item has no Deposit. */
  deposit: {
    depositor: Address;
    amount: string;
    amountUsdc: string;
    serial: string;
    /** When the Timeout ends: from then on, anyone can Refund an active Deposit. */
    deadline: string;
    timeoutPassed: boolean;
    /** Seconds until the Timeout ends, or 0 once it has. */
    secondsLeft: number;
    forfeitPercent: number;
    /** How a resolved Deposit was split, or null while it is active. */
    outcome: { refunded: string; refundedUsdc: string; forfeited: string; forfeitedUsdc: string } | null;
  } | null;
  /** The chain's time when it was read. */
  checkedAt: string;
  /** The Depositor's page on the block explorer, which lists the Deposit and its Refund, or null. */
  explorerUrl: string | null;
}

export interface RefundPlan {
  from: Address;
  /** Where the Refund goes, whoever sends it. */
  depositor: Address;
  amount: string;
  amountUsdc: string;
  step: Step;
}

export interface DepositsOptions {
  client: PublicClient;
  escrow: Address;
  /** The block explorer, for links; null or left out where none is known. */
  explorerUrl?: string | null;
  /** The most the tools will prepare or submit for one Deposit, in USDC base units. */
  maxDeposit: bigint;
  /** The Bona Fide App's base URL, whose relay submits signed Deposits. */
  appUrl?: string;
  fetch?: typeof fetch;
  /** How long submit_signed_deposit waits for a relayed Deposit to be mined. */
  receiptTimeoutMs?: number;
}

export function createDeposits({
  client,
  escrow: configured,
  maxDeposit,
  appUrl,
  explorerUrl = null,
  fetch = globalThis.fetch,
  receiptTimeoutMs = RECEIPT_TIMEOUT_MS,
}: DepositsOptions) {
  const escrow = getAddress(configured);

  async function rules(target: Target): Promise<DepositRules> {
    const repoId = repoIdOf(target.repo);
    const key = keyOf(repoId, target.kind, target.number);
    const read = { address: escrow, abi: escrowAbi } as const;
    const [chainId, usdc, active, [pending, effectiveAt], deposit] = await Promise.all([
      client.getChainId(),
      client.readContract({ ...read, functionName: "usdc" }),
      client.readContract({ ...read, functionName: "activeConfig", args: [repoId] }),
      client.readContract({ ...read, functionName: "pendingConfig", args: [repoId] }),
      client.readContract({ ...read, functionName: "depositOf", args: [key] }),
    ]);
    return {
      ...target,
      key,
      repoId,
      chainId,
      escrow,
      usdc,
      binding: active.maintainer === zeroAddress ? null : { ...terms(active), maintainer: active.maintainer },
      pendingBinding:
        pending.maintainer === zeroAddress ? null : { ...terms(pending), effectiveAt: isoTime(effectiveAt) },
      activeDeposit:
        deposit.status === STATUS_ACTIVE
          ? {
              depositor: deposit.depositor,
              amount: deposit.amount.toString(),
              amountUsdc: usdc6(deposit.amount),
              deadline: isoTime(deposit.deadline),
            }
          : null,
      limitUsdc: usdc6(maxDeposit),
      withinLimit: active.maintainer === zeroAddress ? null : active.amount <= maxDeposit,
    };
  }

  /** The rules, if a Deposit for the target can be prepared now; otherwise a Refusal. */
  async function depositable(
    target: Target,
  ): Promise<DepositRules & { binding: NonNullable<DepositRules["binding"]> }> {
    const current = await rules(target);
    const { binding, activeDeposit } = current;
    if (!binding) throw new Refusal(`Bona Fide isn't active for ${target.repo}, so no Deposit can be made there yet.`);
    if (activeDeposit) {
      throw new Refusal(
        `${itemName(target)} in ${target.repo} already has an active Deposit, from ${activeDeposit.depositor}. No other Deposit can be made for it until that one is refunded or forfeited.`,
      );
    }
    if (!current.withinLimit) {
      throw new Refusal(
        `${target.repo} asks for ${binding.amountUsdc} USDC, above your limit of ${current.limitUsdc} USDC. Ask the person you work for to raise MAX_DEPOSIT_USDC or to make the Deposit themselves.`,
      );
    }
    return { ...current, binding };
  }

  async function prepareSigned(target: Target, from: Address): Promise<SignedDepositPlan> {
    const current = await depositable(target);
    const salt = toHex(crypto.getRandomValues(new Uint8Array(32)));
    const nonce = authorizationNonce(current.key, salt);
    const validBefore = (await client.getBlock()).timestamp + SIGNATURE_WINDOW_SECONDS;
    const payer = getAddress(from);
    const typedData: SignedDepositPlan["typedData"] = {
      ...RECEIVE_WITH_AUTHORIZATION_TYPES,
      primaryType: "ReceiveWithAuthorization",
      domain: { name: "USDC", version: "2", chainId: current.chainId, verifyingContract: current.usdc },
      message: {
        from: payer,
        to: escrow,
        value: current.binding.amount,
        validAfter: "0",
        validBefore: validBefore.toString(),
        nonce,
      },
    };
    const chain = circleChain(current.chainId);
    return {
      typedData,
      circleCommand: chain ? signTypedDataCommand(typedData, payer, chain) : null,
      submit: {
        repo: target.repo,
        kind: target.kind,
        number: target.number,
        from: payer,
        value: current.binding.amount,
        validAfter: "0",
        validBefore: validBefore.toString(),
        salt,
      },
      amountUsdc: current.binding.amountUsdc,
      expiresAt: isoTime(validBefore),
    };
  }

  async function prepareTwoStep(target: Target, from: Address): Promise<TwoStepPlan> {
    const current = await depositable(target);
    const payer = getAddress(from);
    const amount = BigInt(current.binding.amount);
    const chain = circleChain(current.chainId);
    const approveArgs = [escrow, amount] as const;
    const depositArgs = [current.repoId, kindCode(target.kind), BigInt(target.number)] as const;
    return {
      from: payer,
      steps: [
        {
          description: `Allow the escrow to take exactly ${current.binding.amountUsdc} USDC from ${payer}.`,
          to: current.usdc,
          data: encodeFunctionData({ abi: usdcAbi, functionName: "approve", args: approveArgs }),
          circleCommand: chain
            ? executeCommand("approve(address,uint256)", approveArgs.map(String), current.usdc, payer, chain)
            : null,
        },
        {
          description: `Make the Deposit for ${itemName(target)} in ${target.repo}.`,
          to: escrow,
          data: encodeFunctionData({ abi: escrowAbi, functionName: "deposit", args: depositArgs }),
          circleCommand: chain
            ? executeCommand("deposit(bytes32,uint8,uint64)", depositArgs.map(String), escrow, payer, chain)
            : null,
        },
      ],
    };
  }

  async function submitSigned(fields: Wire<SignedDeposit>): Promise<MadeDeposit> {
    const decoded = relayDepositRoute.decode(fields);
    if (!decoded.ok) throw new Refusal(decoded.problem);
    const { value } = decoded.value;
    if (value > maxDeposit) {
      throw new Refusal(
        `This authorization is for ${usdc6(value)} USDC, above your limit of ${usdc6(maxDeposit)} USDC. Ask the person you work for to raise MAX_DEPOSIT_USDC or to make the Deposit themselves.`,
      );
    }
    if (!appUrl) {
      throw new Refusal(
        "Set APP_URL to the Bona Fide App's address to submit signed Deposits. Or use prepare_two_step_deposit to deposit from your own wallet.",
      );
    }
    const url = new URL(RELAY_PATH, appUrl.endsWith("/") ? appUrl : `${appUrl}/`);
    let response: Response;
    try {
      response = await fetch(url.toString(), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(relayDepositRoute.encode(decoded.value)),
      });
    } catch {
      throw new Refusal(
        `The Bona Fide App at ${url.origin} can't be reached. Try again, or use prepare_two_step_deposit.`,
      );
    }
    const body: unknown = await response.json().catch(() => null);
    const refusal = refusalIn(body);
    const txHash = response.ok ? relayDepositRoute.answer(body)?.txHash : refusal.txHash;
    const pending = response.status === 504 && txHash;
    if (!response.ok && !pending) throw new Refusal(relayRefusal(response.status, refusal));
    if (!txHash) {
      throw new Refusal(
        "The Bona Fide App didn't answer with a transaction. Check get_deposit_rules before trying again.",
      );
    }
    return confirm(txHash, fields);
  }

  /** Reads the Deposit from the chain itself, rather than taking the App's word for it. */
  async function confirm(txHash: Hex, fields: SignedDepositFields): Promise<MadeDeposit> {
    const key = keyOf(repoIdOf(fields.repo), fields.kind, fields.number);
    const receipt = await client
      .waitForTransactionReceipt({ hash: txHash, pollingInterval: RECEIPT_POLL_MS, timeout: receiptTimeoutMs })
      .catch((error: unknown) => {
        if (!(error instanceof WaitForTransactionReceiptTimeoutError)) throw error;
        throw new Refusal(
          `Transaction ${txHash} isn't confirmed yet. Call get_deposit_rules in a minute to see whether the Deposit landed.`,
        );
      });
    const made = parseEventLogs({ abi: escrowAbi, logs: receipt.logs, eventName: "Deposited" }).find(
      (log) =>
        isAddressEqual(log.address, escrow) && log.args.key === key && isAddressEqual(log.args.depositor, fields.from),
    );
    if (receipt.status !== "success" || !made) {
      throw new Refusal(
        `The App reported transaction ${txHash}, but it didn't make this Deposit. Check get_deposit_rules before trying again.`,
      );
    }
    return {
      repo: fields.repo,
      kind: fields.kind,
      number: fields.number,
      txHash,
      depositor: made.args.depositor,
      amount: made.args.amount.toString(),
      amountUsdc: usdc6(made.args.amount),
      deadline: isoTime(made.args.deadline),
    };
  }

  async function status(target: Target): Promise<DepositState> {
    const key = keyOf(repoIdOf(target.repo), target.kind, target.number);
    const [deposit, block] = await Promise.all([
      client.readContract({ address: escrow, abi: escrowAbi, functionName: "depositOf", args: [key] }),
      client.getBlock(),
    ]);
    const state = DEPOSIT_STATUSES[deposit.status] ?? "none";
    const base = { ...target, key, escrow, status: state, checkedAt: isoTime(block.timestamp) };
    if (state === "none") return { ...base, deposit: null, explorerUrl: null };
    // The escrow's own split: the Forfeit sink's share rounds down, and the rest is refunded.
    const forfeited = state === "forfeited" ? (deposit.amount * BigInt(deposit.forfeitBps)) / 10_000n : 0n;
    const refunded = deposit.amount - forfeited;
    return {
      ...base,
      deposit: {
        depositor: deposit.depositor,
        amount: deposit.amount.toString(),
        amountUsdc: usdc6(deposit.amount),
        serial: deposit.serial.toString(),
        deadline: isoTime(deposit.deadline),
        // refund() checks block.timestamp >= deadline, and the next block is no earlier than this one.
        timeoutPassed: block.timestamp >= deposit.deadline,
        secondsLeft: Number(deposit.deadline > block.timestamp ? deposit.deadline - block.timestamp : 0n),
        forfeitPercent: deposit.forfeitBps / 100,
        outcome:
          state === "active"
            ? null
            : {
                refunded: refunded.toString(),
                refundedUsdc: usdc6(refunded),
                forfeited: forfeited.toString(),
                forfeitedUsdc: usdc6(forfeited),
              },
      },
      explorerUrl: explorerUrl && addressLink(explorerUrl, deposit.depositor),
    };
  }

  /** The escrow's refund(key), once anyone may send it: the Deposit is active and its Timeout has passed. */
  async function prepareRefund(target: Target, from: Address): Promise<RefundPlan> {
    const current = await status(target);
    const { deposit } = current;
    const item = `${itemName(target)} in ${target.repo}`;
    if (!deposit) throw new Refusal(`${capitalized(item)} has no Deposit, so there is nothing to Refund.`);
    if (current.status === "refunded") {
      throw new Refusal(
        `The Deposit for ${item} was already refunded: ${deposit.amountUsdc} USDC went back to ${deposit.depositor}.`,
      );
    }
    if (current.status === "forfeited") {
      throw new Refusal(
        `The Deposit for ${item} was forfeited by its Maintainer's signed verdict: ${deposit.outcome!.forfeitedUsdc} USDC went to the Forfeit sink and ${deposit.outcome!.refundedUsdc} USDC back to ${deposit.depositor}. Nothing is left to Refund.`,
      );
    }
    if (!deposit.timeoutPassed) {
      throw new Refusal(
        `The Deposit for ${item} is still within its Timeout, which ends at ${deposit.deadline}, ${timeLeft(deposit.secondsLeft)} from now. Until then only the Keeper can Refund it, which it does once ${settled(target)}. Call prepare_refund again after ${deposit.deadline}.`,
      );
    }
    const sender = getAddress(from);
    const chain = circleChain(await client.getChainId());
    return {
      from: sender,
      depositor: deposit.depositor,
      amount: deposit.amount,
      amountUsdc: deposit.amountUsdc,
      step: {
        description: `Refund the Deposit for ${item}: ${deposit.amountUsdc} USDC goes back to ${deposit.depositor}.`,
        to: escrow,
        data: encodeFunctionData({ abi: escrowAbi, functionName: "refund", args: [current.key] }),
        circleCommand: chain ? executeCommand("refund(bytes32)", [current.key], escrow, sender, chain) : null,
      },
    };
  }

  return { rules, prepareSigned, prepareTwoStep, submitSigned, status, prepareRefund };
}

function relayRefusal(status: number, { code, error, txHash }: AppRefusal): string {
  if (status === 404) {
    return "This Bona Fide App doesn't relay Deposits. Use prepare_two_step_deposit to deposit from your own wallet.";
  }
  const said = error || `The Bona Fide App answered ${status}.`;
  if (code === "amount-changed") return `${said} Call prepare_signed_deposit again and sign the new typed data.`;
  if (txHash) return `${said} Transaction: ${txHash}.`;
  return said;
}

export type Deposits = ReturnType<typeof createDeposits>;

function terms(config: { forfeitBps: number; timeout: number; amount: bigint }): Terms {
  return {
    amount: config.amount.toString(),
    amountUsdc: usdc6(config.amount),
    forfeitPercent: config.forfeitBps / 100,
    timeoutDays: config.timeout / DAY_SECONDS,
  };
}

export function usdc6(amount: bigint): string {
  return formatUnits(amount, USDC_DECIMALS);
}

function isoTime(seconds: bigint): string {
  return new Date(Number(seconds) * 1000).toISOString();
}
