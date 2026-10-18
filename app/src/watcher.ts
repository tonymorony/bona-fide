import type { Hex } from "viem";
import type { App } from "./app.ts";
import { createBlockScanner } from "./blocks.ts";
import { fullName, type Chain, type DepositedEvent, type GitHub } from "./ports.ts";

/** Tries per Deposit or item. Waits double between tries: 1, 2, 4 … 256 ticks, about 8.5 minutes at one tick a second. */
const MAX_ATTEMPTS = 10;
/** Most open PRs and issues checked again when a repo's Binding takes effect: the most recently updated. */
const RECHECK_LIMIT = 20;
/** Most Deposits kept waiting for their PR or issue to open. Past it, the one waiting longest is dropped. */
const MAX_WAITING = 100;
/** Longest gap between looks at a Deposit waiting for its item: about 17 minutes at one tick a second. */
const MAX_WAIT_TICKS = 1024;

export interface WatcherDeps {
  chain: Chain;
  github: GitHub;
  app: App;
  /** First block to read, such as a saved `position`. Defaults to the latest block at the first tick. */
  fromBlock?: bigint;
}

export interface DepositWatcher {
  /**
   * Settles the item each new Deposit names, looking again on later ticks for an item that doesn't
   * exist yet; checks a repo's open items again when its Binding takes effect; and retries what
   * failed before. Rejects if anything failed this time; that is retried on later ticks. The host
   * calls it on a timer.
   */
  tick(): Promise<void>;
  /** The next block to read. Save it and pass it back as `fromBlock` to resume after a restart. */
  readonly position: bigint | undefined;
}

/** Something to settle; failures of the items it goes on to settle are collected in `failures`. */
type Work = (failures: unknown[]) => Promise<void>;

interface Retry {
  work: Work;
  attempts: number;
  dueTick: number;
}

/** A Deposit whose PR or issue didn't exist yet when the watcher last looked. */
interface Waiting {
  event: DepositedEvent;
  /** Ticks between the last look and the next. */
  wait: number;
  dueTick: number;
}

export function createDepositWatcher({ chain, github, app, fromBlock }: WatcherDeps): DepositWatcher {
  const blocks = createBlockScanner(fromBlock);
  let ticks = 0;
  let retries: Retry[] = [];
  const waiting = new Map<Hex, Waiting>();

  // Anyone can deposit for an item before it opens. The item's own events settle it too, but a
  // missed delivery mustn't leave the Deposit unrefunded, so the watcher keeps looking.
  async function notice(event: DepositedEvent, wait = 1): Promise<void> {
    const repo = await github.findRepo(event.repoId);
    if (!repo) return;
    const item = await github.getItem(repo, event.kind, event.number);
    if (!item) return keepWaiting(event, wait);
    await app.settle(item, event);
    waiting.delete(event.key);
  }

  function keepWaiting(event: DepositedEvent, wait: number): void {
    const known = waiting.get(event.key);
    if (known?.event.serial === event.serial) return void Object.assign(known, { wait, dueTick: ticks + wait });
    waiting.delete(event.key);
    if (waiting.size >= MAX_WAITING) waiting.delete(waiting.keys().next().value!);
    waiting.set(event.key, { event, wait, dueTick: ticks + wait });
  }

  // Each look doubles the wait, and one whose Deposit was refunded or forfeited meanwhile is the last.
  async function lookAgain({ event, wait }: Waiting): Promise<void> {
    const next = Math.min(wait * 2, MAX_WAIT_TICKS);
    try {
      if (await chain.depositSince(event.key, new Date(0), event)) await notice(event, next);
      else waiting.delete(event.key);
    } catch (error) {
      keepWaiting(event, next);
      throw error;
    }
  }

  // Before its Binding took effect, a repo's items got a neutral check or nothing; now they may
  // need a Deposit. A repo may have thousands open, so only the most recently updated are checked.
  async function recheckOpenItems(repoId: Hex, failures: unknown[]): Promise<void> {
    const repo = await github.findRepo(repoId);
    if (!repo) return;
    const { items, more } = await github.openItems(repo, RECHECK_LIMIT);
    if (more) {
      console.log(
        `Binding active in ${fullName(repo)}: checked its ${RECHECK_LIMIT} most recently updated open PRs and issues again. More are open; each is checked on its next event.`,
      );
    }
    for (const { kind, number } of items) await attempt(() => app.recheck(repo, kind, number), 0, failures);
  }

  // One failing Deposit or item, such as one in an archived repo, must not hold up the others.
  async function attempt(work: Work, attempts: number, failures: unknown[]): Promise<void> {
    try {
      await work(failures);
    } catch (error) {
      failures.push(error);
      if (attempts + 1 < MAX_ATTEMPTS) retries.push({ work, attempts: attempts + 1, dueTick: ticks + 2 ** attempts });
    }
  }

  return {
    get position() {
      return blocks.position;
    },

    async tick() {
      ticks += 1;
      const failures: unknown[] = [];
      const due = retries.filter((retry) => retry.dueTick <= ticks);
      retries = retries.filter((retry) => retry.dueTick > ticks);
      for (const retry of due) await attempt(retry.work, retry.attempts, failures);
      for (const entry of [...waiting.values()]) {
        if (entry.dueTick <= ticks) await lookAgain(entry).catch((error: unknown) => failures.push(error));
      }

      await blocks.scan(await chain.latestBlock(), async (from, to) => {
        for (const event of await chain.escrowEvents(from, to)) {
          if (event.type === "deposited") await attempt(() => notice(event.deposit), 0, failures);
          else if (event.type === "activated") {
            await attempt((failed) => recheckOpenItems(event.repoId, failed), 0, failures);
          }
        }
      });
      if (failures.length > 0) {
        throw new AggregateError(
          failures,
          `${failures.length} Deposit(s) or item(s) not settled yet; later ticks retry them.`,
        );
      }
    },
  };
}

/** Ticks the watcher every `intervalMs` until the returned function is called. */
export function pollDeposits(
  watcher: DepositWatcher,
  intervalMs: number,
  onError: (error: unknown) => void,
): () => void {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const loop = async () => {
    try {
      await watcher.tick();
    } catch (error) {
      onError(error);
    }
    if (!stopped) timer = setTimeout(() => void loop(), intervalMs);
  };
  void loop();
  return () => {
    stopped = true;
    clearTimeout(timer);
  };
}
