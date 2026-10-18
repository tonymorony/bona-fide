import type { Kind } from "@bona-fide/sdk";
import type { Address } from "viem";
import { usdc } from "../copy.ts";

export const NOUNS: Record<Kind, string> = { pr: "PR", issue: "issue" };

export interface BadFaithFacts {
  kind: Kind;
  signLink: string;
  maintainer: Address;
  /** The Deposit's deadline, in Unix seconds. */
  deadline: bigint;
  amount: bigint;
  forfeitBps: number;
}

/** The Keeper's note after the bona-fide:bad-faith label. */
export function badFaithNote({ kind, signLink, maintainer, deadline, amount, forfeitBps }: BadFaithFacts): string {
  const forfeited = (amount * BigInt(forfeitBps)) / 10_000n;
  return [
    "**Bad faith: waiting for the Maintainer's signature**",
    "",
    `A Maintainer marked this ${NOUNS[kind]} as bad faith. The label alone moves no funds.`,
    "",
    `To forfeit the Deposit, the Maintainer signs with ${maintainer} before ${utc(deadline)}:`,
    `**[Sign the Forfeit](${signLink})**`,
    "",
    `- **Signed:** ${usdc(forfeited)} funds open-source maintainers (Protocol Guild), and ${usdc(amount - forfeited)} is refunded to the Depositor.`,
    "- **No signature by then:** refunded in full.",
  ].join("\n");
}

function utc(seconds: bigint): string {
  return `${new Date(Number(seconds) * 1000).toISOString().slice(0, 16).replace("T", " ")} UTC`;
}
