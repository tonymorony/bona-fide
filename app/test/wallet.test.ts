import type { Address, PublicClient } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { expect, test } from "vitest";
import { createBountyWallets, WALLETS_PER_QUERY } from "../src/bounties/wallet.ts";

const FACTORY = "0x00000000000000000000000000000000000fac70";

// Anyone can create Bounty wallets through the factory, and an RPC refuses a log filter with too
// many addresses, which stopped the Bounty notices for good.
test("wallet events are read with at most WALLETS_PER_QUERY addresses a query", async () => {
  const filters: Address[][] = [];
  const client = {
    getLogs: async ({ address }: { address: Address[] }) => {
      filters.push(address);
      return [];
    },
  } as unknown as PublicClient;
  const wallets = createBountyWallets({
    client,
    account: privateKeyToAccount(`0x${"11".repeat(32)}`),
    factory: FACTORY,
  });
  const known = Array.from({ length: 250 }, (_, i) => `0x${(i + 1).toString(16).padStart(40, "0")}` as Address);

  await wallets.walletEvents(known, 1n, 10n);

  expect(filters.map((filter) => filter.length)).toEqual([WALLETS_PER_QUERY, WALLETS_PER_QUERY, 51]);
  expect(filters[0]![0]).toBe(FACTORY);
  expect(filters.flat()).toHaveLength(251);
});
