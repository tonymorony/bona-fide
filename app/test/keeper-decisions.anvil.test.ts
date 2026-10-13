import { afterAll, beforeAll, expect, test } from "vitest";
import { createTimeoutRefunder } from "../src/keeper/timeouts.ts";
import { keyOf, repoIdOf, type Kind } from "../src/keys.ts";
import type { Anvil } from "./support/anvil.ts";
import { keeperHarness, startKeeperAnvil } from "./support/keeper.ts";
import { NEWCOMER, payload, REPO, review } from "./support/webhooks.ts";

// Each early Refund the Keeper makes because a Maintainer accepted the PR or issue is a decision in
// the log, with the facts it acted on and its transaction. Refunds that decide nothing, at the
// Timeout or of a Deposit the check doesn't count, aren't. Against the real escrow on anvil.

let anvil: Anvil;
let keeperKey: `0x${string}`;

beforeAll(async () => {
  ({ anvil, keeperKey } = await startKeeperAnvil());
  await anvil.bind(REPO);
}, 120_000);

afterAll(() => anvil?.stop());

const TX = /^0x[0-9a-f]{64}$/;

function closedPr(number: number, o: { private?: boolean } = {}) {
  const body = payload("pull_request", "closed", { author: NEWCOMER, ...o });
  body.number = number;
  body.pull_request.number = number;
  body.pull_request.merged = true;
  body.pull_request.merged_by = { login: "mo" };
  body.sender.login = "mo";
  return body;
}

// GitHub's examples have no issues.closed payload: this is the recorded reopened one with the
// fields a close sets.
function closedIssue(number: number) {
  const body = payload("issues", "reopened", { author: NEWCOMER, labels: [] });
  body.action = "closed";
  body.issue.number = number;
  body.issue.state = "closed";
  body.issue.state_reason = "completed";
  body.sender.login = "mo";
  return body;
}

function opened(kind: Kind, number: number, at: Date) {
  const event = kind === "pr" ? "pull_request" : "issues";
  const body = payload(event, "opened", { author: NEWCOMER, createdAt: at.toISOString(), labels: [] });
  (kind === "pr" ? body.pull_request : body.issue).number = number;
  if (kind === "pr") body.pull_request.head.sha = String(number).padStart(40, "0");
  return body;
}

/** A Deposit on an item opened just before it, so the check counts it. */
async function depositedOn(harness: ReturnType<typeof keeperHarness>, kind: Kind, number: number) {
  const body = opened(kind, number, await anvil.now());
  await harness.deliver(kind === "pr" ? "pull_request" : "issues", body);
  await anvil.mine(1, 5);
  await anvil.deposit(REPO, kind, number);
  return body;
}

async function mined(txHash: string | null) {
  const receipt = await anvil.client.getTransactionReceipt({ hash: txHash as `0x${string}` });
  return receipt.status;
}

test("merging a PR logs the Refund as decided, with who merged it and its transaction", async () => {
  const harness = keeperHarness(anvil, keeperKey);
  await anvil.deposit(REPO, "pr", 201);

  await harness.deliver("pull_request", closedPr(201));

  expect(harness.logged).toEqual([
    {
      id: expect.any(String),
      at: expect.stringMatching(/^\d{4}-\d\d-\d\dT/),
      repo: REPO,
      private: false,
      item: { kind: "pr", number: 201 },
      serial: expect.stringMatching(/^\d+$/),
      type: "early-refund",
      inputs: { source: "webhook pull_request closed" },
      suggestion: null,
      witnesses: [
        {
          name: "Deposit",
          value: expect.stringMatching(new RegExp(`^Serial \\d+: 1 USDC from ${anvil.contributor}$`)),
        },
        { name: "Merged", value: "yes" },
        { name: "Merged by", value: "@mo" },
      ],
      action: "refunded",
      txHash: expect.stringMatching(TX),
      outcome: "decided",
      cost: null,
    },
  ]);
  expect(await mined(harness.logged[0]!.txHash)).toBe("success");
}, 30_000);

test("closing an issue as completed logs the Refund, with who closed it", async () => {
  const harness = keeperHarness(anvil, keeperKey);
  await anvil.deposit(REPO, "issue", 202);

  await harness.deliver("issues", closedIssue(202));

  expect(harness.logged).toMatchObject([
    {
      item: { kind: "issue", number: 202 },
      type: "early-refund",
      inputs: { source: "webhook issues closed" },
      action: "refunded",
      outcome: "decided",
    },
  ]);
  expect(harness.logged[0]!.witnesses.slice(1)).toEqual([
    { name: "Closed as", value: "completed" },
    { name: "Closed by", value: "@mo, not the author" },
  ]);
  expect(await mined(harness.logged[0]!.txHash)).toBe("success");
}, 30_000);

