import type { DecisionLog } from "../ports.ts";
import { fixedWindow, type RateLimit } from "../relay/rate-limit.ts";

export const DECISIONS_ENDPOINT = "/decisions";
/** Most decisions GET /decisions answers. */
export const LATEST = 50;

/** Requests per client IP. Every request counts, well-formed or not. */
const PER_IP: RateLimit = { max: 30, windowMs: 60_000 };

// As the pages read them: a GitHub owner, and a repo name.
const REPO_NAME = /^[A-Za-z0-9-]{1,39}\/[A-Za-z0-9._-]{1,100}$/;

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
    if (url.pathname !== DECISIONS_ENDPOINT) return null;
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: PREFLIGHT });
    if (request.method !== "GET") {
      return answer({ error: "Send a GET request." }, 405, { allow: "GET, OPTIONS" });
    }
    const wait = ipWait(clientIp);
    if (wait > 0) {
      return answer({ error: `Too many requests. Try again in ${wait} s.` }, 429, { "retry-after": String(wait) });
    }
    const repo = url.searchParams.get("repo") ?? "";
    if (!REPO_NAME.test(repo)) return answer({ error: "repo must be owner/name, such as octocat/hello-world." }, 400);
    const decisions = log.latest(repo, LATEST).map(({ private: _, ...published }) => published);
    return answer({ counts: log.counts(repo), decisions });
  };
}

function answer(body: object, status = 200, headers: Record<string, string> = {}): Response {
  return Response.json(body, { status, headers: { ...CORS, "cache-control": "no-store", ...headers } });
}
