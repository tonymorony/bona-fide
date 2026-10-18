import { getAddress, isAddress, type Address, type Hex } from "viem";
import { KINDS, type Kind } from "./keys.ts";

// The Bona Fide App's HTTP contract with its clients, the pages and the agent's MCP server: where
// each route is, the body a client sends and the App reads, what the App answers, and why it
// refuses. Clients encode a request with the same route the App decodes it with. On the wire,
// amounts and Unix times are decimal strings; the App also reads a time sent as a JSON number.

/** Where the App serves each route, on its own origin. */
export const APP_PATHS = {
  relayDeposit: "/relay/deposit",
  forfeit: "/forfeit",
  bindingProof: "/binding-proof",
  bountyPayout: "/bounty/payout",
  decisions: "/decisions",
} as const;

/** A Contributor's EIP-3009 authorization for one Deposit, for POST /relay/deposit. */
export interface SignedDeposit {
  /** owner/name. */
  repo: string;
  kind: Kind;
  number: number;
  from: Address;
  /** USDC base units. */
  value: bigint;
  /** Unix seconds. */
  validAfter: bigint;
  /** Unix seconds. */
  validBefore: bigint;
  salt: Hex;
  signature: Hex;
}

/** A Forfeit the Maintainer signed, for POST /forfeit. */
export interface SignedForfeit {
  repo: string;
  kind: Kind;
  number: number;
  /** Unix seconds. */
  sigDeadline: bigint;
  signature: Hex;
}

/** A Maintainer's signed proof that they control `maintainer`, for POST /binding-proof. */
export interface SignedBindingProof {
  repo: string;
  maintainer: Address;
  nonce: Hex;
  /** Unix seconds. */
  deadline: bigint;
  signature: Hex;
}

/** A Payout the Maintainer signed for the Bounty on issue `issue`, for POST /bounty/payout. */
export interface SignedPayout {
  repo: string;
  issue: number;
  /** Checksummed by the decoder. */
  payee: Address;
  /** Unix seconds. */
  deadline: bigint;
  signature: Hex;
}

/** A request as JSON: each bigint a decimal string. */
export type Wire<T> = { [K in keyof T]: T[K] extends bigint ? string : T[K] };

/** A request as the App read it, or what is wrong with it, written for whoever sent it. */
export type Decoded<T> = { ok: true; value: T } | { ok: false; problem: string };

/** The answer to POST /binding-proof. `effectiveAt` is Unix seconds. */
export type BindingAnswer =
  | { status: "proposed"; txHash: Hex; effectiveAt: number }
  | { status: "pending"; effectiveAt: number }
  | { status: "active" };

/** One decision in a repo's log, as GET /decisions publishes it. Its text is untrusted: show it as text only. */
export interface PublishedDecision {
  id: string;
  /** ISO 8601. */
  at: string;
  repo: string;
  item: { kind: Kind; number: number };
  /** A decimal string. */
  serial: string | null;
  /** "triage", "early-refund", "waive", "pay" or "hold" today; the App may add others. */
  type: string;
  inputs: Record<string, string | number | boolean> | null;
  suggestion: { verdict: string; reasons: string[] } | null;
  witnesses: { name: string; value: string }[];
  action: string;
  txHash: Hex | null;
  outcome: "decided" | "escalated";
  cost: { model: string; inputTokens: number; outputTokens: number; usd: number | null } | null;
}

/** The answer to GET /decisions?repo=owner/name. */
export interface DecisionsAnswer {
  counts: { decided: number; escalated: number };
  decisions: PublishedDecision[];
}

/** A POST route: its path, its body both ways, and its answer when it acts. */
export interface PostRoute<Request, Answer> {
  path: string;
  /** The JSON body a client sends. */
  encode(request: Request): Wire<Request>;
  /** The body as the App reads it, from parsed JSON. */
  decode(body: unknown): Decoded<Request>;
  /** A 200 answer, or null for one out of shape. */
  answer(body: unknown): Answer | null;
}

