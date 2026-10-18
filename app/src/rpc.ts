// Paces the App's RPC requests, so a burst never runs into the RPC's rate limit. Without it, the
// Keeper's read of the escrow's history after a restart uses up the limit, and every request
// that arrives in the meantime fails: webhooks, the watcher, the Keeper's own ticks.

import type { Transport } from "viem";

/**
 * Requests a second that Arc's public RPC takes without refusing any, with a log query counted as
 * three. Measured: it counts over about a minute, takes one log query a second or three of the other
 * requests, and once over, refuses everything for several seconds.
 */
export const DEFAULT_RPC_RPS = 3;

/** What a log query costs, in requests. */
const LOG_QUERY_COST = 3;

/** At most this long of unused allowance is kept for a burst, in milliseconds. */
const BURST_MS = 1000;

/** Most requests served ahead of a waiting background caller, so the pollers keep a share under any load. */
const FOREGROUND_RUN = 3;

export interface RateLimiter {
  /**
   * Resolves when a request of that cost may be sent. Callers are served in the order they asked,
   * except that a background caller waits behind the others: nobody is waiting for its answer. But
   * it waits behind no more than FOREGROUND_RUN in a row, since the pollers it stands for, such as
   * the Timeout refunds, must keep up however many requests arrive.
   */
  take(cost?: number, background?: boolean): Promise<void>;
}

export interface RateLimiterOptions {
  /** The requests allowed each second. */
  perSecond: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

export function createRateLimiter({
  perSecond,
  now = Date.now,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
}: RateLimiterOptions): RateLimiter {
  if (!(perSecond > 0)) throw new Error(`A rate limit must be above 0 requests a second, not ${perSecond}.`);
  const waiting: { cost: number; background: boolean; go: () => void }[] = [];
  // When the next request may go. Earlier than now after a quiet spell: that is the burst allowance.
  let next = -Infinity;
  let asleep = false;
  /** Callers served ahead of a waiting background one since a background one was last served. */
  let run = 0;

  function serve(): void {
    while (waiting.length > 0 && !asleep) {
      const time = now();
      const start = Math.max(next, time - BURST_MS);
      if (start > time) {
        asleep = true;
        void sleep(start - time).then(() => {
          asleep = false;
          serve();
        });
        return;
      }
      const turn =
        run < FOREGROUND_RUN ? waiting.findIndex((c) => !c.background) : waiting.findIndex((c) => c.background);
      const [caller] = waiting.splice(turn === -1 ? 0 : turn, 1);
      run = caller!.background ? 0 : waiting.some((other) => other.background) ? run + 1 : 0;
      next = start + (caller!.cost * 1000) / perSecond;
      caller!.go();
    }
  }

  return {
    take(cost = 1, background = false) {
      return new Promise((go) => {
        waiting.push({ cost, background, go });
        serve();
      });
    },
  };
}

export interface RateLimitedOptions {
  /** Whether the request being sent is a background one, such as a poller's. Default: never. */
  background?: () => boolean;
}

/** The transport, with every request waiting its turn at the limiter. */
export function rateLimited(
  transport: Transport,
  limiter: RateLimiter,
  { background = () => false }: RateLimitedOptions = {},
): Transport {
  return (config) => {
    const inner = transport(config);
    return {
      ...inner,
      request: (async (args: { method: string }, options?: unknown) => {
        await limiter.take(args.method === "eth_getLogs" ? LOG_QUERY_COST : 1, background());
        return (inner.request as (args: unknown, options?: unknown) => Promise<unknown>)(args, options);
      }) as typeof inner.request,
    };
  };
}
