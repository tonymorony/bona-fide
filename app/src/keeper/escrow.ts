import { DEPOSIT_STATUSES, escrowAbi, isValidSignatureNow, type DepositStatus } from "@bona-fide/sdk";
import {
  BaseError,
  ContractFunctionRevertedError,
  getAbiItem,
  isAddressEqual,
  parseEventLogs,
  type Address,
  type Hex,
  type LocalAccount,
  type PublicClient,
  type WriteContractParameters,
} from "viem";
import { nonceManager, privateKeyToAccount } from "viem/accounts";
import { writeContract } from "viem/actions";
import { createEscrowChain } from "../escrow.ts";
import type { Binding } from "../ports.ts";

/** One of the escrow's custom errors, such as "DepositNotActive". */
export type EscrowError = Extract<(typeof escrowAbi)[number], { type: "error" }>["name"];

/** A transaction that passed simulation but reverted on-chain, which costs its gas. */
export class TransactionReverted extends Error {
  readonly txHash: Hex;

  constructor(txHash: Hex) {
    super(`Transaction ${txHash} reverted.`);
    this.txHash = txHash;
  }
}

/** The escrow would revert with one of its custom errors. */
export class EscrowRejection extends Error {
  readonly reason: EscrowError;

  constructor(reason: EscrowError) {
    super(`The escrow would revert with ${reason}.`);
    this.reason = reason;
  }
}

const REPO_PROPOSED = getAbiItem({ abi: escrowAbi, name: "RepoProposed" });
const DEPOSIT_CHANGES = [
  getAbiItem({ abi: escrowAbi, name: "Deposited" }),
  getAbiItem({ abi: escrowAbi, name: "Refunded" }),
  getAbiItem({ abi: escrowAbi, name: "Forfeited" }),
];

export interface EscrowDeposit {
  status: DepositStatus;
  depositor: Address;
  maintainer: Address;
  serial: bigint;
  amount: bigint;
  forfeitBps: number;
  deadline: bigint;
}

/**
 * What proposing a Binding came to. Proposing the Binding that is already pending or active would
 * only restart the Binding delay, so then nothing is sent.
 */
export type BindingStatus =
  | { status: "proposed"; txHash: Hex; effectiveAt: bigint }
  | { status: "pending"; effectiveAt: bigint }
  | { status: "active" };

/**
 * A Deposit made, with its deadline in Unix seconds, or one resolved: refunded or forfeited. As the
 * escrow's events report it.
 */
export type DepositChange =
  { type: "deposited"; key: Hex; serial: bigint; deadline: bigint } | { type: "resolved"; key: Hex; serial: bigint };

/**
 * The escrow as the Keeper uses it: reads, and transactions signed with the Keeper key. Each
 * transaction is simulated first, so one the escrow would reject costs no gas, and they are sent
 * one at a time.
 */
export interface KeeperEscrow {
  readonly address: Address;
  chainId(): Promise<number>;
  /** The latest block's time, in Unix seconds: the time the escrow's checks use. */
  now(): Promise<bigint>;
  /** Whether `signer` made `signature` over `digest`, checked as the escrow checks it. */
  isValidSignature(signer: Address, digest: Hex, signature: Hex): Promise<boolean>;
  depositOf(key: Hex): Promise<EscrowDeposit>;
  /**
   * Refunds the key's active Deposit in full to its Depositor. With `serial`, only that Deposit:
   * the escrow's refund names no serial, so this is checked just before sending. Null if there was
   * nothing to refund.
   */
  refund(key: Hex, serial?: bigint): Promise<Hex | null>;
  /**
   * Relays a Forfeit the Maintainer signed. Throws an EscrowRejection if the escrow would revert,
   * and a TransactionReverted if it reverted all the same.
   */
  forfeit(key: Hex, sigDeadline: bigint, signature: Hex): Promise<Hex>;
  /** The repo's proposed Binding and when it can be activated, or null if none is pending. */
  pendingBinding(repoId: Hex): Promise<{ binding: Binding; effectiveAt: bigint } | null>;
  /** Proposes a Binding, unless it is already pending or active. It can be activated `bindingDelay` later. */
  proposeRepo(repoId: Hex, binding: Binding): Promise<BindingStatus>;
  latestBlock(): Promise<bigint>;
  /** The Bindings proposed in these blocks, oldest first. */
  proposals(fromBlock: bigint, toBlock: bigint): Promise<{ repoId: Hex; effectiveAt: bigint }[]>;
  /** The Deposits made, refunded and forfeited in these blocks, oldest first. */
  depositChanges(fromBlock: bigint, toBlock: bigint): Promise<DepositChange[]>;
  /** Activates the repo's pending Binding. Throws an EscrowRejection if the escrow would revert. */
  activateRepo(repoId: Hex): Promise<Hex>;
}

