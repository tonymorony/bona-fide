import { payeeDeclaredIn } from "@bona-fide/sdk";
import { getAddress, type Address } from "viem";
import { afterAll, beforeAll, expect, test } from "vitest";
import { startChain, type Chain } from "./support/chain.ts";
import { connect, textOf } from "./support/mcp.ts";

// get_bounty against the real Bounty wallet factory and wallets on anvil. The repo's Bounty wallet is
// its Binding Maintainer's, with a per-payout limit of 5 USDC and 8 USDC a period for the Keeper.

const REPO = "octo/bounties";
const PAYEE = "0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed" as Address;
const LIMITS = { perPayout: 5_000_000n, period: 8_000_000n };

let chain: Chain;
let wallet: Address;

beforeAll(async () => {
  chain = await startChain();
  await chain.bind(REPO, 1_000_000n, chain.maintainer);
  wallet = await chain.postBounties(chain.maintainer, REPO, LIMITS, [
    [1, 4_000_000n],
    [2, 6_000_000n],
    [3, 5_000_000n],
    [4, 3_000_000n],
  ]);
  // Issue 1 is paid, which leaves the Keeper 4 USDC this period: less than issue 3's 5 USDC.
  await chain.keeperPay(wallet, 1, PAYEE);
}, 120_000);

afterAll(() => chain?.stop());

function server(explorerUrl?: string) {
  return connect({
    client: chain.client,
    escrow: chain.escrow,
    maxDeposit: 5_000_000n,
    bountyFactory: chain.bountyFactory,
    explorerUrl,
  });
}

async function getBounty(args: { repo?: string; issue: number; payee?: string }, explorerUrl?: string) {
  const mcp = await server(explorerUrl);
  const result = await mcp.call("get_bounty", { repo: REPO, ...args });
  await mcp.close();
  return result;
}

test("an open Bounty within the Keeper's limits: the wallet lets the Keeper pay it", async () => {
  const result = await getBounty({ issue: 4 }, "https://explorer.test");

  expect(result.isError).toBeFalsy();
  expect(result.structuredContent).toMatchObject({
    maintainer: chain.maintainer,
    factory: chain.bountyFactory,
    wallet: {
      address: wallet,
      keeperEnabled: true,
      perPayoutLimit: "5000000",
      perPayoutLimitUsdc: "5",
      keeperAllowance: "4000000",
      keeperAllowanceUsdc: "4",
    },
    bounty: {
      status: "open",
      amount: "3000000",
      amountUsdc: "3",
      serial: "4",
      payee: null,
      keeperMayPay: true,
      keeperLimit: null,
    },
    payee: null,
    explorerUrl: `https://explorer.test/address/${wallet}`,
  });
  expect(textOf(result)).toContain("Issue #4 in octo/bounties has an open Bounty of 3 USDC");
  expect(textOf(result)).toContain("The wallet lets the Keeper pay it");
  expect(textOf(result)).toContain("write a line of its own, `Bounty wallet: 0x…`");
  expect(textOf(result)).toContain("The latest line wins");
});

test("an open Bounty above the per-payout limit is left to the Maintainer", async () => {
  const result = await getBounty({ issue: 2 });

  expect(result.structuredContent).toMatchObject({
    bounty: { status: "open", amountUsdc: "6", keeperMayPay: false, keeperLimit: "per-payout" },
  });
  expect(textOf(result)).toContain(
    "6 USDC is above the wallet's per-payout limit of 5 USDC, so only the Maintainer can pay it",
  );
});

test("an open Bounty above what the Keeper has left this period is left to the Maintainer", async () => {
  const result = await getBounty({ issue: 3 });

  expect(result.structuredContent).toMatchObject({
    bounty: { status: "open", amountUsdc: "5", keeperMayPay: false, keeperLimit: "period" },
  });
  expect(textOf(result)).toContain("The Keeper has only 4 USDC left to pay in this period");
});

test("a paid Bounty shows its Payee", async () => {
  const result = await getBounty({ issue: 1 });

  expect(result.structuredContent).toMatchObject({
    bounty: { status: "paid", amountUsdc: "4", payee: PAYEE, keeperMayPay: false, keeperLimit: null },
  });
  expect(textOf(result)).toContain(`The Bounty on issue #1 in octo/bounties was paid: 4 USDC to ${PAYEE}.`);
});

test("an issue without a Bounty in the repo's wallet", async () => {
  const result = await getBounty({ issue: 9 });

  expect(result.structuredContent).toMatchObject({ bounty: { status: "none", amount: "0" } });
  expect(textOf(result)).toContain(`Issue #9 in octo/bounties has no Bounty in the repo's Bounty wallet, ${wallet}.`);
});

test("payee gives the exact line that names it, checksummed, and the App reads it back as that wallet", async () => {
  const result = await getBounty({ issue: 4, payee: PAYEE.toLowerCase() });

  const { payee } = result.structuredContent as { payee: { address: Address; line: string; problem: null } };
  expect(payee).toEqual({ address: PAYEE, line: `Bounty wallet: ${PAYEE}`, problem: null });
  expect(payeeDeclaredIn(`Fixes #4.\n\n${payee.line}`)).toEqual({ address: PAYEE });
  expect(textOf(result)).toContain(`Your line: Bounty wallet: ${PAYEE}`);
});

test("a payee the Bounty wallet would refuse is caught", async () => {
  const result = await getBounty({ issue: 4, payee: chain.keeper });

  expect(result.structuredContent).toMatchObject({ payee: { problem: "it is the Keeper's address" } });
  expect(textOf(result)).toContain(
    `The Bounty wallet can't pay ${getAddress(chain.keeper)}: it is the Keeper's address.`,
  );
});

test("a repo without a Binding has no Bounty wallet, but the payee line is still given", async () => {
  const result = await getBounty({ repo: "octo/unbound", issue: 1, payee: PAYEE });

  expect(result.structuredContent).toMatchObject({
    maintainer: null,
    wallet: null,
    bounty: null,
    payee: { line: `Bounty wallet: ${PAYEE}` },
  });
  expect(textOf(result)).toContain("Bona Fide isn't active for octo/unbound");
});

test("only the Binding Maintainer's wallet is the repo's: one anyone else made for it is ignored", async () => {
  const repo = "octo/no-wallet";
  await chain.bind(repo);
  await chain.postBounties(chain.stranger, repo, LIMITS, [[1, 2_000_000n]]);

  const result = await getBounty({ repo, issue: 1 });

  expect(result.structuredContent).toMatchObject({ maintainer: chain.keeper, wallet: null, bounty: null });
  expect(textOf(result)).toContain("octo/no-wallet's Maintainer hasn't created a Bounty wallet");
});

test("without a known Bounty wallet factory, get_bounty says how to name one", async () => {
  const mcp = await connect({ client: chain.client, escrow: chain.escrow, maxDeposit: 5_000_000n });

  const result = await mcp.call("get_bounty", { repo: REPO, issue: 4 });

  expect(result.isError).toBe(true);
  expect(textOf(result)).toContain("Set BOUNTY_FACTORY_ADDRESS");
  await mcp.close();
});
