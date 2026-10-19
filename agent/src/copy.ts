import type { Address } from "viem";
import type { BountyReport } from "./bounties.ts";
import type {
  DepositRules,
  DepositState,
  MadeDeposit,
  RefundPlan,
  SignedDepositPlan,
  Target,
  TwoStepPlan,
} from "./deposits.ts";

const WORDS = {
  pr: { noun: "PR", accepted: "Merged or accepted", notAccepted: "Not merged", settled: "merged or accepted" },
  issue: { noun: "issue", accepted: "Accepted", notAccepted: "Not accepted", settled: "accepted" },
} as const;

export function itemName({ kind, number }: Target): string {
  return `${WORDS[kind].noun} #${number}`;
}

/** When the Keeper refunds a Deposit early, as "the PR is merged or accepted". */
export function settled({ kind }: Pick<Target, "kind">): string {
  return `the ${WORDS[kind].noun} is ${WORDS[kind].settled}`;
}

export function addressLink(explorerUrl: string, address: Address): string {
  return `${explorerUrl.replace(/\/+$/, "")}/address/${address}`;
}

/** The rules in the words the App's check uses, for the agent and the person it works for. */
export function describeRules(rules: DepositRules): string {
  const { binding, pendingBinding, activeDeposit } = rules;
  const item = itemName(rules);
  const lines: string[] = [];
  if (!binding) {
    lines.push(`Bona Fide isn't active for ${rules.repo}, so no Deposit can be made there yet.`);
  } else {
    lines.push(
      `${rules.repo} asks for a refundable Deposit of ${binding.amountUsdc} USDC on ${item}.`,
      `- ${WORDS[rules.kind].accepted}: refunded in full.`,
      `- ${WORDS[rules.kind].notAccepted}: refunded in full when the Timeout ends, ${days(binding.timeoutDays)} after the Deposit.`,
    );
    if (binding.forfeitPercent > 0) {
      lines.push(
        `- Bad faith, signed by a Maintainer: up to ${binding.forfeitPercent}% funds open source, and the rest is refunded.`,
      );
    }
    if (activeDeposit) {
      lines.push(
        `${item} already has an active Deposit of ${activeDeposit.amountUsdc} USDC, from ${activeDeposit.depositor}. No other Deposit can be made for it until that one is refunded or forfeited.`,
      );
    } else if (!rules.withinLimit) {
      lines.push(
        `No Deposit has been made for it yet. ${binding.amountUsdc} USDC is above your limit of ${rules.limitUsdc} USDC, so these tools won't prepare it. Ask the person you work for to raise MAX_DEPOSIT_USDC or to make the Deposit themselves.`,
      );
    } else {
      lines.push(
        `No Deposit has been made for it yet. ${binding.amountUsdc} USDC is within your limit of ${rules.limitUsdc} USDC.`,
      );
    }
  }
  if (pendingBinding) {
    lines.push(
      `A new Binding takes effect at ${pendingBinding.effectiveAt}: a Deposit of ${pendingBinding.amountUsdc} USDC with a Timeout of ${days(pendingBinding.timeoutDays)}.${binding ? " Deposits made before then keep the current terms." : ""}`,
    );
  }
  return lines.join("\n");
}

export function describeSignedPlan({ submit, circleCommand, amountUsdc, expiresAt }: SignedDepositPlan): string {
  const lines = [
    `Sign typedData with the wallet ${submit.from}. Then call submit_signed_deposit with the submit fields and the signature, before ${expiresAt}.`,
    `The signature lets the escrow take exactly ${amountUsdc} USDC from ${submit.from} for ${itemName(submit)} in ${submit.repo}, once. Refunds go back to ${submit.from}.`,
  ];
  if (circleCommand) {
    lines.push(
      "With a Circle agent wallet, this command prints the signature. The wallet must already be deployed on Arc, which happens with its first transaction:",
      circleCommand,
    );
  }
  return lines.join("\n");
}

export function describeTwoStepPlan({ from, steps }: TwoStepPlan): string {
  const lines = [`Send these two transactions from ${from}, in this order. Refunds go back to ${from}.`];
  steps.forEach((step, i) => {
    lines.push(`${i + 1}. ${step.description}`);
    if (step.circleCommand) lines.push(`   With a Circle agent wallet: ${step.circleCommand}`);
  });
  return lines.join("\n");
}

export function describeMadeDeposit(made: MadeDeposit): string {
  return [
    `Deposited ${made.amountUsdc} USDC for ${itemName(made)} in ${made.repo}, from ${made.depositor}. Transaction: ${made.txHash}.`,
    `It is refunded in full to ${made.depositor} once ${settled(made)}, or when the Timeout ends at ${made.deadline}, unless a Maintainer signs a Forfeit before then.`,
  ].join("\n");
}

