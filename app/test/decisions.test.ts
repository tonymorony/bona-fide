import { decisionsRoute } from "@bona-fide/sdk";
import { expect, test } from "vitest";
import { createDecisionLog, decisionCost, KEPT_PER_REPO } from "../src/decisions/log.ts";
import { createDecisionRoutes, LATEST } from "../src/decisions/routes.ts";
import type { Decision } from "../src/ports.ts";

// The decision log: what the App decided on its own and what it left to the Maintainer, as anyone
// can read it for a public repo.

const CLIENT_IP = "203.0.113.9";

let counter = 0;

/** A decision in `repo`, recorded at a later time than the one before. */
function decision(repo: string, more: Partial<Decision> = {}): Decision {
  counter += 1;
  return {
    id: `d-${counter}`,
    at: new Date(Date.UTC(2026, 8, 1, 0, 0, counter)).toISOString(),
    repo,
    private: false,
    item: { kind: "pr", number: counter },
    serial: String(counter),
    type: "early-refund",
    inputs: { source: "webhook pull_request.closed" },
    suggestion: null,
    witnesses: [{ name: "Merged", value: "yes" }],
    action: "refunded",
    txHash: `0x${"ab".repeat(32)}`,
    outcome: "decided",
    cost: null,
    ...more,
  };
}

function get(query: string, init: RequestInit = {}): Request {
  return new Request(`https://app.example${decisionsRoute.path}${query}`, init);
}

test("the log counts a repo's decisions made and left to the Maintainer, and lists the latest first", () => {
  const log = createDecisionLog();
  const first = decision("acme/widgets");
  const second = decision("acme/widgets", { type: "triage", outcome: "escalated", action: "drafted-verdict" });
  log.append(first);
  log.append(second);
  log.append(decision("acme/other"));

  expect(log.counts("Acme/Widgets")).toEqual({ decided: 1, escalated: 1 });
  expect(log.latest("acme/widgets", 10).map((d) => d.id)).toEqual([second.id, first.id]);
  expect(log.latest("acme/widgets", 1)).toEqual([second]);
});

test("a private repo's decisions are never published, not even as counts", () => {
  const log = createDecisionLog();
  log.append(decision("acme/secret", { private: true }));

  expect(log.counts("acme/secret")).toEqual({ decided: 0, escalated: 0 });
  expect(log.latest("acme/secret", 50)).toEqual([]);
});

test("once a repo turns private, none of its decisions are published, including earlier public ones", () => {
  const log = createDecisionLog();
  log.append(decision("acme/turned"));
  log.append(decision("acme/turned", { private: true }));

  expect(log.counts("acme/turned")).toEqual({ decided: 0, escalated: 0 });
  expect(log.latest("acme/turned", 50)).toEqual([]);
});

test("once a private repo turns public, only the decisions made while public are published", () => {
  const log = createDecisionLog();
  log.append(decision("acme/opened", { private: true }));
  const later = decision("acme/opened");
  log.append(later);

  expect(log.counts("acme/opened")).toEqual({ decided: 1, escalated: 0 });
  expect(log.latest("acme/opened", 50)).toEqual([later]);
});

test("memory keeps the latest decisions of each repo, and counts all of them", () => {
  const log = createDecisionLog();
  const all = Array.from({ length: KEPT_PER_REPO + 5 }, () => decision("acme/busy"));
  for (const d of all) log.append(d);

  expect(log.counts("acme/busy")).toEqual({ decided: KEPT_PER_REPO + 5, escalated: 0 });
  expect(log.latest("acme/busy", 1_000)).toHaveLength(KEPT_PER_REPO);
  expect(log.latest("acme/busy", 1)[0]).toEqual(all.at(-1));
});

test("each appended decision is written once, private ones too", () => {
  const written: Decision[] = [];
  const log = createDecisionLog({ write: (d) => written.push(d) });
  const added = [decision("acme/widgets"), decision("acme/secret", { private: true })];

  for (const d of added) log.append(d);

  expect(written).toEqual(added);
});

test("the latest waive decision about an item is kept for the App, private repos' too, and never served", () => {
  const log = createDecisionLog();
  const item = { kind: "pr", number: 7 } as const;
  log.append(decision("acme/widgets", { type: "waive", item, action: "required", outcome: "escalated" }));
  const waived = decision("acme/widgets", { type: "waive", item, action: "waived" });
  log.append(waived);
  log.append(decision("acme/widgets", { type: "triage", item, action: "noted-accept" }));
  const secret = decision("acme/secret", { type: "waive", item, action: "waived", private: true });
  log.append(secret);

  expect(log.waiverOf("Acme/Widgets", "pr", 7)).toEqual(waived);
  expect(log.waiverOf("acme/secret", "pr", 7)).toEqual(secret);
  expect(log.waiverOf("acme/widgets", "issue", 7)).toBeNull();
  expect(log.latest("acme/secret", 50)).toEqual([]);
});

