import { decisionCost } from "../decisions/log.ts";
import type { Answer } from "../ports.ts";

/** Most characters of an item's body the model reads. */
export const BODY_BUDGET = 20_000;
/** Most characters of a PR's diff the model reads, about 15,000 tokens. */
export const DIFF_BUDGET = 60_000;
/** Most characters in each reason. */
const MAX_REASON_CHARS = 300;

/** The model couldn't be asked, or erred. `reason` is short and names no secret. */
export class ModelFailed extends Error {
  readonly reason: string;

  constructor(reason: string) {
    super(`The model failed: ${reason}.`);
    this.reason = reason;
  }
}

/** What a model replied, before it is settled: its suggestion as given, or null with why there is none. */
export interface Reply<V extends string> {
  suggestion: { verdict: V; reasons: string[] } | null;
  /** Why there is no suggestion, such as "refusal". */
  silence?: string;
  /** The model that answered, which may be a fallback. */
  model: string;
  inputTokens: number;
  outputTokens: number;
}

/**
 * The answer `reply` settles to, which every Model returns: a rejection fails, named by a
 * ModelFailed's reason and otherwise "unexpected error", and a verdict with no reasons left is silent.
 */
export async function settle<V extends string>(
  maxReasons: number,
  reply: () => PromiseLike<Reply<V>>,
): Promise<Answer<V>> {
  let replied: Reply<V>;
  try {
    replied = await reply();
  } catch (error) {
    const why = error instanceof ModelFailed ? error.reason : "unexpected error";
    return { status: "failed", verdict: null, reasons: [], why, cost: null };
  }
  const cost = decisionCost(replied.model, replied.inputTokens, replied.outputTokens);
  const suggestion = replied.suggestion;
  if (!suggestion) return { status: "silent", verdict: null, reasons: [], why: replied.silence ?? "none", cost };
  const reasons = plainReasons(suggestion.reasons, maxReasons);
  // A suggestion with nothing for the Maintainer to check is no suggestion. The verdict is kept for
  // the decision log.
  if (reasons.length === 0) return { status: "silent", verdict: suggestion.verdict, reasons, why: "no reasons", cost };
  return { status: "suggested", verdict: suggestion.verdict, reasons, cost };
}

/** The text up to `budget` characters, ending at a line break if one is near, and how much was left out. */
export function cut(text: string, budget: number): { text: string; leftOut: number } {
  if (text.length <= budget) return { text, leftOut: 0 };
  const lineEnd = text.lastIndexOf("\n", budget);
  const end = lineEnd > budget * 0.9 ? lineEnd + 1 : budget;
  return { text: text.slice(0, end), leftOut: text.length - end };
}

// The model read text anyone can write, so its answer is untrusted too. A reason is one plain line
// with no links; in a note it also can't ping anyone or carry HTML, once made markdownSafe.
function plainReasons(reasons: string[], max: number): string[] {
  return reasons
    .map(plainReason)
    .filter((reason) => reason !== "")
    .slice(0, max);
}

function plainReason(reason: string): string {
  const line = reason
    .replace(/\s+/g, " ")
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    // GitHub links a URL after an underscore or a digit too, where \b doesn't match.
    .replace(/(?:[a-z][a-z0-9+.-]*:\/\/|www\.)[^\s)\]>]*/gi, "(link removed)")
    .trim();
  return line.length > MAX_REASON_CHARS ? `${line.slice(0, MAX_REASON_CHARS - 1).trimEnd()}…` : line;
}
