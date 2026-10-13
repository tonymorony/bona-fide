import type { Address, Hex } from "viem";
import type { Kind } from "./keys.ts";

export interface Repo {
  owner: string;
  name: string;
  installationId: number;
  /** Whether GitHub says the repo is private. Unknown counts as private: its decisions are never published. */
  private?: boolean;
}

export function fullName(repo: Repo): string {
  return `${repo.owner}/${repo.name}`;
}

export interface ItemFields {
  repo: Repo;
  number: number;
  author: string;
  createdAt: Date;
  labels: string[];
}

export interface PullRequest extends ItemFields {
  kind: "pr";
  headSha: string;
}

export interface Issue extends ItemFields {
  kind: "issue";
}

/** What a Deposit is for: a PR or an issue. */
export type Item = PullRequest | Issue;

export type Permission = "admin" | "write" | "read" | "none";

export interface CheckRun {
  conclusion: "success" | "failure" | "neutral" | "action_required";
  title: string;
  summary: string;
  detailsUrl?: string;
  /** Kept on the run and sent back when someone re-runs it. */
  externalId?: string;
}

export interface GitHub {
  /** A file's text on the default branch, or null if it doesn't exist. */
  readFile(repo: Repo, path: string): Promise<string | null>;
  permissionOf(repo: Repo, login: string): Promise<Permission>;
  hasMergedPullRequest(repo: Repo, login: string): Promise<boolean>;
  /** Creates or updates the "Bona Fide" check on a commit. */
  setCheck(repo: Repo, headSha: string, check: CheckRun): Promise<void>;
  /** The id of the App's own comment on an issue, or null. */
  findOwnComment(repo: Repo, number: number): Promise<number | null>;
  createComment(repo: Repo, number: number, body: string): Promise<void>;
  updateComment(repo: Repo, commentId: number, body: string): Promise<void>;
  addLabel(repo: Repo, number: number, label: string): Promise<void>;
  removeLabel(repo: Repo, number: number, label: string): Promise<void>;
  /** The installed repo whose repoId this is, or null. */
  findRepo(repoId: Hex): Promise<Repo | null>;
  /** The open or closed PR or issue, or null if there is none of that kind. */
  getItem(repo: Repo, kind: Kind, number: number): Promise<Item | null>;
  /** Posts the Keeper's note on a PR or issue, or edits the one it posted before. */
  postNote(repo: Repo, number: number, body: string): Promise<void>;
  /** Whether the App has a comment on the PR or issue that starts with `marker`. */
  hasNote(repo: Repo, number: number, marker: string): Promise<boolean>;
  /** Posts a new comment that starts with `marker`. It never edits the Keeper's note or the App's comment. */
  addNote(repo: Repo, number: number, marker: string, body: string): Promise<void>;
  /** The logins whose latest review of the PR approves it. */
  approvers(repo: Repo, number: number): Promise<string[]>;
  /** What the PR or issue says, and for a PR what it changes: what triage reads. */
  contentOf(item: Item): Promise<ItemContent>;
  /** The PRs the App's "Bona Fide" runs in one of its check suites were posted for. */
  suitePullRequests(repo: Repo, suiteId: number): Promise<number[]>;
  /** Up to `max` of the repo's open PRs and issues, the most recently updated first, and whether more are open. */
  openItems(repo: Repo, max: number): Promise<{ items: { kind: Kind; number: number }[]; more: boolean }>;
  /** Who opened the PR or issue and whether it was accepted, for a Contributor's record, or null if there is none. */
  outcomeOf(repo: Repo, kind: Kind, number: number): Promise<ItemOutcome | null>;
  /** What GitHub shows publicly about `login`, or null if there is no such account. `repo` is the repo being checked. */
  profileOf(repo: Repo, login: string): Promise<GitHubProfile | null>;
}

/**
 * Whose PR or issue a Deposit was for, and whether it was accepted: a PR merged, an issue closed as
 * completed by someone other than its author, or either labelled bona-fide:ok.
 */
export interface ItemOutcome {
  author: string;
  accepted: boolean;
}

/** A Contributor's public GitHub profile, as a Record Exemption reads it. Numbers only. */
export interface GitHubProfile {
  createdAt: Date;
  publicRepos: number;
  followers: number;
  /** Merged PRs in repos owned by neither the Contributor nor the owner of the repo being checked. */
  mergedElsewhere: number;
}

