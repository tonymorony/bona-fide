import { expect, test } from "vitest";
import {
  askKeeperToBind,
  payoutBody,
  readDecisions,
  relayDeposit,
  relayPayout,
  sendVerdict,
  type Fetch,
} from "../src/endpoints.ts";

const TX = `0x${"ab".repeat(32)}`;
const WALLET = "0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed";

/** A fetch that answers with `status` and a JSON body (or text), and records what was sent. */
function answering(status: number, body: unknown, headers: Record<string, string> = {}) {
  const sent: { url: string; init: RequestInit }[] = [];
  const fetch: Fetch = async (url, init) => {
    sent.push({ url: String(url), init: init ?? {} });
    const text = typeof body === "string" ? body : JSON.stringify(body);
    const type = typeof body === "string" ? "text/plain" : "application/json";
    return new Response(text, { status, headers: { "content-type": type, ...headers } });
  };
  return { fetch, sent };
}

const failing: Fetch = async () => {
  throw new TypeError("Failed to fetch");
};

const deposit = {
  repo: "acme/widgets",
  kind: "pr",
  number: 128,
  from: WALLET,
  value: "1000000",
  validAfter: "0",
  validBefore: "1790000000",
  salt: `0x${"11".repeat(32)}`,
  signature: `0x${"22".repeat(65)}`,
} as const;

test("a Deposit goes to the relay on the page's own origin as JSON", async () => {
  const { fetch, sent } = answering(200, { txHash: TX });

  await relayDeposit(deposit, fetch);

  expect(sent).toHaveLength(1);
  expect(sent[0]!.url).toBe("/relay/deposit");
  expect(sent[0]!.init.method).toBe("POST");
  expect(new Headers(sent[0]!.init.headers).get("content-type")).toBe("application/json");
  expect(JSON.parse(String(sent[0]!.init.body))).toEqual(deposit);
});

test.each([
  [200, { txHash: TX }, {}, { kind: "deposited", txHash: TX }],
  [409, { error: "…", amount: "2500000" }, {}, { kind: "amount-changed", amount: 2_500_000n }],
  [409, { error: "…", depositor: WALLET }, {}, { kind: "already-paid", depositor: WALLET }],
  [409, { error: "Bona Fide isn't active for acme/widgets." }, {}, { kind: "conflict" }],
  [409, { error: "A Deposit for PR #128 is being relayed right now." }, {}, { kind: "conflict" }],
  [422, { error: "The Deposit would fail on-chain: FiatTokenV2: authorization is expired." }, {}, { kind: "expired" }],
  [
    422,
    { error: "The Deposit would fail on-chain: ERC20: transfer amount exceeds balance." },
    {},
    { kind: "low-balance" },
  ],
  [422, { error: "The Deposit would fail on-chain: FiatTokenV2: invalid signature." }, {}, { kind: "bad-signature" }],
  [
    422,
    { error: "The Deposit would fail on-chain: DepositAlreadyActive." },
    {},
    { kind: "would-fail", message: "The Deposit would fail on-chain: DepositAlreadyActive." },
  ],
  [429, { error: "Too many requests. Try again in 42 s." }, { "retry-after": "42" }, { kind: "wait", seconds: 42 }],
  [502, { error: "…", txHash: TX }, {}, { kind: "reverted", txHash: TX }],
  [
    503,
    { error: "The relay can't complete this Deposit right now. Try again in a minute." },
    {},
    { kind: "unavailable" },
  ],
  [504, { error: "…", txHash: TX }, {}, { kind: "unconfirmed", txHash: TX }],
  [404, { error: "This App doesn't relay Deposits." }, {}, { kind: "no-relay" }],
  [413, { error: "The request body is over the 16 KiB limit." }, {}, { kind: "too-large" }],
  [
    400,
    { error: "`salt` must be 32 bytes of hex." },
    {},
    { kind: "invalid", message: "`salt` must be 32 bytes of hex." },
  ],
])("the relay's %i answer %j becomes %j", async (status, body, headers, outcome) => {
  expect(await relayDeposit(deposit, answering(status, body, headers).fetch)).toMatchObject(outcome);
});

test("a relay the page can't reach, or one that answers without JSON, is unavailable", async () => {
  expect(await relayDeposit(deposit, failing)).toEqual({ kind: "unavailable" });
  expect(await relayDeposit(deposit, answering(502, "<html>Bad Gateway</html>").fetch)).toEqual({
    kind: "unavailable",
  });
  expect(await relayDeposit(deposit, answering(500, "").fetch)).toEqual({ kind: "unavailable" });
});

test("a 504 without a transaction hash is unavailable, and a 429 without Retry-After waits a minute", async () => {
  expect(await relayDeposit(deposit, answering(504, { error: "…" }).fetch)).toEqual({ kind: "unavailable" });
  expect(await relayDeposit(deposit, answering(429, { error: "…" }).fetch)).toMatchObject({
    kind: "wait",
    seconds: 60,
  });
});

