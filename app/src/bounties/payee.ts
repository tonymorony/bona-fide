import { payeeDeclaredIn } from "@bona-fide/sdk";
import type { Address } from "viem";
import type { AuthoredText, PullRequestFacts } from "../ports.ts";

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
    const declaration = payeeDeclaredIn(text.text);
    if (declaration?.address) payee = { kind: "declared", address: declaration.address, source };
    else if (declaration) payee = { kind: "invalid", written: declaration.written, source };
  }
  return payee;
}
