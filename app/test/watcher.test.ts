import { expect, test, vi } from "vitest";
import type { Item } from "../src/ports.ts";
import { createDepositWatcher } from "../src/watcher.ts";
import { harness } from "./support/harness.ts";
import { HEAD_SHA, HELLO_WORLD, ISSUE, NEWCOMER, payload, PR, REPO } from "./support/webhooks.ts";

const DEPOSITOR = "0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed";
const REQUIRED = "bona-fide:deposit-required";

const pr: Item = {
  repo: HELLO_WORLD,
  kind: "pr",
  number: PR,
  author: NEWCOMER,
  createdAt: new Date("2019-05-15T15:20:33Z"),
  labels: [],
  headSha: HEAD_SHA,
};

const issue: Item = {
  repo: HELLO_WORLD,
  kind: "issue",
  number: ISSUE,
  author: NEWCOMER,
  createdAt: new Date("2019-05-15T15:20:18Z"),
  labels: [],
};

function watching() {
  const h = harness({ config: "" });
  const watcher = createDepositWatcher({ chain: h.chain, github: h.github, app: h.app });
  return { ...h, watcher };
}

function minutesAfter(date: Date, minutes: number): Date {
  return new Date(date.getTime() + minutes * 60_000);
}

test("a Deposit turns the PR's check green on the next tick", async () => {
  const { github, chain, deliver, watcher } = watching();
  github.addItem(pr);
  await deliver("pull_request", payload("pull_request", "opened", { author: NEWCOMER }));
  await watcher.tick();

  chain.deposit({ repo: REPO, kind: "pr", number: PR, depositor: DEPOSITOR, at: minutesAfter(pr.createdAt, 5) });
  await watcher.tick();

  expect(github.checkOn(REPO, HEAD_SHA)).toMatchObject({
    conclusion: "success",
    title: "Deposit received from 0x5aAe…eAed",
  });
});

test("a Deposit on an issue edits the comment and removes the label", async () => {
  const { github, chain, deliver, watcher } = watching();
  github.addItem(issue);
  await deliver("issues", payload("issues", "opened", { author: NEWCOMER, labels: [] }));
  await watcher.tick();

  const { txHash } = chain.deposit({
    repo: REPO,
    kind: "issue",
    number: ISSUE,
    depositor: DEPOSITOR,
    at: minutesAfter(issue.createdAt, 5),
  });
  await watcher.tick();

  const comments = github.commentsOn(REPO, ISSUE);
  expect(comments).toHaveLength(1);
  expect(comments[0]).toContain("Deposit received from 0x5aAe…eAed");
  expect(comments[0]).toContain(`${DEPOSITOR} paid the refundable Deposit of **1 USDC** for this issue.`);
  expect(comments[0]).toContain(`[View the Deposit on Arc](https://explorer.arc.io/tx/${txHash})`);
  expect(github.labelsOn(REPO, ISSUE)).not.toContain(REQUIRED);
});

test("a Deposit made before the PR was opened doesn't turn it green", async () => {
  const { github, chain, deliver, watcher } = watching();
  github.addItem(pr);
  await watcher.tick();

  chain.deposit({ repo: REPO, kind: "pr", number: PR, depositor: DEPOSITOR, at: minutesAfter(pr.createdAt, -5) });
  await watcher.tick();
  await deliver("pull_request", payload("pull_request", "opened", { author: NEWCOMER }));

  expect(github.checkOn(REPO, HEAD_SHA)?.conclusion).toBe("action_required");
});

test("Deposits for other repos and for items that don't exist are skipped", async () => {
  const { github, chain, watcher } = watching();
  await watcher.tick();

  chain.deposit({ repo: "someone/else", kind: "pr", number: 1, depositor: DEPOSITOR, at: new Date() });
  chain.deposit({ repo: REPO, kind: "pr", number: 999, depositor: DEPOSITOR, at: new Date() });
  await watcher.tick();

  expect(github.checkOn(REPO, HEAD_SHA)).toBeUndefined();
});

test("the webhook and the watcher settling one issue at once leave one comment", async () => {
  const { github, chain, app, deliver } = watching();
  github.addItem(issue);
  github.latency = 2;
  const event = chain.deposit({
    repo: REPO,
    kind: "issue",
    number: ISSUE,
    depositor: DEPOSITOR,
    at: minutesAfter(issue.createdAt, 1),
  });

  await Promise.all([
    deliver("issues", payload("issues", "opened", { author: NEWCOMER, labels: [] })),
    app.settle(issue, event),
  ]);

  const comments = github.commentsOn(REPO, ISSUE);
  expect(comments).toHaveLength(1);
  expect(comments[0]).toContain("Deposit received");
  expect(github.labelsOn(REPO, ISSUE)).not.toContain(REQUIRED);
});

test("a Deposit that keeps failing doesn't hold up the others", async () => {
  const { github, chain, deliver, watcher } = watching();
  github.addItem(pr);
  github.addItem({ ...issue, number: 13 });
  github.breakItem("issue", 13);
  await deliver("pull_request", payload("pull_request", "opened", { author: NEWCOMER }));
  await watcher.tick();

  chain.deposit({ repo: REPO, kind: "issue", number: 13, depositor: DEPOSITOR, at: minutesAfter(issue.createdAt, 5) });
  chain.deposit({ repo: REPO, kind: "pr", number: PR, depositor: DEPOSITOR, at: minutesAfter(pr.createdAt, 5) });
  await expect(watcher.tick()).rejects.toThrow();

  expect(github.checkOn(REPO, HEAD_SHA)?.conclusion).toBe("success");
});

