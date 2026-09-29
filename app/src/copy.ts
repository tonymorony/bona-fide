import { formatUnits } from "viem";
import type { Exemption, NewTerms } from "./app.ts";
import { CONFIG_PATH, DAY_SECONDS, USDC_DECIMALS } from "./config.ts";
import type { Kind } from "./keys.ts";
import { ACCEPTED, WAIVER } from "./labels.ts";
import { fullName, type Binding, type Deposit, type Item, type PendingBinding, type Repo } from "./ports.ts";

const HOUR_SECONDS = 3600;

export interface Wording {
  title: string;
  summary: string;
}

// Closing a PR unmerged or an issue unaccepted is no verdict: its Deposit is refunded at the Timeout.
const WORDS: Record<Kind, { noun: string; accepted: string; notAccepted: string; notice: string }> = {
  pr: { noun: "PR", accepted: "Merged or accepted", notAccepted: "Not merged", notice: "check" },
  issue: { noun: "issue", accepted: "Accepted", notAccepted: "Not accepted", notice: "comment" },
};

export function exemptText(kind: Kind, exemption: Exemption, author: string): Wording {
  const noun = WORDS[kind].noun;
  const needsNone = `so this ${noun} needs no Deposit.`;
  const reasons: Record<Exemption, Wording> = {
    waiver: { title: "a Maintainer waived it", summary: `A Maintainer added the \`${WAIVER}\` label, ${needsNone}` },
    collaborator: { title: `@${author} is a collaborator`, summary: `@${author} can push to this repo, ${needsNone}` },
    vouched: { title: `@${author} is vouched for`, summary: `@${author} is vouched for in VOUCHED.td, ${needsNone}` },
    bot: {
      title: `@${author} is an allowed bot`,
      summary: `@${author} is on this repo's list of allowed bots, ${needsNone}`,
    },
    merged: {
      title: `@${author} has a merged PR here`,
      summary: `@${author} already has a merged PR in this repo, ${needsNone}`,
    },
    grandfathered: {
      title: "opened before Bona Fide started here",
      summary: `This ${noun} was opened before Bona Fide started in this repo, so it needs no Deposit.`,
    },
  };
  const { title, summary } = reasons[exemption];
  return { title: `No Deposit needed: ${title}`, summary };
}

export function acceptedText(kind: Kind): Wording {
  return {
    title: "No Deposit needed: a Maintainer accepted it",
    summary: `A Maintainer accepted this ${WORDS[kind].noun} with the \`${ACCEPTED}\` label, so it needs no Deposit.`,
  };
}

export function depositLink(pageUrl: string, item: Item): string {
  const url = new URL(pageUrl);
  url.searchParams.set("repo", fullName(item.repo));
  url.searchParams.set("kind", item.kind);
  url.searchParams.set("number", String(item.number));
  return url.toString();
}

export function setupLink(pageUrl: string, repo: Repo): string {
  const url = new URL(pageUrl);
  url.searchParams.set("repo", fullName(repo));
  return url.toString();
}

export function configProblemsText(problems: string[]): Wording {
  return {
    title: `Paused: ${CONFIG_PATH} needs a fix`,
    summary: [
      "Bona Fide won't ask for Deposits until the file on the default branch is fixed:",
      "",
      ...problems.map((problem) => `- ${problem}`),
    ].join("\n"),
  };
}

export function denouncedText(item: Item): Wording {
  return {
    title: "No Deposit accepted: contact the Maintainers",
    summary: `This ${WORDS[item.kind].noun} can't go ahead with a Deposit. The Maintainers of ${fullName(item.repo)} can tell you more.`,
  };
}

export function depositedText(kind: Kind, deposit: Deposit, explorerUrl: string): Wording {
  const { depositor } = deposit;
  const transaction = `${explorerUrl.replace(/\/+$/, "")}/tx/${deposit.txHash}`;
  return {
    title: `Deposit received from ${depositor.slice(0, 6)}…${depositor.slice(-4)}`,
    summary: [
      `${depositor} paid the refundable Deposit of **${usdc(deposit.amount)}** for this ${WORDS[kind].noun}.`,
      "",
      `[View the Deposit on Arc](${transaction})`,
    ].join("\n"),
  };
}