/**
 * Why the App refused a request: each refusal's body is `{ error, code }`, the `error` for a person
 * and the `code` for a client. The HTTP status says the same, more coarsely.
 *
 * | Code | Route | Status | Meaning |
 * |---|---|---|---|
 * | `invalid` | any | 400 | The request is malformed; `error` says how |
 * | `method-not-allowed` | any | 405 | Another method than the route takes |
 * | `not-served` | relay, payout | 404 | This App doesn't relay Deposits, or doesn't pay Bounties |
 * | `too-large` | any POST | 413 | The body is over the App's limit |
 * | `rate-limited` | any | 429 | Too many requests, Deposits relayed or Bindings proposed; see Retry-After |
 * | `paused` | relay, forfeit, payout | 429 | One reverted on-chain, so none for that item or wallet for 10 minutes |
 * | `unavailable` | relay | 503 | The App can't reach the chain |
 * | `inactive` | relay | 409 | The repo has no active Binding |
 * | `amount-changed` | relay | 409 | The repo's amount is now `amount` |
 * | `already-deposited` | relay | 409 | The item has an active Deposit, from `depositor` |
 * | `in-flight` | relay | 409 | A Deposit for the item is being relayed right now |
 * | `expired` | any POST | 422 relay, 400 others | The authorization, signature or proof has expired, or soon will |
 * | `bad-signature` | any POST | 422 relay, 400 others | The signature isn't the signer's, or USDC refused it |
 * | `low-balance` | relay | 422 | The wallet holds less USDC than the Deposit |
 * | `would-fail` | relay | 422 | The Deposit would fail on-chain for another reason, which `error` gives |
 * | `reverted` | relay, forfeit, payout | 502 | The transaction `txHash` reverted, so nothing moved |
 * | `unconfirmed` | relay | 504 | The transaction `txHash` was sent but isn't confirmed yet |
 * | `not-installed` | binding, payout | 404 | Bona Fide isn't installed on the repo |
 * | `not-found` | forfeit, payout | 404 | No Deposit on the item, no Bounty wallet, or no Bounty on the issue |
 * | `resolved` | forfeit, payout | 409 | The Deposit was refunded or forfeited, or the Bounty paid or cancelled |
 * | `timeout-passed` | forfeit | 409 | The Timeout has passed: anyone can Refund the Deposit |
 * | `bad-config` | binding | 409 | `.github/bona-fide.yml` is missing, needs a fix, or names another Maintainer |
 * | `bad-payee` | payout | 400 | The Bounty wallet can't pay the Payee |
 */
export const REFUSAL_CODES = [
  "invalid",
  "method-not-allowed",
  "not-served",
  "too-large",
  "rate-limited",
  "paused",
  "unavailable",
  "inactive",
  "amount-changed",
  "already-deposited",
  "in-flight",
  "expired",
  "bad-signature",
  "low-balance",
  "would-fail",
  "reverted",
  "unconfirmed",
  "not-installed",
  "not-found",
  "resolved",
  "timeout-passed",
  "bad-config",
  "bad-payee",
] as const;
export type RefusalCode = (typeof REFUSAL_CODES)[number];

/** A refusal's body, as the App sends it. */
export interface RefusalBody {
  error: string;
  code: RefusalCode;
  /** With `reverted` and `unconfirmed`. */
  txHash?: Hex;
  /** With `amount-changed`: the repo's amount now, in USDC base units. */
  amount?: string;
  /** With `already-deposited`. */
  depositor?: Address;
}

/**
 * A refusal as a client reads it. `code` is null when the answer has none, as from a proxy or an App
 * older than the codes, and each detail is null when it is missing or out of shape.
 */
export interface AppRefusal {
  code: RefusalCode | null;
  error: string;
  txHash: Hex | null;
  amount: bigint | null;
  depositor: Address | null;
}

