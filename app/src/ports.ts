import type { Address, Hex } from "viem";
import type { Kind } from "./keys.ts";

export interface Repo {
  owner: string;
  name: string;
  installationId: number;
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
 * What the watcher reads from the escrow's logs: a Deposit, or a repo's Binding taking effect (the
 * escrow's RepoActivated event, whoever activated it).
 */
export type EscrowEvent = { type: "deposited"; deposit: DepositedEvent } | { type: "activated"; repoId: Hex };

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
  /** The Deposits and activated Bindings in these blocks, in the order they happened, read in one log query. */
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
