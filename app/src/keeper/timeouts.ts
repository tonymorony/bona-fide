import type { Hex } from "viem";
import { createBlockScanner } from "../blocks.ts";
import type { KeeperEscrow } from "./escrow.ts";

/** Most open Deposits the Keeper follows to their Timeout: the ones due first. */
const MAX_OPEN = 10_000;
/** Longest wait between tries at a refund that keeps failing: about 8.5 hours at 30 s a tick. */
const MAX_WAIT_TICKS = 1024;

export interface TimeoutRefunderDeps {
  escrow: KeeperEscrow;
  /** First block to read: the escrow's deploy block, so no Deposit that is still open is missed. */
  fromBlock?: bigint;
  /** Most open Deposits followed. */
  maxOpen?: number;
}

export interface TimeoutRefunder {
  /**
   * Refunds every active Deposit whose deadline is at or before the latest block's time. Rejects if
   * a refund failed; later ticks try it again, less and less often. The host calls it on a timer.
   */
  tick(): Promise<void>;
  /** The next block to read. */
  readonly position: bigint | undefined;
}

interface Open {
  serial: bigint;
  /** In Unix seconds. */
  deadline: bigint;
  /** Ticks to wait after the next failed try. */
  wait: number;
  /** The first tick of the next try. */
  retryTick: number;
}

// After its Timeout anyone may refund a Deposit; the Keeper does, so the refund needs nobody to act.
export function createTimeoutRefunder({ escrow, fromBlock, maxOpen = MAX_OPEN }: TimeoutRefunderDeps): TimeoutRefunder {
  const blocks = createBlockScanner(fromBlock);
  const open = new Map<Hex, Open>();
  let ticks = 0;
  let dropped = 0;

  // Past the limit, the Deposit due last is dropped. Anyone can still refund it after its Timeout.
  function follow(key: Hex, serial: bigint, deadline: bigint): void {
    open.delete(key);
    if (open.size >= maxOpen) {
      const last = dueLast();
      dropped += 1;
      if (open.get(last)!.deadline <= deadline) return;
      open.delete(last);
    }
    open.set(key, { serial, deadline, wait: 1, retryTick: 0 });
  }

  function dueLast(): Hex {
    let last: [Hex, Open] | undefined;
    for (const entry of open) if (!last || entry[1].deadline > last[1].deadline) last = entry;
    return last![0];
  }

  return {
    get position() {
      return blocks.position;
    },

    async tick() {
      ticks += 1;
      await blocks.scan(await escrow.latestBlock(), async (from, to) => {
        for (const change of await escrow.depositChanges(from, to)) {
          if (change.type === "deposited") follow(change.key, change.serial, change.deadline);
          else if (open.get(change.key)?.serial === change.serial) open.delete(change.key);
        }
      });
      if (dropped > 0) {
        console.log(
          `The Keeper follows at most ${count(maxOpen, "open Deposit")} to their Timeout, the ones due first. It dropped ${dropped} due later: anyone can refund those after their Timeout.`,
        );
        dropped = 0;
      }

      const now = await escrow.now();
      const failures: unknown[] = [];
      for (const [key, deposit] of [...open]) {
        if (deposit.deadline > now || deposit.retryTick > ticks) continue;
        try {
          // Refunds only this serial, and only if it is still active when the transaction is sent.
          await escrow.refund(key, deposit.serial);
          open.delete(key);
        } catch (error) {
          failures.push(error);
          deposit.retryTick = ticks + deposit.wait;
          deposit.wait = Math.min(deposit.wait * 2, MAX_WAIT_TICKS);
        }
      }
      if (failures.length > 0) {
        throw new AggregateError(
          failures,
          `${failures.length} Deposit(s) past their Timeout not refunded yet; later ticks try again.`,
        );
      }
    },
  };
}

function count(n: number, noun: string): string {
  return `${n.toLocaleString("en-US")} ${noun}${n === 1 ? "" : "s"}`;
}
