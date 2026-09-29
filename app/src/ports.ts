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
  /** The PRs the App's "Bona Fide" runs in one of its check suites were posted for. */
  suitePullRequests(repo: Repo, suiteId: number): Promise<number[]>;
  /** Up to `max` of the repo's open PRs and issues, the most recently updated first, and whether more are open. */
  openItems(repo: Repo, max: number): Promise<{ items: { kind: Kind; number: number }[]; more: boolean }>;
}

export interface Deposit {
  depositor: Address;
  amount: bigint;
  /** The transaction that made it. */
  txHash: Hex;
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
