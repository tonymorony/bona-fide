import type { Decision } from "./endpoints.ts";

/** How the repo page words one decision. Every string is shown as text, never as HTML. */
export interface DecisionWords {
  /** "Automated review", "Early Refund", "Record Exemption", "Bounty Payout" or "Bounty held". */
  kind: string;
  outcome: string;
  /** What the model suggested, or null when no model was asked. */
  suggestion: string | null;
  /** What Bona Fide did. */
  done: string;
  /** What the model read, or null. */
  read: string | null;
  /** What asking the model cost, or null. */
  cost: string | null;
  /** The merged PR a Bounty decision is about, or null. */
  pr: number | null;
}

const KINDS: Record<string, string> = {
  triage: "Automated review",
  "early-refund": "Early Refund",
  waive: "Record Exemption",
  pay: "Bounty Payout",
  hold: "Bounty held",
};

const VERDICTS: Record<string, string> = {
  accept: "good-faith work",
  "bad-faith": "likely bad faith",
  unsure: "unsure",
  waive: "no Deposit needed",
  require: "ask for the Deposit",
  flag: "ask for the Deposit, and flag the record for the Maintainer",
  resolves: "the PR resolves the issue",
  partial: "the PR resolves the issue only in part",
  unrelated: "the PR doesn't resolve the issue",
};

const ACTIONS: Record<string, string> = {
  "noted-accept": "Posted a note suggesting the Maintainer accept it.",
  "drafted-verdict": "Posted a draft bad-faith verdict for the Maintainer. Nothing was forfeited.",
  silent: "Posted nothing. The Maintainer decides.",
  "skipped: a Maintainer decided": "A Maintainer decided while the model read, so nothing was posted.",
  refunded: "Refunded the Deposit in full to its Depositor.",
};

// A Record Exemption's actions: whatever the model answered, only a waiver changes the check.
const WAIVE_ACTIONS: Record<string, string> = {
  waived: "Passed the check: no Deposit needed.",
  required: "Kept asking for the Deposit.",
  flagged: "Kept asking for the Deposit, and posted a note for the Maintainer.",
  silent: "Kept asking for the Deposit.",
};

const HOLD = "The Maintainer can pay it from the Bounty page.";

// Why the App held a Bounty, as `held: <why>` names it.
const HELD: Record<string, string> = {
  "not linked": "GitHub doesn't link the PR as closing the issue",
  "no model": "no automated reviewer was available",
  "merged after another": "another PR that closes the issue was merged first",
  "checks not green": "the PR's checks weren't green",
  "Keeper payouts off": "Keeper payouts are off",
  "above the per-payout limit": "it's above the per-payout limit",
  "above the period limit": "it's above what's left of the per-period limit",
  "model said partial": "an automated reviewer thinks the PR only partly resolves the issue",
  "model said unrelated": "an automated reviewer thinks the PR doesn't resolve the issue",
};

function heldWords(why: string): string {
  const refused = /^wallet refused \((.+)\)$/.exec(why)?.[1];
  return HELD[why] ?? (refused ? `the Bounty wallet refused it: ${refused}` : why);
}

// A Bounty's: Bona Fide pays it within the Maintainer's limits, relays their signed Payout, or leaves
// it to them, saying why.
function bountyAction(d: Decision, failed: string | undefined): string {
  if (d.action === "paid") {
    return d.inputs?.method === "signature"
      ? "Sent the Maintainer's signed Payout: the Bounty went in full to its payee."
      : "Paid the Bounty in full to its payee.";
  }
  const held = /^held: (.+)$/.exec(d.action)?.[1];
  if (held) return `Paid nothing: ${heldWords(held)}. ${HOLD}`;
  if (d.action === "silent") return `Paid nothing. ${HOLD}`;
  if (failed) return `Bona Fide couldn't finish (${failed}). Nothing was paid. ${HOLD}`;
  return d.action;
}

