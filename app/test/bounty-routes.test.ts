import type { Hex } from "viem";
import { expect, test } from "vitest";
import type { SignedPayout } from "../src/bounties/bounties.ts";
import { Refusal, type Keeper } from "../src/keeper/keeper.ts";
import { createKeeperRoutes } from "../src/keeper/routes.ts";
import { PAYEE } from "./support/bounties.ts";

// POST /bounty/payout: the request a Bounty page sends to relay a Payout the Maintainer signed. The
// relay itself runs against the real wallet in bounties.anvil.test.ts.

const KEEPER = {} as Keeper;
const TX: Hex = `0x${"ab".repeat(32)}`;

function routesWith(relayPayout: (payout: SignedPayout) => Promise<Hex>) {
  const routes = createKeeperRoutes(KEEPER, { bounties: { relayPayout } });
  return (body: unknown, init: RequestInit = { method: "POST" }) =>
    routes(
      new Request("https://app.example/bounty/payout", {
        ...init,
        body: init.method === "POST" ? (typeof body === "string" ? body : JSON.stringify(body)) : undefined,
      }),
      "203.0.113.9",
    );
}

const VALID = {
  repo: "Codertocat/Hello-World",
  issue: 42,
  payee: PAYEE.toLowerCase(),
  deadline: 1_790_000_000,
  signature: `0x${"ab".repeat(65)}`,
};

test("a signed Payout is relayed, with the payee checksummed and the deadline as a bigint", async () => {
  const relayed: SignedPayout[] = [];
  const post = routesWith(async (payout) => {
    relayed.push(payout);
    return TX;
  });

  const response = await post({ ...VALID, deadline: "1790000000" });

  expect(response?.status).toBe(200);
  expect(response?.headers.get("access-control-allow-origin")).toBe("*");
  expect(await response?.json()).toEqual({ txHash: TX });
  expect(relayed).toEqual([{ ...VALID, payee: PAYEE, deadline: 1_790_000_000n }]);
});

test.each([
  ["no JSON body", "{", "Send a JSON body with repo, issue, payee, deadline and signature."],
  ["a repo without an owner", { ...VALID, repo: "hello" }, "repo must be owner/name, such as octocat/hello-world."],
  [
    "an owner GitHub wouldn't allow",
    { ...VALID, repo: "hello_world/x" },
    "repo must be owner/name, such as octocat/hello-world.",
  ],
  ["an issue that isn't whole", { ...VALID, issue: 4.2 }, "issue must be a whole number above 0."],
  ["an issue number as a string", { ...VALID, issue: "42" }, "issue must be a whole number above 0."],
  ["a payee that isn't an address", { ...VALID, payee: "newcomer.eth" }, "payee must be a wallet address."],
  ["a deadline that isn't a time", { ...VALID, deadline: "soon" }, "deadline must be a time in Unix seconds."],
  ["a signature that isn't hex", { ...VALID, signature: "0xzz" }, "signature must be 0x-prefixed hex."],
])("a Payout request with %s is refused with the reason", async (_, body, error) => {
  const post = routesWith(async () => TX);

  const response = await post(body);

  expect(response?.status).toBe(400);
  expect(await response?.json()).toEqual({ error, code: "invalid" });
});

test("a refusal keeps its status, code and reason", async () => {
  const post = routesWith(async () => {
    throw new Refusal(409, "resolved", "This Bounty was already paid.");
  });

  const response = await post(VALID);

  expect(response?.status).toBe(409);
  expect(await response?.json()).toEqual({ error: "This Bounty was already paid.", code: "resolved" });
});

test("it answers a CORS preflight, and any other method gets 405", async () => {
  const post = routesWith(async () => TX);

  expect((await post(null, { method: "OPTIONS" }))?.status).toBe(204);
  const get = await post(null, { method: "GET" });
  expect(get?.status).toBe(405);
  expect(await get?.json()).toMatchObject({ code: "method-not-allowed" });
});

test("it shares the per-IP limit of the Keeper's endpoints", async () => {
  const post = routesWith(async () => TX);
  for (let i = 0; i < 10; i++) await post(VALID);

  const response = await post(VALID);

  expect(response?.status).toBe(429);
  expect(await response?.json()).toMatchObject({ code: "rate-limited" });
});

test("without Bounties, the path isn't the Keeper's to answer", async () => {
  const routes = createKeeperRoutes(KEEPER);

  expect(await routes(new Request("https://app.example/bounty/payout", { method: "POST" }), "203.0.113.9")).toBeNull();
});
