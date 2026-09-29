import { createWalletClient, http, type AbiEvent, type AbiFunction } from "viem";
import { formatAbiItem } from "viem/utils";
import { afterAll, beforeAll, expect, test } from "vitest";
import { createEscrowChain, escrowAbi } from "../src/escrow.ts";
import { keyOf, kindCode, repoIdOf, type Kind } from "../src/keys.ts";
import { artifact, startAnvil, type Anvil } from "./support/anvil.ts";
import { REPO } from "./support/webhooks.ts";

let anvil: Anvil;
/** When REPO's Binding took effect, a few blocks after the escrow's deploy. */
let started: Date;

// Blocks before the escrow's deploy, as on a real chain, where the escrow has no state to read.
beforeAll(async () => {
  anvil = await startAnvil({ blocksBefore: 64 });
  started = await anvil.bind(REPO);
}, 120_000);

function escrowChain() {
  return createEscrowChain({ client: anvil.client, escrow: anvil.escrow, fromBlock: anvil.deployBlock });
}

/** The Deposits in the escrow's logs from `from` to the latest block. */
async function depositsSince(from: bigint) {
  const events = await escrowChain().escrowEvents(from, await anvil.blockNumber());
  return events.flatMap((event) => (event.type === "deposited" ? [event.deposit] : []));
}

function seconds(date: Date, delta: number): Date {
  return new Date(date.getTime() + delta * 1000);
}

afterAll(() => anvil?.stop());

test.each([
  ["Codertocat/Hello-World", "pr", 2],
  ["Codertocat/Hello-World", "issue", 1],
  ["TonyMorony/Lottie-Squeeze", "pr", 7],
  ["tonymorony/lottie-squeeze", "issue", Number.MAX_SAFE_INTEGER],
] as [string, Kind, number][])("the key for %s %s #%i matches the escrow's keyOf", async (repo, kind, number) => {
  const onChain = await anvil.client.readContract({
    address: anvil.escrow,
    abi: anvil.escrowAbi,
    functionName: "keyOf",
    args: [repoIdOf(repo), kindCode(kind), BigInt(number)],
  });

  expect(keyOf(repoIdOf(repo), kind, number)).toBe(onChain);
});

test("the App's escrow ABI matches the Foundry artifact", () => {
  const built = artifact("BonaFideEscrow").abi as (AbiEvent | AbiFunction)[];
  for (const item of escrowAbi) {
    const match = built.find((b) => b.type === item.type && b.name === item.name);
    expect(match && formatAbiItem(match)).toBe(formatAbiItem(item));
  }
});

test("Deposited events come with their key, item, depositor, amount, block time and transaction", async () => {
  const from = (await anvil.blockNumber()) + 1n;
  const { at, txHash } = await anvil.deposit(REPO, "issue", 40);

  const events = await depositsSince(from);

  expect(events).toEqual([
    expect.objectContaining({
      key: keyOf(repoIdOf(REPO), "issue", 40),
      repoId: repoIdOf(REPO),
      kind: "issue",
      number: 40,
      depositor: anvil.contributor,
      amount: 1_000_000n,
      blockTime: at,
      txHash,
    }),
  ]);
});

test("a Binding taking effect comes in block order with the Deposits, whoever activated it", async () => {
  const repo = "bona-fide/events";
  const from = (await anvil.blockNumber()) + 1n;
  await anvil.propose(repo);
  await anvil.deposit(REPO, "pr", 45);
  await anvil.mine(1, anvil.bindingDelaySeconds);
  const hash = await createWalletClient({ transport: http(anvil.url) }).writeContract({
    account: anvil.contributor,
    chain: null,
    address: anvil.escrow,
    abi: anvil.escrowAbi,
    functionName: "activateRepo",
    args: [repoIdOf(repo)],
  });
  await anvil.client.waitForTransactionReceipt({ hash });
  await anvil.deposit(REPO, "pr", 46);

  const events = await escrowChain().escrowEvents(from, await anvil.blockNumber());

  expect(events).toEqual([
    { type: "deposited", deposit: expect.objectContaining({ number: 45 }) },
    { type: "activated", repoId: repoIdOf(repo) },
    { type: "deposited", deposit: expect.objectContaining({ number: 46 }) },
  ]);
}, 30_000);

