import { getAddress, isAddress, type Address } from "viem";
import { parse } from "yaml";
import type { Fetch } from "./endpoints.ts";

export const CONFIG_PATH = ".github/bona-fide.yml";

const UNIT = 1_000_000n;
const DAY_SECONDS = 86_400;
const MAX_AMOUNT = 50n * UNIT;
const LOGIN = /^[\w-]+(\[bot\])?$/;

/** The terms a repo's bona-fide.yml asks the Keeper to propose, and its Maintainer's wallet. */
export interface FileTerms {
  /** Null when the file names none, or not an address: the Keeper then proposes nothing. */
  maintainer: Address | null;
  amount: bigint;
  forfeitBps: number;
  timeoutSeconds: number;
}

export type ReadFile = { ok: true; terms: FileTerms } | { ok: false; problems: string[] };

// The same rules, and the same problems, as the App's parseConfig: a file the page reads as fine is
// one the Keeper accepts. The failsafe schema keeps every value a string.
export function readBonaFideYml(text: string): ReadFile {
  let settings: unknown;
  try {
    settings = parse(text, { schema: "failsafe" });
  } catch {
    return { ok: false, problems: ["The file isn't valid YAML."] };
  }
  if (settings === null) settings = {};
  if (typeof settings !== "object" || Array.isArray(settings)) {
    return { ok: false, problems: ["The file must hold settings such as `amount: 1`."] };
  }
  const { amount, forfeit, timeout, exempt_bots, maintainer } = settings as Record<string, unknown>;
  const problems: string[] = [];
  const terms: FileTerms = {
    maintainer: typeof maintainer === "string" && isAddress(maintainer.trim()) ? getAddress(maintainer.trim()) : null,
    amount: isSet(amount) ? parseAmount(String(amount), problems) : UNIT,
    forfeitBps: isSet(forfeit) ? parseForfeit(String(forfeit), problems) : 5000,
    timeoutSeconds: isSet(timeout) ? parseTimeout(String(timeout), problems) : 7 * DAY_SECONDS,
  };
  if (isSet(exempt_bots)) {
    const valid =
      Array.isArray(exempt_bots) && exempt_bots.every((login) => typeof login === "string" && LOGIN.test(login));
    if (!valid) problems.push("`exempt_bots` must be a list of GitHub logins.");
  }
  return problems.length === 0 ? { ok: true, terms } : { ok: false, problems };
}

function isSet(value: unknown): boolean {
  return value !== undefined && value !== null && value !== "";
}

function parseAmount(text: string, problems: string[]): bigint {
  const match = /^(\d+)(?:\.(\d+))?(?:\s*usdc)?$/i.exec(text.trim());
  if (match?.[2] && match[2].length > 6) {
    problems.push("`amount` can have at most 6 decimals.");
    return 0n;
  }
  const amount = match ? BigInt(match[1]!) * UNIT + BigInt((match[2] ?? "").padEnd(6, "0")) : 0n;
  if (amount <= 0n || amount > MAX_AMOUNT) problems.push("`amount` must be more than 0 and at most 50 USDC.");
  return amount;
}

function parseForfeit(text: string, problems: string[]): number {
  const match = /^(\d+)(?:\.(\d{1,2}))?\s*%?$/.exec(text.trim());
  const bps = match ? Number(match[1]) * 100 + Number((match[2] ?? "").padEnd(2, "0")) : NaN;
  if (!(bps >= 0 && bps <= 5000)) problems.push("`forfeit` must be from 0% to 50%.");
  return bps;
}

function parseTimeout(text: string, problems: string[]): number {
  const match = /^(\d+)\s*(?:d|days?)?$/i.exec(text.trim());
  const days = match ? Number(match[1]) : NaN;
  if (!(days >= 1 && days <= 60)) problems.push("`timeout` must be a whole number of days from 1 to 60.");
  return days * DAY_SECONDS;
}

export type FetchedFile = { kind: "found"; text: string } | { kind: "missing" } | { kind: "unreadable" };

/**
 * The repo's bona-fide.yml on its default branch, from GitHub's API. GitHub answers 404 both for a
 * missing file and for a repo it won't show, such as a private one, so a 404 asks about the repo too.
 */
export async function fetchBonaFideYml(repo: string, fetch: Fetch): Promise<FetchedFile> {
  try {
    const response = await fetch(`https://api.github.com/repos/${repo}/contents/${CONFIG_PATH}`, {
      headers: { accept: "application/vnd.github.raw+json" },
    });
    if (response.ok) return { kind: "found", text: await response.text() };
    if (response.status !== 404) return { kind: "unreadable" };
    const visible = await fetch(`https://api.github.com/repos/${repo}`, {
      headers: { accept: "application/vnd.github+json" },
    });
    return visible.ok ? { kind: "missing" } : { kind: "unreadable" };
  } catch {
    return { kind: "unreadable" };
  }
}