/** Reads any answer's body as a refusal. */
export function refusalIn(body: unknown): AppRefusal {
  const fields = objectIn(body) ?? {};
  const { code, error, txHash, amount, depositor } = fields;
  return {
    code: REFUSAL_CODES.find((known) => known === code) ?? null,
    error: typeof error === "string" ? error : "",
    txHash: hashIn(txHash),
    amount: typeof amount === "string" && /^\d{1,78}$/.test(amount) ? BigInt(amount) : null,
    depositor: typeof depositor === "string" && ADDRESS.test(depositor) ? (depositor as Address) : null,
  };
}

/** A GitHub repo's owner/name, as every route takes it: an owner of up to 39 letters, digits and hyphens. */
export const REPO_NAME = /^[A-Za-z0-9-]{1,39}\/[A-Za-z0-9._-]{1,100}$/;
const HASH = /^0x[0-9a-fA-F]{64}$/;
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const UINT256_MAX = 2n ** 256n - 1n;

function isRepoName(value: unknown): value is string {
  return typeof value === "string" && REPO_NAME.test(value);
}

/** Each bigint as a decimal string. */
function toWire<T extends object>(request: T): Wire<T> {
  return Object.fromEntries(
    Object.entries(request).map(([name, value]) => [name, typeof value === "bigint" ? value.toString() : value]),
  ) as Wire<T>;
}

/** Each field's reader, which answers null for a value out of shape, and what to say then. */
type Fields<T> = { [K in keyof T]-?: [read: (value: unknown) => T[K] | null, problem: string] };

/**
 * A decoder that reads each field in order. A body that isn't an object gets `notObject`; otherwise
 * the first problem, or with `every` all of them.
 */
function decoder<T>(fields: Fields<T>, notObject: string, every = false) {
  return (body: unknown): Decoded<T> => {
    const object = objectIn(body);
    if (!object) return { ok: false, problem: notObject };
    const value: Partial<T> = {};
    const problems: string[] = [];
    for (const name of Object.keys(fields) as (keyof T & string)[]) {
      const [read, problem] = fields[name];
      const parsed = read(object[name]);
      if (parsed === null) problems.push(problem);
      else value[name] = parsed;
    }
    if (problems.length > 0) return { ok: false, problem: every ? problems.join(" ") : problems[0]! };
    return { ok: true, value: value as T };
  };
}

const repo = (value: unknown) => (isRepoName(value) ? value : null);
const kind = (value: unknown) => KINDS.find((k) => k === value) ?? null;
const positive = (value: unknown) =>
  typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : null;
const address = (value: unknown) => (typeof value === "string" && isAddress(value) ? value : null);
const bytes32 = (value: unknown) => (typeof value === "string" && HASH.test(value) ? (value as Hex) : null);
const hex = (value: unknown) =>
  typeof value === "string" && /^0x(?:[0-9a-fA-F]{2})+$/.test(value) ? (value as Hex) : null;

/** A uint256: a decimal string, or a JSON number that is a safe integer. */
function uint(value: unknown): bigint | null {
  if (typeof value === "number") return Number.isSafeInteger(value) && value >= 0 ? BigInt(value) : null;
  if (typeof value !== "string" || !/^\d{1,78}$/.test(value)) return null;
  const parsed = BigInt(value);
  return parsed <= UINT256_MAX ? parsed : null;
}

function txAnswer(body: unknown): { txHash: Hex } | null {
  const txHash = hashIn(objectIn(body)?.txHash);
  return txHash ? { txHash } : null;
}

const REPO_PROBLEM = "repo must be owner/name, such as octocat/hello-world.";
const SIGNATURE_PROBLEM = "signature must be 0x-prefixed hex.";