const verdict = {
  repo: "acme/widgets",
  kind: "pr",
  number: 125,
  sigDeadline: "1790000000",
  signature: `0x${"33".repeat(65)}`,
} as const;

test.each([
  [200, { txHash: TX }, {}, { kind: "forfeited", txHash: TX }],
  [
    400,
    { error: "This signature has expired. Sign again with a later deadline." },
    {},
    { kind: "refused", status: 400, message: "This signature has expired. Sign again with a later deadline." },
  ],
  [404, { error: "There's no Deposit on this PR." }, {}, { kind: "refused", status: 404 }],
  [409, { error: "This Deposit was already refunded." }, {}, { kind: "refused", status: 409 }],
  [429, { error: "Too many requests. Try again in 7 s." }, { "retry-after": "7" }, { kind: "wait", seconds: 7 }],
  [502, { error: "The Forfeit was sent but reverted on-chain…", txHash: TX }, {}, { kind: "reverted", txHash: TX }],
  [413, { error: "The request body is over the 16 KiB limit." }, {}, { kind: "too-large" }],
  [500, "", {}, { kind: "unavailable" }],
  [401, "Bad signature", {}, { kind: "unavailable" }],
])("the Keeper's %i answer %j to a verdict becomes %j", async (status, body, headers, outcome) => {
  expect(await sendVerdict(verdict, answering(status, body, headers).fetch)).toMatchObject(outcome);
});

test("a verdict goes to /forfeit on the page's own origin", async () => {
  const { fetch, sent } = answering(200, { txHash: TX });

  await sendVerdict(verdict, fetch);

  expect(sent[0]!.url).toBe("/forfeit");
  expect(JSON.parse(String(sent[0]!.init.body))).toEqual(verdict);
});

const proof = {
  repo: "acme/gizmos",
  maintainer: WALLET,
  nonce: `0x${"44".repeat(32)}`,
  deadline: "1790000000",
  signature: `0x${"55".repeat(65)}`,
} as const;

test.each([
  [
    200,
    { status: "proposed", txHash: TX, effectiveAt: 1790086400 },
    {},
    { kind: "proposed", txHash: TX, effectiveAt: 1790086400 },
  ],
  [200, { status: "pending", effectiveAt: 1790086400 }, {}, { kind: "pending", effectiveAt: 1790086400 }],
  [200, { status: "active" }, {}, { kind: "active" }],
  [
    409,
    { error: ".github/bona-fide.yml names 0x1 as the Maintainer, not 0x2." },
    {},
    { kind: "refused", status: 409, message: ".github/bona-fide.yml names 0x1 as the Maintainer, not 0x2." },
  ],
  [404, { error: "Bona Fide isn't installed on acme/gizmos." }, {}, { kind: "refused", status: 404 }],
  [400, { error: "This proof has expired. Sign a new one." }, {}, { kind: "refused", status: 400 }],
  [429, { error: "Too many requests. Try again in 3 s." }, { "retry-after": "3" }, { kind: "wait", seconds: 3 }],
  [413, { error: "The request body is over the 16 KiB limit." }, {}, { kind: "too-large" }],
  [500, "", {}, { kind: "unavailable" }],
  [200, { status: "something new" }, {}, { kind: "unavailable" }],
])("the Keeper's %i answer %j to a Binding proof becomes %j", async (status, body, headers, outcome) => {
  expect(await askKeeperToBind(proof, answering(status, body, headers).fetch)).toMatchObject(outcome);
});

test("a Binding proof goes to /binding-proof on the page's own origin", async () => {
  const { fetch, sent } = answering(200, { status: "active" });

  await askKeeperToBind(proof, fetch);

  expect(sent[0]!.url).toBe("/binding-proof");
  expect(JSON.parse(String(sent[0]!.init.body))).toEqual(proof);
});

const decision = {
  id: "3f1c",
  at: "2026-09-01T12:00:00.000Z",
  repo: "Acme/Widgets",
  item: { kind: "pr", number: 7 },
  serial: "3",
  type: "triage",
  inputs: { titleChars: 24, bodyChars: 12, bodyLeftOut: 0 },
  suggestion: { verdict: "accept", reasons: ["It fixes the typo it names."] },
  witnesses: [{ name: "Labels", value: "none" }],
  action: "noted-accept",
  txHash: null,
  outcome: "decided",
  cost: { model: "claude-opus-5", inputTokens: 1200, outputTokens: 80, usd: 0.008 },
};

test("the decision log is read with a GET to /decisions on the page's own origin", async () => {
  const { fetch, sent } = answering(200, { counts: { decided: 1, escalated: 0 }, decisions: [decision] });

  const outcome = await readDecisions("Acme/Widgets", fetch);

  expect(sent[0]!.url).toBe("/decisions?repo=Acme%2FWidgets");
  expect(sent[0]!.init.method ?? "GET").toBe("GET");
  expect(outcome).toEqual({
    kind: "ok",
    counts: { decided: 1, escalated: 0 },
    decisions: [{ ...decision, at: new Date(decision.at) }],
  });
});

