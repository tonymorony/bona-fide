import {
  bindingProofRoute,
  bountyPayoutRoute,
  decisionsRoute,
  forfeitRoute,
  refusalIn,
  relayDepositRoute,
  type AppRefusal,
  type PublishedDecision,
  type SignedBindingProof,
  type SignedDeposit,
  type SignedDepositTerms,
  type SignedForfeit,
  type SignedPayout,
  type Wire,
} from "@bona-fide/sdk";
import type { Address, Hex } from "viem";

// The App's routes, on the pages' own origin. The sdk's routes say what each takes and answers.

export type Fetch = (input: string, init?: RequestInit) => Promise<Response>;

/** The body of POST /relay/deposit for an authorization built with the same terms. */
export function depositRelayBody(terms: SignedDepositTerms, signature: Hex): Wire<SignedDeposit> {
  const { repo, kind, number, from, value, validBefore, salt } = terms;
  return relayDepositRoute.encode({ repo, kind, number, from, value, validAfter: 0n, validBefore, salt, signature });
}

/** The body of POST /forfeit. */
export function forfeitBody(verdict: SignedForfeit): Wire<SignedForfeit> {
  return forfeitRoute.encode(verdict);
}

/** The body of POST /binding-proof. `repo` is owner/name, as the Keeper reads it. */
export function bindingProofBody(
  proof: { repo: string; maintainer: Address; nonce: Hex; deadline: bigint },
  signature: Hex,
): Wire<SignedBindingProof> {
  return bindingProofRoute.encode({ ...proof, signature });
}

/**
 * The body of POST /bounty/payout: the Maintainer's signed Payout, for the Keeper to relay. `issue` is the
 * Bounty's issue number, and `deadline` the signature's, in unix seconds.
 */
export function payoutBody(payout: Omit<SignedPayout, "signature">, signature: Hex): Wire<SignedPayout> {
  return bountyPayoutRoute.encode({ ...payout, signature });
}

/** An answer with a JSON object body. Anything else (no answer, HTML from a proxy, an empty 500) is null. */
interface Answer {
  status: number;
  body: unknown;
  /** What the body says if it is a refusal. */
  refusal: AppRefusal;
  /** Seconds, from Retry-After. */
  retryAfter: number | null;
}