export function describeDepositState(state: DepositState): string {
  const { deposit } = state;
  const item = capitalized(`${itemName(state)} in ${state.repo}`);
  if (!deposit) return `${item} has no Deposit.`;
  const lines = [
    `${item} has a Deposit of ${deposit.amountUsdc} USDC from ${deposit.depositor} (Serial ${deposit.serial}).`,
  ];
  if (state.status === "refunded") {
    lines.push(`It was refunded: ${deposit.amountUsdc} USDC went back to ${deposit.depositor}.`);
  } else if (state.status === "forfeited") {
    lines.push(
      `It was forfeited by its Maintainer's signed verdict: ${deposit.outcome!.forfeitedUsdc} USDC went to the Forfeit sink, which funds open-source maintainers, and ${deposit.outcome!.refundedUsdc} USDC back to ${deposit.depositor}.`,
    );
  } else if (deposit.timeoutPassed) {
    lines.push(
      `It is active, and its Timeout ended at ${deposit.deadline}, so anyone can Refund it now. prepare_refund prepares the transaction; the Refund goes to ${deposit.depositor}, whoever sends it.`,
    );
  } else {
    lines.push(
      `It is active. The Keeper refunds it in full once ${settled(state)}. Otherwise anyone can Refund it once the Timeout ends at ${deposit.deadline}, ${timeLeft(deposit.secondsLeft)} from now.`,
    );
    if (deposit.forfeitPercent > 0) {
      lines.push(
        `Until then a Maintainer can forfeit it with a signed bad-faith verdict: up to ${deposit.forfeitPercent}% funds open-source maintainers, and the rest is refunded.`,
      );
    }
  }
  if (state.explorerUrl) lines.push(`The Depositor on the explorer: ${state.explorerUrl}`);
  return lines.join("\n");
}

export function describeRefundPlan({ from, depositor, amountUsdc, step }: RefundPlan): string {
  const lines = [
    `Send this transaction from ${from}. ${amountUsdc} USDC goes back to the Depositor, ${depositor}, whoever sends it.`,
    `1. ${step.description}`,
  ];
  if (step.circleCommand) lines.push(`   With a Circle agent wallet: ${step.circleCommand}`);
  return lines.join("\n");
}

/** How a PR's author names their Payee, as the App reads it. */
const PAYEE_RULE =
  "To name your Payee, write a line of its own, `Bounty wallet: 0x…`, in your PR's description or in a comment of your own on the PR. Only the PR's author's words count, and only a description or comment nobody else has edited since. The latest line wins: a comment over the description, a later comment over an earlier one, and in one text the last line.";

const KEEPER_LIMITS = {
  off: () => "Keeper payouts are off in this wallet",
  "per-payout": (report: BountyReport) =>
    `${report.bounty!.amountUsdc} USDC is above the wallet's per-payout limit of ${report.wallet!.perPayoutLimitUsdc} USDC`,
  period: (report: BountyReport) =>
    `the Keeper has only ${report.wallet!.keeperAllowanceUsdc} USDC left to pay in this period`,
} as const;

export function describeBounty(report: BountyReport): string {
  const { wallet, bounty } = report;
  const issue = `issue #${report.issue} in ${report.repo}`;
  const lines: string[] = [];
  if (!report.maintainer) {
    lines.push(
      `Bona Fide isn't active for ${report.repo}, so it has no Bounty wallet and ${issue} has no Bounty. A repo's Bounty wallet is the one its Maintainer, bound on-chain, created.`,
    );
  } else if (!wallet || !bounty) {
    lines.push(`${report.repo}'s Maintainer hasn't created a Bounty wallet, so ${issue} has no Bounty.`);
  } else if (bounty.status === "none") {
    lines.push(`${capitalized(issue)} has no Bounty in the repo's Bounty wallet, ${wallet.address}.`);
  } else if (bounty.status === "cancelled") {
    lines.push(`The Bounty on ${issue} was cancelled, so there is nothing to pay.`);
  } else if (bounty.status === "paid") {
    lines.push(`The Bounty on ${issue} was paid: ${bounty.amountUsdc} USDC to ${bounty.payee}.`);
  } else {
    lines.push(
      `${capitalized(issue)} has an open Bounty of ${bounty.amountUsdc} USDC (Serial ${bounty.serial}) in the repo's Bounty wallet, ${wallet.address}. It is paid in full, once, when a PR that closes the issue is merged, to the Payee its author names.`,
    );
    if (bounty.keeperLimit) {
      lines.push(
        `${capitalized(KEEPER_LIMITS[bounty.keeperLimit](report))}, so only the Maintainer can pay it: with their signature, which anyone can relay, or directly.`,
      );
    } else {
      lines.push(
        `The wallet lets the Keeper pay it: Keeper payouts are on, and it is within the per-payout limit of ${wallet.perPayoutLimitUsdc} USDC and the ${wallet.keeperAllowanceUsdc} USDC the Keeper has left this period. The App pays it only once its checks on the merged PR pass; otherwise the Maintainer decides.`,
      );
    }
  }
  if (bounty?.status === "open") lines.push(PAYEE_RULE);
  if (report.payee) {
    const { address, line, problem } = report.payee;
    lines.push(
      problem ? `The Bounty wallet can't pay ${address}: ${problem}. Name another wallet.` : `Your line: ${line}`,
    );
  }
  if (report.explorerUrl) lines.push(`The Bounty wallet on the explorer: ${report.explorerUrl}`);
  return lines.join("\n");
}

/** Like "2 days 3 hours", for a time left. */
export function timeLeft(seconds: number): string {
  const days = Math.floor(seconds / 86_400);
  const hours = Math.floor((seconds % 86_400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  if (days > 0) return hours > 0 ? `${count(days, "day")} ${count(hours, "hour")}` : count(days, "day");
  if (hours > 0) return minutes > 0 ? `${count(hours, "hour")} ${count(minutes, "minute")}` : count(hours, "hour");
  if (minutes > 0) return count(minutes, "minute");
  return "less than a minute";
}

function count(n: number, unit: string): string {
  return `${n} ${unit}${n === 1 ? "" : "s"}`;
}

export function capitalized(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** A tool result's text: the summary, then the details as JSON. */
export function withDetails(summary: string, details: unknown): string {
  return `${summary}\n\nDetails:\n${JSON.stringify(details, null, 2)}`;
}

function days(n: number): string {
  return n === 1 ? "1 day" : `${n} days`;
}