test.each([
  ["claude-opus-5", 1_000_000, 1_000_000, 30],
  ["claude-opus-5", 1_200, 80, 0.008],
  ["claude-opus-5-20260801", 2_000, 0, 0.01],
  ["some-other-model", 1_200, 80, null],
])("%s reading %i tokens and writing %i costs about %s USD", (model, input, output, usd) => {
  expect(decisionCost(model, input, output)).toEqual({ model, inputTokens: input, outputTokens: output, usd });
});

test("GET /decisions answers a public repo's counts and its latest 50 decisions, newest first", async () => {
  const log = createDecisionLog();
  const all = Array.from({ length: 55 }, (_, i) =>
    decision("Acme/Widgets", i % 5 === 0 ? { outcome: "escalated", type: "triage" } : {}),
  );
  for (const d of all) log.append(d);
  log.append(decision("acme/other"));
  const routes = createDecisionRoutes(log);

  const response = (await routes(get("?repo=acme/widgets"), CLIENT_IP))!;

  expect(response.status).toBe(200);
  expect(response.headers.get("access-control-allow-origin")).toBe("*");
  expect(response.headers.get("content-type")).toContain("application/json");
  const body = decisionsRoute.answer(await response.json())!;
  expect(body.counts).toEqual({ decided: 44, escalated: 11 });
  expect(body.decisions).toHaveLength(LATEST);
  expect(body.decisions[0]!.id).toBe(all.at(-1)!.id);
  const { private: _, ...published } = all.at(-1)!;
  expect(body.decisions[0]).toEqual(published);
});

test("a private repo answers exactly like a repo with no decisions", async () => {
  const log = createDecisionLog();
  log.append(decision("acme/secret", { private: true }));
  const routes = createDecisionRoutes(log);

  const secret = (await routes(get("?repo=acme/secret"), CLIENT_IP))!;
  const unknown = (await routes(get("?repo=acme/unknown"), CLIENT_IP))!;

  expect(secret.status).toBe(200);
  expect(await secret.json()).toEqual({ counts: { decided: 0, escalated: 0 }, decisions: [] });
  expect([...secret.headers]).toEqual([...unknown.headers]);
  expect(await unknown.json()).toEqual({ counts: { decided: 0, escalated: 0 }, decisions: [] });
});

test.each(["", "?repo=", "?repo=acme", "?repo=acme/widgets/extra", "?repo=../etc", "?repo=a%20b/c"])(
  "GET /decisions%s is a 400 that says what a repo looks like",
  async (query) => {
    const routes = createDecisionRoutes(createDecisionLog());

    const response = (await routes(get(query), CLIENT_IP))!;

    expect(response.status).toBe(400);
    expect(response.headers.get("access-control-allow-origin")).toBe("*");
    expect(await response.json()).toEqual({
      error: "repo must be owner/name, such as octocat/hello-world.",
      code: "invalid",
    });
  },
);

test("GET /decisions is read-only: a preflight is allowed, and other methods get 405", async () => {
  const routes = createDecisionRoutes(createDecisionLog());

  const preflight = (await routes(get("?repo=acme/widgets", { method: "OPTIONS" }), CLIENT_IP))!;
  const post = (await routes(get("?repo=acme/widgets", { method: "POST", body: "{}" }), CLIENT_IP))!;

  expect(preflight.status).toBe(204);
  expect(preflight.headers.get("access-control-allow-methods")).toBe("GET, OPTIONS");
  expect(post.status).toBe(405);
  expect(post.headers.get("allow")).toBe("GET, OPTIONS");
  expect(await post.json()).toEqual({ error: "Send a GET request.", code: "method-not-allowed" });
});

test("other paths are left to the host", async () => {
  const routes = createDecisionRoutes(createDecisionLog());

  expect(await routes(new Request("https://app.example/forfeit", { method: "POST" }), CLIENT_IP)).toBeNull();
});

test("each client IP gets its own limit, and past it a 429 with Retry-After", async () => {
  let time = 0;
  const routes = createDecisionRoutes(createDecisionLog(), { perIp: { max: 2, windowMs: 60_000 }, now: () => time });

  const statuses = [];
  for (let i = 0; i < 3; i++) statuses.push((await routes(get("?repo=acme/widgets"), CLIENT_IP))!.status);
  const limited = (await routes(get("?repo=acme/widgets"), CLIENT_IP))!;
  const other = (await routes(get("?repo=acme/widgets"), "198.51.100.1"))!;
  time = 60_000;
  const later = (await routes(get("?repo=acme/widgets"), CLIENT_IP))!;

  expect(statuses).toEqual([200, 200, 429]);
  expect(limited.headers.get("retry-after")).toBe("60");
  expect(await limited.json()).toEqual({ error: "Too many requests. Try again in 60 s.", code: "rate-limited" });
  expect(other.status).toBe(200);
  expect(later.status).toBe(200);
});
