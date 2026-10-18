import { escrowAbi } from "@bona-fide/sdk";
import { parseEventLogs, type Address, type Hex } from "viem";
import { afterAll, beforeAll, expect, test } from "vitest";
import { startChain, type Chain } from "./support/chain.ts";
import { connect, textOf } from "./support/mcp.ts";

// After a Deposit: its status from the escrow, and the Refund anyone may send once its Timeout has
// passed. Some tests move the chain's time, so each makes its own Deposit.

const REPO = "octo/refunds";
const TIMEOUT = 7 * 86_400;
const EXPLORER = "https://explorer.test/";

let chain: Chain;

beforeAll(async () => {
  chain = await startChain();
  await chain.bind(REPO);
}, 120_000);

afterAll(() => chain?.stop());

function server(explorerUrl?: string) {
  return connect({ client: chain.client, escrow: chain.escrow, maxDeposit: 5_000_000n, explorerUrl });
}

/** A fresh Contributor's Deposit on the issue, and its key. */
async function deposited(number: number) {
  const { account } = await chain.contributor();
  await chain.deposit(account, REPO, "issue", number);
  return { depositor: account.address, key: await chain.keyOf(REPO, "issue", number) };
}

interface RefundPlan {
  from: Address;
  depositor: Address;
  step: { description: string; to: Address; data: Hex; circleCommand: string | null };
}

test("get_deposit_status says when an item has no Deposit", async () => {
  const mcp = await server();

  const result = await mcp.call("get_deposit_status", { repo: REPO, kind: "pr", number: 1 });

  expect(result.isError).toBeFalsy();
  expect(result.structuredContent).toMatchObject({
    key: await chain.keyOf(REPO, "pr", 1),
    escrow: chain.escrow,
    status: "none",
    deposit: null,
    explorerUrl: null,
  });
  expect(textOf(result)).toContain("PR #1 in octo/refunds has no Deposit.");
  await mcp.close();
});

test("get_deposit_status shows an active Deposit, its Serial and how long until anyone can Refund it", async () => {
  const { depositor } = await deposited(2);
  const mcp = await server(EXPLORER);

  const result = await mcp.call("get_deposit_status", { repo: REPO, kind: "issue", number: 2 });

  const { deposit, checkedAt } = result.structuredContent as {
    deposit: { deadline: string; serial: string; secondsLeft: number };
    checkedAt: string;
  };
  expect(result.structuredContent).toMatchObject({
    status: "active",
    deposit: {
      depositor,
      amount: "1000000",
      amountUsdc: "1",
      timeoutPassed: false,
      forfeitPercent: 50,
      outcome: null,
    },
    explorerUrl: `https://explorer.test/address/${depositor}`,
  });
  expect(BigInt(deposit.serial)).toBeGreaterThan(0n);
  expect(Date.parse(deposit.deadline) - Date.parse(checkedAt)).toBe(deposit.secondsLeft * 1000);
  expect(deposit.secondsLeft).toBeGreaterThan(TIMEOUT - 60);
  expect(textOf(result)).toContain("It is active. The Keeper refunds it in full once the issue is accepted.");
  expect(textOf(result)).toMatch(/(7 days|6 days 23 hours) from now/);
  await mcp.close();
});

test("prepare_refund refuses before the Timeout, saying how long is left and that only the Keeper can Refund", async () => {
  await deposited(3);
  const { account } = await chain.contributor();
  const mcp = await server();

  const result = await mcp.call("prepare_refund", { repo: REPO, kind: "issue", number: 3, from: account.address });

  expect(result.isError).toBe(true);
  expect(textOf(result)).toContain("is still within its Timeout");
  expect(textOf(result)).toMatch(/(7 days|6 days 23 hours) from now/);
  expect(textOf(result)).toContain("only the Keeper can Refund it");
  await mcp.close();
});

