import { getAddress, isAddress, type Address } from "viem";
import { REPO_NAME } from "./app-routes.ts";
import { KINDS, type Kind } from "./keys.ts";

// The Deposit request for machines: one hidden HTML comment line that the Bona Fide App adds under
// the text of its check run and its comment while they ask for a Deposit, and only then. GitHub
// shows nothing for it. It names the escrow and the PR or issue, so an AI agent can find the terms
// without reading the text meant for people. It leaves out the Timeout and the forfeit share: an
// agent reads every term from the escrow before it pays.

/** The GitHub App that asks for Deposits, as GitHub names it on its check runs and comments. */
export const APP_SLUG = "bona-fide-deposits";

/**
 * What the App asks for on one PR or issue, as its check run and comment carry it.
 *
 * Anyone who can comment on a PR or issue can post a block like this, so it counts only from the
 * "Bona Fide" check run whose `app.slug` is `bona-fide-deposits`, or from a comment whose
 * `performed_via_github_app.slug` is `bona-fide-deposits` (its author is `bona-fide-deposits[bot]`).
 * Even then it says only where to look: read the repo's terms from the escrow, as the MCP server's
 * `get_deposit_rules` does, and never pay what the block says without that.
 */
export interface DepositRequest {
  /** The chain the escrow is on: 5042 for Arc mainnet. */
  chainId: number;
  escrow: Address;
  /** owner/name. */
  repo: string;
  kind: Kind;
  number: number;
  /**
   * The Deposit asked for when the App wrote the block, in USDC base units. A hint, such as for an
   * agent's limit: the escrow takes its Binding's amount.
   */
  amount: bigint;
  /** The deposit page for this PR or issue. */
  depositUrl: string;
  /** What an agent should read first: llms.txt on the deposit page's site. */
  llmsTxtUrl: string;
}

const VERSION = 1;
const BLOCK = /<!--\s*bona-fide:deposit-request\s+(.*?)\s*-->/gs;
const UINT256_MAX = 2n ** 256n - 1n;

/** The request as one HTML comment line, such as `<!-- bona-fide:deposit-request {"v":1,…} -->`. */
export function depositRequestBlock(request: DepositRequest): string {
  const { chainId, escrow, repo, kind, number, amount, depositUrl, llmsTxtUrl } = request;
  const json = JSON.stringify({
    v: VERSION,
    chainId,
    escrow,
    repo,
    kind,
    number,
    amount: amount.toString(),
    depositUrl,
    llmsTxtUrl,
  });
  // Escaped, no "<" or ">" in a URL can close the comment early and show the rest.
  return `<!-- bona-fide:deposit-request ${json.replaceAll("<", "\\u003c").replaceAll(">", "\\u003e")} -->`;
}

/**
 * The Deposit request in a check run's summary or a comment's body, or null when it has none, has
 * more than one, or has one out of shape or of another version. Check where the text came from: see
 * {@link DepositRequest}.
 */
export function depositRequestIn(text: string): DepositRequest | null {
  const blocks = [...text.matchAll(BLOCK)];
  // The App writes one. With two, nobody can tell which is the App's.
  if (blocks.length !== 1) return null;
  let fields: unknown;
  try {
    fields = JSON.parse(blocks[0]![1]!);
  } catch {
    return null;
  }
  if (typeof fields !== "object" || fields === null || Array.isArray(fields)) return null;
  const { v, chainId, escrow, repo, kind, number, amount, depositUrl, llmsTxtUrl } = fields as Record<string, unknown>;
  const known = KINDS.find((k) => k === kind);
  if (v !== VERSION || !isPositive(chainId) || typeof escrow !== "string" || !isAddress(escrow)) return null;
  if (typeof repo !== "string" || !REPO_NAME.test(repo) || !known || !isPositive(number)) return null;
  if (typeof amount !== "string" || !/^\d{1,78}$/.test(amount) || BigInt(amount) > UINT256_MAX) return null;
  if (!isWebUrl(depositUrl) || !isWebUrl(llmsTxtUrl)) return null;
  return {
    chainId,
    escrow: getAddress(escrow),
    repo,
    kind: known,
    number,
    amount: BigInt(amount),
    depositUrl,
    llmsTxtUrl,
  };
}

function isPositive(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function isWebUrl(value: unknown): value is string {
  if (typeof value !== "string" || !URL.canParse(value)) return false;
  const { protocol } = new URL(value);
  return protocol === "https:" || protocol === "http:";
}