export interface ChangedFile {
  path: string;
  additions: number;
  deletions: number;
}

export interface ItemContent {
  title: string;
  body: string;
  repoDescription: string | null;
  /** A PR's changed files: the first page GitHub lists, and how many the PR changes in all. */
  files?: { listed: ChangedFile[]; total: number };
  /** A PR's unified diff, or null when GitHub won't make one, as for a very large PR. */
  diff?: string | null;
}

export interface Deposit {
  depositor: Address;
  amount: bigint;
  /** The transaction that made it. */
  txHash: Hex;
  /** Its Serial: triage marks its note with it, so each Deposit is triaged once. */
  serial: bigint;
}

export interface DepositedEvent extends Deposit {
  key: Hex;
  serial: bigint;
  repoId: Hex;
  kind: Kind;
  number: number;
  blockNumber: bigint;
  blockTime: Date;
}

/**
 * What the watcher reads from the escrow's logs: a Deposit, a repo's Binding taking effect (the
 * escrow's RepoActivated event, whoever activated it), or a Deposit refunded or forfeited.
 */
export type EscrowEvent =
  | { type: "deposited"; deposit: DepositedEvent }
  | { type: "activated"; repoId: Hex }
  | { type: "refunded" | "forfeited"; key: Hex; serial: bigint };

/** A repo's on-chain configuration: its Maintainer, and the terms each new Deposit takes. */
export interface Binding {
  maintainer: Address;
  amount: bigint;
  forfeitBps: number;
  timeoutSeconds: number;
}

/** A proposed Binding. Anyone can activate it from `effectiveAt` on. */
export interface PendingBinding extends Binding {
  effectiveAt: Date;
}

export interface RepoBinding {
  /** The Binding new Deposits take. Until a repo has one, the escrow refuses its Deposits. */
  active: Binding | null;
  pending: PendingBinding | null;
}

export interface Chain {
  /**
   * The key's latest Deposit, if it was made at or after `since` and is still active: a refunded
   * or forfeited Deposit no longer counts.
   * `seen` is its Deposited event, if the caller has it: it saves looking up the block time.
   */
  depositSince(key: Hex, since: Date, seen?: DepositedEvent): Promise<Deposit | null>;
  latestBlock(): Promise<bigint>;
  /** The Deposits, activated Bindings, Refunds and Forfeits in these blocks, in the order they happened, read in one log query. */
  escrowEvents(fromBlock: bigint, toBlock: bigint): Promise<EscrowEvent[]>;
  bindingOf(repoId: Hex): Promise<RepoBinding>;
  /**
   * When Bona Fide started in the repo: the block time of its first RepoActivated event, or null if
   * no Binding of the repo has taken effect yet. A later Binding doesn't change it.
   */
  startedAt(repoId: Hex): Promise<Date | null>;
}

export type Suggestion = "accept" | "bad-faith" | "unsure";

/** What triage shows the model: an item's text, cut to fixed budgets, with how much was left out. */
export interface ReviewRequest {
  repo: string;
  repoDescription: string | null;
  kind: Kind;
  number: number;
  author: string;
  title: string;
  body: { text: string; leftOut: number };
  files?: { listed: ChangedFile[]; leftOut: number };
  /** Null when GitHub made no diff. */
  diff?: { text: string; leftOut: number } | null;
}

export interface Review {
  /** The model's suggestion, or null when it gave none, such as when it declined. */
  suggestion: { verdict: Suggestion; reasons: string[] } | null;
  /** Why there is no suggestion, such as "refusal". */
  silence?: string;
  /** The model that answered, which may be a fallback. */
  model: string;
  inputTokens: number;
  outputTokens: number;
}

/**
 * A model that reads a PR or issue and suggests whether it is good-faith work. Its answer is
 * untrusted text: it only changes what triage's note says.
 */
export interface Reviewer {
  /** Rejects with ReviewFailed when the model can't be reached or errs. */
  review(request: ReviewRequest): Promise<Review>;
}

/**
 * A Contributor's Bona Fide record: their Deposits across every repo the App can see, each linked
 * to them through the author of the PR or issue it was for. The counts are of public repos only,
 * so a record never shows who contributes to a private repo.
 */