/** POST /relay/deposit: the App submits a Contributor's signed Deposit and pays its gas. */
export const relayDepositRoute: PostRoute<SignedDeposit, { txHash: Hex }> = {
  path: APP_PATHS.relayDeposit,
  encode: toWire,
  // Every problem at once, so an agent building the body by hand fixes them in one go.
  decode: decoder<SignedDeposit>(
    {
      repo: [repo, "`repo` must be owner/name."],
      kind: [kind, '`kind` must be "pr" or "issue".'],
      number: [positive, "`number` must be a positive whole number."],
      from: [address, "`from` must be an address."],
      value: [uint, "`value` must be a whole number of USDC base units."],
      validAfter: [(value) => uint(value === undefined ? "0" : value), "`validAfter` must be a Unix time in seconds."],
      validBefore: [uint, "`validBefore` must be a Unix time in seconds."],
      salt: [bytes32, "`salt` must be 32 bytes of hex."],
      signature: [
        (value) => (typeof value === "string" && /^0x(?:[0-9a-fA-F]{2}){1,2048}$/.test(value) ? (value as Hex) : null),
        "`signature` must be hex.",
      ],
    },
    "The body must be a JSON object.",
    true,
  ),
  answer: txAnswer,
};

/** POST /forfeit: the Keeper relays a Forfeit the Maintainer signed. */
export const forfeitRoute: PostRoute<SignedForfeit, { txHash: Hex }> = {
  path: APP_PATHS.forfeit,
  encode: toWire,
  decode: decoder<SignedForfeit>(
    {
      repo: [repo, REPO_PROBLEM],
      kind: [kind, 'kind must be "pr" or "issue".'],
      number: [positive, "number must be a whole number above 0."],
      sigDeadline: [uint, "sigDeadline must be a time in Unix seconds."],
      signature: [hex, SIGNATURE_PROBLEM],
    },
    "Send a JSON body with repo, kind, number, sigDeadline and signature.",
  ),
  answer: txAnswer,
};

/** POST /binding-proof: the Keeper proposes the Binding in the repo's bona-fide.yml. */
export const bindingProofRoute: PostRoute<SignedBindingProof, BindingAnswer> = {
  path: APP_PATHS.bindingProof,
  encode: toWire,
  decode: decoder<SignedBindingProof>(
    {
      repo: [repo, REPO_PROBLEM],
      maintainer: [address, "maintainer must be a wallet address."],
      nonce: [bytes32, "nonce must be 32 bytes of hex."],
      deadline: [uint, "deadline must be a time in Unix seconds."],
      signature: [hex, SIGNATURE_PROBLEM],
    },
    "Send a JSON body with repo, maintainer, nonce, deadline and signature.",
  ),
  answer(body) {
    const answer = objectIn(body);
    const effectiveAt = answer?.effectiveAt;
    const txHash = hashIn(answer?.txHash);
    const at = typeof effectiveAt === "number" && Number.isSafeInteger(effectiveAt) && effectiveAt > 0;
    if (answer?.status === "proposed" && txHash && at) return { status: "proposed", txHash, effectiveAt };
    if (answer?.status === "pending" && at) return { status: "pending", effectiveAt };
    if (answer?.status === "active") return { status: "active" };
    return null;
  },
};

/** POST /bounty/payout: the Keeper relays a Payout the Maintainer signed. */
export const bountyPayoutRoute: PostRoute<SignedPayout, { txHash: Hex }> = {
  path: APP_PATHS.bountyPayout,
  encode: toWire,
  decode: decoder<SignedPayout>(
    {
      repo: [repo, REPO_PROBLEM],
      issue: [positive, "issue must be a whole number above 0."],
      payee: [(value) => address(value) && getAddress(value as string), "payee must be a wallet address."],
      deadline: [uint, "deadline must be a time in Unix seconds."],
      signature: [hex, SIGNATURE_PROBLEM],
    },
    "Send a JSON body with repo, issue, payee, deadline and signature.",
  ),
  answer: txAnswer,
};