test("the bona-fide:ok label logs the Refund, with the label as its witness", async () => {
  const harness = keeperHarness(anvil, keeperKey);
  await depositedOn(harness, "pr", 203);
  const body = payload("pull_request", "labeled", {
    author: NEWCOMER,
    label: "bona-fide:ok",
    labels: ["bona-fide:ok"],
  });
  body.pull_request.number = 203;

  await harness.deliver("pull_request", body);

  expect(harness.logged).toHaveLength(1);
  expect(harness.logged[0]).toMatchObject({
    item: { kind: "pr", number: 203 },
    action: "refunded",
    outcome: "decided",
  });
  expect(harness.logged[0]!.witnesses.slice(1)).toEqual([
    { name: "Label", value: "bona-fide:ok" },
    { name: "Marked bad faith", value: "no" },
  ]);
  expect(harness.logged[0]!.inputs).toEqual({ source: "check" });
  expect(await mined(harness.logged[0]!.txHash)).toBe("success");
}, 30_000);

test("a Maintainer's approval logs the Refund, naming the approver and their access", async () => {
  const harness = keeperHarness(anvil, keeperKey);
  const openedPr = await depositedOn(harness, "pr", 204);
  harness.github.setPermission(REPO, "mo", "write");
  harness.github.approve(REPO, 204, "mo");
  const approval = review("approved", "mo", {
    author: NEWCOMER,
    labels: [],
    createdAt: openedPr.pull_request.created_at,
    headSha: openedPr.pull_request.head.sha,
  });
  approval.pull_request.number = 204;

  await harness.deliver("pull_request_review", approval);

  expect(harness.logged).toHaveLength(1);
  expect(harness.logged[0]!.witnesses.slice(1)).toEqual([
    { name: "Approved by", value: "@mo, with write access" },
    { name: "Marked bad faith", value: "no" },
  ]);
  expect(await mined(harness.logged[0]!.txHash)).toBe("success");
}, 30_000);

test("a merge delivered twice logs one Refund", async () => {
  const harness = keeperHarness(anvil, keeperKey);
  await anvil.deposit(REPO, "pr", 205);

  await Promise.all([harness.deliver("pull_request", closedPr(205)), harness.deliver("pull_request", closedPr(205))]);

  expect(harness.logged).toHaveLength(1);
}, 30_000);

test("a merge with no active Deposit logs nothing", async () => {
  const harness = keeperHarness(anvil, keeperKey);

  await harness.deliver("pull_request", closedPr(206));

  expect(harness.logged).toEqual([]);
}, 30_000);

test("a merge in a private repo is logged as private, so it is never published", async () => {
  const harness = keeperHarness(anvil, keeperKey);
  await anvil.deposit(REPO, "pr", 207);

  await harness.deliver("pull_request", closedPr(207, { private: true }));

  expect(harness.logged).toMatchObject([{ private: true, action: "refunded" }]);
  expect(harness.log.latest(REPO, 50).map((d) => d.item.number)).not.toContain(207);
}, 30_000);

test("Refunds that decide nothing aren't logged: at the Timeout, or of a Deposit the check doesn't count", async () => {
  const harness = keeperHarness(anvil, keeperKey);
  // Made before its PR was opened, so the check ignores it and the Keeper refunds it when the PR opens.
  await anvil.deposit(REPO, "pr", 208);
  await anvil.mine(1, 3 * 60);
  await harness.deliver("pull_request", opened("pr", 208, await anvil.now()));
  // A collaborator's Deposit, which their Exemption makes needless.
  harness.github.setPermission(REPO, "newcomer", "write");
  await depositedOn(harness, "issue", 209);
  await harness.deliver("issues", { ...opened("issue", 209, await anvil.now()), action: "reopened" });
  harness.github.setPermission(REPO, "newcomer", "none");
  // One left to its Timeout.
  await depositedOn(harness, "pr", 210);
  await anvil.mine(1, 7 * 86_400 + 60);
  await createTimeoutRefunder({ escrow: harness.escrow, fromBlock: anvil.deployBlock }).tick();

  const statuses = await Promise.all(
    [
      ["pr", 208],
      ["issue", 209],
      ["pr", 210],
    ].map(([kind, number]) => harness.escrow.depositOf(keyFor(kind as Kind, number as number))),
  );
  expect(statuses.map((d) => d.status)).toEqual(["refunded", "refunded", "refunded"]);
  expect(harness.logged).toEqual([]);
}, 60_000);

function keyFor(kind: Kind, number: number) {
  return keyOf(repoIdOf(REPO), kind, number);
}
