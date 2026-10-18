import { expect, test } from "vitest";
import {
  APP_PATHS,
  bindingProofRoute,
  bountyPayoutRoute,
  decisionsRoute,
  forfeitRoute,
  REFUSAL_CODES,
  refusalIn,
  relayDepositRoute,
  type SignedBindingProof,
  type SignedDeposit,
  type SignedForfeit,
  type SignedPayout,
} from "../src/index.ts";

// The App's HTTP contract, as both sides use it: a client encodes each body with the route the App
// decodes it with.

const TX = `0x${"ab".repeat(32)}` as const;
const WALLET = "0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed";

const deposit: SignedDeposit = {
  repo: "acme/widgets",
  kind: "pr",
  number: 128,
  from: WALLET,
  value: 1_000_000n,
  validAfter: 0n,
  validBefore: 1_790_000_000n,
  salt: `0x${"11".repeat(32)}`,
  signature: `0x${"22".repeat(65)}`,
};

const forfeit: SignedForfeit = {
  repo: "acme/widgets",
  kind: "issue",
  number: 7,
  sigDeadline: 1_790_000_000n,
  signature: `0x${"33".repeat(65)}`,
};

const proof: SignedBindingProof = {
  repo: "acme/gizmos",
  maintainer: WALLET,
  nonce: `0x${"44".repeat(32)}`,
  deadline: 1_790_000_000n,
  signature: `0x${"55".repeat(65)}`,
};

const payout: SignedPayout = {
  repo: "acme/widgets",
  issue: 12,
  payee: WALLET,
  deadline: 1_790_000_000n,
  signature: `0x${"66".repeat(65)}`,
};

test("each route is at its path on the App's origin", () => {
  expect(APP_PATHS).toEqual({
    relayDeposit: "/relay/deposit",
    forfeit: "/forfeit",
    bindingProof: "/binding-proof",
    bountyPayout: "/bounty/payout",
    decisions: "/decisions",
  });
  expect(
    [relayDepositRoute, forfeitRoute, bindingProofRoute, bountyPayoutRoute, decisionsRoute].map((r) => r.path),
  ).toEqual(Object.values(APP_PATHS));
});

test("every amount and time goes as a decimal string", () => {
  expect(relayDepositRoute.encode(deposit)).toEqual({
    ...deposit,
    value: "1000000",
    validAfter: "0",
    validBefore: "1790000000",
  });
  expect(forfeitRoute.encode(forfeit)).toEqual({ ...forfeit, sigDeadline: "1790000000" });
  expect(bindingProofRoute.encode(proof)).toEqual({ ...proof, deadline: "1790000000" });
  expect(bountyPayoutRoute.encode(payout)).toEqual({ ...payout, deadline: "1790000000" });
});

test.each([
  ["a signed Deposit", relayDepositRoute, deposit],
  ["a Forfeit", forfeitRoute, forfeit],
  ["a Binding proof", bindingProofRoute, proof],
  ["a Payout", bountyPayoutRoute, payout],
] as const)("the App reads %s as the client sent it", (_, route, request) => {
  const sent = JSON.parse(JSON.stringify(route.encode(request as never)));

  expect(route.decode(sent)).toEqual({ ok: true, value: request });
});

test("a time sent as a JSON number, as pages before decimal strings sent a Payout's deadline, is read too", () => {
  expect(bountyPayoutRoute.decode({ ...bountyPayoutRoute.encode(payout), deadline: 1_790_000_000 })).toEqual({
    ok: true,
    value: payout,
  });
  expect(forfeitRoute.decode({ ...forfeitRoute.encode(forfeit), sigDeadline: 1_790_000_000 })).toMatchObject({
    ok: true,
  });
});

test("a payee in any case is read checksummed, and a Deposit without validAfter is valid from 0", () => {
  const { validAfter: _, ...rest } = relayDepositRoute.encode(deposit);

  expect(bountyPayoutRoute.decode({ ...bountyPayoutRoute.encode(payout), payee: WALLET.toLowerCase() })).toEqual({
    ok: true,
    value: payout,
  });
  expect(relayDepositRoute.decode(rest)).toEqual({ ok: true, value: deposit });
});

test.each([
  ["an owner with an underscore", "acme_corp/widgets"],
  ["an owner over 39 characters", `${"a".repeat(40)}/widgets`],
  ["no owner", "widgets"],
  ["a path", "acme/widgets/issues"],
])("every route refuses a repo with %s", (_, repo) => {
  for (const [route, request] of [
    [relayDepositRoute, deposit],
    [forfeitRoute, forfeit],
    [bindingProofRoute, proof],
    [bountyPayoutRoute, payout],
  ] as const) {
    expect(route.decode({ ...route.encode(request as never), repo })).toMatchObject({ ok: false });
  }
  expect(decisionsRoute.decode(new URLSearchParams({ repo }))).toMatchObject({ ok: false });
});

test("the relay names every problem with a Deposit at once", () => {
  const body = { ...relayDepositRoute.encode(deposit), value: "1.5", salt: "0x12" };

  expect(relayDepositRoute.decode(body)).toEqual({
    ok: false,
    problem: "`value` must be a whole number of USDC base units. `salt` must be 32 bytes of hex.",
  });
  expect(relayDepositRoute.decode([])).toEqual({ ok: false, problem: "The body must be a JSON object." });
});

