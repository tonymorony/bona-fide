import type { DecisionsAnswer, RefusalBody } from "@bona-fide/sdk";
import type { Hex } from "viem";
import { expect, test } from "vitest";
import {
  askKeeperToBind,
  bindingProofBody,
  depositRelayBody,
  forfeitBody,
  payoutBody,
  readDecisions,
  relayDeposit,
  relayPayout,
  sendVerdict,
  type Fetch,
} from "../src/endpoints.ts";

// How the pages read each of the App's answers. The answers are built from the sdk's shapes, as the
// App sends them; the codecs themselves are tested in the sdk.

const TX: Hex = `0x${"ab".repeat(32)}`;
const WALLET = "0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed";

/** A fetch that answers with `status` and a JSON body (or text), and records what was sent. */
function answering(status: number, body: RefusalBody | object | string, headers: Record<string, string> = {}) {
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

const deposit = depositRelayBody(
  {
    chainId: 5042002,
    usdc: WALLET,
    escrow: WALLET,
    repo: "acme/widgets",
    kind: "pr",
    number: 128,
    from: WALLET,
    value: 1_000_000n,
    validBefore: 1_790_000_000n,
    salt: `0x${"11".repeat(32)}`,
  },
  `0x${"22".repeat(65)}`,
);

test("a Deposit goes to the relay on the page's own origin as JSON, amounts and times as strings", async () => {
  const { fetch, sent } = answering(200, { txHash: TX });

  await relayDeposit(deposit, fetch);

  expect(sent).toHaveLength(1);
  expect(sent[0]!.url).toBe("/relay/deposit");
  expect(sent[0]!.init.method).toBe("POST");
  expect(new Headers(sent[0]!.init.headers).get("content-type")).toBe("application/json");
  expect(JSON.parse(String(sent[0]!.init.body))).toEqual({
    repo: "acme/widgets",
    kind: "pr",
    number: 128,
    from: WALLET,
    value: "1000000",
    validAfter: "0",
    validBefore: "1790000000",
    salt: `0x${"11".repeat(32)}`,
    signature: `0x${"22".repeat(65)}`,
  });
});

const refusal = (code: RefusalBody["code"], more: Partial<RefusalBody> = {}): RefusalBody => ({
  error: `Refused: ${code}.`,
  code,
  ...more,
});

test.each([
  [200, { txHash: TX }, {}, { kind: "deposited", txHash: TX }],
  [409, refusal("amount-changed", { amount: "2500000" }), {}, { kind: "amount-changed", amount: 2_500_000n }],
  [409, refusal("already-deposited", { depositor: WALLET }), {}, { kind: "already-paid", depositor: WALLET }],
  [409, refusal("inactive"), {}, { kind: "conflict", message: "Refused: inactive." }],
  [409, refusal("in-flight"), {}, { kind: "conflict" }],
  [422, refusal("expired"), {}, { kind: "expired" }],
  [422, refusal("low-balance"), {}, { kind: "low-balance" }],
  [422, refusal("bad-signature"), {}, { kind: "bad-signature", message: "Refused: bad-signature." }],
  [422, refusal("would-fail"), {}, { kind: "would-fail", message: "Refused: would-fail." }],
  [429, refusal("rate-limited"), { "retry-after": "42" }, { kind: "wait", seconds: 42, paused: false }],
  [429, refusal("paused"), { "retry-after": "600" }, { kind: "wait", seconds: 600, paused: true }],
  [502, refusal("reverted", { txHash: TX }), {}, { kind: "reverted", txHash: TX }],
  [503, refusal("unavailable"), {}, { kind: "unavailable" }],
  [504, refusal("unconfirmed", { txHash: TX }), {}, { kind: "unconfirmed", txHash: TX }],
  [404, refusal("not-served"), {}, { kind: "no-relay" }],
  [413, refusal("too-large"), {}, { kind: "too-large" }],
  [400, refusal("invalid"), {}, { kind: "invalid", message: "Refused: invalid." }],
])("the relay's %i answer %j becomes %j", async (status, body, headers, outcome) => {
  expect(await relayDeposit(deposit, answering(status, body, headers).fetch)).toMatchObject(outcome);
});

// The code says why, not the text: an App older than the codes, or a proxy, gets the safe reading.
test("a refusal is read by its code, and one without a code by its status alone", async () => {
  const saysBalance = { error: "The Deposit would fail on-chain: ERC20: transfer amount exceeds balance." };

  expect(await relayDeposit(deposit, answering(422, saysBalance).fetch)).toMatchObject({ kind: "would-fail" });
  expect(await relayDeposit(deposit, answering(422, { ...saysBalance, code: "low-balance" }).fetch)).toEqual({
    kind: "low-balance",
  });
  expect(await relayDeposit(deposit, answering(429, { error: "The relay paused Deposits." }).fetch)).toMatchObject({
    kind: "wait",
    paused: false,
  });
  expect(await relayDeposit(deposit, answering(404, { error: "No such endpoint." }).fetch)).toEqual({
    kind: "no-relay",
  });
});

test("a relay the page can't reach, or one that answers without JSON, is unavailable", async () => {
  expect(await relayDeposit(deposit, failing)).toEqual({ kind: "unavailable" });
  expect(await relayDeposit(deposit, answering(502, "<html>Bad Gateway</html>").fetch)).toEqual({
    kind: "unavailable",
  });
  expect(await relayDeposit(deposit, answering(500, "").fetch)).toEqual({ kind: "unavailable" });
});

test("a 504 without a transaction hash is unavailable, and a 429 without Retry-After waits a minute", async () => {
  expect(await relayDeposit(deposit, answering(504, refusal("unconfirmed")).fetch)).toEqual({ kind: "unavailable" });
  expect(await relayDeposit(deposit, answering(429, refusal("rate-limited")).fetch)).toMatchObject({
    kind: "wait",
    seconds: 60,
  });
});

const verdict = forfeitBody({
  repo: "acme/widgets",
  kind: "pr",
  number: 125,
  sigDeadline: 1_790_000_000n,
  signature: `0x${"33".repeat(65)}`,
});

test.each([
  [200, { txHash: TX }, {}, { kind: "forfeited", txHash: TX }],
  [400, refusal("expired"), {}, { kind: "refused", status: 400, message: "Refused: expired." }],
  [404, refusal("not-found"), {}, { kind: "refused", status: 404 }],
  [409, refusal("resolved"), {}, { kind: "refused", status: 409 }],
  [429, refusal("rate-limited"), { "retry-after": "7" }, { kind: "wait", seconds: 7, paused: false }],
  [429, refusal("paused"), { "retry-after": "600" }, { kind: "wait", seconds: 600, paused: true }],
  [502, refusal("reverted", { txHash: TX }), {}, { kind: "reverted", txHash: TX }],
  [413, refusal("too-large"), {}, { kind: "too-large" }],
  [500, "", {}, { kind: "unavailable" }],
  [401, "Bad signature", {}, { kind: "unavailable" }],
])("the Keeper's %i answer %j to a verdict becomes %j", async (status, body, headers, outcome) => {
  expect(await sendVerdict(verdict, answering(status, body, headers).fetch)).toMatchObject(outcome);
});

test("a verdict goes to /forfeit on the page's own origin, its deadline as a decimal string", async () => {
  const { fetch, sent } = answering(200, { txHash: TX });

  await sendVerdict(verdict, fetch);

  expect(sent[0]!.url).toBe("/forfeit");
  expect(JSON.parse(String(sent[0]!.init.body))).toEqual({
    repo: "acme/widgets",
    kind: "pr",
    number: 125,
    sigDeadline: "1790000000",
    signature: `0x${"33".repeat(65)}`,
  });
});

const proof = bindingProofBody(
  { repo: "acme/gizmos", maintainer: WALLET, nonce: `0x${"44".repeat(32)}`, deadline: 1_790_000_000n },
  `0x${"55".repeat(65)}`,
);

test.each([
  [
    200,
    { status: "proposed", txHash: TX, effectiveAt: 1790086400 },
    {},
    { kind: "proposed", txHash: TX, effectiveAt: 1790086400 },
  ],
  [200, { status: "pending", effectiveAt: 1790086400 }, {}, { kind: "pending", effectiveAt: 1790086400 }],
  [200, { status: "active" }, {}, { kind: "active" }],
  [409, refusal("bad-config"), {}, { kind: "refused", status: 409, message: "Refused: bad-config." }],
  [404, refusal("not-installed"), {}, { kind: "refused", status: 404 }],
  [400, refusal("expired"), {}, { kind: "refused", status: 400 }],
  [429, refusal("rate-limited"), { "retry-after": "3" }, { kind: "wait", seconds: 3 }],
  [413, refusal("too-large"), {}, { kind: "too-large" }],
  [500, "", {}, { kind: "unavailable" }],
  [200, { status: "something new" }, {}, { kind: "unavailable" }],
])("the Keeper's %i answer %j to a Binding proof becomes %j", async (status, body, headers, outcome) => {
  expect(await askKeeperToBind(proof, answering(status, body, headers).fetch)).toMatchObject(outcome);
});

test("a Binding proof goes to /binding-proof on the page's own origin", async () => {
  const { fetch, sent } = answering(200, { status: "active" });

  await askKeeperToBind(proof, fetch);

  expect(sent[0]!.url).toBe("/binding-proof");
  expect(JSON.parse(String(sent[0]!.init.body))).toEqual({ ...proof, deadline: "1790000000" });
});

const log: DecisionsAnswer = {
  counts: { decided: 1, escalated: 0 },
  decisions: [
    {
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
    },
  ],
};

test("the decision log is read with a GET to /decisions on the page's own origin, each time as a Date", async () => {
  const { fetch, sent } = answering(200, log);

  const outcome = await readDecisions("Acme/Widgets", fetch);

  expect(sent[0]!.url).toBe("/decisions?repo=Acme%2FWidgets");
  expect(sent[0]!.init.method ?? "GET").toBe("GET");
  expect(outcome).toEqual({
    kind: "ok",
    counts: { decided: 1, escalated: 0 },
    decisions: [{ ...log.decisions[0], at: new Date("2026-09-01T12:00:00.000Z") }],
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
  ["a 429", answering(429, refusal("rate-limited"), { "retry-after": "60" }).fetch],
  ["HTML from a proxy", answering(200, "<html>Bad gateway</html>").fetch],
  [
    "a decision out of shape",
    answering(200, { ...log, decisions: [{ ...log.decisions[0], witnesses: "none" }] }).fetch,
  ],
])("%s makes the log unavailable, never an empty one", async (_, fetch) => {
  expect(await readDecisions("acme/widgets", fetch ?? failing)).toEqual({ kind: "unavailable" });
});

const payout = payoutBody(
  { repo: "acme/widgets", issue: 12, payee: WALLET, deadline: 1_790_000_000n },
  `0x${"66".repeat(65)}`,
);

test("a signed Payout goes to /bounty/payout on the page's own origin, its deadline as a decimal string", async () => {
  const { fetch, sent } = answering(200, { txHash: TX });

  await relayPayout(payout, fetch);

  expect(sent[0]!.url).toBe("/bounty/payout");
  expect(sent[0]!.init.method).toBe("POST");
  expect(JSON.parse(String(sent[0]!.init.body))).toEqual({
    repo: "acme/widgets",
    issue: 12,
    payee: WALLET,
    deadline: "1790000000",
    signature: `0x${"66".repeat(65)}`,
  });
});

test.each([
  [200, { txHash: TX }, {}, { kind: "paid", txHash: TX }],
  [400, refusal("bad-payee"), {}, { kind: "refused", status: 400 }],
  [404, { error: "No such endpoint." }, {}, { kind: "refused", status: 404, message: "No such endpoint." }],
  [404, refusal("not-served"), {}, { kind: "refused", status: 404 }],
  [404, refusal("not-found"), {}, { kind: "refused", status: 404 }],
  [409, refusal("resolved"), {}, { kind: "refused", status: 409, message: "Refused: resolved." }],
  [429, refusal("paused"), { "retry-after": "9" }, { kind: "wait", seconds: 9, paused: true }],
  [502, refusal("reverted", { txHash: TX }), {}, { kind: "reverted", txHash: TX }],
  [504, refusal("unconfirmed", { txHash: TX }), {}, { kind: "unconfirmed", txHash: TX }],
  [413, refusal("too-large"), {}, { kind: "too-large" }],
  [502, "<html>Bad Gateway</html>", {}, { kind: "unavailable" }],
  [200, { status: "ok" }, {}, { kind: "unavailable" }],
])("the Keeper's %i answer %j to a signed Payout becomes %j", async (status, body, headers, outcome) => {
  expect(await relayPayout(payout, answering(status, body, headers).fetch)).toMatchObject(outcome);
});

test("a Payout relay the page can't reach is unavailable", async () => {
  expect(await relayPayout(payout, failing)).toEqual({ kind: "unavailable" });
});
