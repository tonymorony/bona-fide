import { keyOf, repoIdOf, type Kind } from "@bona-fide/sdk";
import { createTestClient, createWalletClient, http, type Hex } from "viem";
import { afterAll, beforeAll, expect, test, vi } from "vitest";
import { createTimeoutRefunder } from "../src/keeper/timeouts.ts";
import type { Anvil } from "./support/anvil.ts";
import { keeperHarness, startKeeperAnvil } from "./support/keeper.ts";
import { REPO } from "./support/webhooks.ts";

// The Keeper refunds Deposits past their Timeout on its own, against the real escrow on anvil.

// The escrow's Status enum: None, Active, Refunded, Forfeited.
const ACTIVE = 1;
const REFUNDED = 2;
const FORFEITED = 3;
const ONE_USDC = 1_000_000n;

let anvil: Anvil;
let keeperKey: `0x${string}`;

beforeAll(async () => {
  ({ anvil, keeperKey } = await startKeeperAnvil());
  await anvil.bind(REPO);
}, 120_000);

afterAll(() => anvil?.stop());

async function depositOf(kind: Kind, number: number, repo = REPO) {
  const key = keyOf(repoIdOf(repo), kind, number);
  const deposit = (await anvil.client.readContract({
    address: anvil.escrow,
    abi: anvil.escrowAbi,
    functionName: "depositOf",
    args: [key],
  })) as { status: number; deadline: bigint };
  return { key, ...deposit };
}

/** Mines the next block at `time`, in Unix seconds. */
async function mineAt(time: bigint): Promise<void> {
  const chain = createTestClient({ mode: "anvil", transport: http(anvil.url) });
  await chain.setNextBlockTimestamp({ timestamp: time });
  await chain.mine({ blocks: 1 });
}

/** Refunds a Deposit after its Timeout from an account that isn't the Keeper, as anyone may. */
async function refundAsAnyone(key: Hex): Promise<void> {
  const hash = await createWalletClient({ transport: http(anvil.url) }).writeContract({
    account: anvil.contributor,
    chain: null,
    address: anvil.escrow,
    abi: anvil.escrowAbi,
    functionName: "refund",
    args: [key],
  });
  await anvil.client.waitForTransactionReceipt({ hash });
}

function keeperTransactions(): Promise<number> {
  return anvil.client.getTransactionCount({ address: anvil.keeper });
}

test("a Deposit is refunded in full once its Timeout passes, without any webhook", async () => {
  const from = (await anvil.blockNumber()) + 1n;
  await anvil.deposit(REPO, "pr", 401);
  const { deadline } = await depositOf("pr", 401);
  const before = await anvil.usdcBalance(anvil.contributor);
  const { escrow } = keeperHarness(anvil, keeperKey);

  await mineAt(deadline);
  await createTimeoutRefunder({ escrow, fromBlock: from }).tick();

  expect((await depositOf("pr", 401)).status).toBe(REFUNDED);
  expect(await anvil.usdcBalance(anvil.contributor)).toBe(before + ONE_USDC);
}, 30_000);

test("a Deposit is left alone one second before its deadline, and refunded at it", async () => {
  const from = (await anvil.blockNumber()) + 1n;
  await anvil.deposit(REPO, "pr", 402);
  const { deadline } = await depositOf("pr", 402);
  const { escrow } = keeperHarness(anvil, keeperKey);
  const refunder = createTimeoutRefunder({ escrow, fromBlock: from });

  await mineAt(deadline - 1n);
  await refunder.tick();
  const early = (await depositOf("pr", 402)).status;
  await mineAt(deadline);
  await refunder.tick();

  expect(early).toBe(ACTIVE);
  expect((await depositOf("pr", 402)).status).toBe(REFUNDED);
}, 30_000);

test("a Deposit forfeited before its Timeout is left alone", async () => {
  const from = (await anvil.blockNumber()) + 1n;
  await anvil.deposit(REPO, "pr", 403);
  const { escrow } = keeperHarness(anvil, keeperKey);
  const refunder = createTimeoutRefunder({ escrow, fromBlock: from });
  await refunder.tick();
  await anvil.forfeit(REPO, "pr", 403);
  const { deadline } = await depositOf("pr", 403);
  await mineAt(deadline);
  const sent = await keeperTransactions();

  await refunder.tick();

  expect(await keeperTransactions()).toBe(sent);
  expect((await depositOf("pr", 403)).status).toBe(FORFEITED);
}, 30_000);

