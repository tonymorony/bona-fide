import { expect, test } from "vitest";
import { decisionWords } from "../src/decisions.ts";
import type { Decision } from "../src/endpoints.ts";

// How the repo page words each decision in the App's log.

const triage: Decision = {
  id: "a",
  at: new Date("2026-09-01T12:00:00Z"),
  repo: "acme/widgets",
  item: { kind: "pr", number: 7 },
  serial: "3",
  type: "triage",
  inputs: {
    titleChars: 13,
    bodyChars: 20_000,
    bodyLeftOut: 10_000,
    files: 100,
    filesLeftOut: 20,
    diffChars: 60_000,
    diffLeftOut: 0,
  },
  suggestion: { verdict: "accept", reasons: ["It fixes the typo it names."] },
  witnesses: [],
  action: "noted-accept",
  txHash: null,
  outcome: "decided",
  cost: { model: "claude-opus-5", inputTokens: 1_200, outputTokens: 80, usd: 0.008 },
};

test("a triage decision says what the model suggested, what it read, what was done and what it cost", () => {
  expect(decisionWords(triage)).toEqual({
    kind: "Automated review",
    outcome: "Decided",
    suggestion: "Suggested: good-faith work",
    done: "Posted a note suggesting the Maintainer accept it.",
    read: "Read: title 13 characters; body 20,000 characters (10,000 more left out); 120 changed files (100 listed); diff 60,000 characters.",
    cost: "Model cost: claude-opus-5: 1,200 tokens in, 80 out, about $0.008.",
    pr: null,
  });
});

test.each([
  [{ suggestion: { verdict: "bad-faith", reasons: [] }, action: "drafted-verdict" }, "Suggested: likely bad faith"],
  [{ suggestion: { verdict: "unsure", reasons: [] }, action: "silent" }, "Suggested: unsure"],
  [{ suggestion: null, action: "silent" }, "The model gave no suggestion."],
  [{ suggestion: null, action: "failed: rate limited" }, null],
])("%j is worded %j", (more, suggestion) => {
  expect(decisionWords({ ...triage, ...more, outcome: "escalated" })).toMatchObject({
    suggestion,
    outcome: "Left to the Maintainer",
  });
});

test("a failed review names the failure, and a model without a price has no estimate", () => {
  const words = decisionWords({
    ...triage,
    action: "failed: rate limited",
    suggestion: null,
    cost: { model: "claude-next", inputTokens: 5, outputTokens: 1, usd: null },
  });

  expect(words.done).toBe("The model couldn't be asked (rate limited). Nothing was posted.");
  expect(words.cost).toBe("Model cost: claude-next: 5 tokens in, 1 out, no price on file.");
});

test("an early Refund says it refunded the Deposit, with no suggestion, reading or cost", () => {
  expect(
    decisionWords({
      ...triage,
      type: "early-refund",
      inputs: { source: "check" },
      suggestion: null,
      action: "refunded",
      cost: null,
    }),
  ).toEqual({
    kind: "Early Refund",
    outcome: "Decided",
    suggestion: null,
    done: "Refunded the Deposit in full to its Depositor.",
    read: null,
    cost: null,
    pr: null,
  });
});

const waive: Decision = {
  ...triage,
  serial: null,
  type: "waive",
  inputs: {
    login: "newcomer",
    refunds: 4,
    repos: 3,
    otherRefunds: 1,
    forfeits: 0,
    active: 0,
    accountAgeDays: 1_826,
    publicRepos: 12,
    followers: 1,
    mergedElsewhere: 57,
  },
  suggestion: { verdict: "waive", reasons: ["Four accepted Deposits in three repos."] },
  action: "waived",
  cost: { model: "claude-opus-5", inputTokens: 600, outputTokens: 40, usd: 0.004 },
};

test("a Record Exemption says what the model suggested, the record it read, what was done and what it cost", () => {
  expect(decisionWords(waive)).toEqual({
    kind: "Record Exemption",
    outcome: "Decided",
    suggestion: "Suggested: no Deposit needed",
    done: "Passed the check: no Deposit needed.",
    read: "Read: @newcomer's record in public repos: 4 Refunds on accepted work in 3 repos, 1 other Refund, 0 Forfeits, 0 open Deposits. On GitHub: account 1,826 days old, 12 public repos, 1 follower, 57 merged PRs elsewhere.",
    cost: "Model cost: claude-opus-5: 600 tokens in, 40 out, about $0.004.",
    pr: null,
  });
});

test.each([
  [
    { suggestion: { verdict: "require", reasons: [] }, action: "required" },
    "Suggested: ask for the Deposit",
    "Kept asking for the Deposit.",
  ],
  [
    { suggestion: { verdict: "flag", reasons: [] }, action: "flagged" },
    "Suggested: ask for the Deposit, and flag the record for the Maintainer",
    "Kept asking for the Deposit, and posted a note for the Maintainer.",
  ],
  [{ suggestion: null, action: "silent" }, "The model gave no suggestion.", "Kept asking for the Deposit."],
  [
    { suggestion: null, action: "failed: rate limited" },
    null,
    "The model couldn't be asked (rate limited). The Deposit is still needed.",
  ],
])("a Record Exemption held back, %j, is worded %j and %j", (more, suggestion, done) => {
  expect(decisionWords({ ...waive, ...more, outcome: "escalated" })).toMatchObject({
    outcome: "Left to the Maintainer",
    suggestion,
    done,
  });
});

