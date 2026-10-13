import type { Verdict } from "../app.ts";
import type { Config } from "../config.ts";
import { depositLink, triageAcceptNote, triageDraftNote } from "../copy.ts";
import type { Kind } from "../keys.ts";
import { ACCEPTED, BAD_FAITH, WAIVER } from "../labels.ts";
import {
  fullName,
  type GitHub,
  type Item,
  type ItemContent,
  type Review,
  type Reviewer,
  type ReviewRequest,
} from "../ports.ts";

/** Most characters of an item's body the model reads. */
export const BODY_BUDGET = 20_000;
/** Most characters of a PR's diff the model reads, about 15,000 tokens. */
export const DIFF_BUDGET = 60_000;
/** Most reasons a note shows, and most characters in each. */
const MAX_REASONS = 4;
const MAX_REASON_CHARS = 300;
/** Most triaged Deposits remembered, so a re-check doesn't ask GitHub again. Past it, the memory is emptied. */
const MAX_REMEMBERED = 10_000;

const OFF = "skipped: off in bona-fide.yml";
const DECIDED = "skipped: a Maintainer decided";
const CHANGEABLE_SKIPS: TriageAction[] = [OFF, DECIDED];

/** The model couldn't be asked, or erred. `reason` is short and names no secret. */
export class ReviewFailed extends Error {
  readonly reason: string;

  constructor(reason: string) {
    super(`Triage failed: ${reason}.`);
    this.reason = reason;
  }
}

export type TriageAction = "noted-accept" | "drafted-verdict" | "silent" | `skipped: ${string}` | `failed: ${string}`;

/** One triage decision: what the model read, what it suggested, and what the App did. */
export interface TriageDecision {
  repo: string;
  kind: Kind;
  number: number;
  /** The Deposit's Serial, as a decimal string. */
  serial: string;
  author: string;
  /** The sizes of what the model read, and how much of each was left out. */
  inputs: {
    titleChars: number;
    bodyChars: number;
    bodyLeftOut: number;
    files?: number;
    filesLeftOut?: number;
    diffChars?: number;
    diffLeftOut?: number;
  } | null;
  model: string | null;
  verdict: "accept" | "bad-faith" | "unsure" | null;
  /** The reasons as the note shows them. */
  reasons: string[];
  action: TriageAction;
  usage: { inputTokens: number; outputTokens: number } | null;
  at: string;
}

export interface TriageDeps {
  github: GitHub;
  reviewer: Reviewer;
  /** The Maintainer's sign page, which a draft verdict links to. */
  signPageUrl: string;
  /** Hears every decision, such as to log it. */
  record(decision: TriageDecision): void;
  now?: () => Date;
}

export interface Triage {
  /**
   * Starts triage of an item whose check counts its Deposit, at most once per Deposit, and resolves
   * at once: the model can take longer than GitHub waits for a webhook. It never rejects.
   */
  afterVerdict(item: Item, verdict: Verdict, config: Config): Promise<void>;
  /** Resolves once every triage started so far is done. */
  idle(): Promise<void>;
}

// Triage only writes a note. Whatever the model answers, it never adds a label, refunds or
// forfeits: a Refund needs a Maintainer's acceptance, and a Forfeit the Maintainer's signature.
export function createTriage({ github, reviewer, signPageUrl, record, now = () => new Date() }: TriageDeps): Triage {
  const triaged = new Set<string>();
  const running = new Map<string, Promise<void>>();

  async function decide(item: Item, serial: bigint, config: Config): Promise<Outcome> {
    const none = { inputs: null, model: null, verdict: null, reasons: [], usage: null };
    if (!config.triage) return { ...none, action: OFF };
    if (settledByMaintainer(item.labels)) return { ...none, action: DECIDED };
    const marker = markerFor(serial);
    if (await github.hasNote(item.repo, item.number, marker)) return { ...none, action: "skipped: triaged before" };

    const request = requestFor(item, await github.contentOf(item));
    const inputs = inputsOf(request);
    let review: Review;
    try {
      review = await reviewer.review(request);
    } catch (error) {
      const reason = error instanceof ReviewFailed ? error.reason : "unexpected error";
      return { ...none, inputs, action: `failed: ${reason}` };
    }
    const usage = { inputTokens: review.inputTokens, outputTokens: review.outputTokens };
    const answered = { inputs, model: review.model, usage };
    const suggestion = review.suggestion;
    if (!suggestion) return { ...answered, verdict: null, reasons: [], action: "silent" };
    const reasons = cleanReasons(suggestion.reasons);
    const decided = { ...answered, verdict: suggestion.verdict, reasons };
    if (suggestion.verdict === "unsure" || reasons.length === 0) return { ...decided, action: "silent" };

    // A Maintainer may have decided while the model read.
    const current = await github.getItem(item.repo, item.kind, item.number);
    if (!current || settledByMaintainer(current.labels)) return { ...decided, action: DECIDED };
    if (suggestion.verdict === "accept") {
      await github.addNote(item.repo, item.number, marker, triageAcceptNote(item.kind, reasons));
      return { ...decided, action: "noted-accept" };
    }
    const signLink = depositLink(signPageUrl, item);
    await github.addNote(item.repo, item.number, marker, triageDraftNote(item.kind, reasons, signLink));
    return { ...decided, action: "drafted-verdict" };
  }

  async function run(item: Item, serial: bigint, config: Config, id: string): Promise<void> {
    const facts: Facts = {
      repo: fullName(item.repo),
      kind: item.kind,
      number: item.number,
      serial: String(serial),
      author: item.author,
    };
    let decision: TriageDecision;
    try {
      decision = { ...facts, ...(await decide(item, serial, config)), at: now().toISOString() };
    } catch (error) {
      // GitHub failed: nothing was posted, so the next check of the item tries again.
      const reason = error instanceof Error ? error.message : String(error);
      const failed = { inputs: null, model: null, verdict: null, reasons: [], usage: null };
      decision = { ...facts, ...failed, action: `failed: GitHub: ${reason}`, at: now().toISOString() };
      return void safely(() => record(decision));
    }
    // Asked once per Deposit in this process; after a restart, the note's marker says so. A skip
    // for a reason that can change leaves the next check to look again.
    if (!CHANGEABLE_SKIPS.includes(decision.action)) {
      if (triaged.size >= MAX_REMEMBERED) triaged.clear();
      triaged.add(id);
    }
    safely(() => record(decision));
  }

  return {
    async afterVerdict(item, verdict, config) {
      if (verdict.kind !== "deposited") return;
      const serial = verdict.deposit.serial;
      const id = `${fullName(item.repo)}#${item.kind}${item.number}:${serial}`.toLowerCase();
      if (triaged.has(id) || running.has(id)) return;
      const work = run(item, serial, config, id).finally(() => running.delete(id));
      running.set(id, work);
    },

    async idle() {
      while (running.size > 0) await Promise.all(running.values());
    },
  };
}