test.each([
  [forfeitRoute, null, "Send a JSON body with repo, kind, number, sigDeadline and signature."],
  [forfeitRoute, { ...forfeitRoute.encode(forfeit), kind: "commit", number: 1.5 }, 'kind must be "pr" or "issue".'],
  [
    forfeitRoute,
    { ...forfeitRoute.encode(forfeit), sigDeadline: "soon" },
    "sigDeadline must be a time in Unix seconds.",
  ],
  [bindingProofRoute, { ...bindingProofRoute.encode(proof), nonce: "0x12" }, "nonce must be 32 bytes of hex."],
  [bindingProofRoute, { ...bindingProofRoute.encode(proof), signature: "0xzz" }, "signature must be 0x-prefixed hex."],
  [bountyPayoutRoute, { ...bountyPayoutRoute.encode(payout), issue: "12" }, "issue must be a whole number above 0."],
  [
    bountyPayoutRoute,
    { ...bountyPayoutRoute.encode(payout), payee: "newcomer.eth" },
    "payee must be a wallet address.",
  ],
  [
    bountyPayoutRoute,
    { ...bountyPayoutRoute.encode(payout), deadline: -1 },
    "deadline must be a time in Unix seconds.",
  ],
] as const)("a Keeper route names the first problem with its body", (route, body, problem) => {
  expect(route.decode(body)).toEqual({ ok: false, problem });
});

test("a decisions query is the repo, and only owner/name is read", () => {
  const query = decisionsRoute.encode({ repo: "Acme/Widgets" });

  expect(`${decisionsRoute.path}?${query}`).toBe("/decisions?repo=Acme%2FWidgets");
  expect(decisionsRoute.decode(new URLSearchParams(query))).toEqual({ ok: true, value: { repo: "Acme/Widgets" } });
  expect(decisionsRoute.decode(new URLSearchParams())).toEqual({
    ok: false,
    problem: "repo must be owner/name, such as octocat/hello-world.",
  });
});

test("a refusal is read by its code, with the details that come with it", () => {
  expect(refusalIn({ error: "The Deposit is now 2 USDC.", code: "amount-changed", amount: "2000000" })).toEqual({
    code: "amount-changed",
    error: "The Deposit is now 2 USDC.",
    txHash: null,
    amount: 2_000_000n,
    depositor: null,
  });
  expect(refusalIn({ error: "…", code: "reverted", txHash: TX })).toMatchObject({ code: "reverted", txHash: TX });
  expect(refusalIn({ error: "…", code: "already-deposited", depositor: WALLET })).toMatchObject({
    depositor: WALLET,
  });
});

test("a refusal without a known code, or that isn't one, reads as having no code", () => {
  expect(refusalIn({ error: "No such endpoint." })).toMatchObject({ code: null, error: "No such endpoint." });
  expect(refusalIn({ error: "…", code: "something-new" })).toMatchObject({ code: null });
  expect(refusalIn("<html>Bad Gateway</html>")).toEqual({
    code: null,
    error: "",
    txHash: null,
    amount: null,
    depositor: null,
  });
  expect(refusalIn({ code: "reverted", txHash: "0x1234", amount: "1.5" })).toMatchObject({
    txHash: null,
    amount: null,
  });
});

test("every refusal code is distinct", () => {
  expect(new Set(REFUSAL_CODES).size).toBe(REFUSAL_CODES.length);
});

test("a transaction answer needs a transaction hash", () => {
  for (const route of [relayDepositRoute, forfeitRoute, bountyPayoutRoute]) {
    expect(route.answer({ txHash: TX })).toEqual({ txHash: TX });
    expect(route.answer({ txHash: "0x1234" })).toBeNull();
    expect(route.answer({ status: "ok" })).toBeNull();
  }
});

test.each([
  [
    { status: "proposed", txHash: TX, effectiveAt: 1790086400 },
    { status: "proposed", txHash: TX, effectiveAt: 1790086400 },
  ],
  [
    { status: "pending", effectiveAt: 1790086400 },
    { status: "pending", effectiveAt: 1790086400 },
  ],
  [{ status: "active" }, { status: "active" }],
  [{ status: "proposed", effectiveAt: 1790086400 }, null],
  [{ status: "pending" }, null],
  [{ status: "something new" }, null],
])("the Binding answer %j reads as %j", (body, answer) => {
  expect(bindingProofRoute.answer(body)).toEqual(answer);
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

test("a decision log is read as published", () => {
  const body = { counts: { decided: 1, escalated: 0 }, decisions: [decision] };

  expect(decisionsRoute.answer(body)).toEqual(body);
  expect(decisionsRoute.answer({ counts: { decided: 0, escalated: 0 }, decisions: [] })).toEqual({
    counts: { decided: 0, escalated: 0 },
    decisions: [],
  });
});

test.each([
  ["counts that aren't numbers", { counts: { decided: "1", escalated: 0 }, decisions: [] }],
  ["no list", { counts: { decided: 0, escalated: 0 } }],
  ["witnesses out of shape", { counts: { decided: 1, escalated: 0 }, decisions: [{ ...decision, witnesses: "none" }] }],
  ["a malformed transaction hash", { counts: { decided: 1, escalated: 0 }, decisions: [{ ...decision, txHash: "x" }] }],
  [
    "a Serial that isn't a number",
    { counts: { decided: 1, escalated: 0 }, decisions: [{ ...decision, serial: "two" }] },
  ],
  ["a time that isn't one", { counts: { decided: 1, escalated: 0 }, decisions: [{ ...decision, at: "yesterday" }] }],
  [
    "an unknown kind",
    { counts: { decided: 1, escalated: 0 }, decisions: [{ ...decision, item: { kind: "x", number: 1 } }] },
  ],
])("a decision log with %s is out of shape", (_, body) => {
  expect(decisionsRoute.answer(body)).toBeNull();
});
