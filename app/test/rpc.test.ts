import { createPublicClient, custom } from "viem";
import { expect, test } from "vitest";
import { createRateLimiter, rateLimited } from "../src/rpc.ts";

/** A clock that only moves when the limiter sleeps, so a test reads the waits as times. */
function fakeClock() {
  let time = 0;
  return {
    now: () => time,
    sleep: async (ms: number) => {
      time += ms;
    },
    advance(ms: number) {
      time += ms;
    },
  };
}

test("spaces requests at the rate, after the burst a quiet second allows", async () => {
  const clock = fakeClock();
  clock.advance(5000);
  const limiter = createRateLimiter({ perSecond: 4, ...clock });
  const sent: number[] = [];

  for (let i = 0; i < 8; i++) {
    await limiter.take();
    sent.push(clock.now() - 5000);
  }

  // The saved second pays for four, the fifth is due now, then one goes every 250 ms.
  expect(sent).toEqual([0, 0, 0, 0, 0, 250, 500, 750]);
});

test("a costlier request holds the next one back for longer", async () => {
  const clock = fakeClock();
  const limiter = createRateLimiter({ perSecond: 4, ...clock });
  for (let i = 0; i < 4; i++) await limiter.take();
  const start = clock.now();

  await limiter.take(2);
  const afterCostly = clock.now() - start;
  await limiter.take();

  expect(afterCostly).toBe(0);
  expect(clock.now() - start).toBe(500);
});

test("saves no more than a second of unused allowance", async () => {
  const clock = fakeClock();
  const limiter = createRateLimiter({ perSecond: 2, ...clock });
  clock.advance(60_000);
  const start = clock.now();

  for (let i = 0; i < 4; i++) await limiter.take();

  // The saved second pays for two, the third is due now, and the fourth half a second on.
  expect(clock.now() - start).toBe(500);
});

test("serves callers in the order they asked", async () => {
  const clock = fakeClock();
  const limiter = createRateLimiter({ perSecond: 1, ...clock });
  const order: string[] = [];

  await Promise.all(["a", "b", "c", "d"].map((name) => limiter.take().then(() => order.push(name))));

  expect(order).toEqual(["a", "b", "c", "d"]);
});

test("a background caller waits behind the others, however early it asked", async () => {
  const clock = fakeClock();
  const limiter = createRateLimiter({ perSecond: 1, ...clock });
  await limiter.take();
  await limiter.take();
  const order: string[] = [];

  await Promise.all([
    limiter.take(1, true).then(() => order.push("poll 1")),
    limiter.take(1, true).then(() => order.push("poll 2")),
    limiter.take().then(() => order.push("webhook 1")),
    limiter.take().then(() => order.push("webhook 2")),
  ]);

  expect(order).toEqual(["webhook 1", "webhook 2", "poll 1", "poll 2"]);
});

test("refuses a rate of zero", () => {
  expect(() => createRateLimiter({ perSecond: 0 })).toThrow("above 0");
});

test("a rate-limited transport sends every request, counts a log query as three, and marks a poller's as background", async () => {
  const clock = fakeClock();
  const costs: number[] = [];
  const asked: boolean[] = [];
  const limiter = createRateLimiter({ perSecond: 4, ...clock });
  const counting = {
    take: async (cost?: number, background?: boolean) => {
      costs.push(cost ?? 1);
      asked.push(background ?? false);
      await limiter.take(cost, background);
    },
  };
  let polling = false;
  const methods: string[] = [];
  const transport = custom({
    request: async ({ method }: { method: string }) => {
      methods.push(method);
      return method === "eth_blockNumber" ? "0x10" : [];
    },
  });
  const client = createPublicClient({ transport: rateLimited(transport, counting, { background: () => polling }) });

  expect(await client.getBlockNumber()).toBe(16n);
  polling = true;
  expect(await client.getLogs({ fromBlock: 1n, toBlock: 2n })).toEqual([]);

  expect(methods).toEqual(["eth_blockNumber", "eth_getLogs"]);
  expect(costs).toEqual([1, 3]);
  expect(asked).toEqual([false, true]);
});