/** GET /decisions?repo=owner/name: a public repo's decision log. */
export const decisionsRoute = {
  path: APP_PATHS.decisions,
  /** The query a client sends, after the `?`. */
  encode({ repo }: { repo: string }): string {
    return `repo=${encodeURIComponent(repo)}`;
  },
  /** The query, such as a URL's searchParams, as the App reads it. */
  decode(query: { get(name: string): string | null }): Decoded<{ repo: string }> {
    const repo = query.get("repo");
    return isRepoName(repo) ? { ok: true, value: { repo } } : { ok: false, problem: REPO_PROBLEM };
  },
  /** A 200 answer, or null for one out of shape: one decision out of shape spoils the answer. */
  answer(body: unknown): DecisionsAnswer | null {
    const answer = objectIn(body);
    const counts = objectIn(answer?.counts);
    if (!answer || !counts || !isCount(counts.decided) || !isCount(counts.escalated)) return null;
    if (!Array.isArray(answer.decisions)) return null;
    const decisions = answer.decisions.map(decisionIn);
    if (decisions.some((decision) => decision === null)) return null;
    return {
      counts: { decided: counts.decided, escalated: counts.escalated },
      decisions: decisions as PublishedDecision[],
    };
  },
};

function objectIn(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function hashIn(value: unknown): Hex | null {
  return typeof value === "string" && HASH.test(value) ? (value as Hex) : null;
}

function isCount(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

const isString = (value: unknown): value is string => typeof value === "string";

function decisionIn(value: unknown): PublishedDecision | null {
  const d = objectIn(value);
  const item = objectIn(d?.item);
  const itemKind = kind(item?.kind);
  if (!d || !item || !itemKind || !isCount(item.number)) return null;
  if (!isString(d.id) || !isString(d.repo) || !isString(d.type) || !isString(d.action)) return null;
  if (!isString(d.at) || isNaN(new Date(d.at).getTime())) return null;
  if (d.outcome !== "decided" && d.outcome !== "escalated") return null;
  if (d.serial !== null && !(isString(d.serial) && /^\d+$/.test(d.serial))) return null;
  if (d.txHash !== null && !hashIn(d.txHash)) return null;
  const inputs = d.inputs === null ? null : objectIn(d.inputs);
  const scalar = (v: unknown) => ["string", "number", "boolean"].includes(typeof v);
  if (d.inputs !== null && (!inputs || !Object.values(inputs).every(scalar))) return null;
  if (!Array.isArray(d.witnesses)) return null;
  const witnesses = d.witnesses.map(objectIn);
  if (witnesses.some((w) => !w || !isString(w.name) || !isString(w.value))) return null;
  const suggestion = d.suggestion === null ? null : objectIn(d.suggestion);
  if (d.suggestion !== null) {
    const reasons = suggestion?.reasons;
    if (!suggestion || !isString(suggestion.verdict) || !Array.isArray(reasons) || !reasons.every(isString)) {
      return null;
    }
  }
  const cost = d.cost === null ? null : objectIn(d.cost);
  if (d.cost !== null) {
    const usd = cost?.usd;
    const priced = usd === null || (typeof usd === "number" && Number.isFinite(usd) && usd >= 0);
    if (!cost || !isString(cost.model) || !isCount(cost.inputTokens) || !isCount(cost.outputTokens) || !priced) {
      return null;
    }
  }
  return {
    id: d.id,
    at: d.at,
    repo: d.repo,
    item: { kind: itemKind, number: item.number },
    serial: d.serial,
    type: d.type,
    inputs: inputs as PublishedDecision["inputs"],
    suggestion: suggestion && { verdict: suggestion.verdict as string, reasons: suggestion.reasons as string[] },
    witnesses: witnesses.map((w) => ({ name: w!.name as string, value: w!.value as string })),
    action: d.action,
    txHash: d.txHash as Hex | null,
    outcome: d.outcome,
    cost: cost && {
      model: cost.model as string,
      inputTokens: cost.inputTokens as number,
      outputTokens: cost.outputTokens as number,
      usd: cost.usd as number | null,
    },
  };
}
