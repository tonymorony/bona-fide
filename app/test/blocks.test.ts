import { expect, test } from "vitest";
import { createBlockScanner } from "../src/blocks.ts";

/** Scans until `latest` is read or `scans` runs out, keeping the ranges read and those that failed. */
async function scanned(failing: (from: bigint, to: bigint) => boolean, latest: bigint, scans = 30) {
  const scanner = createBlockScanner(0n);
  const read: [bigint, bigint][] = [];
  const failed: [bigint, bigint][] = [];
  for (let i = 0; i < scans && (scanner.position ?? 0n) <= latest; i++) {
    await scanner
      .scan(latest, async (from, to) => {
        if (failing(from, to)) {
          failed.push([from, to]);
          throw new Error("too many logs");
        }
        read.push([from, to]);
      })
      .catch(() => {});
  }
  return { scanner, read, failed };
}

test("reads 10,000 blocks a range, resuming where it stopped", async () => {
  const { read, scanner } = await scanned(() => false, 25_000n);

  expect(read).toEqual([
    [0n, 9_999n],
    [10_000n, 19_999n],
    [20_000n, 25_000n],
  ]);
  expect(scanner.position).toBe(25_001n);
});

// A range an RPC never answers, such as one with too many logs in it, held up every later block.
test("a range that keeps failing is read again in halves, so only the blocks that must wait do", async () => {
  // Any range over 2,000 blocks that holds block 15,000 fails.
  const { read, failed, scanner } = await scanned(
    (from, to) => from <= 15_000n && to >= 15_000n && to - from >= 2_000n,
    40_000n,
  );

  expect(failed[0]).toEqual([10_000n, 19_999n]);
  expect(read.some(([from, to]) => from <= 15_000n && to >= 15_000n)).toBe(true);
  expect(scanner.position).toBe(40_001n);
  // Once past it, ranges grow back to 10,000 blocks.
  expect(read.some(([from, to]) => from > 15_000n && to - from + 1n === 10_000n)).toBe(true);
});

test("a single block that keeps failing holds the scan there, and is never skipped", async () => {
  const { failed, scanner } = await scanned((from, to) => from <= 7n && to >= 7n, 100n);

  expect(scanner.position).toBe(7n);
  expect(failed.at(-1)).toEqual([7n, 7n]);
});
