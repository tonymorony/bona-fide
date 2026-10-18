import {
  bindingProofRoute,
  bountyPayoutRoute,
  forfeitRoute,
  type BindingAnswer,
  type Decoded,
  type RefusalBody,
} from "@bona-fide/sdk";
import type { Bounties } from "../bounties/bounties.ts";
import { fixedWindow, type RateLimit } from "../relay/rate-limit.ts";
import { Refusal, type Keeper } from "./keeper.ts";

/** Requests per client IP to the endpoints together. Every POST counts, well-formed or not. */
const PER_IP: RateLimit = { max: 10, windowMs: 60_000 };

export interface KeeperRoutesOptions {
  /** Relays the Payouts Maintainers sign at POST /bounty/payout. Without it, that path isn't served. */
  bounties?: Pick<Bounties, "relayPayout">;
  perIp?: RateLimit;
  /** The clock for the rate limit, in milliseconds. */
  now?: () => number;
}

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
    [forfeitRoute.path]: async (body) => ({ txHash: await keeper.relayForfeit(read(forfeitRoute.decode(body))) }),
    [bindingProofRoute.path]: async (body): Promise<BindingAnswer> => {
      const bound = await keeper.bindRepo(read(bindingProofRoute.decode(body)));
      return "effectiveAt" in bound ? { ...bound, effectiveAt: Number(bound.effectiveAt) } : bound;
    },
  };
  if (bounties) {
    routes[bountyPayoutRoute.path] = async (body) => ({
      txHash: await bounties.relayPayout(read(bountyPayoutRoute.decode(body))),
    });
  }
  return async (request, clientIp) => {
    const route = routes[new URL(request.url).pathname];
    if (!route) return null;
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: PREFLIGHT });
    if (request.method !== "POST") {
      return refuse(405, { error: "Send a POST request.", code: "method-not-allowed" }, { allow: "POST, OPTIONS" });
    }
    const wait = ipWait(clientIp);
    if (wait > 0) {
      const error = `Too many requests. Try again in ${wait} s.`;
      return refuse(429, { error, code: "rate-limited" }, { "retry-after": String(wait) });
    }
    try {
      return answer(await route(await request.json().catch(() => null)));
    } catch (error) {
      if (!(error instanceof Refusal)) throw error;
      const { message, code, status, retryAfter, txHash } = error;
      return refuse(
        status,
        txHash ? { error: message, code, txHash } : { error: message, code },
        retryAfter ? { "retry-after": String(retryAfter) } : {},
      );
    }
  };
}

function answer(body: object, status = 200, headers: Record<string, string> = {}): Response {
  return Response.json(body, { status, headers: { ...CORS, ...headers } });
}

function refuse(status: number, body: RefusalBody, headers: Record<string, string> = {}): Response {
  return answer(body, status, headers);
}

/** The request the body names. Throws a Refusal that says what is wrong with it. */
function read<T>(decoded: Decoded<T>): T {
  if (!decoded.ok) throw new Refusal(400, "invalid", decoded.problem);
  return decoded.value;
}