export interface ContributorRecord {
  /** Refunds on accepted work in public repos the Contributor doesn't own. The score counts these. */
  refunds: number;
  /** How many public repos those Refunds are in. */
  repos: number;
  /** Other Refunds in public repos: at the Timeout, of a Deposit that wasn't needed, or in their own repos. */
  otherRefunds: number;
  forfeits: number;
  active: number;
  /** Forfeits in every repo the App can see, private ones included. Only ever shown as none. */
  forfeitsAnywhere: number;
  /** Whether every Forfeit the escrow made so far is linked to its Contributor. Until then, no Record Exemption is granted. */
  complete: boolean;
}

export interface ContributorRecords {
  recordOf(login: string): ContributorRecord;
}

/** A suggestion on a Contributor's record: pass the check with no Deposit, ask for it, or ask for it and flag the item. */
export type Advice = "waive" | "require" | "flag";

/** What a Record Exemption shows the model: numbers from the Contributor's record and GitHub profile. */
export interface AdviceRequest {
  repo: string;
  kind: Kind;
  number: number;
  login: string;
  record: Pick<ContributorRecord, "refunds" | "repos" | "otherRefunds" | "forfeits" | "active">;
  profile: { accountAgeDays: number; publicRepos: number; followers: number; mergedElsewhere: number };
}

export interface AdviceAnswer {
  /** The model's suggestion, or null when it gave none, such as when it declined. */
  suggestion: { verdict: Advice; reasons: string[] } | null;
  /** Why there is no suggestion, such as "refusal". */
  silence?: string;
  /** The model that answered, which may be a fallback. */
  model: string;
  inputTokens: number;
  outputTokens: number;
}

/**
 * A model that reads a Contributor's record and suggests whether their item needs a Deposit. It can
 * hold a Record Exemption back, never grant one alone: the App's own witnesses must hold too.
 */
export interface Advisor {
  /** Rejects with ReviewFailed when the model can't be reached or errs. */
  advise(request: AdviceRequest): Promise<AdviceAnswer>;
}

/**
 * What the decision log records: triage's suggestions, the Keeper's early Refunds and the Record
 * Exemptions the model was asked about. `pay` and `hold` are kept for decisions the App doesn't make yet.
 */
export type DecisionType = "triage" | "early-refund" | "waive" | "pay" | "hold";

/**
 * "decided": the App acted on its own, such as an early Refund or a note suggesting acceptance.
 * "escalated": the App left it to the Maintainer, such as a draft bad-faith verdict, an unsure
 * model, or a model that declined or failed.
 */
export type DecisionOutcome = "decided" | "escalated";

/** A fact the App checked before it acted, such as who approved the PR. */
export interface Witness {
  name: string;
  value: string;
}

/** What asking the model cost. `usd` is an estimate from list prices, or null for a model without one. */
export interface DecisionCost {
  model: string;
  inputTokens: number;
  outputTokens: number;
  usd: number | null;
}

/** One decision the App made or left to the Maintainer, and why: what anyone can check on the repo page. */
export interface Decision {
  id: string;
  /** ISO 8601. */
  at: string;
  /** owner/name, in GitHub's case. */
  repo: string;
  /** Whether the repo was private. A private repo's decisions are kept, but never published. */
  private: boolean;
  item: { kind: Kind; number: number };
  /** The Deposit's Serial, as a decimal string, if one is involved. */
  serial: string | null;
  type: DecisionType;
  /** A summary of what was read, such as sizes and cuts. Never the item's text. */
  inputs: Record<string, string | number | boolean> | null;
  /** The model's suggestion with its reasons as plain lines, or null when no model suggested anything. */
  suggestion: { verdict: Suggestion | Advice; reasons: string[] } | null;
  witnesses: Witness[];
  /** What the App did, such as "refunded", "noted-accept" or "failed: rate limited". Never an error's text. */
  action: string;
  /** The transaction, when money moved. */
  txHash: Hex | null;
  outcome: DecisionOutcome;
  cost: DecisionCost | null;
}

/** Where decisions are kept. What it answers is what may be published: nothing from a private repo. */
export interface DecisionLog {
  append(decision: Decision): void;
  /** Up to `max` of the repo's latest published decisions, the newest first. */
  latest(repo: string, max: number): Decision[];
  counts(repo: string): Record<DecisionOutcome, number>;
  /**
   * The latest `waive` decision about the item, in any repo, private ones included: the App reads it
   * to keep a Record Exemption it granted. It is never served.
   */
  waiverOf(repo: string, kind: Kind, number: number): Decision | null;
}
