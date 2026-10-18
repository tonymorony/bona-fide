import { DEPOSIT_STATUSES, escrowAbi, KINDS } from "@bona-fide/sdk";
import {
  BaseError,
  ContractFunctionZeroDataError,
  getAbiItem,
  zeroAddress,
  type Address,
  type Hex,
  type PublicClient,
} from "viem";
import type { Binding, Chain, DepositedEvent, EscrowEvent } from "./ports.ts";

const DEPOSITED = getAbiItem({ abi: escrowAbi, name: "Deposited" });
const REPO_ACTIVATED = getAbiItem({ abi: escrowAbi, name: "RepoActivated" });
const REFUNDED = getAbiItem({ abi: escrowAbi, name: "Refunded" });
const FORFEITED = getAbiItem({ abi: escrowAbi, name: "Forfeited" });
const STATUS_ACTIVE = DEPOSIT_STATUSES.indexOf("active");

interface RepoConfig {
  maintainer: Address;
  forfeitBps: number;
  timeout: number;
  amount: bigint;
}

// The escrow returns an all-zero config for "none": a Binding always names a Maintainer.
function bindingFrom({ maintainer, forfeitBps, timeout, amount }: RepoConfig): Binding | null {
  return maintainer === zeroAddress ? null : { maintainer, amount, forfeitBps, timeoutSeconds: timeout };
}

export interface EscrowChainOptions {
  client: PublicClient;
  escrow: Address;
  /** The escrow's deploy block. No Deposit is older, so searches start here. */
  fromBlock?: bigint;
}

