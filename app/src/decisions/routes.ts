import { decisionsRoute, type DecisionsAnswer, type RefusalBody } from "@bona-fide/sdk";
import type { DecisionLog } from "../ports.ts";
import { fixedWindow, type RateLimit } from "../relay/rate-limit.ts";

/** Most decisions GET /decisions answers. */
export const LATEST = 50;

/** Requests per client IP. Every request counts, well-formed or not. */
const PER_IP: RateLimit = { max: 30, windowMs: 60_000 };

// The log is public and read-only, so a page on any origin may read it.
const CORS = { "access-control-allow-origin": "*" };
const PREFLIGHT = {
  ...CORS,
  "access-control-allow-methods": "GET, OPTIONS",
  "access-control-max-age": "86400",
};

export interface DecisionRoutesOptions {
  perIp?: RateLimit;
  /** The clock for the rate limit, in milliseconds. */
  now?: () => number;
}

/**
 * GET /decisions?repo=owner/name: the repo's counts of decisions made and left to the Maintainer,
 * and its latest decisions, the newest first. A private repo answers like one with no decisions.
 * Null for any other path, which the host sends on.
 */
export function createDecisionRoutes(
  log: DecisionLog,
  { perIp = PER_IP, now = Date.now }: DecisionRoutesOptions = {},
): (request: Request, clientIp: string) => Promise<Response | null> {
  const ipWait = fixedWindow(perIp, now);
  return async (request, clientIp) => {
    const url = new URL(request.url);
    if (url.pathname !== decisionsRoute.path) return null;
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: PREFLIGHT });
    if (request.method !== "GET") {
      return refuse(405, { error: "Send a GET request.", code: "method-not-allowed" }, { allow: "GET, OPTIONS" });
    }
    const wait = ipWait(clientIp);
    if (wait > 0) {
      const error = `Too many requests. Try again in ${wait} s.`;
      return refuse(429, { error, code: "rate-limited" }, { "retry-after": String(wait) });
    }
    const query = decisionsRoute.decode(url.searchParams);
    if (!query.ok) return refuse(400, { error: query.problem, code: "invalid" });
    const { repo } = query.value;
    const decisions = log.latest(repo, LATEST).map(({ private: _, ...published }) => published);
    return answer({ counts: log.counts(repo), decisions } satisfies DecisionsAnswer);
  };
}

function answer(body: object, status = 200, headers: Record<string, string> = {}): Response {
  return Response.json(body, { status, headers: { ...CORS, "cache-control": "no-store", ...headers } });
}

function refuse(status: number, body: RefusalBody, headers: Record<string, string> = {}): Response {
  return answer(body, status, headers);
}
