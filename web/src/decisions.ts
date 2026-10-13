import type { Decision } from "./endpoints.ts";

/** How the repo page words one decision. Every string is shown as text, never as HTML. */
export interface DecisionWords {
  /** "Automated review" or "Early Refund". */
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
}

const KINDS: Record<string, string> = {
  triage: "Automated review",
  "early-refund": "Early Refund",
  waive: "Waiver",
  pay: "Payment",
  hold: "Hold",
};

const VERDICTS: Record<string, string> = {
  accept: "good-faith work",
  "bad-faith": "likely bad faith",
  unsure: "unsure",
};

const ACTIONS: Record<string, string> = {
  "noted-accept": "Posted a note suggesting the Maintainer accept it.",
  "drafted-verdict": "Posted a draft bad-faith verdict for the Maintainer. Nothing was forfeited.",
  silent: "Posted nothing. The Maintainer decides.",
  "skipped: a Maintainer decided": "A Maintainer decided while the model read, so nothing was posted.",
  refunded: "Refunded the Deposit in full to its Depositor.",
};

export function decisionWords(d: Decision): DecisionWords {
  const failed = /^failed: (.+)$/.exec(d.action)?.[1];
  let suggestion: string | null = null;
  if (d.suggestion) suggestion = `Suggested: ${VERDICTS[d.suggestion.verdict] ?? d.suggestion.verdict}`;
  else if (d.type === "triage" && !failed) suggestion = "The model gave no suggestion.";
  return {
    kind: KINDS[d.type] ?? d.type,
    outcome: d.outcome === "decided" ? "Decided" : "Left to the Maintainer",
    suggestion,
    done: ACTIONS[d.action] ?? (failed ? `The model couldn't be asked (${failed}). Nothing was posted.` : d.action),
    read: d.type === "triage" && d.inputs ? readWords(d.inputs) : null,
    cost: d.cost ? costWords(d.cost) : null,
  };
}

// Triage reads sizes only: the item's text never enters the log.
function readWords(inputs: NonNullable<Decision["inputs"]>): string | null {
  const n = (key: string) => (typeof inputs[key] === "number" ? (inputs[key] as number) : null);
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
