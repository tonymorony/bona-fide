import type { Address, Hex } from "viem";
import { authorizationNonce, keyOf, repoIdOf, type Kind } from "./keys.ts";

// Every message a Bona Fide contract checks a signature on, as EIP-712 typed data. Each builder
// returns { domain, types, primaryType, message }: pass it to viem's signTypedData to sign, or to
// hashTypedData for the digest the contract recovers.

/** The escrow's EIP-712 domain, for Forfeits and Binding proofs. */
export function escrowDomain(chainId: number, escrow: Address) {
  return { name: "BonaFide", version: "1", chainId, verifyingContract: escrow } as const;
}

/** USDC's EIP-712 domain on Arc, for EIP-3009 authorizations. */
export function usdcDomain(chainId: number, usdc: Address) {
  return { name: "USDC", version: "2", chainId, verifyingContract: usdc } as const;
}

/** A Bounty wallet's EIP-712 domain, for Payout signatures: it names the wallet, so one can't pay from another. */
export function bountyDomain(chainId: number, wallet: Address) {
  return { name: "BonaFide Bounty", version: "1", chainId, verifyingContract: wallet } as const;
}

export const RECEIVE_WITH_AUTHORIZATION_TYPES = {
  ReceiveWithAuthorization: [
    { name: "from", type: "address" },
    { name: "to", type: "address" },
    { name: "value", type: "uint256" },
    { name: "validAfter", type: "uint256" },
    { name: "validBefore", type: "uint256" },
    { name: "nonce", type: "bytes32" },
  ],
} as const;

export const FORFEIT_TYPES = {
  Forfeit: [
    { name: "key", type: "bytes32" },
    { name: "serial", type: "uint256" },
    { name: "sigDeadline", type: "uint256" },
  ],
} as const;

export const BINDING_TYPES = {
  Binding: [
    { name: "repo", type: "string" },
    { name: "maintainer", type: "address" },
    { name: "nonce", type: "bytes32" },
    { name: "deadline", type: "uint256" },
  ],
} as const;

export const PAYOUT_TYPES = {
  Payout: [
    { name: "issueNumber", type: "uint256" },
    { name: "serial", type: "uint256" },
    { name: "payee", type: "address" },
    { name: "amount", type: "uint256" },
    { name: "deadline", type: "uint256" },
  ],
} as const;

export interface SignedDepositTerms {
  chainId: number;
  usdc: Address;
  escrow: Address;
  repo: string;
  kind: Kind;
  number: number;
  /** The wallet that pays, and the only one a Refund can reach. */
  from: Address;
  /** The repo's active amount, in USDC base units. */
  value: bigint;
  /** 32 random bytes, so each authorization is new. */
  salt: Hex;
  /** Unix seconds. */
  validBefore: bigint;
}

/**
 * USDC's ReceiveWithAuthorization letting the escrow take exactly `value` from `from`, once, for one
 * item: the Contributor's one-signature Deposit, which anyone can submit with depositWithAuthorization.
 */
export function depositAuthorization(terms: SignedDepositTerms) {
  const key = keyOf(repoIdOf(terms.repo), terms.kind, terms.number);
  return {
    domain: usdcDomain(terms.chainId, terms.usdc),
    types: RECEIVE_WITH_AUTHORIZATION_TYPES,
    primaryType: "ReceiveWithAuthorization",
    message: {
      from: terms.from,
      to: terms.escrow,
      value: terms.value,
      validAfter: 0n,
      validBefore: terms.validBefore,
      nonce: authorizationNonce(key, terms.salt),
    },
  } as const;
}

export interface VerdictTerms {
  chainId: number;
  escrow: Address;
  key: Hex;
  /** The Deposit's Serial: the signature works for this Deposit only. */
  serial: bigint;
  /** Unix seconds. */
  sigDeadline: bigint;
}

/** The Maintainer's bad-faith verdict for one Deposit. */
export function forfeitVerdict({ chainId, escrow, key, serial, sigDeadline }: VerdictTerms) {
  return {
    domain: escrowDomain(chainId, escrow),
    types: FORFEIT_TYPES,
    primaryType: "Forfeit",
    message: { key, serial, sigDeadline },
  } as const;
}

export interface BindingProofTerms {
  chainId: number;
  escrow: Address;
  /** owner/name, in any case. */
  repo: string;
  /** The wallet being bound: the `maintainer` in bona-fide.yml. */
  maintainer: Address;
  /** 32 random bytes, so each proof is a new message. */
  nonce: Hex;
  /** Unix seconds. */
  deadline: bigint;
}

/** The Maintainer's one-time proof of wallet control, which the Keeper needs before it proposes a Binding. */
export function bindingProof({ chainId, escrow, repo, maintainer, nonce, deadline }: BindingProofTerms) {
  return {
    domain: escrowDomain(chainId, escrow),
    types: BINDING_TYPES,
    primaryType: "Binding",
    message: { repo: `github:${repo.toLowerCase()}`, maintainer, nonce, deadline },
  } as const;
}

export interface PayoutTerms {
  chainId: number;
  /** The Bounty wallet. */
  wallet: Address;
  issueNumber: number;
  /** The open Bounty's Serial: cancelling it and posting again voids the signature. */
  serial: bigint;
  payee: Address;
  /** The open Bounty's whole amount, in USDC base units. */
  amount: bigint;
  /** Unix seconds, inclusive. */
  deadline: bigint;
}

/** The Maintainer's signed Payout of one open Bounty, in full, to one payee. */
export function payoutSignature({ chainId, wallet, issueNumber, serial, payee, amount, deadline }: PayoutTerms) {
  return {
    domain: bountyDomain(chainId, wallet),
    types: PAYOUT_TYPES,
    primaryType: "Payout",
    message: { issueNumber: BigInt(issueNumber), serial, payee, amount, deadline },
  } as const;
}

export interface BountyFundTerms {
  chainId: number;
  usdc: Address;
  /** The Bounty wallet: USDC lets only it redeem the authorization. */
  wallet: Address;
  from: Address;
  value: bigint;
  /** 32 random bytes, so each authorization is new. */
  nonce: Hex;
  /** Unix seconds. */
  validBefore: bigint;
}

/** USDC's ReceiveWithAuthorization letting a Bounty wallet take exactly `value` from `from`, once. */
export function bountyFundAuthorization({ chainId, usdc, wallet, from, value, nonce, validBefore }: BountyFundTerms) {
  return {
    domain: usdcDomain(chainId, usdc),
    types: RECEIVE_WITH_AUTHORIZATION_TYPES,
    primaryType: "ReceiveWithAuthorization",
    message: { from, to: wallet, value, validAfter: 0n, validBefore, nonce },
  } as const;
}
