import { getAddress, isAddress, isAddressEqual, zeroAddress, type Address } from "viem";
import type { AuthoredText, PullRequestFacts } from "../ports.ts";

/** A line of its own, such as "Bounty wallet: 0x…". The label's case doesn't matter, and backticks are allowed. */
const DECLARATION = /^[ \t]*bounty wallet:[ \t]*(.*?)[ \t]*$/gim;
const HEX_ADDRESS = /^0x[0-9a-fA-F]{40}$/;

/** Where the payee came from: the PR's body, or one of its author's comments. */
export type PayeeSource = "body" | "comment";

/**
 * The wallet the PR's author made known, or why there is none. `invalid` holds what they wrote when
 * it looks like an address, so a note can quote it back; anything else isn't quoted.
 */
export type Payee =
  | { kind: "declared"; address: Address; source: PayeeSource }
  | { kind: "invalid"; written: string | null; source: PayeeSource }
  | { kind: "none" };

/**
 * The payee the PR's author declared. Only their own words count, and only those nobody else has
 * edited since: anyone who can push to the repo can edit a body or a comment. The latest declaration
 * wins: a comment over an earlier one and over the body, and in one text the last line.
 */
export function payeeOf(facts: Pick<PullRequestFacts, "author" | "body" | "comments">): Payee {
  const author = facts.author?.toLowerCase();
  if (!author) return { kind: "none" };
  const own = (text: AuthoredText) =>
    text.author?.toLowerCase() === author && (text.editor === null || text.editor.toLowerCase() === author);
  const texts: [AuthoredText, PayeeSource][] = [
    [facts.body, "body"],
    ...[...facts.comments]
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
      .map((comment): [AuthoredText, PayeeSource] => [comment, "comment"]),
  ];
  let payee: Payee = { kind: "none" };
  for (const [text, source] of texts) {
    if (!own(text)) continue;
    const written = lastDeclaration(text.text);
    if (written !== null) payee = declared(written, source);
  }
  return payee;
}

function lastDeclaration(text: string): string | null {
  let last: string | null = null;
  for (const match of text.matchAll(DECLARATION)) last = match[1]!;
  return last;
}

// A mixed-case address must carry a valid EIP-55 checksum, so a typo in one isn't paid.
function declared(written: string, source: PayeeSource): Payee {
  const value = written
    .trim()
    .replace(/^`(.*)`$/, "$1")
    .trim();
  if (isAddress(value)) return { kind: "declared", address: getAddress(value), source };
  return { kind: "invalid", written: HEX_ADDRESS.test(value) ? value : null, source };
}

/** Why the wallet can't pay `payee`, as its own check refuses it, or null if it can. */
export function payeeProblem(payee: Address, wallet: Address, keeper: Address): string | null {
  if (isAddressEqual(payee, zeroAddress)) return "it is the zero address";
  if (isAddressEqual(payee, wallet)) return "it is the Bounty wallet itself";
  if (isAddressEqual(payee, keeper)) return "it is the Keeper's address";
  return null;
}