test("a decision the page doesn't know yet is shown as the App names it", () => {
  const words = decisionWords({ ...triage, type: "audit", action: "logged", suggestion: null, inputs: null });

  expect(words).toMatchObject({ kind: "audit", done: "logged", read: null });
});

const pay: Decision = {
  ...triage,
  item: { kind: "issue", number: 12 },
  serial: "2",
  type: "pay",
  inputs: { source: "merge", pr: 41, method: "keeper", titleChars: 30, bodyChars: 400, bodyLeftOut: 0 },
  suggestion: { verdict: "resolves", reasons: ["PR #41 fixes the crash issue #12 describes."] },
  witnesses: [
    { name: "Merged", value: "yes, by @mo" },
    { name: "Closes the issue", value: "yes: Fixes #12" },
    { name: "Payee wallet", value: "0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed" },
  ],
  action: "paid",
  txHash: `0x${"ab".repeat(32)}`,
  outcome: "decided",
};

test("a Bounty Payout names its PR, what the model read and suggested, and that the Bounty was paid", () => {
  expect(decisionWords(pay)).toEqual({
    kind: "Bounty Payout",
    outcome: "Decided",
    suggestion: "Suggested: the PR resolves the issue",
    done: "Paid the Bounty in full to its payee.",
    read: "Read: title 30 characters; body 400 characters.",
    cost: "Model cost: claude-opus-5: 1,200 tokens in, 80 out, about $0.008.",
    pr: 41,
  });
});

test("a Payout the Maintainer signed and Bona Fide relayed says so", () => {
  const relayed = { ...pay, inputs: { source: "page", pr: 41, method: "signature" }, suggestion: null, cost: null };

  expect(decisionWords({ ...relayed, outcome: "escalated" })).toMatchObject({
    kind: "Bounty Payout",
    outcome: "Left to the Maintainer",
    suggestion: null,
    done: "Sent the Maintainer's signed Payout: the Bounty went in full to its payee.",
    read: null,
    pr: 41,
  });
});

test.each([
  [
    { verdict: "partial", reasons: [] },
    "held: model said partial",
    "Suggested: the PR resolves the issue only in part",
    "Paid nothing: an automated reviewer thinks the PR only partly resolves the issue. The Maintainer can pay it from the Bounty page.",
  ],
  [
    { verdict: "unrelated", reasons: [] },
    "held: above the per-payout limit",
    "Suggested: the PR doesn't resolve the issue",
    "Paid nothing: it's above the per-payout limit. The Maintainer can pay it from the Bounty page.",
  ],
  [null, "silent", null, "Paid nothing. The Maintainer can pay it from the Bounty page."],
  [
    null,
    "failed: rate limited",
    null,
    "Bona Fide couldn't finish (rate limited). Nothing was paid. The Maintainer can pay it from the Bounty page.",
  ],
] as const)("a Bounty held with %j and %j is worded %j and %j", (suggestion, action, suggested, done) => {
  const held: Decision = {
    ...pay,
    type: "hold",
    action,
    suggestion: suggestion && { ...suggestion, reasons: [] },
    txHash: null,
    outcome: "escalated",
  };

  expect(decisionWords(held)).toMatchObject({
    kind: "Bounty held",
    outcome: "Left to the Maintainer",
    suggestion: suggested,
    done,
    pr: 41,
  });
});

test("a Bounty decision without a PR number, or with one that isn't a number, links no PR", () => {
  expect(decisionWords({ ...pay, inputs: null }).pr).toBeNull();
  expect(decisionWords({ ...pay, inputs: { pr: "41" } }).pr).toBeNull();
  expect(decisionWords({ ...pay, inputs: { pr: -1 } }).pr).toBeNull();
  expect(decisionWords({ ...triage, inputs: { pr: 41 } }).pr).toBeNull();
});

test.each([
  ["held: not linked", "Paid nothing: GitHub doesn't link the PR as closing the issue."],
  ["held: checks not green", "Paid nothing: the PR's checks weren't green."],
  ["held: Keeper payouts off", "Paid nothing: Keeper payouts are off."],
  ["held: wallet refused (InvalidRecipient)", "Paid nothing: the Bounty wallet refused it: InvalidRecipient."],
  ["held: something new", "Paid nothing: something new."],
  ["failed: transaction reverted", "Bona Fide couldn't finish (transaction reverted). Nothing was paid."],
])("the App's %j reads as %j", (action, done) => {
  expect(decisionWords({ ...pay, type: "hold", action, outcome: "escalated" }).done).toBe(
    `${done} The Maintainer can pay it from the Bounty page.`,
  );
});
