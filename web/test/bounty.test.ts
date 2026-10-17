import type { Address, Hex } from "viem";
import { expect, test } from "vitest";
import {
  bountiesFrom,
  hasBounties,
  isRefusedPayee,
  keeperLimitFor,
  type BountyEvent,
  type BountyWalletState,
} from "../src/bounty.ts";
import { mainnet, testnet } from "../networks.ts";

// How the pages rebuild a Bounty wallet's Bounties from its events, and read its limits.

const tx = (n: number) => `0x${n.toString(16).padStart(64, "0")}` as Hex;
const PAYEE = "0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed" as Address;

const posted = (issue: number, serial: number, amount: bigint, n: number): BountyEvent => ({
  eventName: "BountyPosted",
  args: { issueNumber: BigInt(issue), serial: BigInt(serial), amount },
  transactionHash: tx(n),
});
const cancelled = (issue: number, serial: number, amount: bigint, n: number): BountyEvent => ({
  eventName: "BountyCancelled",
  args: { issueNumber: BigInt(issue), serial: BigInt(serial), amount },
  transactionHash: tx(n),
});
const paid = (issue: number, serial: number, amount: bigint, method: number, n: number): BountyEvent => ({
  eventName: "Paid",
  args: { issueNumber: BigInt(issue), serial: BigInt(serial), payee: PAYEE, amount, method },
  transactionHash: tx(n),
});

test("each Bounty is rebuilt from its events, newest first: open, paid with its payee and method, or cancelled", () => {
  const rows = bountiesFrom([
    posted(12, 1, 25_000_000n, 1),
    posted(7, 2, 5_000_000n, 2),
    paid(7, 2, 5_000_000n, 0, 3),
    cancelled(12, 1, 25_000_000n, 4),
    posted(12, 3, 30_000_000n, 5),
    posted(9, 4, 80_000_000n, 6),
    paid(9, 4, 80_000_000n, 1, 7),
    { eventName: "Funded", args: { from: PAYEE, amount: 1n }, transactionHash: tx(8) },
  ]);

  expect(rows).toEqual([
    {
      issue: 9,
      serial: 4n,
      amount: 80_000_000n,
      status: "paid",
      postedTx: tx(6),
      payee: PAYEE,
      method: "signature",
      closedTx: tx(7),
    },
    { issue: 12, serial: 3n, amount: 30_000_000n, status: "open", postedTx: tx(5) },
    {
      issue: 7,
      serial: 2n,
      amount: 5_000_000n,
      status: "paid",
      postedTx: tx(2),
      payee: PAYEE,
      method: "keeper",
      closedTx: tx(3),
    },
    { issue: 12, serial: 1n, amount: 25_000_000n, status: "cancelled", postedTx: tx(1), closedTx: tx(4) },
  ]);
});

test("a Payout or cancellation of a Bounty the logs never posted is ignored, not invented", () => {
  expect(bountiesFrom([paid(3, 9, 1n, 2, 1), cancelled(4, 10, 1n, 2)])).toEqual([]);
});

const wallet: BountyWalletState = {
  address: "0x0000000000000000000000000000000000000B01",
  owner: "0x0000000000000000000000000000000000000A01",
  keeper: "0x0000000000000000000000000000000000000C01",
  balance: 100_000_000n,
  reserved: 40_000_000n,
  available: 60_000_000n,
  perPayoutLimit: 50_000_000n,
  periodLimit: 200_000_000n,
  periodLength: 7 * 86_400,
  keeperEnabled: true,
  keeperAllowance: 30_000_000n,
};

test("the Keeper may pay a Bounty within both limits while it's on, and the page says which limit stops it", () => {
  expect(keeperLimitFor(30_000_000n, wallet)).toBeNull();
  expect(keeperLimitFor(30_000_001n, wallet)).toBe("period");
  expect(keeperLimitFor(50_000_001n, wallet)).toBe("per-payout");
  expect(keeperLimitFor(1n, { ...wallet, keeperEnabled: false })).toBe("off");
});

test("a payee the wallet would refuse is caught before anyone signs", () => {
  expect(isRefusedPayee(PAYEE, wallet)).toBe(false);
  expect(isRefusedPayee(wallet.keeper, wallet)).toBe(true);
  expect(isRefusedPayee(wallet.address.toLowerCase() as Address, wallet)).toBe(true);
  expect(isRefusedPayee("0x0000000000000000000000000000000000000000", wallet)).toBe(true);
});

test("a network without a factory has no Bounties yet", () => {
  expect(hasBounties(testnet)).toBe(false);
  expect(hasBounties(mainnet)).toBe(true);
  expect(hasBounties({ ...testnet, bountyFactory: PAYEE })).toBe(true);
});