// Reads the escrow through an RPC node. `depositSince` and `startedAt` read state at past blocks,
// so the node must serve historical state (Arc's public RPC does).
export function createEscrowChain({ client, escrow, fromBlock = 0n }: EscrowChainOptions): Chain {
  const timestamps = new Map<bigint, bigint>();
  /** The last block before each time looked up, once a later block exists, so the answer can't change. */
  const lastBefore = new Map<bigint, bigint | null>();
  const starts = new Map<Hex, Date>();
  /** Each Deposit's transaction, by `key:serial`. */
  const transactions = new Map<string, Hex>();

  async function timestampOf(blockNumber: bigint): Promise<bigint> {
    let timestamp = timestamps.get(blockNumber);
    if (timestamp === undefined) {
      timestamp = (await client.getBlock({ blockNumber })).timestamp;
      if (timestamps.size >= 10_000) timestamps.clear();
      timestamps.set(blockNumber, timestamp);
    }
    return timestamp;
  }

  function latestBlock(): Promise<bigint> {
    return client.getBlockNumber({ cacheTime: 0 });
  }

  function depositOf(key: Hex, blockNumber?: bigint) {
    return client.readContract({
      address: escrow,
      abi: escrowAbi,
      functionName: "depositOf",
      args: [key],
      blockNumber,
    });
  }

  // The last block stamped before `time` (seconds), or null if no block from `fromBlock` on is.
  // Arc makes blocks at a steady rate, so interpolating finds it in a few reads; every other
  // step bisects, which keeps the worst case logarithmic. Every check of an item asks for the same
  // time, its creation's, so a settled answer is remembered.
  async function lastBlockBefore(time: bigint): Promise<bigint | null> {
    if (lastBefore.has(time)) return lastBefore.get(time)!;
    const found = await searchBefore(time);
    if (found.settled) remember(lastBefore, time, found.block);
    return found.block;
  }

  async function searchBefore(time: bigint): Promise<{ block: bigint | null; settled: boolean }> {
    let lo = fromBlock;
    let hi = await latestBlock();
    if ((await timestampOf(lo)) >= time) return { block: null, settled: true };
    // The latest block is before `time`: a later one may be too.
    if ((await timestampOf(hi)) < time) return { block: hi, settled: false };
    for (let step = 0; hi - lo > 1n; step++) {
      const loTime = await timestampOf(lo);
      const hiTime = await timestampOf(hi);
      let mid = step % 2 === 0 ? lo + ((time - loTime) * (hi - lo)) / (hiTime - loTime) : (lo + hi) / 2n;
      if (mid <= lo) mid = lo + 1n;
      if (mid >= hi) mid = hi - 1n;
      if ((await timestampOf(mid)) < time) lo = mid;
      else hi = mid;
    }
    return { block: lo, settled: true };
  }

  // The first block after `after`, up to `latest`, where `holds` does, for a state that keeps
  // holding once it does. Halving the blocks finds it in a few dozen reads.
  async function firstBlock(after: bigint, latest: bigint, holds: (block: bigint) => Promise<boolean>) {
    let lo = after;
    let hi = latest;
    while (hi - lo > 1n) {
      const mid = (lo + hi) / 2n;
      if (await holds(mid)) hi = mid;
      else lo = mid;
    }
    return hi;
  }

  async function activeAt(repoId: Hex, blockNumber: bigint): Promise<boolean> {
    try {
      const { maintainer } = await client.readContract({
        address: escrow,
        abi: escrowAbi,
        functionName: "activeConfig",
        args: [repoId],
        blockNumber,
      });
      return maintainer !== zeroAddress;
    } catch (error) {
      if (beforeDeploy(error)) return false;
      throw error;
    }
  }

  async function serialAt(key: Hex, blockNumber: bigint): Promise<bigint> {
    try {
      return (await depositOf(key, blockNumber)).serial;
    } catch (error) {
      if (beforeDeploy(error)) return 0n;
      throw error;
    }
  }

  // A Binding can be replaced but never removed, so a repo is active from the block of its first
  // RepoActivated event on.
  async function firstActivation(repoId: Hex): Promise<Date | null> {
    const latest = await latestBlock();
    if (!(await activeAt(repoId, latest))) return null;
    const block = await firstBlock(fromBlock - 1n, latest, (b) => activeAt(repoId, b));
    const [activated] = await client.getLogs({
      address: escrow,
      event: REPO_ACTIVATED,
      args: { repoId },
      fromBlock: block,
      toBlock: block,
      strict: true,
    });
    if (!activated) {
      throw new Error(
        `No RepoActivated event for ${repoId} in block ${block}, where it first reads as active. Is fromBlock after its first activation?`,
      );
    }
    return new Date(Number(await timestampOf(block)) * 1000);
  }

  // Serials only grow, so the Deposit was made in the first block after `after` whose state holds
  // its serial or a later one, and its Deposited event there names the transaction.
  async function transactionOf(key: Hex, serial: bigint, after: bigint): Promise<Hex> {
    const known = transactions.get(`${key}:${serial}`);
    if (known) return known;
    const block = await firstBlock(after, await latestBlock(), async (b) => (await serialAt(key, b)) >= serial);
    const logs = await client.getLogs({
      address: escrow,
      event: DEPOSITED,
      args: { key },
      fromBlock: block,
      toBlock: block,
      strict: true,
    });
    const made = logs.find((log) => log.args.serial === serial);
    if (!made) throw new Error(`No Deposited event for Deposit ${serial} of ${key} in block ${block}.`);
    remember(transactions, `${key}:${serial}`, made.transactionHash);
    return made.transactionHash;
  }

  return {
    latestBlock,

    async escrowEvents(from, to) {
      const logs = await client.getLogs({
        address: escrow,
        events: [DEPOSITED, REPO_ACTIVATED, REFUNDED, FORFEITED],
        fromBlock: from,
        toBlock: to,
        strict: true,
      });
      const events: EscrowEvent[] = [];
      for (const log of logs) {
        if (log.eventName === "RepoActivated") {
          events.push({ type: "activated", repoId: log.args.repoId });
          continue;
        }
        if (log.eventName === "Refunded" || log.eventName === "Forfeited") {
          const type = log.eventName === "Refunded" ? "refunded" : "forfeited";
          events.push({ type, key: log.args.key, serial: log.args.serial });
          continue;
        }
        const kind = KINDS[log.args.kind];
        if (!kind) continue;
        const deposit: DepositedEvent = {
          key: log.args.key,
          serial: log.args.serial,
          repoId: log.args.repoId,
          kind,
          number: Number(log.args.number),
          depositor: log.args.depositor,
          amount: log.args.amount,
          txHash: log.transactionHash,
          blockNumber: log.blockNumber,
          blockTime: new Date(Number(await timestampOf(log.blockNumber)) * 1000),
        };
        remember(transactions, `${deposit.key}:${deposit.serial}`, deposit.txHash);
        events.push({ type: "deposited", deposit });
      }
      return events;
    },

    async depositSince(key, since, seen) {
      const { status, depositor, amount, serial } = await depositOf(key);
      if (status !== STATUS_ACTIVE) return null;
      if (seen?.key === key && seen.serial === serial) {
        return seen.blockTime >= since ? { depositor, amount, serial, txHash: seen.txHash } : null;
      }
      const before = await lastBlockBefore(BigInt(Math.ceil(since.getTime() / 1000)));
      if (before !== null && (await depositOf(key, before)).serial === serial) return null;
      return { depositor, amount, serial, txHash: await transactionOf(key, serial, before ?? fromBlock - 1n) };
    },

    async bindingOf(repoId) {
      const [active, [pending, effectiveAt]] = await Promise.all([
        client.readContract({ address: escrow, abi: escrowAbi, functionName: "activeConfig", args: [repoId] }),
        client.readContract({ address: escrow, abi: escrowAbi, functionName: "pendingConfig", args: [repoId] }),
      ]);
      const proposed = bindingFrom(pending);
      return {
        active: bindingFrom(active),
        pending: proposed && { ...proposed, effectiveAt: new Date(Number(effectiveAt) * 1000) },
      };
    },

    async startedAt(repoId) {
      const known = starts.get(repoId);
      if (known) return known;
      const started = await firstActivation(repoId);
      if (started) remember(starts, repoId, started);
      return started;
    },
  };
}

/** Whether a read failed because the escrow didn't exist yet at that block, so its state was empty. */
function beforeDeploy(error: unknown): boolean {
  return error instanceof BaseError && error.walk((e) => e instanceof ContractFunctionZeroDataError) !== null;
}

/** Caches a value that never changes, emptying the cache first once it is full, so memory stays bounded. */
function remember<K, V>(cache: Map<K, V>, key: K, value: V): void {
  if (cache.size >= 10_000) cache.clear();
  cache.set(key, value);
}