export interface KeeperEscrowOptions {
  client: PublicClient;
  /** The Keeper's account. It signs locally; the key never goes to the RPC. */
  account: LocalAccount;
  escrow: Address;
}

/**
 * The Keeper's account from its private key. Neither the account nor any error shows the key. It
 * takes nonces from viem's shared nonce manager, so another sender in the process with the same
 * key never reuses one.
 */
export function keeperAccount(privateKey: string): LocalAccount {
  const key = privateKey.trim();
  if (!/^0x[0-9a-fA-F]{64}$/.test(key)) throw new Error("KEEPER_PRIVATE_KEY must be 0x and 64 hex characters.");
  try {
    return privateKeyToAccount(key as Hex, { nonceManager });
  } catch {
    throw new Error("KEEPER_PRIVATE_KEY isn't a valid private key.");
  }
}

export function createKeeperEscrow({ client, account, escrow }: KeeperEscrowOptions): KeeperEscrow {
  const inTurn = inTurnFor(account);
  const chain = createEscrowChain({ client, escrow });
  let chainId: Promise<number> | undefined;

  async function pendingBinding(repoId: Hex): Promise<{ binding: Binding; effectiveAt: bigint } | null> {
    const { pending } = await chain.bindingOf(repoId);
    if (!pending) return null;
    const { effectiveAt, ...binding } = pending;
    return { binding, effectiveAt: unixSeconds(effectiveAt) };
  }

  async function depositOf(key: Hex): Promise<EscrowDeposit> {
    const d = await client.readContract({ address: escrow, abi: escrowAbi, functionName: "depositOf", args: [key] });
    return { ...d, status: DEPOSIT_STATUSES[d.status] ?? "none" };
  }

  const sent = (request: WriteContractParameters) => sendAndWait(client, request);

  return {
    address: escrow,

    chainId() {
      chainId ??= client.getChainId();
      return chainId;
    },

    async now() {
      return (await client.getBlock({ blockTag: "latest" })).timestamp;
    },

    isValidSignature(signer, digest, signature) {
      return isValidSignatureNow(client, signer, digest, signature);
    },

    depositOf,

    refund(key, serial) {
      return inTurn(async () => {
        const deposit = await depositOf(key);
        if (deposit.status !== "active" || (serial !== undefined && deposit.serial !== serial)) return null;
        try {
          const { request } = await rejecting(
            client.simulateContract({ account, address: escrow, abi: escrowAbi, functionName: "refund", args: [key] }),
          );
          return (await sent(request)).transactionHash;
        } catch (error) {
          if (error instanceof EscrowRejection && error.reason === "DepositNotActive") return null;
          throw error;
        }
      });
    },

    forfeit(key, sigDeadline, signature) {
      return inTurn(async () => {
        const { request } = await rejecting(
          client.simulateContract({
            account,
            address: escrow,
            abi: escrowAbi,
            functionName: "forfeit",
            args: [key, sigDeadline, signature],
          }),
        );
        return (await sent(request)).transactionHash;
      });
    },

    pendingBinding,

    proposeRepo(repoId, binding) {
      return inTurn(async (): Promise<BindingStatus> => {
        const { active, pending } = await chain.bindingOf(repoId);
        if (pending && sameBinding(pending, binding)) {
          return { status: "pending", effectiveAt: unixSeconds(pending.effectiveAt) };
        }
        if (!pending && active && sameBinding(active, binding)) return { status: "active" };
        const { maintainer, forfeitBps, timeoutSeconds, amount } = binding;
        const { request } = await rejecting(
          client.simulateContract({
            account,
            address: escrow,
            abi: escrowAbi,
            functionName: "proposeRepo",
            args: [repoId, maintainer, forfeitBps, timeoutSeconds, amount],
          }),
        );
        const receipt = await sent(request);
        const [proposed] = parseEventLogs({ abi: escrowAbi, eventName: "RepoProposed", logs: receipt.logs });
        if (!proposed) throw new Error(`No RepoProposed event in ${receipt.transactionHash}.`);
        return { status: "proposed", txHash: receipt.transactionHash, effectiveAt: proposed.args.effectiveAt };
      });
    },

    latestBlock() {
      return client.getBlockNumber({ cacheTime: 0 });
    },

    async proposals(fromBlock, toBlock) {
      const logs = await client.getLogs({
        address: escrow,
        event: REPO_PROPOSED,
        fromBlock,
        toBlock,
        strict: true,
      });
      return logs.map((log) => ({ repoId: log.args.repoId, effectiveAt: log.args.effectiveAt }));
    },

    async depositChanges(fromBlock, toBlock) {
      const logs = await client.getLogs({ address: escrow, events: DEPOSIT_CHANGES, fromBlock, toBlock, strict: true });
      return logs.map(({ eventName, args }): DepositChange => {
        if (eventName === "Deposited") {
          return { type: "deposited", key: args.key, serial: args.serial, deadline: args.deadline };
        }
        return { type: "resolved", key: args.key, serial: args.serial };
      });
    },

    activateRepo(repoId) {
      return inTurn(async () => {
        const { request } = await rejecting(
          client.simulateContract({
            account,
            address: escrow,
            abi: escrowAbi,
            functionName: "activateRepo",
            args: [repoId],
          }),
        );
        return (await sent(request)).transactionHash;
      });
    },
  };
}