export function decisionWords(d: Decision): DecisionWords {
  const failed = /^failed: (.+)$/.exec(d.action)?.[1];
  const asked = d.type === "triage" || d.type === "waive";
  let suggestion: string | null = null;
  if (d.suggestion) suggestion = `Suggested: ${VERDICTS[d.suggestion.verdict] ?? d.suggestion.verdict}`;
  else if (asked && !failed) suggestion = "The model gave no suggestion.";
  const waive = d.type === "waive";
  const bounty = d.type === "pay" || d.type === "hold";
  const unasked = waive ? "The Deposit is still needed." : "Nothing was posted.";
  let read: string | null = null;
  if (d.inputs) read = d.type === "triage" || bounty ? readWords(d.inputs) : waive ? recordWords(d.inputs) : null;
  const pr = bounty && typeof d.inputs?.pr === "number" && Number.isSafeInteger(d.inputs.pr) ? d.inputs.pr : null;
  return {
    kind: KINDS[d.type] ?? d.type,
    outcome: d.outcome === "decided" ? "Decided" : "Left to the Maintainer",
    suggestion,
    done: bounty
      ? bountyAction(d, failed)
      : ((waive ? WAIVE_ACTIONS[d.action] : ACTIONS[d.action]) ??
        (failed ? `The model couldn't be asked (${failed}). ${unasked}` : d.action)),
    read,
    cost: d.cost ? costWords(d.cost) : null,
    pr: pr !== null && pr > 0 ? pr : null,
  };
}

// Triage reads sizes only: the item's text never enters the log.
function readWords(inputs: NonNullable<Decision["inputs"]>): string | null {
  const n = (key: string) => (typeof inputs[key] === "number" ? inputs[key] : null);
  const sized = (what: string, chars: number | null, leftOut: number | null) =>
    chars === null
      ? null
      : `${what} ${count(chars, "character")}${leftOut ? ` (${count(leftOut, "more")} left out)` : ""}`;
  const files = n("files");
  const more = n("filesLeftOut");
  const parts = [
    sized("title", n("titleChars"), null),
    sized("body", n("bodyChars"), n("bodyLeftOut")),
    files === null ? null : `${count(files + (more ?? 0), "changed file")}${more ? ` (${files} listed)` : ""}`,
    sized("diff", n("diffChars"), n("diffLeftOut")),
  ].filter((part) => part !== null);
  return parts.length > 0 ? `Read: ${parts.join("; ")}.` : null;
}

// A Record Exemption reads numbers only: the Contributor's record in public repos and their GitHub profile.
function recordWords(inputs: NonNullable<Decision["inputs"]>): string | null {
  const n = (key: string) => (typeof inputs[key] === "number" ? inputs[key] : null);
  const refunds = n("refunds");
  if (refunds === null) return null;
  const login = typeof inputs.login === "string" ? `@${inputs.login}'s` : "The Contributor's";
  const record = [
    `${count(refunds, "Refund")} on accepted work in ${count(n("repos") ?? 0, "repo")}`,
    count(n("otherRefunds") ?? 0, "other Refund"),
    count(n("forfeits") ?? 0, "Forfeit"),
    count(n("active") ?? 0, "open Deposit"),
  ];
  const profile = [
    n("accountAgeDays") === null ? null : `account ${count(n("accountAgeDays")!, "day")} old`,
    n("publicRepos") === null ? null : count(n("publicRepos")!, "public repo"),
    n("followers") === null ? null : count(n("followers")!, "follower"),
    n("mergedElsewhere") === null ? null : `${count(n("mergedElsewhere")!, "merged PR")} elsewhere`,
  ].filter((part) => part !== null);
  const github = profile.length > 0 ? ` On GitHub: ${profile.join(", ")}.` : "";
  return `Read: ${login} record in public repos: ${record.join(", ")}.${github}`;
}

function costWords(cost: NonNullable<Decision["cost"]>): string {
  const tokens = `${cost.inputTokens.toLocaleString("en-US")} tokens in, ${cost.outputTokens.toLocaleString("en-US")} out`;
  const usd = cost.usd === null ? "no price on file" : `about $${dollars(cost.usd)}`;
  return `Model cost: ${cost.model}: ${tokens}, ${usd}.`;
}

/** "0.008", "0.0151", "1.25": three significant digits below a dollar, cents above. */
function dollars(usd: number): string {
  return usd >= 1 ? usd.toFixed(2) : String(Number(usd.toPrecision(3)));
}

function count(n: number, unit: string): string {
  const plural = unit === "more" || n === 1 ? unit : `${unit}s`;
  return `${n.toLocaleString("en-US")} ${plural}`;
}
