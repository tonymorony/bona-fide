import type { DepositRules, MadeDeposit, SignedDepositPlan, Target, TwoStepPlan } from "./deposits.ts";

const WORDS = {
  pr: { noun: "PR", accepted: "Merged or accepted" },
  issue: { noun: "issue", accepted: "Accepted" },
} as const;

export function itemName({ kind, number }: Target): string {
  return `${WORDS[kind].noun} #${number}`;
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
      `- No decision within ${days(binding.timeoutDays)}: refunded in full.`,
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
      `A new Binding takes effect at ${pendingBinding.effectiveAt}: a Deposit of ${pendingBinding.amountUsdc} USDC, refunded after ${days(pendingBinding.timeoutDays)} without a decision.${binding ? " Deposits made before then keep the current terms." : ""}`,
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
  const settled = made.kind === "pr" ? "merged or accepted" : "accepted";
  return [
    `Deposited ${made.amountUsdc} USDC for ${itemName(made)} in ${made.repo}, from ${made.depositor}. Transaction: ${made.txHash}.`,
    `It is refunded in full to ${made.depositor} once the ${WORDS[made.kind].noun} is ${settled}, or after ${made.deadline} if no one decides.`,
  ].join("\n");
}

/** A tool result's text: the summary, then the details as JSON. */
export function withDetails(summary: string, details: unknown): string {
  return `${summary}\n\nDetails:\n${JSON.stringify(details, null, 2)}`;
}

function days(n: number): string {
  return n === 1 ? "1 day" : `${n} days`;
}
