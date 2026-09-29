import type { Hex } from "viem";
import { createBlockScanner } from "../blocks.ts";
import { EscrowRejection, type KeeperEscrow } from "./escrow.ts";

export interface BindingActivatorDeps {
  escrow: KeeperEscrow;
  /** First block to read, such as the escrow's deploy block, so no earlier proposal is missed. */
  fromBlock?: bigint;
}

export interface BindingActivator {
  /** Activates every proposed Binding whose delay has passed. The host calls it on a timer. */
  tick(): Promise<void>;
  /** The next block to read. */
  readonly position: bigint | undefined;
}

// Anyone may activate a Binding once its delay has passed; the Keeper does, so repos go live on time.
export function createBindingActivator({ escrow, fromBlock }: BindingActivatorDeps): BindingActivator {
  const blocks = createBlockScanner(fromBlock);
  const waiting = new Map<Hex, bigint>();

  async function activate(repoId: Hex, now: bigint): Promise<void> {
    const pending = await escrow.pendingBinding(repoId);
    if (!pending) return void waiting.delete(repoId);
    if (pending.effectiveAt > now) return void waiting.set(repoId, pending.effectiveAt);
    try {
      await escrow.activateRepo(repoId);
    } catch (error) {
      if (!(error instanceof EscrowRejection && error.reason === "NoPendingConfig")) throw error;
    }
    waiting.delete(repoId);
  }

  return {
    get position() {
      return blocks.position;
    },

    async tick() {
      await blocks.scan(await escrow.latestBlock(), async (from, to) => {
        for (const { repoId, effectiveAt } of await escrow.proposals(from, to)) waiting.set(repoId, effectiveAt);
      });
      const now = await escrow.now();
      const failures: unknown[] = [];
      for (const [repoId, effectiveAt] of waiting) {
        if (effectiveAt > now) continue;
        await activate(repoId, now).catch((error: unknown) => failures.push(error));
      }
      if (failures.length > 0) {
        throw new AggregateError(failures, `${failures.length} Binding(s) not activated yet; later ticks retry them.`);
      }
    },
  };
}