async function post(path: string, body: unknown, fetch: Fetch): Promise<Answer | null> {
  let response: Response;
  try {
    response = await fetch(path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch {
    return null;
  }
  const parsed: unknown = await response.json().catch(() => null);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
  const retryAfter = Number(response.headers.get("retry-after"));
  return {
    status: response.status,
    body: parsed,
    refusal: refusalIn(parsed),
    retryAfter: Number.isFinite(retryAfter) && retryAfter > 0 ? Math.ceil(retryAfter) : null,
  };
}

/** When a 429 comes without Retry-After, wait out the App's one-minute window. */
const DEFAULT_WAIT_SECONDS = 60;

function waitFor({ retryAfter, refusal }: Answer) {
  return {
    kind: "wait",
    seconds: retryAfter ?? DEFAULT_WAIT_SECONDS,
    paused: refusal.code === "paused",
    message: refusal.error,
  } as const;
}

/**
 * A 429: wait `seconds`. `paused` when a relayed transaction for the same Deposit, Bounty or wallet
 * reverted on-chain, rather than too many requests.
 */
type Wait = ReturnType<typeof waitFor>;

export type RelayOutcome =
  | { kind: "deposited"; txHash: Hex }
  /** The repo's amount changed since the page read it: sign again for the new amount. */
  | { kind: "amount-changed"; amount: bigint }
  | { kind: "already-paid"; depositor: Address }
  /** The repo isn't active, or a Deposit for the item is being relayed: read the chain again. */
  | { kind: "conflict"; message: string }
  | { kind: "expired" }
  | { kind: "low-balance" }
  /** USDC refused the signature, as it does for a smart wallet that isn't deployed yet. */
  | { kind: "bad-signature"; message: string }
  | { kind: "would-fail"; message: string }
  | Wait
  /** The transaction reverted on-chain, so no Deposit was made. */
  | { kind: "reverted"; txHash: Hex | null }
  /** Sent, but not confirmed yet: watch the chain rather than sign again. */
  | { kind: "unconfirmed"; txHash: Hex }
  | { kind: "no-relay" }
  | { kind: "too-large" }
  | { kind: "invalid"; message: string }
  | { kind: "unavailable" };

/** Sends a signed Deposit to POST /relay/deposit, and says what came of it. */
export async function relayDeposit(body: Wire<SignedDeposit>, fetch: Fetch): Promise<RelayOutcome> {
  const answer = await post(relayDepositRoute.path, body, fetch);
  if (!answer) return { kind: "unavailable" };
  const { status, refusal } = answer;
  const { code, error: message, txHash } = refusal;
  const deposited = relayDepositRoute.answer(answer.body);
  if (status === 200 && deposited) return { kind: "deposited", txHash: deposited.txHash };
  if (status === 409) {
    if (code === "amount-changed" && refusal.amount !== null) return { kind: "amount-changed", amount: refusal.amount };
    if (code === "already-deposited" && refusal.depositor) {
      return { kind: "already-paid", depositor: refusal.depositor };
    }
    return { kind: "conflict", message };
  }
  if (status === 422) {
    if (code === "expired" || code === "low-balance") return { kind: code };
    if (code === "bad-signature") return { kind: code, message };
    return { kind: "would-fail", message };
  }
  if (status === 429) return waitFor(answer);
  if (status === 502) return { kind: "reverted", txHash };
  if (status === 504 && txHash) return { kind: "unconfirmed", txHash };
  if (status === 404) return { kind: "no-relay" };
  if (status === 413) return { kind: "too-large" };
  if (status === 400) return { kind: "invalid", message };
  return { kind: "unavailable" };
}

export type VerdictOutcome =
  | { kind: "forfeited"; txHash: Hex }
  /** The Keeper won't relay it: a wrong or expired signature, no Deposit, or one already resolved. */
  | { kind: "refused"; status: 400 | 404 | 409; message: string }
  | Wait
  | { kind: "reverted"; txHash: Hex; message: string }
  | { kind: "too-large" }
  | { kind: "unavailable" };

/** Sends the Maintainer's signed Forfeit to POST /forfeit, and says what came of it. */
export async function sendVerdict(body: Wire<SignedForfeit>, fetch: Fetch): Promise<VerdictOutcome> {
  const answer = await post(forfeitRoute.path, body, fetch);
  if (!answer) return { kind: "unavailable" };
  const { status, refusal } = answer;
  const forfeited = forfeitRoute.answer(answer.body);
  if (status === 200 && forfeited) return { kind: "forfeited", txHash: forfeited.txHash };
  if (status === 400 || status === 404 || status === 409) return { kind: "refused", status, message: refusal.error };
  if (status === 429) return waitFor(answer);
  if (status === 502 && refusal.txHash) return { kind: "reverted", txHash: refusal.txHash, message: refusal.error };
  if (status === 413) return { kind: "too-large" };
  return { kind: "unavailable" };
}

export type BindingOutcome =
  | { kind: "proposed"; txHash: Hex; effectiveAt: number }
  /** That Binding was already proposed, so nothing was sent. */
  | { kind: "pending"; effectiveAt: number }
  /** That Binding is already active, so nothing was sent. */
  | { kind: "active" }
  /** The Keeper won't propose it: the file, the installation or the signature needs a fix. */
  | { kind: "refused"; status: 400 | 404 | 409; message: string }
  | Wait
  | { kind: "too-large" }
  | { kind: "unavailable" };

/** Sends the Maintainer's proof of wallet control to POST /binding-proof, and says what came of it. */
export async function askKeeperToBind(body: Wire<SignedBindingProof>, fetch: Fetch): Promise<BindingOutcome> {
  const answer = await post(bindingProofRoute.path, body, fetch);
  if (!answer) return { kind: "unavailable" };
  const { status, refusal } = answer;
  if (status === 200) {
    const bound = bindingProofRoute.answer(answer.body);
    if (bound?.status === "proposed") return { kind: "proposed", txHash: bound.txHash, effectiveAt: bound.effectiveAt };
    if (bound?.status === "pending") return { kind: "pending", effectiveAt: bound.effectiveAt };
    if (bound?.status === "active") return { kind: "active" };
    return { kind: "unavailable" };
  }
  if (status === 400 || status === 404 || status === 409) return { kind: "refused", status, message: refusal.error };
  if (status === 429) return waitFor(answer);
  if (status === 413) return { kind: "too-large" };
  return { kind: "unavailable" };
}

export type PayoutOutcome =
  | { kind: "paid"; txHash: Hex }
  /** The Keeper won't relay it: a wrong or expired signature, no open Bounty, or no such endpoint here. */
  | { kind: "refused"; status: 400 | 404 | 409 | 422; message: string }
  | Wait
  | { kind: "reverted"; txHash: Hex; message: string }
  /** Sent, but not confirmed yet: watch the chain rather than send it again. */
  | { kind: "unconfirmed"; txHash: Hex }
  | { kind: "too-large" }
  | { kind: "unavailable" };

/** Sends the Maintainer's signed Payout to POST /bounty/payout, and says what came of it. */
export async function relayPayout(body: Wire<SignedPayout>, fetch: Fetch): Promise<PayoutOutcome> {
  const answer = await post(bountyPayoutRoute.path, body, fetch);
  if (!answer) return { kind: "unavailable" };
  const { status, refusal } = answer;
  const { error: message, txHash } = refusal;
  const paid = bountyPayoutRoute.answer(answer.body);
  if (status === 200 && paid) return { kind: "paid", txHash: paid.txHash };
  if (status === 400 || status === 404 || status === 409 || status === 422) return { kind: "refused", status, message };
  if (status === 429) return waitFor(answer);
  if (status === 502 && txHash) return { kind: "reverted", txHash, message };
  if (status === 504 && txHash) return { kind: "unconfirmed", txHash };
  if (status === 413) return { kind: "too-large" };
  return { kind: "unavailable" };
}

/** One decision in the App's log, as GET /decisions answers it, with its time read. Show its text as text only. */
export type Decision = Omit<PublishedDecision, "at"> & { at: Date };

export type DecisionsOutcome =
  | { kind: "ok"; counts: { decided: number; escalated: number }; decisions: Decision[] }
  /** No answer, or one out of shape: the page says the log couldn't be read, never that it is empty. */
  | { kind: "unavailable" };

/** Reads the repo's decision log from GET /decisions. */
export async function readDecisions(repo: string, fetch: Fetch): Promise<DecisionsOutcome> {
  let body: unknown;
  try {
    const response = await fetch(`${decisionsRoute.path}?${decisionsRoute.encode({ repo })}`);
    if (response.status !== 200) return { kind: "unavailable" };
    body = await response.json();
  } catch {
    return { kind: "unavailable" };
  }
  const log = decisionsRoute.answer(body);
  if (!log) return { kind: "unavailable" };
  return {
    kind: "ok",
    counts: log.counts,
    decisions: log.decisions.map((decision) => ({ ...decision, at: new Date(decision.at) })),
  };
}