test("a Deposit counts from its own block time on, not before", async () => {
  await anvil.mine(3000, 2);
  const { at, txHash } = await anvil.deposit(REPO, "pr", 41);
  await anvil.mine(3000, 3);
  const key = keyOf(repoIdOf(REPO), "pr", 41);
  const chain = escrowChain();
  const deposit = { depositor: anvil.contributor, amount: 1_000_000n, txHash };

  expect(await chain.depositSince(key, seconds(at, -3600))).toEqual(deposit);
  expect(await chain.depositSince(key, at)).toEqual(deposit);
  expect(await chain.depositSince(key, seconds(at, 1))).toBeNull();
  expect(await chain.depositSince(key, seconds(at, 3600))).toBeNull();
}, 30_000);

test("a Deposit read without its event comes with the transaction that made it, not an earlier one's", async () => {
  await anvil.deposit(REPO, "pr", 47);
  await anvil.refund(REPO, "pr", 47);
  await anvil.mine(20, 5);
  const { txHash } = await anvil.deposit(REPO, "pr", 47);
  await anvil.mine(20, 5);

  const deposit = await escrowChain().depositSince(keyOf(repoIdOf(REPO), "pr", 47), new Date(0));

  expect(deposit?.txHash).toBe(txHash);
});

test("an item with no Deposit has none since any time", async () => {
  const key = keyOf(repoIdOf(REPO), "pr", 42);

  expect(await escrowChain().depositSince(key, new Date(0))).toBeNull();
});

test("a forfeited Deposit no longer counts, even given its Deposited event", async () => {
  const from = (await anvil.blockNumber()) + 1n;
  await anvil.deposit(REPO, "pr", 43);
  const [event] = await depositsSince(from);
  const key = keyOf(repoIdOf(REPO), "pr", 43);
  const opened = seconds(event!.blockTime, -60);
  expect(await escrowChain().depositSince(key, opened, event)).not.toBeNull();

  await anvil.forfeit(REPO, "pr", 43);

  expect(await escrowChain().depositSince(key, opened)).toBeNull();
  expect(await escrowChain().depositSince(key, opened, event)).toBeNull();
}, 30_000);

test("a repo's active and pending Bindings are read from the escrow", async () => {
  const repo = "bona-fide/bindings";
  const chain = escrowChain();
  expect(await chain.bindingOf(repoIdOf(repo))).toEqual({ active: null, pending: null });

  await anvil.bind(repo, { amount: 2_500_000n, forfeitBps: 2000, timeoutSeconds: 1_209_600 });
  const active = { maintainer: anvil.maintainer, amount: 2_500_000n, forfeitBps: 2000, timeoutSeconds: 1_209_600 };
  expect(await chain.bindingOf(repoIdOf(repo))).toEqual({ active, pending: null });

  const proposedAt = await anvil.propose(repo, { amount: 5_000_000n, forfeitBps: 0, timeoutSeconds: 86_400 });
  expect(await chain.bindingOf(repoIdOf(repo))).toEqual({
    active,
    pending: {
      maintainer: anvil.maintainer,
      amount: 5_000_000n,
      forfeitBps: 0,
      timeoutSeconds: 86_400,
      effectiveAt: seconds(proposedAt, 3600),
    },
  });
}, 30_000);

test("a repo started when its first Binding took effect, and a later Binding doesn't change that", async () => {
  const repo = "bona-fide/started";
  const pending = "bona-fide/started-pending";
  const chain = escrowChain();
  await anvil.propose(pending);
  expect(await chain.startedAt(repoIdOf(repo))).toBeNull();
  expect(await chain.startedAt(repoIdOf(pending))).toBeNull();

  const first = await anvil.bind(repo);
  await anvil.bind(repo, { amount: 2_000_000n });

  expect(await chain.startedAt(repoIdOf(repo))).toEqual(first);
  expect(await chain.startedAt(repoIdOf(pending))).toBeNull();
}, 30_000);

test("a repo's start is found even when the search begins before the escrow existed", async () => {
  const fromGenesis = createEscrowChain({ client: anvil.client, escrow: anvil.escrow, fromBlock: 0n });

  expect(await fromGenesis.startedAt(repoIdOf(REPO))).toEqual(started);
});

test("a refunded Deposit no longer counts, even given its Deposited event", async () => {
  const from = (await anvil.blockNumber()) + 1n;
  await anvil.deposit(REPO, "pr", 44);
  const [event] = await depositsSince(from);
  const key = keyOf(repoIdOf(REPO), "pr", 44);
  const opened = seconds(event!.blockTime, -60);
  expect(await escrowChain().depositSince(key, opened, event)).not.toBeNull();

  await anvil.refund(REPO, "pr", 44);

  expect(await escrowChain().depositSince(key, opened)).toBeNull();
  expect(await escrowChain().depositSince(key, opened, event)).toBeNull();
}, 30_000);
