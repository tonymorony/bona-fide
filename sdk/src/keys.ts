import { encodeAbiParameters, keccak256, stringToBytes, type Hex } from "viem";

/** The escrow's Kind enum in order: a kind's index is its code on-chain. */
export const KINDS = ["pr", "issue"] as const;
export type Kind = (typeof KINDS)[number];

export function kindCode(kind: Kind): number {
  return KINDS.indexOf(kind);
}

/**
 * A GitHub repo's id in the escrow and the Bounty wallets: the hash of "github:" and its owner/name,
 * lowercased. GitHub keeps a repo's case in links, but the escrow knows it lowercased.
 */
export function repoIdOf(repo: string): Hex {
  return keccak256(stringToBytes(`github:${repo.toLowerCase()}`));
}

/** One PR's or issue's Deposit key, as the escrow's keyOf computes it. */
export function keyOf(repoId: Hex, kind: Kind, number: number): Hex {
  return keccak256(
    encodeAbiParameters(
      [{ type: "bytes32" }, { type: "uint8" }, { type: "uint64" }],
      [repoId, kindCode(kind), BigInt(number)],
    ),
  );
}

/**
 * The EIP-3009 nonce that ties a signed authorization to one Deposit key, as the escrow's
 * authorizationNonce computes it. Compute it locally, so a wrong RPC answer can't point a signature
 * at another PR or issue.
 */
export function authorizationNonce(key: Hex, salt: Hex): Hex {
  return keccak256(encodeAbiParameters([{ type: "bytes32" }, { type: "bytes32" }], [key, salt]));
}
