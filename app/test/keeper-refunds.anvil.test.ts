import { createPublicClient, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { afterAll, beforeAll, expect, test } from "vitest";
import { createKeeperEscrow } from "../src/keeper/escrow.ts";
import { keyOf, repoIdOf, type Kind } from "../src/keys.ts";
import type { Anvil } from "./support/anvil.ts";
import type { FakeGitHub } from "./support/fake-github.ts";
import { keeperHarness, startKeeperAnvil } from "./support/keeper.ts";
import { createDepositWatcher } from "../src/watcher.ts";
import { HELLO_WORLD, NEWCOMER, payload, REPO } from "./support/webhooks.ts";

// The escrow's Status enum: None, Active, Refunded, Forfeited.
const ACTIVE = 1;
const REFUNDED = 2;
const ONE_USDC = 1_000_000n;

let anvil: Anvil;
let keeperKey: `0x${string}`;
/** When the repo's Binding took effect. */
let started: Date;

beforeAll(async () => {
  ({ anvil, keeperKey } = await startKeeperAnvil());
  started = await anvil.bind(REPO);
}, 120_000);

afterAll(() => anvil?.stop());

async function statusOf(kind: Kind, number: number): Promise<number> {
  const deposit = (await anvil.client.readContract({
    address: anvil.escrow,
    abi: anvil.escrowAbi,
    functionName: "depositOf",
    args: [keyOf(repoIdOf(REPO), kind, number)],
  })) as { status: number };
  return deposit.status;
}

function closedPr(number: number, { merged, by }: { merged: boolean; by: string }) {
  const body = payload("pull_request", "closed", { author: NEWCOMER });
  body.number = number;
  body.pull_request.number = number;
  body.pull_request.merged = merged;
  body.sender.login = by;
  return body;
}

// GitHub's examples have no issues.closed payload: this is the recorded reopened one with the
// fields a close sets.
function closedIssue(number: number, { reason, by }: { reason: string; by: string }) {
  const body = payload("issues", "reopened", { author: NEWCOMER, labels: [] });
  body.action = "closed";
  body.issue.number = number;
  body.issue.state = "closed";
  body.issue.state_reason = reason;
  body.sender.login = by;
  return body;
}

function opened(kind: Kind, number: number, at: Date) {
  const event = kind === "pr" ? "pull_request" : "issues";
  const body = payload(event, "opened", { author: NEWCOMER, createdAt: at.toISOString(), labels: [] });
  (kind === "pr" ? body.pull_request : body.issue).number = number;
  if (kind === "pr") body.pull_request.head.sha = String(number).padStart(40, "0");
  return body;
}

function labeled(kind: Kind, number: number, label: string) {
  const body = payload(kind === "pr" ? "pull_request" : "issues", "labeled", {
    author: NEWCOMER,
    label,
    labels: [label],
  });
  (kind === "pr" ? body.pull_request : body.issue).number = number;
  return body;
}

test("merging a PR refunds its Deposit in full", async () => {
  const { deliver } = keeperHarness(anvil, keeperKey);
  await anvil.deposit(REPO, "pr", 101);
  const before = await anvil.usdcBalance(anvil.contributor);

  await deliver("pull_request", closedPr(101, { merged: true, by: "maintainer" }));

  expect(await anvil.usdcBalance(anvil.contributor)).toBe(before + ONE_USDC);
  expect(await statusOf("pr", 101)).toBe(REFUNDED);
}, 30_000);

test("closing an issue as completed refunds its Deposit in full", async () => {
  const { deliver } = keeperHarness(anvil, keeperKey);
  await anvil.deposit(REPO, "issue", 111);
  const before = await anvil.usdcBalance(anvil.contributor);

  await deliver("issues", closedIssue(111, { reason: "completed", by: "maintainer" }));

  expect(await anvil.usdcBalance(anvil.contributor)).toBe(before + ONE_USDC);
  expect(await statusOf("issue", 111)).toBe(REFUNDED);
}, 30_000);

test("an author closing their own issue as completed gets no refund", async () => {
  const { deliver } = keeperHarness(anvil, keeperKey);
  await anvil.deposit(REPO, "issue", 112);

  await deliver("issues", closedIssue(112, { reason: "completed", by: NEWCOMER }));

  expect(await statusOf("issue", 112)).toBe(ACTIVE);
}, 30_000);

test.each([
  ["an author closing their own PR", "pr", 121, () => closedPr(121, { merged: false, by: NEWCOMER })],
  ["a Maintainer closing a PR without merging", "pr", 122, () => closedPr(122, { merged: false, by: "maintainer" })],
  [
    "closing an issue as not planned",
    "issue",
    123,
    () => closedIssue(123, { reason: "not_planned", by: "maintainer" }),
  ],
  ["closing an issue as a duplicate", "issue", 124, () => closedIssue(124, { reason: "duplicate", by: "maintainer" })],
] as const)(
  "%s keeps the Deposit until a Forfeit or the Timeout",
  async (_, kind, number, closed) => {
    const { deliver } = keeperHarness(anvil, keeperKey);
    await anvil.deposit(REPO, kind, number);

    await deliver(kind === "pr" ? "pull_request" : "issues", closed());

    expect(await statusOf(kind, number)).toBe(ACTIVE);
  },
  30_000,
);

test.each([
  ["pr", 131],
  ["issue", 132],
] as const)(
  "the bona-fide:ok label on a %s refunds its Deposit in full",
  async (kind, number) => {
    const { deliver } = keeperHarness(anvil, keeperKey);
    await anvil.deposit(REPO, kind, number);
    const before = await anvil.usdcBalance(anvil.contributor);

    await deliver(kind === "pr" ? "pull_request" : "issues", labeled(kind, number, "bona-fide:ok"));

    expect(await anvil.usdcBalance(anvil.contributor)).toBe(before + ONE_USDC);
    expect(await statusOf(kind, number)).toBe(REFUNDED);
  },
  30_000,
);

test("a merge delivered twice at once refunds once, and both deliveries succeed", async () => {
  const { deliver } = keeperHarness(anvil, keeperKey);
  await anvil.deposit(REPO, "pr", 141);
  const before = await anvil.usdcBalance(anvil.contributor);
  const merged = closedPr(141, { merged: true, by: "maintainer" });

  const responses = await Promise.all([deliver("pull_request", merged), deliver("pull_request", merged)]);

  expect(responses.map((r) => r.status)).toEqual([200, 200]);
  expect(await anvil.usdcBalance(anvil.contributor)).toBe(before + ONE_USDC);
}, 30_000);

test.each([
  ["pr", 151],
  ["issue", 152],
] as const)(
  "a Deposit made before its %s was opened is refunded when it opens",
  async (kind, number) => {
    const { deliver } = keeperHarness(anvil, keeperKey);
    await anvil.deposit(REPO, kind, number);
    await anvil.mine(1, 3 * 60);
    const before = await anvil.usdcBalance(anvil.contributor);

    await deliver(kind === "pr" ? "pull_request" : "issues", opened(kind, number, await anvil.now()));

    expect(await anvil.usdcBalance(anvil.contributor)).toBe(before + ONE_USDC);
    expect(await statusOf(kind, number)).toBe(REFUNDED);
    await anvil.deposit(REPO, kind, number);
    expect(await statusOf(kind, number)).toBe(ACTIVE);
  },
  30_000,
);

test("a Deposit made before its PR was opened is refunded once the PR exists, even without the opened delivery", async () => {
  const { github, chain, app } = keeperHarness(anvil, keeperKey);
  const watcher = createDepositWatcher({ chain, github, app });
  await watcher.tick();
  await anvil.deposit(REPO, "pr", 154);
  await watcher.tick();
  await anvil.mine(1, 3 * 60);
  const openedAt = await anvil.now();
  github.addItem({
    repo: HELLO_WORLD,
    kind: "pr",
    number: 154,
    author: NEWCOMER,
    createdAt: openedAt,
    labels: [],
    headSha: "154",
  });
  const before = await anvil.usdcBalance(anvil.contributor);

  for (let i = 0; i < 3; i++) await watcher.tick();

  expect(await anvil.usdcBalance(anvil.contributor)).toBe(before + ONE_USDC);
  expect(await statusOf("pr", 154)).toBe(REFUNDED);
}, 30_000);

// GitHub's clock and Arc's may disagree, so the check counts a Deposit up to two minutes older than
// its item, and the Keeper leaves such a Deposit alone.
test("a Deposit on a PR opened before Bona Fide started here is refunded when the check runs", async () => {
  const { deliver } = keeperHarness(anvil, keeperKey);
  await anvil.deposit(REPO, "pr", 187);
  const before = await anvil.usdcBalance(anvil.contributor);
  const pushed = opened("pr", 187, new Date(started.getTime() - 3_600_000));
  pushed.action = "synchronize";

  await deliver("pull_request", pushed);

  expect(await anvil.usdcBalance(anvil.contributor)).toBe(before + ONE_USDC);
  expect(await statusOf("pr", 187)).toBe(REFUNDED);
}, 30_000);

test("a Deposit less than two minutes older than its PR counts, and stays", async () => {
  const { deliver } = keeperHarness(anvil, keeperKey);
  await anvil.deposit(REPO, "pr", 185);
  await anvil.mine(1, 60);

  await deliver("pull_request", opened("pr", 185, await anvil.now()));

  expect(await statusOf("pr", 185)).toBe(ACTIVE);
}, 30_000);

test("after the bona-fide:ok label refunds a PR's Deposit, a push keeps the check green", async () => {
  const { deliver, github } = keeperHarness(anvil, keeperKey);
  const openedPr = opened("pr", 186, await anvil.now());
  await deliver("pull_request", openedPr);
  await anvil.mine(1, 5);
  await anvil.deposit(REPO, "pr", 186);
  await deliver("pull_request", labeled("pr", 186, "bona-fide:ok"));
  const pushed = structuredClone(openedPr);
  pushed.action = "synchronize";
  pushed.pull_request.labels = [{ name: "bona-fide:ok" }];

  await deliver("pull_request", pushed);

  expect(await statusOf("pr", 186)).toBe(REFUNDED);
  expect(github.checkOn(REPO, openedPr.pull_request.head.sha)).toMatchObject({
    conclusion: "success",
    title: "No Deposit needed: a Maintainer accepted it",
  });
}, 30_000);

test("a Deposit made after the PR was opened stays through a re-check", async () => {
  const { deliver, github } = keeperHarness(anvil, keeperKey);
  const openedPr = opened("pr", 153, await anvil.now());
  await deliver("pull_request", openedPr);
  await anvil.mine(1, 5);
  await anvil.deposit(REPO, "pr", 153);

  await deliver("pull_request", { ...openedPr, action: "synchronize" });

  expect(await statusOf("pr", 153)).toBe(ACTIVE);
  expect(github.checkOn(REPO, openedPr.pull_request.head.sha)?.conclusion).toBe("success");
}, 30_000);

test("a Deposit on a PR is refunded when a Maintainer waives the PR", async () => {
  const { deliver } = keeperHarness(anvil, keeperKey);
  await deliver("pull_request", opened("pr", 161, await anvil.now()));
  await anvil.mine(1, 5);
  await anvil.deposit(REPO, "pr", 161);
  const before = await anvil.usdcBalance(anvil.contributor);

  await deliver("pull_request", labeled("pr", 161, "bona-fide:waive"));

  expect(await anvil.usdcBalance(anvil.contributor)).toBe(before + ONE_USDC);
  expect(await statusOf("pr", 161)).toBe(REFUNDED);
}, 30_000);

test("a Deposit from a denounced Contributor is refunded when the check runs", async () => {
  const { deliver, github } = keeperHarness(anvil, keeperKey);
  github.setFile(REPO, "VOUCHED.td", "-newcomer\n");
  const openedPr = opened("pr", 162, await anvil.now());
  await deliver("pull_request", openedPr);
  await anvil.mine(1, 5);
  await anvil.deposit(REPO, "pr", 162);
  const before = await anvil.usdcBalance(anvil.contributor);

  await deliver("pull_request", { ...openedPr, action: "synchronize" });

  expect(await anvil.usdcBalance(anvil.contributor)).toBe(before + ONE_USDC);
  expect(await statusOf("pr", 162)).toBe(REFUNDED);
}, 30_000);

test("a Deposit on a collaborator's issue is refunded as soon as the watcher sees it", async () => {
  const { github, chain, app } = keeperHarness(anvil, keeperKey);
  github.setPermission(REPO, NEWCOMER, "write");
  const openedAt = new Date((await anvil.now()).getTime() - 60_000);
  github.addItem({ repo: HELLO_WORLD, kind: "issue", number: 163, author: NEWCOMER, createdAt: openedAt, labels: [] });
  const watcher = createDepositWatcher({ chain, github, app });
  await watcher.tick();
  await anvil.deposit(REPO, "issue", 163);
  const before = await anvil.usdcBalance(anvil.contributor);

  await watcher.tick();

  expect(await anvil.usdcBalance(anvil.contributor)).toBe(before + ONE_USDC);
  expect(await statusOf("issue", 163)).toBe(REFUNDED);
}, 30_000);

test("a Deposit made while the Keeper refunds an earlier one on the same PR is left alone", async () => {
  const { deliver } = keeperHarness(anvil, keeperKey, {
    escrow: (escrow) => ({
      ...escrow,
      async refund(...args) {
        // Right before the Keeper's refund, someone else refunds the early Deposit and the
        // Contributor makes a new one.
        await anvil.refund(REPO, "pr", 171);
        await anvil.deposit(REPO, "pr", 171);
        return escrow.refund(...args);
      },
    }),
  });
  await anvil.deposit(REPO, "pr", 171);
  await anvil.mine(1, 60);

  await deliver("pull_request", opened("pr", 171, await anvil.now()));

  expect(await statusOf("pr", 171)).toBe(ACTIVE);
}, 30_000);

test("a Deposit someone else refunds just before the Keeper does is no error", async () => {
  await anvil.deposit(REPO, "pr", 191);
  const client = createPublicClient({ transport: http(anvil.url) });
  const racing = new Proxy(client, {
    get(target, property, receiver) {
      if (property !== "simulateContract") return Reflect.get(target, property, receiver);
      return async (parameters: Parameters<typeof client.simulateContract>[0]) => {
        await anvil.refund(REPO, "pr", 191);
        return target.simulateContract(parameters);
      };
    },
  });
  const escrow = createKeeperEscrow({ client: racing, account: privateKeyToAccount(keeperKey), escrow: anvil.escrow });

  await expect(escrow.refund(keyOf(repoIdOf(REPO), "pr", 191))).resolves.toBeNull();
}, 30_000);

test.each([
  ["denounced", 181, (github: FakeGitHub) => github.setFile(REPO, "VOUCHED.td", "-newcomer\n")],
  ["exempt through a merged PR", 182, (github: FakeGitHub) => github.addMergedPullRequest(REPO, NEWCOMER)],
])(
  "a Deposit marked bad faith waits for the Maintainer's signature when its Contributor turns %s",
  async (_, number, turn) => {
    const { deliver, github } = keeperHarness(anvil, keeperKey);
    const openedPr = opened("pr", number, await anvil.now());
    await deliver("pull_request", openedPr);
    await anvil.mine(1, 5);
    await anvil.deposit(REPO, "pr", number);
    await deliver("pull_request", labeled("pr", number, "bona-fide:bad-faith"));
    turn(github);
    const pushed = structuredClone(openedPr);
    pushed.action = "synchronize";
    pushed.pull_request.labels = [{ name: "bona-fide:bad-faith" }];

    await deliver("pull_request", pushed);

    expect(await statusOf("pr", number)).toBe(ACTIVE);
  },
  30_000,
);

test.each([
  ["vouched for in VOUCHED.td", 183, (github: FakeGitHub) => github.setFile(REPO, "VOUCHED.td", "newcomer\n")],
  ["the author of a merged PR", 184, (github: FakeGitHub) => github.addMergedPullRequest(REPO, NEWCOMER)],
])(
  "a Deposit from a Contributor who turns out %s is refunded when the check runs",
  async (_, number, exempt) => {
    const { deliver, github } = keeperHarness(anvil, keeperKey);
    const openedPr = opened("pr", number, await anvil.now());
    await deliver("pull_request", openedPr);
    await anvil.mine(1, 5);
    await anvil.deposit(REPO, "pr", number);
    exempt(github);
    const before = await anvil.usdcBalance(anvil.contributor);

    await deliver("pull_request", { ...openedPr, action: "synchronize" });

    expect(await anvil.usdcBalance(anvil.contributor)).toBe(before + ONE_USDC);
    expect(await statusOf("pr", number)).toBe(REFUNDED);
  },
  30_000,
);
