import type { Address, Hex } from "viem";
import { KINDS, type Kind } from "./keys.ts";

export interface Item {
  /** owner/name, in GitHub's case. */
  repo: string;
  kind: Kind;
  number: number;
}

// As the App's relay accepts them: a GitHub owner, and a repo name.
const REPO = /^[A-Za-z0-9-]{1,39}\/[A-Za-z0-9._-]{1,100}$/;
const NUMBER = /^[1-9]\d{0,15}$/;

/** The repo named in a page link's query, or null. */
export function readRepoLink(search: string): string | null {
  const repo = new URLSearchParams(search).get("repo");
  return repo !== null && REPO.test(repo) ? repo : null;
}

/** The PR or issue a deposit or sign link names: `?repo=owner/name&kind=pr|issue&number=N`. */
export function readItemLink(search: string): Item | null {
  const query = new URLSearchParams(search);
  const repo = readRepoLink(search);
  const kind = KINDS.find((k) => k === query.get("kind"));
  const text = query.get("number") ?? "";
  const number = NUMBER.test(text) ? Number(text) : NaN;
  if (repo === null || kind === undefined || !Number.isSafeInteger(number)) return null;
  return { repo, kind, number };
}

export function itemUrl({ repo, kind, number }: Item): string {
  return `https://github.com/${repo}/${kind === "pr" ? "pull" : "issues"}/${number}`;
}

/** "PR #128" or "issue #7"; "Issue #7" to start a sentence. */
export function itemName(kind: Kind, number: number, { capital = false } = {}): string {
  if (kind === "pr") return `PR #${number}`;
  return `${capital ? "Issue" : "issue"} #${number}`;
}

export function repoPageUrl(repo: string): string {
  return `repo.html?${new URLSearchParams({ repo })}`;
}

export function explorerTx({ explorerUrl }: { explorerUrl: string }, hash: Hex): string {
  return `${explorerUrl}/tx/${hash}`;
}

export function explorerAddress({ explorerUrl }: { explorerUrl: string }, address: Address): string {
  return `${explorerUrl}/address/${address}`;
}
