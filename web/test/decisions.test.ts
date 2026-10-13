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

test("a decision the page doesn't know yet is shown as the App names it", () => {
  const words = decisionWords({ ...triage, type: "audit", action: "logged", suggestion: null, inputs: null });

  expect(words).toMatchObject({ kind: "audit", done: "logged", read: null });
});