type Facts = Pick<TriageDecision, "repo" | "kind" | "number" | "serial" | "author">;
type Outcome = Omit<TriageDecision, keyof Facts | "at">;

/** The hidden marker a triage note starts with. It names the Deposit, so each is triaged once. */
export function markerFor(serial: bigint): string {
  return `<!-- bona-fide:triage serial=${serial} -->`;
}

/** The decision as one JSON log line. */
export function decisionLine(decision: TriageDecision): string {
  return JSON.stringify({ event: "triage", ...decision });
}

function settledByMaintainer(labels: string[]): boolean {
  return labels.includes(BAD_FAITH) || labels.includes(ACCEPTED) || labels.includes(WAIVER);
}

function requestFor(item: Item, content: ItemContent): ReviewRequest {
  const request: ReviewRequest = {
    repo: fullName(item.repo),
    repoDescription: content.repoDescription,
    kind: item.kind,
    number: item.number,
    author: item.author,
    title: content.title.slice(0, 1_000),
    body: cut(content.body, BODY_BUDGET),
  };
  if (content.files) {
    request.files = { listed: content.files.listed, leftOut: content.files.total - content.files.listed.length };
  }
  if (content.diff !== undefined) request.diff = content.diff === null ? null : cut(content.diff, DIFF_BUDGET);
  return request;
}

/** The text up to `budget` characters, ending at a line break if one is near, and how much was left out. */
function cut(text: string, budget: number): { text: string; leftOut: number } {
  if (text.length <= budget) return { text, leftOut: 0 };
  const lineEnd = text.lastIndexOf("\n", budget);
  const end = lineEnd > budget * 0.9 ? lineEnd + 1 : budget;
  return { text: text.slice(0, end), leftOut: text.length - end };
}

function inputsOf(request: ReviewRequest): TriageDecision["inputs"] {
  return {
    titleChars: request.title.length,
    bodyChars: request.body.text.length,
    bodyLeftOut: request.body.leftOut,
    ...(request.files ? { files: request.files.listed.length, filesLeftOut: request.files.leftOut } : {}),
    ...(request.diff !== undefined
      ? { diffChars: request.diff?.text.length ?? 0, diffLeftOut: request.diff?.leftOut ?? 0 }
      : {}),
  };
}

// The model read text anyone can write, so its answer is untrusted too. In the note a reason is
// one plain line: it can't ping anyone, link anywhere, or carry HTML.
function cleanReasons(reasons: string[]): string[] {
  return reasons
    .map(cleanReason)
    .filter((reason) => reason !== "")
    .slice(0, MAX_REASONS);
}

function cleanReason(reason: string): string {
  const line = reason
    .replace(/\s+/g, " ")
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\b(?:[a-z][a-z0-9+.-]*:\/\/|www\.)[^\s)\]>]*/gi, "(link removed)")
    .trim();
  const short = line.length > MAX_REASON_CHARS ? `${line.slice(0, MAX_REASON_CHARS - 1).trimEnd()}…` : line;
  return (
    short
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/([[\]])/g, "\\$1")
      // A zero-width space after @ keeps GitHub from turning it into a mention.
      .replace(/@/g, "@\u200b")
  );
}

function safely(work: () => void): void {
  try {
    work();
  } catch {
    // A logger that throws mustn't break triage.
  }
}
