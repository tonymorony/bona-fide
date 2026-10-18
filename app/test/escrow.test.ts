import { DEPOSIT_STATUSES } from "@bona-fide/sdk";
import type { PublicClient } from "viem";
import { expect, test } from "vitest";
import { createEscrowChain } from "../src/escrow.ts";

const KEY = `0x${"ab".repeat(32)}` as const;
const ESCROW = "0x0000000000000000000000000000000000000e5c";
const TX = `0x${"cd".repeat(32)}` as const;

/** A chain of 1,000 blocks, two seconds apart, with one Deposit on KEY made in block 600. */
function fakeClient() {
  const reads = { getBlock: 0, getBlockNumber: 0 };
  const client = {
    getBlockNumber: async () => {
      reads.getBlockNumber += 1;
      return 1_000n;
    },
    getBlock: async ({ blockNumber }: { blockNumber: bigint }) => {
      reads.getBlock += 1;
      return { timestamp: blockNumber * 2n };
    },
    readContract: async ({ blockNumber }: { blockNumber?: bigint }) => ({
      status: DEPOSIT_STATUSES.indexOf("active"),
      depositor: "0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed",
      amount: 1_000_000n,
      serial: blockNumber === undefined || blockNumber >= 600n ? 1n : 0n,
    }),
    getLogs: async () => [{ args: { serial: 1n }, transactionHash: TX }],
  };
  return { client: client as unknown as PublicClient, reads };
}

// Every check of an item asks whether a Deposit was made since the item was opened, and each one
// searched the chain's block times again.
test("the block before an item's creation is searched for once, however often the item is checked", async () => {
  const { client, reads } = fakeClient();
  const chain = createEscrowChain({ client, escrow: ESCROW });
  const since = new Date(1_000_000);

  const first = await chain.depositSince(KEY, since);
  const searched = { ...reads };
  const again = await chain.depositSince(KEY, since);

  expect(first).toMatchObject({ serial: 1n, txHash: TX });
  expect(again).toEqual(first);
  expect(searched.getBlock).toBeGreaterThan(0);
  expect(reads).toEqual(searched);
});

test("a time after the latest block isn't remembered, since a later block may come before it", async () => {
  const { client, reads } = fakeClient();
  const chain = createEscrowChain({ client, escrow: ESCROW });
  const since = new Date(5_000_000);

  expect(await chain.depositSince(KEY, since)).toBeNull();
  const searched = reads.getBlockNumber;
  await chain.depositSince(KEY, since);

  expect(reads.getBlockNumber).toBeGreaterThan(searched);
});