test("prepare_refund refuses an item without a Deposit", async () => {
  const { account } = await chain.contributor();
  const mcp = await server();

  const result = await mcp.call("prepare_refund", { repo: REPO, kind: "pr", number: 4, from: account.address });

  expect(result.isError).toBe(true);
  expect(textOf(result)).toContain("PR #4 in octo/refunds has no Deposit, so there is nothing to Refund.");
  await mcp.close();
});

test("a Deposit the Keeper refunded shows as refunded in full, and prepare_refund refuses it", async () => {
  const { depositor, key } = await deposited(5);
  await chain.keeperRefund(key);
  const mcp = await server();

  const status = await mcp.call("get_deposit_status", { repo: REPO, kind: "issue", number: 5 });
  const refund = await mcp.call("prepare_refund", { repo: REPO, kind: "issue", number: 5, from: depositor });

  expect(status.structuredContent).toMatchObject({
    status: "refunded",
    deposit: { outcome: { refunded: "1000000", refundedUsdc: "1", forfeited: "0", forfeitedUsdc: "0" } },
  });
  expect(textOf(status)).toContain(`It was refunded: 1 USDC went back to ${depositor}.`);
  expect(refund.isError).toBe(true);
  expect(textOf(refund)).toContain("was already refunded");
  await mcp.close();
});

test("a forfeited Deposit shows how it was split, and prepare_refund refuses it", async () => {
  const { depositor, key } = await deposited(6);
  await chain.forfeit(key);
  const mcp = await server();

  const status = await mcp.call("get_deposit_status", { repo: REPO, kind: "issue", number: 6 });
  const refund = await mcp.call("prepare_refund", { repo: REPO, kind: "issue", number: 6, from: depositor });

  expect(status.structuredContent).toMatchObject({
    status: "forfeited",
    deposit: { outcome: { refunded: "500000", refundedUsdc: "0.5", forfeited: "500000", forfeitedUsdc: "0.5" } },
  });
  expect(textOf(status)).toContain("0.5 USDC went to the Forfeit sink");
  expect(refund.isError).toBe(true);
  expect(textOf(refund)).toContain("was forfeited by its Maintainer's signed verdict");
  await mcp.close();
});

test("after the Timeout, prepare_refund's transaction, sent from an unrelated wallet, refunds the Depositor", async () => {
  const { depositor, key } = await deposited(7);
  await chain.increaseTime(TIMEOUT);
  const stranger = await chain.contributor(0n);
  const mcp = await server();

  const status = await mcp.call("get_deposit_status", { repo: REPO, kind: "issue", number: 7 });
  expect(status.structuredContent).toMatchObject({
    status: "active",
    deposit: { timeoutPassed: true, secondsLeft: 0 },
  });
  expect(textOf(status)).toContain("anyone can Refund it now");

  const result = await mcp.call("prepare_refund", {
    repo: REPO,
    kind: "issue",
    number: 7,
    from: stranger.account.address,
  });

  expect(result.isError).toBeFalsy();
  const plan = result.structuredContent as RefundPlan;
  expect(plan).toMatchObject({ from: stranger.account.address, depositor });
  expect(plan.step.circleCommand).toBe(
    `circle wallet execute "refund(bytes32)" ${key} --contract ${chain.escrow} --address ${stranger.account.address} --chain ARC-TESTNET --output json`,
  );
  const before = await chain.usdcBalance(depositor);
  const receipt = await chain.sendFrom(stranger.account, plan.step.to, plan.step.data);
  const [refunded] = parseEventLogs({ abi: escrowAbi, logs: receipt.logs, eventName: "Refunded" });
  expect(refunded?.args).toMatchObject({ key, depositor, amount: 1_000_000n, byKeeper: false });
  expect((await chain.usdcBalance(depositor)) - before).toBe(1_000_000n);
  expect(await chain.usdcBalance(stranger.account.address)).toBe(0n);

  const after = await mcp.call("get_deposit_status", { repo: REPO, kind: "issue", number: 7 });
  expect(after.structuredContent).toMatchObject({ status: "refunded" });
  await mcp.close();
});
