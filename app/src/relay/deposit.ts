import { DEPOSIT_STATUSES, escrowAbi, keyOf, KINDS, kindCode, repoIdOf, type Kind } from "@bona-fide/sdk";
import {
  BaseError,
  ContractFunctionRevertedError,
  formatUnits,
  isAddress,
  type Account,
  type Address,
  type Chain,
  type Hex,
  type PublicClient,
  type Transport,
  type WalletClient,
  WaitForTransactionReceiptTimeoutError,
  zeroAddress,
} from "viem";
import { nonceManager, privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";
import { USDC_DECIMALS } from "../config.ts";
import { cooldown, fixedWindow, REVERT_COOLDOWN_MS, type RateLimit } from "./rate-limit.ts";

export const RELAY_DEPOSIT_PATH = "/relay/deposit";

const STATUS_ACTIVE = DEPOSIT_STATUSES.indexOf("active");
const NOUN: Record<Kind, string> = { pr: "PR", issue: "Issue" };

export interface DepositRelayOptions {
  client: PublicClient;
  /** Signs and pays for the relayed transactions. */
  wallet: WalletClient<Transport, Chain | undefined, Account>;
  escrow: Address;
  /** Requests per client IP. Every request counts, well-formed or not. */
  perIp?: RateLimit;
  /** Requests naming one repo, from any IP. */
  perRepo?: RateLimit;
  /** Deposits sent from one Contributor's wallet. */
  perDepositor?: RateLimit;
  /** Deposits sent for one PR or issue. */
  perItem?: RateLimit;
  /** The clock for the rate limits and the cooldown after a reverted Deposit, in milliseconds. */
  now?: () => number;
  /** How long to wait for a sent Deposit to be mined before answering without it. */
  receiptTimeoutMs?: number;
}

const PER_IP: RateLimit = { max: 10, windowMs: 60_000 };
const PER_REPO: RateLimit = { max: 30, windowMs: 60_000 };
const DAY_MS = 24 * 60 * 60_000;
// The relayer pays for every Deposit it sends, and an exempt item's Deposit is refunded at once, so
// one balance could go round and round. A Contributor makes a few Deposits a day at most.
const PER_DEPOSITOR: RateLimit = { max: 10, windowMs: DAY_MS };
const PER_ITEM: RateLimit = { max: 3, windowMs: DAY_MS };
/** Least time an authorization must have left when it arrives, so it can't expire on the way to a block. */
const VALID_MARGIN_MS = 2 * 60_000;
const RECEIPT_TIMEOUT_MS = 30_000;
const RECEIPT_POLL_MS = 500;

/** Handles POST /relay/deposit. `clientIp` is the caller's address, as the host sees it. */
export type DepositRelay = (request: Request, clientIp: string) => Promise<Response>;

/** A Contributor's EIP-3009 authorization for one Deposit, as the relay receives it. */
export interface SignedDeposit {
  repo: string;
  kind: Kind;
  number: number;
  from: Address;
  value: bigint;
  validAfter: bigint;
  validBefore: bigint;
  salt: Hex;
  signature: Hex;
}

export function createDepositRelay({
  client,
  wallet,
  escrow,
  perIp = PER_IP,
  perRepo = PER_REPO,
  perDepositor = PER_DEPOSITOR,
  perItem = PER_ITEM,
  now = Date.now,
  receiptTimeoutMs = RECEIPT_TIMEOUT_MS,
}: DepositRelayOptions): DepositRelay {
  const ipWait = fixedWindow(perIp, now);
  const repoWait = fixedWindow(perRepo, now);
  const depositorWait = fixedWindow(perDepositor, now);
  const itemWait = fixedWindow(perItem, now);
  const afterRevert = cooldown(REVERT_COOLDOWN_MS, now);
  const inFlight = new Set<Hex>();
  let sending: Promise<unknown> = Promise.resolve();

  // One send at a time, so each transaction takes the next nonce however the account is set up.
  function oneAtATime<T>(send: () => Promise<T>): Promise<T> {
    const sent = sending.then(send);
    sending = sent.catch(() => {});
    return sent;
  }

  async function relay(deposit: SignedDeposit, repoId: Hex, key: Hex): Promise<Response> {
    const [binding, existing] = await Promise.all([
      client.readContract({ address: escrow, abi: escrowAbi, functionName: "activeConfig", args: [repoId] }),
      client.readContract({ address: escrow, abi: escrowAbi, functionName: "depositOf", args: [key] }),
    ]);
    if (binding.maintainer === zeroAddress) {
      return refuse(409, `Bona Fide isn't active for ${deposit.repo}, so it takes no Deposits.`);
    }
    if (binding.amount !== deposit.value) {
      return refuse(
        409,
        `The Deposit for ${deposit.repo} is ${usdc(binding.amount)}, but this authorization is for ${usdc(deposit.value)}. Sign a new one for ${usdc(binding.amount)}.`,
        { amount: binding.amount.toString() },
      );
    }
    if (existing.status === STATUS_ACTIVE) {
      return refuse(409, `${itemName(deposit)} already has an active Deposit, from ${existing.depositor}.`, {
        depositor: existing.depositor,
      });
    }
    const simulation = await client
      .simulateContract({
        account: wallet.account,
        address: escrow,
        abi: escrowAbi,
        functionName: "depositWithAuthorization",
        args: [
          repoId,
          kindCode(deposit.kind),
          BigInt(deposit.number),
          deposit.from,
          deposit.validAfter,
          deposit.validBefore,
          deposit.salt,
          deposit.signature,
        ],
      })
      .catch((error: unknown) => {
        const reason = revertReason(error);
        if (reason === null) throw error;
        return reason;
      });
    if (typeof simulation === "string") return refuse(422, `The Deposit would fail on-chain: ${simulation}.`);
    // Counted only when the relayer would pay: a Deposit refused above costs it nothing.
    const sends = Math.max(depositorWait(deposit.from.toLowerCase()), itemWait(key));
    if (sends > 0) return tooManyDeposits(sends);
    const txHash = await oneAtATime(() => wallet.writeContract(simulation.request));
    const receipt = await client
      .waitForTransactionReceipt({ hash: txHash, pollingInterval: RECEIPT_POLL_MS, timeout: receiptTimeoutMs })
      .catch((error: unknown) => {
        if (!(error instanceof WaitForTransactionReceiptTimeoutError))
          console.error("deposit relay can't confirm:", error);
        return null;
      });
    if (receipt === null) {
      return refuse(504, "The Deposit was sent but isn't confirmed yet. Check its transaction before trying again.", {
        txHash,
      });
    }
    if (receipt.status !== "success") {
      afterRevert.hold(key);
      afterRevert.hold(deposit.from.toLowerCase());
      return refuse(
        502,
        "The transaction reverted on-chain, so no Deposit was made. Try again in 10 minutes, or deposit from your own wallet.",
        { txHash },
      );
    }
    return Response.json({ txHash });
  }

  return async (request, clientIp) => {
    if (request.method !== "POST") {
      return Response.json({ error: "Use POST." }, { status: 405, headers: { allow: "POST" } });
    }
    const wait = ipWait(clientIp);
    if (wait > 0) return tooMany(wait);
    const parsed = parseSignedDeposit(await request.text());
    if (!parsed.ok) return refuse(400, parsed.problem);
    const deposit = parsed.deposit;
    if (deposit.validBefore * 1000n < BigInt(now() + VALID_MARGIN_MS)) {
      return refuse(422, "This authorization expires too soon to be relayed. Sign a new one.");
    }
    const repoWaits = repoWait(deposit.repo.toLowerCase());
    if (repoWaits > 0) return tooMany(repoWaits);
    const repoId = repoIdOf(deposit.repo);
    const key = keyOf(repoId, deposit.kind, deposit.number);
    const cooling = Math.max(afterRevert.wait(key), afterRevert.wait(deposit.from.toLowerCase()));
    if (cooling > 0) return revertedRecently(deposit, cooling);
    if (inFlight.has(key)) return refuse(409, `A Deposit for ${itemName(deposit)} is being relayed right now.`);
    inFlight.add(key);
    try {
      return await relay(deposit, repoId, key);
    } catch (error) {
      console.error("deposit relay failed:", error);
      return refuse(503, "The relay can't complete this Deposit right now. Try again in a minute.");
    } finally {
      inFlight.delete(key);
    }
  };
}

/**
 * The relayer's account. It shares viem's nonce manager, so other senders in this process that use
 * the same key, such as the Keeper, don't reuse its nonces. The key never appears in an error.
 */
export function relayerAccount(privateKey: string): PrivateKeyAccount {
  const hex = privateKey.startsWith("0x") ? privateKey : `0x${privateKey}`;
  if (!/^0x[0-9a-fA-F]{64}$/.test(hex)) throw new Error("The relayer key must be 32 bytes of hex.");
  return privateKeyToAccount(hex as Hex, { nonceManager });
}

function itemName({ kind, number, repo }: SignedDeposit): string {
  return `${NOUN[kind]} #${number} in ${repo}`;
}

function refuse(status: number, error: string, details: Record<string, string> = {}): Response {
  return Response.json({ error, ...details }, { status });
}

function tooManyDeposits(seconds: number): Response {
  return Response.json(
    {
      error: `The relay has sent as many Deposits from this wallet, or for this item, as it does in a day. Try again in ${seconds} s, or deposit from your own wallet.`,
    },
    { status: 429, headers: { "retry-after": String(seconds) } },
  );
}

function tooMany(seconds: number): Response {
  return Response.json(
    { error: `Too many requests. Try again in ${seconds} s.` },
    { status: 429, headers: { "retry-after": String(seconds) } },
  );
}

function revertedRecently(deposit: SignedDeposit, seconds: number): Response {
  return Response.json(
    {
      error: `The relay paused Deposits for ${itemName(deposit)} or from ${deposit.from} after one reverted on-chain. Try again in ${seconds} s, or deposit from your own wallet.`,
    },
    { status: 429, headers: { "retry-after": String(seconds) } },
  );
}

function revertReason(error: unknown): string | null {
  const reverted = error instanceof BaseError ? error.walk((e) => e instanceof ContractFunctionRevertedError) : null;
  if (!(reverted instanceof ContractFunctionRevertedError)) return null;
  return reverted.reason ?? reverted.data?.errorName ?? reverted.signature ?? "no reason given";
}

function usdc(amount: bigint): string {
  return `${formatUnits(amount, USDC_DECIMALS)} USDC`;
}

type Parsed = { ok: true; deposit: SignedDeposit } | { ok: false; problem: string };

export function parseSignedDeposit(text: string): Parsed {
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return { ok: false, problem: "The body must be JSON." };
  }
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return { ok: false, problem: "The body must be a JSON object." };
  }
  const {
    repo,
    kind,
    number,
    from,
    value,
    validAfter = "0",
    validBefore,
    salt,
    signature,
  } = body as Record<string, unknown>;
  const problems: string[] = [];
  const check = <T>(parsed: T | null, problem: string): T => {
    if (parsed === null) problems.push(problem);
    return parsed as T;
  };
  const deposit: SignedDeposit = {
    repo: check(typeof repo === "string" && REPO.test(repo) ? repo : null, "`repo` must be owner/name."),
    kind: check(KINDS.find((k) => k === kind) ?? null, '`kind` must be "pr" or "issue".'),
    number: check(
      typeof number === "number" && Number.isSafeInteger(number) && number > 0 ? number : null,
      "`number` must be a positive whole number.",
    ),
    from: check(typeof from === "string" && isAddress(from) ? from : null, "`from` must be an address."),
    value: check(uint(value), "`value` must be a whole number of USDC base units."),
    validAfter: check(uint(validAfter), "`validAfter` must be a Unix time in seconds."),
    validBefore: check(uint(validBefore), "`validBefore` must be a Unix time in seconds."),
    salt: check(
      typeof salt === "string" && /^0x[0-9a-fA-F]{64}$/.test(salt) ? (salt as Hex) : null,
      "`salt` must be 32 bytes of hex.",
    ),
    signature: check(
      typeof signature === "string" && /^0x(?:[0-9a-fA-F]{2}){1,2048}$/.test(signature) ? (signature as Hex) : null,
      "`signature` must be hex.",
    ),
  };
  return problems.length === 0 ? { ok: true, deposit } : { ok: false, problem: problems.join(" ") };
}

const REPO = /^[A-Za-z0-9-]{1,39}\/[A-Za-z0-9._-]{1,100}$/;
const UINT256_MAX = 2n ** 256n - 1n;

function uint(value: unknown): bigint | null {
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) return BigInt(value);
  if (typeof value !== "string" || !/^\d{1,78}$/.test(value)) return null;
  const parsed = BigInt(value);
  return parsed <= UINT256_MAX ? parsed : null;
}
