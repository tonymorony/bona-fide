import { KINDS, type Kind } from "@bona-fide/sdk";
import { getAddress, isAddress, type Hex } from "viem";
import type { Bounties, SignedPayout } from "../bounties/bounties.ts";
import { fixedWindow, type RateLimit } from "../relay/rate-limit.ts";
import { Refusal, type BindingProof, type Keeper, type SignedForfeit } from "./keeper.ts";

export const FORFEIT_PATH = "/forfeit";
export const BINDING_PROOF_PATH = "/binding-proof";
export const BOUNTY_PAYOUT_PATH = "/bounty/payout";

/** Requests per client IP to the endpoints together. Every POST counts, well-formed or not. */
const PER_IP: RateLimit = { max: 10, windowMs: 60_000 };

export interface KeeperRoutesOptions {
  /** Relays the Payouts Maintainers sign at POST /bounty/payout. Without it, that path isn't served. */
  bounties?: Pick<Bounties, "relayPayout">;
  perIp?: RateLimit;
  /** The clock for the rate limit, in milliseconds. */
  now?: () => number;
}

const REPO_NAME = /^[\w.-]+\/[\w.-]+$/;
const HEX = /^0x(?:[0-9a-fA-F]{2})+$/;
const UINT256_MAX = 2n ** 256n - 1n;

// The endpoints take no credentials: the signature in the body is what authorizes each action, so
// a sign page on any origin may call them.
const CORS = { "access-control-allow-origin": "*" };
const PREFLIGHT = {
  ...CORS,
  "access-control-allow-methods": "POST, OPTIONS",
  "access-control-allow-headers": "content-type",
  "access-control-max-age": "86400",
};

/**
 * The Keeper's HTTP endpoints. Null for any other request, which the host sends on. `clientIp` is
 * the caller's address, as the host sees it.
 */
export function createKeeperRoutes(
  keeper: Keeper,
  { bounties, perIp = PER_IP, now = Date.now }: KeeperRoutesOptions = {},
): (request: Request, clientIp: string) => Promise<Response | null> {
  const ipWait = fixedWindow(perIp, now);
  const routes: Record<string, (body: unknown) => Promise<object>> = {
    [FORFEIT_PATH]: async (body) => ({ txHash: await keeper.relayForfeit(parseForfeit(body)) }),
    [BINDING_PROOF_PATH]: async (body) => {
      const bound = await keeper.bindRepo(parseBindingProof(body));
      return "effectiveAt" in bound ? { ...bound, effectiveAt: Number(bound.effectiveAt) } : bound;
    },
  };
  if (bounties) {
    routes[BOUNTY_PAYOUT_PATH] = async (body) => ({ txHash: await bounties.relayPayout(parsePayout(body)) });
  }
  return async (request, clientIp) => {
    const route = routes[new URL(request.url).pathname];
    if (!route) return null;
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: PREFLIGHT });
    if (request.method !== "POST") return answer({ error: "Send a POST request." }, 405, { allow: "POST, OPTIONS" });
    const wait = ipWait(clientIp);
    if (wait > 0) {
      return answer({ error: `Too many requests. Try again in ${wait} s.` }, 429, { "retry-after": String(wait) });
    }
    try {
      return answer(await route(await request.json().catch(() => null)));
    } catch (error) {
      if (!(error instanceof Refusal)) throw error;
      const { message, status, retryAfter, txHash } = error;
      return answer(txHash ? { error: message, txHash } : { error: message }, status, {
        ...(retryAfter ? { "retry-after": String(retryAfter) } : {}),
      });
    }
  };
}

function answer(body: object, status = 200, headers: Record<string, string> = {}): Response {
  return Response.json(body, { status, headers: { ...CORS, ...headers } });
}

/** The request as a SignedForfeit. Throws a Refusal that says what is wrong with it. */
function parseForfeit(body: unknown): SignedForfeit {
  const { repo, kind, number, sigDeadline, signature } = fieldsOf(
    body,
    "repo, kind, number, sigDeadline and signature",
  );
  if (typeof repo !== "string" || !REPO_NAME.test(repo))
    throw badRequest("repo must be owner/name, such as octocat/hello-world.");
  if (!KINDS.includes(kind as Kind)) throw badRequest('kind must be "pr" or "issue".');
  if (typeof number !== "number" || !Number.isSafeInteger(number) || number < 1) {
    throw badRequest("number must be a whole number above 0.");
  }
  const deadline = unixSeconds(sigDeadline);
  if (deadline === null) throw badRequest("sigDeadline must be a time in Unix seconds.");
  if (typeof signature !== "string" || !HEX.test(signature)) throw badRequest("signature must be 0x-prefixed hex.");
  return { repo, kind: kind as Kind, number, sigDeadline: deadline, signature: signature as Hex };
}

/** The request as a BindingProof. Throws a Refusal that says what is wrong with it. */
function parseBindingProof(body: unknown): BindingProof {
  const { repo, maintainer, nonce, deadline, signature } = fieldsOf(
    body,
    "repo, maintainer, nonce, deadline and signature",
  );
  if (typeof repo !== "string" || !REPO_NAME.test(repo))
    throw badRequest("repo must be owner/name, such as octocat/hello-world.");
  if (typeof maintainer !== "string" || !isAddress(maintainer))
    throw badRequest("maintainer must be a wallet address.");
  if (typeof nonce !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(nonce))
    throw badRequest("nonce must be 32 bytes of hex.");
  const until = unixSeconds(deadline);
  if (until === null) throw badRequest("deadline must be a time in Unix seconds.");
  if (typeof signature !== "string" || !HEX.test(signature)) throw badRequest("signature must be 0x-prefixed hex.");
  return { repo, maintainer, nonce: nonce as Hex, deadline: until, signature: signature as Hex };
}

/** The request as a SignedPayout. Throws a Refusal that says what is wrong with it. */
function parsePayout(body: unknown): SignedPayout {
  const { repo, issue, payee, deadline, signature } = fieldsOf(body, "repo, issue, payee, deadline and signature");
  if (typeof repo !== "string" || !REPO_NAME.test(repo))
    throw badRequest("repo must be owner/name, such as octocat/hello-world.");
  if (typeof issue !== "number" || !Number.isSafeInteger(issue) || issue < 1) {
    throw badRequest("issue must be a whole number above 0.");
  }
  if (typeof payee !== "string" || !isAddress(payee)) throw badRequest("payee must be a wallet address.");
  const until = unixSeconds(deadline);
  if (until === null) throw badRequest("deadline must be a time in Unix seconds.");
  if (typeof signature !== "string" || !HEX.test(signature)) throw badRequest("signature must be 0x-prefixed hex.");
  return { repo, issue, payee: getAddress(payee), deadline: until, signature: signature as Hex };
}

function fieldsOf(body: unknown, names: string): Record<string, unknown> {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw badRequest(`Send a JSON body with ${names}.`);
  }
  return body as Record<string, unknown>;
}

function badRequest(message: string): Refusal {
  return new Refusal(400, message);
}

// A JSON number, or a decimal string for values past 2^53.
function unixSeconds(value: unknown): bigint | null {
  if (typeof value === "number") return Number.isSafeInteger(value) && value >= 0 ? BigInt(value) : null;
  if (typeof value !== "string" || !/^\d{1,78}$/.test(value)) return null;
  const seconds = BigInt(value);
  return seconds <= UINT256_MAX ? seconds : null;
}