test("an empty log is read as no decisions, not as a failure", async () => {
  const { fetch } = answering(200, { counts: { decided: 0, escalated: 0 }, decisions: [] });

  expect(await readDecisions("acme/widgets", fetch)).toEqual({
    kind: "ok",
    counts: { decided: 0, escalated: 0 },
    decisions: [],
  });
});

test.each([
  ["no answer", null],
  ["a 500", answering(500, "").fetch],
  ["a 429", answering(429, { error: "Too many requests. Try again in 60 s." }, { "retry-after": "60" }).fetch],
  ["HTML from a proxy", answering(200, "<html>Bad gateway</html>").fetch],
  ["counts that aren't numbers", answering(200, { counts: { decided: "1", escalated: 0 }, decisions: [] }).fetch],
  ["no list", answering(200, { counts: { decided: 0, escalated: 0 } }).fetch],
  [
    "a decision out of shape",
    answering(200, { counts: { decided: 1, escalated: 0 }, decisions: [{ ...decision, witnesses: "none" }] }).fetch,
  ],
  [
    "a malformed transaction hash",
    answering(200, { counts: { decided: 1, escalated: 0 }, decisions: [{ ...decision, txHash: "javascript:x" }] })
      .fetch,
  ],
])("%s makes the log unavailable, never an empty one", async (_, fetch) => {
  expect(await readDecisions("acme/widgets", fetch ?? failing)).toEqual({ kind: "unavailable" });
});

test.each([
  ["a Bounty Payout", { type: "pay", action: "paid", txHash: TX, item: { kind: "issue", number: 12 } }],
  [
    "a Bounty held for the Maintainer",
    {
      type: "hold",
      action: "held: above the per-payout limit",
      outcome: "escalated",
      serial: "2",
      item: { kind: "issue", number: 12 },
      inputs: { source: "merge", pr: 41, method: "keeper" },
      suggestion: { verdict: "resolves", reasons: ["It fixes the crash."] },
    },
  ],
])("%s is read like any other decision", async (_, more) => {
  const logged = { ...decision, ...more };
  const { fetch } = answering(200, { counts: { decided: 1, escalated: 1 }, decisions: [logged] });

  expect(await readDecisions("acme/widgets", fetch)).toEqual({
    kind: "ok",
    counts: { decided: 1, escalated: 1 },
    decisions: [{ ...logged, at: new Date(decision.at) }],
  });
});

test("a Bounty decision out of shape still makes the whole log unavailable", async () => {
  const broken = { ...decision, type: "pay", action: "paid", txHash: "0x1234", serial: "two" };
  const { fetch } = answering(200, { counts: { decided: 1, escalated: 0 }, decisions: [broken] });

  expect(await readDecisions("acme/widgets", fetch)).toEqual({ kind: "unavailable" });
});

const payout = {
  repo: "acme/widgets",
  issue: 12,
  payee: WALLET,
  deadline: 1790000000,
  signature: `0x${"66".repeat(65)}`,
} as const;

test("a signed Payout goes to /bounty/payout on the page's own origin, with the deadline as a number", async () => {
  const { fetch, sent } = answering(200, { txHash: TX });

  await relayPayout(payoutBody({ ...payout, deadline: 1790000000n }, payout.signature), fetch);

  expect(sent[0]!.url).toBe("/bounty/payout");
  expect(sent[0]!.init.method).toBe("POST");
  expect(JSON.parse(String(sent[0]!.init.body))).toEqual(payout);
});

test.each([
  [200, { txHash: TX }, {}, { kind: "paid", txHash: TX }],
  [400, { error: "This signature has expired." }, {}, { kind: "refused", status: 400 }],
  [404, { error: "No such endpoint." }, {}, { kind: "refused", status: 404, message: "No such endpoint." }],
  [404, { error: "acme/widgets has no Bounty on issue #12." }, {}, { kind: "refused", status: 404 }],
  [409, { error: "The Bounty on issue #12 was already paid." }, {}, { kind: "refused", status: 409 }],
  [422, { error: "The Payout would fail on-chain: InvalidSignature." }, {}, { kind: "refused", status: 422 }],
  [429, { error: "Too many requests." }, { "retry-after": "9" }, { kind: "wait", seconds: 9 }],
  [502, { error: "reverted", txHash: TX }, {}, { kind: "reverted", txHash: TX }],
  [504, { error: "not confirmed yet", txHash: TX }, {}, { kind: "unconfirmed", txHash: TX }],
  [413, { error: "The request body is over the 16 KiB limit." }, {}, { kind: "too-large" }],
  [502, "<html>Bad Gateway</html>", {}, { kind: "unavailable" }],
  [200, { status: "ok" }, {}, { kind: "unavailable" }],
])("the Keeper's %i answer %j to a signed Payout becomes %j", async (status, body, headers, outcome) => {
  expect(await relayPayout(payout, answering(status, body, headers).fetch)).toMatchObject(outcome);
});

test("a Payout relay the page can't reach is unavailable", async () => {
  expect(await relayPayout(payout, failing)).toEqual({ kind: "unavailable" });
});
