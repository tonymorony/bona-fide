import type { Kind } from "@bona-fide/sdk";
import type { Verdict } from "../app.ts";
import type { Config } from "../config.ts";
import { depositLink, triageAcceptNote, triageDraftNote, usdc } from "../copy.ts";
import { decisionCost, newDecision } from "../decisions/log.ts";
import { ACCEPTED, BAD_FAITH, WAIVER } from "../labels.ts";
import {
  fullName,
  type Decision,
  type DecisionLog,
  type Deposit,
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
  /** Keeps each decision made after asking the model, for the repo page. */
  decisions?: DecisionLog;
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
export function createTriage({
  github,
  reviewer,
  signPageUrl,
  record,
  decisions,
  now = () => new Date(),
}: TriageDeps): Triage {
  const triaged = new Set<string>();
  const running = new Map<string, Promise<void>>();

  // `seen` collects what the decision log keeps beyond the log line: the reasons as plain text,
  // and the labels read again after the model answered.
  async function decide(item: Item, serial: bigint, config: Config, seen: Seen): Promise<Outcome> {
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
    seen.reasons = plainReasons(suggestion.reasons);
    const reasons = seen.reasons.map(markdownSafe);
    const decided = { ...answered, verdict: suggestion.verdict, reasons };
    if (suggestion.verdict === "unsure" || reasons.length === 0) return { ...decided, action: "silent" };

    // A Maintainer may have decided while the model read.
    const current = await github.getItem(item.repo, item.kind, item.number);
    seen.labelsAfter = current?.labels ?? null;
    if (!current || settledByMaintainer(current.labels)) return { ...decided, action: DECIDED };
    if (suggestion.verdict === "accept") {
      await github.addNote(item.repo, item.number, marker, triageAcceptNote(item.kind, reasons));
      return { ...decided, action: "noted-accept" };
    }
    const signLink = depositLink(signPageUrl, item);
    await github.addNote(item.repo, item.number, marker, triageDraftNote(item.kind, reasons, signLink));
    return { ...decided, action: "drafted-verdict" };
  }

  async function run(item: Item, deposit: Deposit, config: Config, id: string): Promise<void> {
    const facts: Facts = {
      repo: fullName(item.repo),
      kind: item.kind,
      number: item.number,
      serial: String(deposit.serial),
      author: item.author,
    };
    const seen: Seen = { reasons: [], labelsAfter: undefined };
    let decision: TriageDecision;
    try {
      decision = { ...facts, ...(await decide(item, deposit.serial, config, seen)), at: now().toISOString() };
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
    // Only a decision the model was asked about: a skip before that decided nothing.
    if (decision.inputs !== null) safely(() => decisions?.append(logged(item, deposit, decision, seen)));
  }

  return {
    async afterVerdict(item, verdict, config) {
      if (verdict.kind !== "deposited") return;
      const deposit = verdict.deposit;
      const id = `${fullName(item.repo)}#${item.kind}${item.number}:${deposit.serial}`.toLowerCase();
      if (triaged.has(id) || running.has(id)) return;
      const work = run(item, deposit, config, id).finally(() => running.delete(id));
      running.set(id, work);
    },

    async idle() {
      while (running.size > 0) await Promise.all(running.values());
    },
  };
}

type Facts = Pick<TriageDecision, "repo" | "kind" | "number" | "serial" | "author">;
type Outcome = Omit<TriageDecision, keyof Facts | "at">;

interface Seen {
  /** The model's reasons as plain lines, before they're made safe for GitHub. */
  reasons: string[];
  /** The item's labels once the model answered; undefined if they weren't read again. */
  labelsAfter: string[] | null | undefined;
}

// A note suggesting acceptance is the App acting on its own. Everything else was left to the
// Maintainer: a draft verdict, a model unsure, declining or failing, or a Maintainer deciding first.
function logged(item: Item, deposit: Deposit, decision: TriageDecision, seen: Seen): Decision {
  const witnesses = [
    {
      name: "Deposit",
      value: `Serial ${deposit.serial}: ${usdc(deposit.amount)} from ${deposit.depositor}, counted by the check`,
    },
    { name: "Exemption", value: "none" },
    { name: "Labels", value: labelList(item.labels) },
    { name: "Triage in bona-fide.yml", value: "on" },
  ];
  if (seen.labelsAfter !== undefined) {
    const after = seen.labelsAfter === null ? "the item is gone" : labelList(seen.labelsAfter);
    witnesses.push({ name: "Labels after the model answered", value: after });
  }
  return newDecision(
    {
      repo: decision.repo,
      private: item.repo.private !== false,
      item: { kind: item.kind, number: item.number },
      serial: decision.serial,
      type: "triage",
      inputs: decision.inputs,
      suggestion: decision.verdict ? { verdict: decision.verdict, reasons: seen.reasons } : null,
      witnesses,
      action: decision.action,
      txHash: null,
      outcome: decision.action === "noted-accept" ? "decided" : "escalated",
      cost:
        decision.model && decision.usage
          ? decisionCost(decision.model, decision.usage.inputTokens, decision.usage.outputTokens)
          : null,
    },
    new Date(decision.at),
  );
}

function labelList(labels: string[]): string {
  return labels.length > 0 ? labels.join(", ") : "none";
}

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
export function cut(text: string, budget: number): { text: string; leftOut: number } {
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

// The model read text anyone can write, so its answer is untrusted too. A reason is one plain line
// with no links; in the note it also can't ping anyone or carry HTML.
export function plainReasons(reasons: string[], max = MAX_REASONS): string[] {
  return reasons
    .map(plainReason)
    .filter((reason) => reason !== "")
    .slice(0, max);
}

function plainReason(reason: string): string {
  const line = reason
    .replace(/\s+/g, " ")
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\b(?:[a-z][a-z0-9+.-]*:\/\/|www\.)[^\s)\]>]*/gi, "(link removed)")
    .trim();
  return line.length > MAX_REASON_CHARS ? `${line.slice(0, MAX_REASON_CHARS - 1).trimEnd()}…` : line;
}

export function markdownSafe(line: string): string {
  return (
    line
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
