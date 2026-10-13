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
