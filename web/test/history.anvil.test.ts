import { afterAll, beforeAll, expect, test } from "vitest";
import { createChainReader, publicClientFor } from "../src/chain.ts";
import { readRepoHistory } from "../src/history.ts";
import { keyOf, repoIdOf } from "../src/keys.ts";
import { startStack, type Stack } from "./support/stack.ts";

let stack: Stack;

beforeAll(async () => {
  stack = await startStack();
}, 120_000);

afterAll(() => stack?.stop());

test("the repo page reads every Deposit of one repo, and how each ended, across many log ranges", async () => {
  const repo = "Acme/Widgets";
  const maintainer = await stack.account(0n);
  await stack.bind(repo, { maintainer: maintainer.address });
  const activatedAt = await stack.now();
  const [merged, badFaith, timedOut, again, elsewhere] = await Promise.all([1, 2, 3, 4, 5].map(() => stack.account()));
  await stack.deposit(merged!, repo, "pr", 1);
  await stack.deposit(badFaith!, repo, "issue", 2);
  await stack.deposit(timedOut!, repo, "pr", 3);
  await stack.mine(12);
  await stack.refund(repo, "pr", 1);
  await stack.forfeit(maintainer, repo, "issue", 2);
  await stack.advance(7 * 86_400 + 1);
  await stack.refundAfterTimeout(repo, "pr", 3);
  await stack.deposit(again!, repo, "pr", 3);
  await stack.bind("acme/other");
  await stack.deposit(elsewhere!, "acme/other", "pr", 1);
  await stack.flush();
  const progress: number[] = [];

  const history = await readRepoHistory({
    client: publicClientFor(stack.network),
    network: stack.network,
    repoId: repoIdOf(repo),
    rangeSize: 5,
    concurrency: 3,
    onProgress: (done, total) => progress.push(done / total),
  });

  expect(history.deposits.map((d) => [d.kind, d.number, d.status, d.depositor])).toEqual([
    ["pr", 3, "active", again!.address],
    ["pr", 3, "refunded", timedOut!.address],
    ["issue", 2, "forfeited", badFaith!.address],
    ["pr", 1, "refunded", merged!.address],
  ]);
  const [active, afterTimeout, forfeited, early] = history.deposits;
  expect(afterTimeout!.refund).toMatchObject({ afterTimeout: true });
  expect(early!.refund).toMatchObject({ afterTimeout: false });
  expect(forfeited!.forfeit).toMatchObject({ forfeited: 500_000n, refunded: 500_000n });
  expect(active!.serial).toBeGreaterThan(afterTimeout!.serial);
  expect(active!.madeAt.getTime()).toBeGreaterThan(afterTimeout!.madeAt.getTime());
  expect(active!.deadline.getTime() - active!.madeAt.getTime()).toBe(7 * 86_400 * 1000);
  expect(active!.txHash).toMatch(/^0x[0-9a-f]{64}$/);
  expect(history.liveSince?.getTime()).toBe(Number(activatedAt) * 1000);
  expect(history.flushes).toEqual({ total: 500_000n, count: 1 });
  expect(progress.at(-1)).toBe(1);
  expect(progress.length).toBeGreaterThan(3);
});

test("a repo that was never bound has no history", async () => {
  const history = await readRepoHistory({
    client: publicClientFor(stack.network),
    network: stack.network,
    repoId: repoIdOf("acme/nothing-here"),
  });

  expect(history.deposits).toEqual([]);
  expect(history.liveSince).toBeNull();
});

test("the pages read a repo's active and pending terms, and a Deposit's state, from the escrow", async () => {
  const repo = "acme/terms";
  const reader = createChainReader(publicClientFor(stack.network), stack.network);
  const maintainer = await stack.account(0n);

  expect(await reader.repoTerms(repoIdOf(repo))).toEqual({ active: null, pending: null });

  await stack.bind(repo, { maintainer: maintainer.address, amount: 2_500_000n, timeoutSeconds: 14 * 86_400 });
  await stack.propose(repo, { maintainer: maintainer.address, amount: 3_000_000n });
  const proposedAt = await stack.now();
  const terms = await reader.repoTerms(repoIdOf(repo));

  expect(terms.active).toEqual({
    maintainer: maintainer.address,
    amount: 2_500_000n,
    forfeitBps: 5000,
    timeoutSeconds: 14 * 86_400,
  });
  expect(terms.pending).toMatchObject({ amount: 3_000_000n, timeoutSeconds: 7 * 86_400 });
  expect(terms.pending!.effectiveAt.getTime()).toBe(Number(proposedAt + 3600n) * 1000);

  const key = keyOf(repoIdOf(repo), "issue", 9);
  expect(await reader.depositOf(key)).toMatchObject({ status: "none" });
  const contributor = await stack.account();
  await stack.deposit(contributor, repo, "issue", 9, 2_500_000n);
  expect(await reader.depositOf(key)).toMatchObject({
    status: "active",
    depositor: contributor.address,
    maintainer: maintainer.address,
    amount: 2_500_000n,
    forfeitBps: 5000,
  });
  expect(await reader.usdcBalance(contributor.address)).toBe(2_500_000n);
  expect(await reader.bindingDelaySeconds()).toBe(3600);
  expect((await reader.now()).getTime()).toBe(Number(await stack.now()) * 1000);
});