test("a Deposit that failed to settle is retried on a later tick", async () => {
  const { github, chain, deliver, watcher } = watching();
  github.addItem(pr);
  github.breakItem("pr", PR, 1);
  await deliver("pull_request", payload("pull_request", "opened", { author: NEWCOMER }));
  await watcher.tick();

  chain.deposit({ repo: REPO, kind: "pr", number: PR, depositor: DEPOSITOR, at: minutesAfter(pr.createdAt, 5) });
  await expect(watcher.tick()).rejects.toThrow();
  await watcher.tick();

  expect(github.checkOn(REPO, HEAD_SHA)?.conclusion).toBe("success");
});

test("a Deposit that never settles is given up after a while", async () => {
  const { github, chain, watcher } = watching();
  github.addItem({ ...issue, number: 13 });
  github.breakItem("issue", 13);
  await watcher.tick();
  chain.deposit({ repo: REPO, kind: "issue", number: 13, depositor: DEPOSITOR, at: minutesAfter(issue.createdAt, 5) });

  for (let i = 0; i < 600; i++) await watcher.tick().catch(() => {});

  await expect(watcher.tick()).resolves.toBeUndefined();
});

test("a watcher resumed from its saved position settles Deposits made while it was stopped", async () => {
  const { github, chain, app, deliver, watcher } = watching();
  github.addItem(pr);
  await deliver("pull_request", payload("pull_request", "opened", { author: NEWCOMER }));
  await watcher.tick();
  const saved = watcher.position;

  chain.deposit({ repo: REPO, kind: "pr", number: PR, depositor: DEPOSITOR, at: minutesAfter(pr.createdAt, 5) });
  chain.deposit({
    repo: "someone/else",
    kind: "pr",
    number: 1,
    depositor: DEPOSITOR,
    at: minutesAfter(pr.createdAt, 6),
  });
  await createDepositWatcher({ chain, github, app, fromBlock: saved }).tick();

  expect(github.checkOn(REPO, HEAD_SHA)?.conclusion).toBe("success");
});

test("a replayed Deposit that was forfeited since doesn't turn the check green", async () => {
  const { github, chain, app, deliver, watcher } = watching();
  github.addItem(pr);
  await deliver("pull_request", payload("pull_request", "opened", { author: NEWCOMER }));
  await watcher.tick();
  const saved = watcher.position;
  const event = chain.deposit({
    repo: REPO,
    kind: "pr",
    number: PR,
    depositor: DEPOSITOR,
    at: minutesAfter(pr.createdAt, 5),
  });
  chain.forfeit(event.key);

  await createDepositWatcher({ chain, github, app, fromBlock: saved }).tick();

  expect(github.checkOn(REPO, HEAD_SHA)?.conclusion).toBe("action_required");
});

/** A Deposit for the PR, made five minutes before the PR is opened: the PR doesn't exist yet. */
async function depositedBeforeThePrOpened() {
  const h = watching();
  await h.watcher.tick();
  const event = h.chain.deposit({
    repo: REPO,
    kind: "pr",
    number: PR,
    depositor: DEPOSITOR,
    at: minutesAfter(pr.createdAt, -5),
  });
  await h.watcher.tick();
  return { ...h, event };
}

test("a Deposit made before its PR existed is checked once the PR opens, with no event for the PR", async () => {
  const { github, watcher } = await depositedBeforeThePrOpened();

  github.addItem(pr);
  for (let i = 0; i < 3; i++) await watcher.tick();

  expect(github.checkOn(REPO, HEAD_SHA)?.conclusion).toBe("action_required");
});

test("a Deposit waiting for its PR is looked at less and less often", async () => {
  const { github, watcher } = await depositedBeforeThePrOpened();
  const reads = vi.spyOn(github, "getItem");

  for (let i = 0; i < 100; i++) await watcher.tick();
  github.addItem(pr);
  for (let i = 0; i < 128; i++) await watcher.tick();

  expect(reads.mock.calls.length).toBeLessThanOrEqual(8);
  expect(github.checkOn(REPO, HEAD_SHA)?.conclusion).toBe("action_required");
});

test("a Deposit refunded or forfeited before its PR opens is no longer waited for", async () => {
  const { github, chain, watcher, event } = await depositedBeforeThePrOpened();

  chain.forfeit(event.key);
  await watcher.tick();
  github.addItem(pr);
  for (let i = 0; i < 3; i++) await watcher.tick();

  expect(github.checkOn(REPO, HEAD_SHA)).toBeUndefined();
});

test("at most 100 Deposits wait for their items, and the oldest is dropped first", async () => {
  const { github, chain, watcher } = watching();
  await watcher.tick();
  for (let number = 1; number <= 101; number++) {
    chain.deposit({ repo: REPO, kind: "issue", number, depositor: DEPOSITOR, at: minutesAfter(issue.createdAt, -5) });
  }
  await watcher.tick();

  for (let number = 1; number <= 101; number++) github.addItem({ ...issue, number });
  await watcher.tick();

  const checked = Array.from({ length: 101 }, (_, i) => i + 1).filter((n) => github.commentsOn(REPO, n).length > 0);
  expect(checked).toEqual(Array.from({ length: 100 }, (_, i) => i + 2));
});
