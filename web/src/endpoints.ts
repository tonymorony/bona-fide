import type { Address, Hex } from "viem";
import type { Kind } from "./keys.ts";
import type { SignedDepositTerms } from "./typed-data.ts";

/** The App's endpoints, on the pages' own origin. */
export const PATHS = {
  relayDeposit: "/relay/deposit",
  forfeit: "/forfeit",
  bindingProof: "/binding-proof",
} as const;

export type Fetch = (input: string, init?: RequestInit) => Promise<Response>;

/** The body of POST /relay/deposit for an authorization built with the same terms. */
export function depositRelayBody(terms: SignedDepositTerms, signature: Hex) {
  return {
    repo: terms.repo,
    kind: terms.kind,
    number: terms.number,
    from: terms.from,
    value: terms.value.toString(),
    validAfter: "0",
    validBefore: terms.validBefore.toString(),
    salt: terms.salt,
    signature,
  };
}

/** The body of POST /forfeit. */
export function forfeitBody(verdict: {
  repo: string;
  kind: Kind;
  number: number;
  sigDeadline: bigint;
  signature: Hex;
}) {
  return { ...verdict, sigDeadline: verdict.sigDeadline.toString() };
}

/** The body of POST /binding-proof. `repo` is owner/name, as the Keeper reads it. */
export function bindingProofBody(
  proof: { repo: string; maintainer: Address; nonce: Hex; deadline: bigint },
  signature: Hex,
) {
  return { ...proof, deadline: proof.deadline.toString(), signature };
}

/** An answer with a JSON object body. Anything else (no answer, HTML from a proxy, an empty 500) is null. */
interface Answer {
  status: number;
  body: Record<string, unknown>;
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
    body: parsed as Record<string, unknown>,
    retryAfter: Number.isFinite(retryAfter) && retryAfter > 0 ? Math.ceil(retryAfter) : null,
  };
}

const HASH = /^0x[0-9a-fA-F]{64}$/;
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
/** When a 429 comes without Retry-After, wait out the App's one-minute window. */
const DEFAULT_WAIT_SECONDS = 60;

function hashIn(body: Record<string, unknown>): Hex | null {
  return typeof body.txHash === "string" && HASH.test(body.txHash) ? (body.txHash as Hex) : null;
}

function messageIn(body: Record<string, unknown>): string {
  return typeof body.error === "string" ? body.error : "";
}

function waitFor(answer: Answer) {
  return { kind: "wait", seconds: answer.retryAfter ?? DEFAULT_WAIT_SECONDS, message: messageIn(answer.body) } as const;
}

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
  | { kind: "wait"; seconds: number; message: string }
  /** The transaction reverted on-chain, so no Deposit was made. */
  | { kind: "reverted"; txHash: Hex | null }
  /** Sent, but not confirmed yet: watch the chain rather than sign again. */
  | { kind: "unconfirmed"; txHash: Hex }
  | { kind: "no-relay" }
  | { kind: "too-large" }
  | { kind: "invalid"; message: string }
  | { kind: "unavailable" };

/** Sends a signed Deposit to POST /relay/deposit, and says what came of it. */
export async function relayDeposit(body: ReturnType<typeof depositRelayBody>, fetch: Fetch): Promise<RelayOutcome> {
  const answer = await post(PATHS.relayDeposit, body, fetch);
  if (!answer) return { kind: "unavailable" };
  const { status, body: reply } = answer;
  const message = messageIn(reply);
  const txHash = hashIn(reply);
  if (status === 200 && txHash) return { kind: "deposited", txHash };
  if (status === 409) {
    if (typeof reply.amount === "string" && /^\d+$/.test(reply.amount)) {
      return { kind: "amount-changed", amount: BigInt(reply.amount) };
    }
    if (typeof reply.depositor === "string" && ADDRESS.test(reply.depositor)) {
      return { kind: "already-paid", depositor: reply.depositor as Address };
    }
    return { kind: "conflict", message };
  }
  if (status === 422) {
    if (/expired/i.test(message)) return { kind: "expired" };
    if (/balance/i.test(message)) return { kind: "low-balance" };
    if (/signature/i.test(message)) return { kind: "bad-signature", message };
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
  | { kind: "wait"; seconds: number; message: string }
  | { kind: "reverted"; txHash: Hex; message: string }
  | { kind: "too-large" }
  | { kind: "unavailable" };

/** Sends the Maintainer's signed Forfeit to POST /forfeit, and says what came of it. */
export async function sendVerdict(body: ReturnType<typeof forfeitBody>, fetch: Fetch): Promise<VerdictOutcome> {
  const answer = await post(PATHS.forfeit, body, fetch);
  if (!answer) return { kind: "unavailable" };
  const { status, body: reply } = answer;
  const txHash = hashIn(reply);
  if (status === 200 && txHash) return { kind: "forfeited", txHash };
  if (status === 400 || status === 404 || status === 409) return { kind: "refused", status, message: messageIn(reply) };
  if (status === 429) return waitFor(answer);
  if (status === 502 && txHash) return { kind: "reverted", txHash, message: messageIn(reply) };
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
  | { kind: "wait"; seconds: number; message: string }
  | { kind: "too-large" }
  | { kind: "unavailable" };

/** Sends the Maintainer's proof of wallet control to POST /binding-proof, and says what came of it. */
export async function askKeeperToBind(
  body: ReturnType<typeof bindingProofBody>,
  fetch: Fetch,
): Promise<BindingOutcome> {
  const answer = await post(PATHS.bindingProof, body, fetch);
  if (!answer) return { kind: "unavailable" };
  const { status, body: reply } = answer;
  if (status === 200) {
    const effectiveAt = typeof reply.effectiveAt === "number" ? reply.effectiveAt : null;
    const txHash = hashIn(reply);
    if (reply.status === "proposed" && txHash && effectiveAt) return { kind: "proposed", txHash, effectiveAt };
    if (reply.status === "pending" && effectiveAt) return { kind: "pending", effectiveAt };
    if (reply.status === "active") return { kind: "active" };
    return { kind: "unavailable" };
  }
  if (status === 400 || status === 404 || status === 409) return { kind: "refused", status, message: messageIn(reply) };
  if (status === 429) return waitFor(answer);
  if (status === 413) return { kind: "too-large" };
  return { kind: "unavailable" };
}
