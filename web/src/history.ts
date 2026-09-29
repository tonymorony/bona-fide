import type { Address, Hex, PublicClient } from "viem";
import { escrowAbi, routerAbi } from "./abi.ts";
import { KINDS, type Kind } from "./keys.ts";
import type { LiveNetwork } from "./network.ts";

/** Arc's public RPC answers getLogs for at most 10,000 blocks at a time. */
export const LOG_RANGE = 10_000;
const ATTEMPTS = 3;

const EVENTS = [
  ...escrowAbi.filter((item) => item.type === "event"),
  ...routerAbi.filter((item) => item.type === "event"),
];

export interface DepositRow {
  key: Hex;
  serial: bigint;
  kind: Kind;
  number: number;
  depositor: Address;
  amount: bigint;
  madeAt: Date;
  deadline: Date;
  txHash: Hex;
  status: "active" | "refunded" | "forfeited";
  refund?: { at: Date; afterTimeout: boolean; txHash: Hex };
  forfeit?: { forfeited: bigint; refunded: bigint; txHash: Hex };
}

export interface RepoHistory {
  /** Newest first. */
  deposits: DepositRow[];
  /** When the repo's first Binding took effect. */
  liveSince: Date | null;
  /** What the Charity router has sent on so far, from every repo. */
  flushes: { total: bigint; count: number };
}

export interface HistoryOptions {
  client: PublicClient;
  network: LiveNetwork;
  repoId: Hex;
  rangeSize?: number;
  /** Ranges read at once. */
  concurrency?: number;
  onProgress?: (done: number, total: number) => void;
}

/**
 * A repo's Deposits and how each ended, read from the escrow's and the router's events since the
 * escrow was deployed. One getLogs per range covers both contracts and every event the page shows.
 */
export async function readRepoHistory({
  client,
  network,
  repoId,
  rangeSize = LOG_RANGE,
  concurrency = 4,
  onProgress,
}: HistoryOptions): Promise<RepoHistory> {
  const latest = await client.getBlockNumber({ cacheTime: 0 });
  const ranges: [bigint, bigint][] = [];
  for (let from = BigInt(network.escrowFromBlock); from <= latest; from += BigInt(rangeSize)) {
    const to = from + BigInt(rangeSize) - 1n;
    ranges.push([from, to < latest ? to : latest]);
  }

  const read = (fromBlock: bigint, toBlock: bigint) =>
    client.getLogs({ address: [network.escrow, network.router], events: EVENTS, fromBlock, toBlock, strict: true });
  type Log = Awaited<ReturnType<typeof read>>[number];

  const logs: Log[] = [];
  let done = 0;
  let next = 0;
  async function worker() {
    while (next < ranges.length) {
      const [from, to] = ranges[next++]!;
      logs.push(...(await withRetries(() => read(from, to))));
      onProgress?.(++done, ranges.length);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, ranges.length) }, worker));
  logs.sort((a, b) => Number(a.blockNumber - b.blockNumber) || a.logIndex - b.logIndex);

  const times = new Map<bigint, Promise<Date>>();
  const timeOf = (log: Log): Promise<Date> => {
    const stamped = (log as { blockTimestamp?: bigint }).blockTimestamp;
    if (stamped !== undefined) return Promise.resolve(new Date(Number(stamped) * 1000));
    let time = times.get(log.blockNumber);
    if (!time) {
      time = client.getBlock({ blockNumber: log.blockNumber }).then((b) => new Date(Number(b.timestamp) * 1000));
      times.set(log.blockNumber, time);
    }
    return time;
  };

  const deposits = new Map<string, DepositRow>();
  const idOf = (key: Hex, serial: bigint) => `${key}:${serial}`;
  let liveSince: Date | null = null;
  const flushes = { total: 0n, count: 0 };

  for (const log of logs) {
    if (log.eventName === "Deposited" && log.args.repoId === repoId) {
      const { key, serial, kind, number, depositor, amount, deadline } = log.args;
      const kindName = KINDS[kind];
      if (!kindName) continue;
      deposits.set(idOf(key, serial), {
        key,
        serial,
        kind: kindName,
        number: Number(number),
        depositor,
        amount,
        madeAt: await timeOf(log),
        deadline: new Date(Number(deadline) * 1000),
        txHash: log.transactionHash,
        status: "active",
      });
    } else if (log.eventName === "Refunded") {
      const row = deposits.get(idOf(log.args.key, log.args.serial));
      if (!row) continue;
      const at = await timeOf(log);
      row.status = "refunded";
      row.refund = { at, afterTimeout: at >= row.deadline, txHash: log.transactionHash };
    } else if (log.eventName === "Forfeited") {
      const row = deposits.get(idOf(log.args.key, log.args.serial));
      if (!row) continue;
      row.status = "forfeited";
      row.forfeit = { forfeited: log.args.forfeited, refunded: log.args.refunded, txHash: log.transactionHash };
    } else if (log.eventName === "RepoActivated" && log.args.repoId === repoId) {
      liveSince ??= await timeOf(log);
    } else if (log.eventName === "Flushed") {
      flushes.total += log.args.amount;
      flushes.count += 1;
    }
  }

  return { deposits: [...deposits.values()].reverse(), liveSince, flushes };
}

async function withRetries<T>(read: () => Promise<T>): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await read();
    } catch (error) {
      if (attempt >= ATTEMPTS) throw error;
      await new Promise((resolve) => setTimeout(resolve, 400 * attempt));
    }
  }
}
