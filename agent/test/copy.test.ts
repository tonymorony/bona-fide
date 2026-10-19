import { expect, test } from "vitest";
import { describeDepositState, describeMadeDeposit, describeRules } from "../src/copy.ts";
import type { DepositRules, DepositState, MadeDeposit } from "../src/deposits.ts";

// The words the agent reads back: the Timeout said one way, as the App's check says it.

const DEPOSITOR = "0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed";
const ESCROW = "0x1111111111111111111111111111111111111111";
const KEY = `0x${"ab".repeat(32)}` as const;
const DEADLINE = "2026-10-26T12:00:00.000Z";

const RULES: DepositRules = {
  repo: "acme/widgets",
  kind: "pr",
  number: 7,
  key: KEY,
  repoId: KEY,
  chainId: 5042002,
  escrow: ESCROW,
  usdc: "0x3600000000000000000000000000000000000000",
  binding: { amount: "1000000", amountUsdc: "1", forfeitPercent: 50, timeoutDays: 7, maintainer: DEPOSITOR },
  pendingBinding: null,
  activeDeposit: null,
  limitUsdc: "5",
  withinLimit: true,
};

test("the rules say a PR not merged is refunded when the Timeout ends, counted from the Deposit", () => {
  expect(describeRules(RULES)).toBe(
    [
      "acme/widgets asks for a refundable Deposit of 1 USDC on PR #7.",
      "- Merged or accepted: refunded in full.",
      "- Not merged: refunded in full when the Timeout ends, 7 days after the Deposit.",
      "- Bad faith, signed by a Maintainer: up to 50% funds open source, and the rest is refunded.",
      "No Deposit has been made for it yet. 1 USDC is within your limit of 5 USDC.",
    ].join("\n"),
  );
});

test("an issue's rules say not accepted, and a pending Binding names its Timeout", () => {
  const text = describeRules({
    ...RULES,
    kind: "issue",
    pendingBinding: {
      amount: "2000000",
      amountUsdc: "2",
      forfeitPercent: 50,
      timeoutDays: 1,
      effectiveAt: "2026-10-20T12:00:00.000Z",
    },
  });

  expect(text).toContain("- Accepted: refunded in full.\n");
  expect(text).toContain("- Not accepted: refunded in full when the Timeout ends, 7 days after the Deposit.\n");
  expect(text).toContain(
    "A new Binding takes effect at 2026-10-20T12:00:00.000Z: a Deposit of 2 USDC with a Timeout of 1 day. Deposits made before then keep the current terms.",
  );
});

test("a Deposit just made is refunded once the PR is settled, or when the Timeout ends", () => {
  const made: MadeDeposit = {
    repo: "acme/widgets",
    kind: "pr",
    number: 7,
    txHash: KEY,
    depositor: DEPOSITOR,
    amount: "1000000",
    amountUsdc: "1",
    deadline: DEADLINE,
  };

  expect(describeMadeDeposit(made)).toContain(
    `It is refunded in full to ${DEPOSITOR} once the PR is merged or accepted, or when the Timeout ends at ${DEADLINE}.`,
  );
});

test("an active Deposit can be refunded by anyone once the Timeout ends", () => {
  const state: DepositState = {
    repo: "acme/widgets",
    kind: "pr",
    number: 7,
    key: KEY,
    escrow: ESCROW,
    status: "active",
    deposit: {
      depositor: DEPOSITOR,
      amount: "1000000",
      amountUsdc: "1",
      serial: "1",
      deadline: DEADLINE,
      timeoutPassed: false,
      secondsLeft: 2 * 86_400 + 3 * 3600,
      forfeitPercent: 0,
      outcome: null,
    },
    checkedAt: "2026-10-24T09:00:00.000Z",
    explorerUrl: null,
  };

  expect(describeDepositState(state)).toContain(
    `It is active. The Keeper refunds it in full once the PR is merged or accepted. Otherwise anyone can Refund it once the Timeout ends at ${DEADLINE}, 2 days 3 hours from now.`,
  );
});
