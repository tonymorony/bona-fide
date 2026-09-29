import { encodeAbiParameters, keccak256, stringToBytes, type Hex } from "viem";

/** The escrow's Kind enum in order: a kind's index is its code on-chain. */
export const KINDS = ["pr", "issue"] as const;
export type Kind = (typeof KINDS)[number];

export function kindCode(kind: Kind): number {
  return KINDS.indexOf(kind);
}

/** GitHub keeps a repo's case in links, but the escrow knows it lowercased. */
export function repoIdOf(repo: string): Hex {
  return keccak256(stringToBytes(`github:${repo.toLowerCase()}`));
}

export function keyOf(repoId: Hex, kind: Kind, number: number): Hex {
  return keccak256(
    encodeAbiParameters(
      [{ type: "bytes32" }, { type: "uint8" }, { type: "uint64" }],
      [repoId, kindCode(kind), BigInt(number)],
    ),
  );
}
