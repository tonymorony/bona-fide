import type { Address, Hex } from "viem";
import { usdc } from "../copy.ts";
import { fullName, type Repo } from "../ports.ts";

// The Bounty notes. The reasons come from a model, already made plain text; check names come
// from the repo's CI, already made safe.

/** The Bounty page, where the Maintainer signs a Payout: ?repo=owner/name&issue=N, and &payee=0x… once one is known. */
export function bountyLink(pageUrl: string, repo: Repo, issue: number, payee: Address | null): string {
  const url = new URL(pageUrl);
  url.searchParams.set("repo", fullName(repo));
  url.searchParams.set("issue", String(issue));
  if (payee) url.searchParams.set("payee", payee);
  return url.toString();
}

/** The repo page, which lists the repo's Bounties: ?repo=owner/name. It sits beside the Bounty page. */
export function repoPageLink(bountyPageUrl: string, repo: Repo): string {
  const url = new URL("repo.html", bountyPageUrl);
  url.searchParams.set("repo", fullName(repo));
  return url.toString();
}

export function transactionLink(explorerUrl: string, txHash: Hex): string {
  return `${explorerUrl.replace(/\/+$/, "")}/tx/${txHash}`;
}

export interface PaidFacts {
  /** Where the note goes: the PR or the issue. */
  on: "pr" | "issue";
  issue: number;
  /** The merged PR that closed the issue, if the App knows it. */
  pr: number | null;
  amount: bigint;
  payee: Address;
  /** Who paid it: the Keeper, the Maintainer's signature, or someone the App didn't see. */
  by: "keeper" | "signature" | "unknown";
  txLink: string;
}

/** The note on the PR and the issue once a Bounty is paid. Every Payout links its transaction. */
export function bountyPaidNote({ on, issue, pr, amount, payee, by, txLink }: PaidFacts): string {
  const what = on === "pr" ? `The Bounty on #${issue}` : "This issue's Bounty";
  const forPr = pr !== null && on === "issue" ? ` for #${pr}` : "";
  const how = {
    keeper:
      "The Keeper paid it: the PR was merged and closes the issue, its checks passed, it was within the Maintainer's limits, and an automated reviewer agreed it resolves the issue.",
    signature: "The Maintainer signed the Payout.",
    unknown: "",
  }[by];
  return [
    `**Bounty paid: ${usdc(amount)}**`,
    "",
    `${what}, **${usdc(amount)}**, was paid in full${forPr} to ${payee}.${how ? ` ${how}` : ""}`,
    "",
    `[View the Payout on Arc](${txLink})`,
  ].join("\n");
}

export interface PostedFacts {
  issue: number;
  amount: bigint;
  /**
   * Who pays it once a PR that closes the issue is merged: the Keeper, when the witnesses hold, or
   * only the Maintainer, such as with the Keeper's payouts off or `bounties: off`.
   */
  payer: "keeper" | "maintainer";
  /** The wallet's per-payout limit, when the Bounty is above it. */
  aboveLimit: bigint | null;
  repoLink: string;
}

/** The note on the issue when a Bounty is posted on it, so Contributors see it where they work. */
export function bountyPostedNote({ issue, amount, payer, aboveLimit, repoLink }: PostedFacts): string {
  // "The first merged PR" is the Keeper's rule, and it reads the checks once, at the merge: it holds
  // a Bounty when another PR that closes the issue was merged first. A held Bounty is the
  // Maintainer's to pay, to anyone, or to cancel.
  const paid =
    payer === "keeper"
      ? "The Keeper pays the Bounty in full to the author of the first merged PR that closes this issue, within the Maintainer's limits. It pays only if the PR's checks are green when it's merged and an automated reviewer agrees it resolves the issue. Otherwise the Maintainer decides, and can pay it by signing the Payout."
      : "Once your PR is merged, the Maintainer can pay the Bounty to you in full by signing the Payout.";
  const limit =
    aboveLimit === null
      ? ""
      : ` It is above the wallet's per-payout limit of ${usdc(aboveLimit)}, so the Keeper won't pay it on its own.`;
  return [
    `**Bounty: ${usdc(amount)}**`,
    "",
    `This issue has a Bounty of **${usdc(amount)}**, reserved in the repo's Bounty wallet.${limit}`,
    "",
    "To receive it:",
    "",
    `1. Open a PR that closes this issue, such as with \`Fixes #${issue}\` in its description.`,
    // A fenced block, as in the payee note: a Contributor who copies the line copies no backticks.
    "2. Add this line, with your wallet, to the PR description or to a comment of your own on the PR:",
    "",
    "   ```",
    "   Bounty wallet: 0xYourWalletAddress",
    "   ```",
    "",
    `3. ${paid}`,
    "",
    `[See the Bounty](${repoLink})`,
  ].join("\n");
}

export interface PayeeFacts {
  issue: number;
  amount: bigint;
  author: string;
  /** Why the wallet named so far can't be paid, if one was named: what was written, and the problem. */
  problem: string | null;
}

/** The note asking the PR's author which wallet the Bounty goes to. */
export function payeeNeededNote({ issue, amount, author, problem }: PayeeFacts): string {
  return [
    "**Bounty: which wallet should it go to?**",
    "",
    `This PR closed #${issue}, which has a Bounty of **${usdc(amount)}**. @${author}, to receive it, add a line like this to the PR description or to a comment of your own:`,
    "",
    "```",
    "Bounty wallet: 0xYourWalletAddress",
    "```",
    "",
    ...(problem ? [problem, ""] : []),
    "Only your own words count, and the latest line wins. The Bounty is checked again as soon as you add it.",
  ].join("\n");
}

export interface HoldFacts {
  issue: number;
  amount: bigint;
  /** Why the Keeper won't pay it on its own: one sentence that ends without a full stop. */
  why: string;
  /** The model's reasons, if it was asked and gave any. */
  reasons: string[];
  owner: Address;
  signLink: string;
}

/** The note on the PR when the Keeper leaves a Bounty to the Maintainer. It moves nothing. */
export function bountyHeldNote({ issue, amount, why, reasons, owner, signLink }: HoldFacts): string {
  const lines = [
    `**Bounty waiting for the Maintainer: ${usdc(amount)}**`,
    "",
    `This PR closed #${issue}, which has a Bounty of **${usdc(amount)}**. The Keeper won't pay it on its own: ${why}.`,
  ];
  if (reasons.length > 0) {
    lines.push(
      "",
      "An automated reviewer read the issue and this PR. This is only a suggestion: the Maintainer decides.",
      "",
      ...reasons.map((reason) => `- ${reason}`),
    );
  }
  lines.push(
    "",
    `- **To pay it:** the Maintainer [signs the Payout](${signLink}) with ${owner}.`,
    "- **If not:** nothing moves. The Bounty stays reserved until the Maintainer pays or cancels it.",
  );
  return lines.join("\n");
}