// Only a PR or issue checked before the repo's first Binding takes effect gets this text, and one
// opened before then never needs a Deposit.
export function inactiveText(kind: Kind, pending: PendingBinding | null, now: Date, setupUrl: string): Wording {
  if (!pending) {
    return {
      title: "No Deposit needed: not set up here yet",
      summary: [
        "Bona Fide starts asking for Deposits here once a Maintainer finishes setting it up.",
        "",
        `Maintainers: [finish setting up](${setupUrl}).`,
      ].join("\n"),
    };
  }
  return {
    title: `No Deposit needed: starts ${startsIn(pending.effectiveAt, now)}`,
    summary: [
      `Bona Fide starts in this repo at ${utc(pending.effectiveAt)} or shortly after.`,
      `This ${WORDS[kind].noun} was opened before then, so it won't need a Deposit.`,
    ].join(" "),
  };
}

export function depositNeededText(kind: Kind, terms: Binding, newTerms: NewTerms | null, link: string): Wording {
  const amount = usdc(terms.amount);
  const lines = [
    `This repo asks for a refundable Deposit of **${amount}** on this ${WORDS[kind].noun}.`,
    "",
    `- **${WORDS[kind].accepted}:** refunded in full.`,
    `- **${WORDS[kind].notAccepted} within ${timeout(terms.timeoutSeconds)}:** refunded in full.`,
  ];
  if (terms.forfeitBps > 0) {
    lines.push(
      `- **Bad faith, signed by a Maintainer:** up to ${percent(terms.forfeitBps)} funds open-source maintainers (Protocol Guild), and the rest is refunded.`,
    );
  }
  lines.push("", "Nobody else gets any of it: not the Maintainers, and not Bona Fide.");
  if (newTerms?.startsAt) {
    lines.push(
      "",
      `This repo's terms change at ${utc(newTerms.startsAt)} or shortly after. A Deposit made before then keeps the terms above.`,
    );
  } else if (newTerms) {
    lines.push(
      "",
      "This repo has new terms that aren't in effect yet. A Deposit made before they are keeps the terms above.",
    );
  }
  lines.push(
    "",
    `**[Make the Deposit](${link})**, or ask a Maintainer to vouch for you.`,
    "",
    `This ${WORDS[kind].notice} updates within seconds of the Deposit.`,
  );
  return { title: `Deposit needed: ${amount}, refundable`, summary: lines.join("\n") };
}

/** An amount as money: "1 USDC", "0.50 USDC", "1.125 USDC". */
export function usdc(amount: bigint): string {
  const [whole, fraction] = formatUnits(amount, USDC_DECIMALS).split(".");
  return fraction ? `${whole}.${fraction.padEnd(2, "0")} USDC` : `${whole} USDC`;
}

// A Binding past its time takes effect as soon as someone activates it, which anyone may do.
function startsIn(at: Date, now: Date): string {
  const hours = (at.getTime() - now.getTime()) / (HOUR_SECONDS * 1000);
  if (hours <= 0) return "shortly";
  if (hours < 1) return "in under an hour";
  return `in about ${count(Math.round(hours), "hour")}`;
}

function utc(date: Date): string {
  return `${date.toISOString().slice(0, 16).replace("T", " ")} UTC`;
}

// The config only sets whole days, but a Binding can hold any Timeout. Rounding up keeps the promise:
// after the time shown, a Refund always works.
function timeout(seconds: number): string {
  if (seconds % DAY_SECONDS === 0) return count(seconds / DAY_SECONDS, "day");
  return count(Math.ceil(seconds / HOUR_SECONDS), "hour");
}

function count(n: number, unit: string): string {
  return `${n} ${unit}${n === 1 ? "" : "s"}`;
}

function percent(bps: number): string {
  return `${bps / 100}%`;
}
