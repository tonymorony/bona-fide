export interface RateLimit {
  /** Most requests per window. */
  max: number;
  windowMs: number;
}

/** Past this many keys, windows that have ended are dropped, so memory stays bounded. */
const PRUNE_AT = 10_000;

/**
 * Counts requests per key in fixed windows. The returned function counts one request and returns
 * how many seconds the caller must wait, or 0 if the request may go ahead.
 */
export function fixedWindow({ max, windowMs }: RateLimit, now: () => number): (key: string) => number {
  const windows = new Map<string, { start: number; count: number }>();
  return (key) => {
    const time = now();
    let window = windows.get(key);
    if (!window || time - window.start >= windowMs) {
      if (windows.size >= PRUNE_AT) {
        for (const [k, w] of windows) if (time - w.start >= windowMs) windows.delete(k);
      }
      window = { start: time, count: 0 };
      windows.set(key, window);
    }
    window.count += 1;
    return window.count > max ? Math.max(1, Math.ceil((window.start + windowMs - time) / 1000)) : 0;
  };
}

/**
 * How long a relay sends nothing for a Deposit key or a signer's wallet after one of its
 * transactions passed simulation but reverted on-chain. A smart-contract wallet can answer
 * ERC-1271 differently in the transaction than in the simulation, and each such revert costs gas.
 */
export const REVERT_COOLDOWN_MS = 10 * 60_000;

export interface Cooldown {
  /** Starts the cooldown for `key`. */
  hold(key: string): void;
  /** How many seconds are left of `key`'s cooldown, or 0 if it has none. */
  wait(key: string): number;
}

export function cooldown(ms: number, now: () => number): Cooldown {
  const ends = new Map<string, number>();
  return {
    hold(key) {
      const time = now();
      if (ends.size >= PRUNE_AT) {
        for (const [k, end] of ends) if (end <= time) ends.delete(k);
      }
      ends.set(key, time + ms);
    },
    wait(key) {
      const left = (ends.get(key) ?? 0) - now();
      return left > 0 ? Math.ceil(left / 1000) : 0;
    },
  };
}