test("a Deposit someone else refunds after its Timeout, just before the Keeper does, is no error", async () => {
  const from = (await anvil.blockNumber()) + 1n;
  await anvil.deposit(REPO, "pr", 404);
  const { key, deadline } = await depositOf("pr", 404);
  const { escrow } = keeperHarness(anvil, keeperKey, {
    escrow: (escrow) => ({
      ...escrow,
      async refund(...args) {
        await refundAsAnyone(key);
        return escrow.refund(...args);
      },
    }),
  });
  await mineAt(deadline);
  const sent = await keeperTransactions();

  await expect(createTimeoutRefunder({ escrow, fromBlock: from }).tick()).resolves.toBeUndefined();

  expect(await keeperTransactions()).toBe(sent);
  expect((await depositOf("pr", 404)).status).toBe(REFUNDED);
}, 30_000);

test("a Deposit refunded before its Timeout frees its place among the open Deposits the Keeper keeps", async () => {
  const from = (await anvil.blockNumber()) + 1n;
  await anvil.deposit(REPO, "pr", 405);
  await anvil.refund(REPO, "pr", 405);
  await anvil.deposit(REPO, "issue", 405);
  const { deadline } = await depositOf("issue", 405);
  const { escrow } = keeperHarness(anvil, keeperKey);

  await mineAt(deadline);
  await createTimeoutRefunder({ escrow, fromBlock: from, maxOpen: 1 }).tick();

  expect((await depositOf("issue", 405)).status).toBe(REFUNDED);
}, 30_000);

test("a Deposit forfeited before its Timeout frees its place among the open Deposits the Keeper keeps", async () => {
  const from = (await anvil.blockNumber()) + 1n;
  await anvil.deposit(REPO, "pr", 406);
  await anvil.forfeit(REPO, "pr", 406);
  await anvil.deposit(REPO, "issue", 406);
  const { deadline } = await depositOf("issue", 406);
  const { escrow } = keeperHarness(anvil, keeperKey);

  await mineAt(deadline);
  await createTimeoutRefunder({ escrow, fromBlock: from, maxOpen: 1 }).tick();

  expect((await depositOf("issue", 406)).status).toBe(REFUNDED);
}, 30_000);

test("with more open Deposits than it keeps, the Keeper keeps the ones due first", async () => {
  const short = "octo/one-day";
  await anvil.bind(short, { timeoutSeconds: 86_400 });
  const from = (await anvil.blockNumber()) + 1n;
  await anvil.deposit(REPO, "pr", 407);
  await anvil.deposit(short, "pr", 1);
  const { deadline } = await depositOf("pr", 1, short);
  const { escrow } = keeperHarness(anvil, keeperKey);
  const log = vi.spyOn(console, "log").mockImplementation(() => {});

  await mineAt(deadline);
  await createTimeoutRefunder({ escrow, fromBlock: from, maxOpen: 1 }).tick();

  expect((await depositOf("pr", 1, short)).status).toBe(REFUNDED);
  expect(log).toHaveBeenCalledWith(expect.stringMatching(/\b1 open Deposits?\b.*\b1\b.*due later/));
  log.mockRestore();
}, 30_000);

test("a Timeout refund that fails is tried again on later ticks, less and less often", async () => {
  const from = (await anvil.blockNumber()) + 1n;
  await anvil.deposit(REPO, "pr", 408);
  const { deadline } = await depositOf("pr", 408);
  let failing = true;
  let tries = 0;
  const { escrow } = keeperHarness(anvil, keeperKey, {
    escrow: (escrow) => ({
      ...escrow,
      async refund(...args) {
        tries += 1;
        if (failing) throw new Error("The RPC is down.");
        return escrow.refund(...args);
      },
    }),
  });
  const refunder = createTimeoutRefunder({ escrow, fromBlock: from });
  await mineAt(deadline);

  const failed = await refunder.tick().catch((error: unknown) => error);
  for (let i = 1; i < 100; i++) await refunder.tick().catch(() => {});
  const triedWhileFailing = tries;
  failing = false;
  for (let i = 0; i < 128; i++) await refunder.tick();

  expect(failed).toBeInstanceOf(AggregateError);
  expect(triedWhileFailing).toBeLessThanOrEqual(8);
  expect((await depositOf("pr", 408)).status).toBe(REFUNDED);
}, 60_000);