function unixSeconds(date: Date): bigint {
  return BigInt(date.getTime() / 1000);
}

export function sameBinding(a: Binding, b: Binding): boolean {
  return (
    isAddressEqual(a.maintainer, b.maintainer) &&
    a.forfeitBps === b.forfeitBps &&
    a.timeoutSeconds === b.timeoutSeconds &&
    a.amount === b.amount
  );
}

async function rejecting<T>(simulation: Promise<T>): Promise<T> {
  try {
    return await simulation;
  } catch (error) {
    const reason = revertNameOf(error);
    throw isEscrowError(reason) ? new EscrowRejection(reason) : error;
  }
}

/** The custom error a simulated call reverted with, such as "DepositNotActive", if it names one. */
export function revertNameOf(error: unknown): string | undefined {
  const revert = error instanceof BaseError ? error.walk((e) => e instanceof ContractFunctionRevertedError) : null;
  return revert instanceof ContractFunctionRevertedError ? revert.data?.errorName : undefined;
}

/** Sends a simulated request and waits for it to be mined. Throws a TransactionReverted if it reverted. */
export async function sendAndWait(client: PublicClient, request: WriteContractParameters) {
  const hash = await writeContract(client, request);
  const receipt = await client.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") throw new TransactionReverted(hash);
  return receipt;
}

function isEscrowError(name: string | undefined): name is EscrowError {
  return escrowAbi.some((item) => item.type === "error" && item.name === name);
}

// The Keeper sends one transaction at a time, whether to the escrow or to a Bounty wallet: its
// nonces stay in order, and each decision reads the state the previous transaction left.
const turns = new WeakMap<LocalAccount, <T>(work: () => Promise<T>) => Promise<T>>();

/** Runs each piece of work after the previous one `account` started, so its transactions go out one at a time. */
export function inTurnFor(account: LocalAccount): <T>(work: () => Promise<T>) => Promise<T> {
  let inTurn = turns.get(account);
  if (!inTurn) {
    let tail: Promise<unknown> = Promise.resolve();
    inTurn = <T>(work: () => Promise<T>): Promise<T> => {
      const run = tail.then(work, work);
      tail = run.catch(() => {});
      return run;
    };
    turns.set(account, inTurn);
  }
  return inTurn;
}
