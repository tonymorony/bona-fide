import { getAddress, isAddress, isAddressEqual, type Address, type Hex } from "viem";
import { parse } from "yaml";
import type { Verdict } from "../app.ts";
import { CLOCK_SKEW_SECONDS, CONFIG_PATH, parseConfig } from "../config.ts";
import { depositLink, usdc } from "../copy.ts";
import { newDecision } from "../decisions/log.ts";
import { keyOf, repoIdOf, type Kind } from "../keys.ts";
import { ACCEPTED, BAD_FAITH } from "../labels.ts";
import {
  fullName,
  type Binding,
  type Chain,
  type DecisionLog,
  type GitHub,
  type Item,
  type Witness,
} from "../ports.ts";
import { cooldown, REVERT_COOLDOWN_MS } from "../relay/rate-limit.ts";
import { itemFields } from "../webhook.ts";
import { badFaithNote, NOUNS } from "./copy.ts";
import {
  EscrowRejection,
  TransactionReverted,
  type BindingStatus,
  type EscrowDeposit,
  type KeeperEscrow,
} from "./escrow.ts";
import { bindingDigest, forfeitDigest } from "./signatures.ts";

export interface KeeperDeps {
  escrow: KeeperEscrow;
  /** The same Chain the App's check reads, so the Keeper and the check agree on which Deposit counts. */
  chain: Chain;
  github: GitHub;
  /** The page where a Maintainer signs a Forfeit. It takes the same query as the deposit page. */
  signPageUrl: string;
  /** Keeps each early Refund made because the item was accepted, for the repo page. */
  decisions?: DecisionLog;
  now?: () => Date;
}

/** Why the Keeper won't do what a request asks, with the HTTP status that says so. */
export class Refusal extends Error {
  readonly status: 400 | 404 | 409 | 429 | 502;
  /** For a 429, the seconds to wait before asking again. */
  readonly retryAfter: number | undefined;
  /** For a 502, the transaction that reverted. */
  readonly txHash: Hex | undefined;

  constructor(status: Refusal["status"], message: string, more: { retryAfter?: number; txHash?: Hex } = {}) {
    super(message);
    this.status = status;
    this.retryAfter = more.retryAfter;
    this.txHash = more.txHash;
  }
}

/** A Forfeit the Maintainer signed, for the PR or issue `number` in `repo` (owner/name). */
export interface SignedForfeit {
  repo: string;
  kind: Kind;
  number: number;
  sigDeadline: bigint;
  signature: Hex;
}

/** A Maintainer's signed proof that they control `maintainer`, for `repo` (owner/name). */
export interface BindingProof {
  repo: string;
  maintainer: Address;
  nonce: Hex;
  deadline: bigint;
  signature: Hex;
}

export interface Keeper {
  /** Acts on a verified GitHub delivery. */
  onWebhook(event: string | null, payload: any): Promise<void>;
  /** Refunds an active Deposit that the check's verdict doesn't count. */
  afterVerdict(item: Item, verdict: Verdict): Promise<void>;
  /** Relays a signed Forfeit and returns its transaction. */
  relayForfeit(forfeit: SignedForfeit): Promise<Hex>;
  /** Proposes the Binding in the repo's bona-fide.yml, once its Maintainer has proved control of the wallet. */
  bindRepo(proof: BindingProof): Promise<BindingStatus>;
}

export function createKeeper({
  escrow,
  chain,
  github,
  signPageUrl,
  decisions,
  now = () => new Date(),
}: KeeperDeps): Keeper {
  const keyFor = (item: Item) => keyOf(repoIdOf(fullName(item.repo)), item.kind, item.number);
  const afterRevert = cooldown(REVERT_COOLDOWN_MS, Date.now);

  // A Maintainer accepted the item. The Refund names the Deposit read, so the one logged is the
  // one refunded; a redelivery finds it refunded and logs nothing.
  async function refundAccepted(item: Item, source: string, witnesses: Witness[]): Promise<void> {
    const key = keyFor(item);
    const deposit = await escrow.depositOf(key);
    if (deposit.status !== "active") return;
    await refundAndLog(item, key, deposit, source, witnesses);
  }

  async function refundAndLog(
    item: Item,
    key: Hex,
    deposit: EscrowDeposit,
    source: string,
    witnesses: Witness[],
  ): Promise<void> {
    const txHash = await escrow.refund(key, deposit.serial);
    if (!txHash) return;
    const decision = newDecision(
      {
        repo: fullName(item.repo),
        private: item.repo.private !== false,
        item: { kind: item.kind, number: item.number },
        serial: String(deposit.serial),
        type: "early-refund",
        inputs: { source },
        suggestion: null,
        witnesses: [
          { name: "Deposit", value: `Serial ${deposit.serial}: ${usdc(deposit.amount)} from ${deposit.depositor}` },
          ...witnesses,
        ],
        action: "refunded",
        txHash,
        outcome: "decided",
        cost: null,
      },
      now(),
    );
    try {
      decisions?.append(decision);
    } catch (error) {
      // The Refund is made: a log that fails mustn't fail the delivery.
      console.error("decision log failed:", error);
    }
  }

  // The label is only a request: the Deposit moves when the Maintainer signs.
  async function askForSignature(item: Item): Promise<void> {
    const deposit = await escrow.depositOf(keyFor(item));
    if (deposit.status !== "active" || (await escrow.now()) >= deposit.deadline) return;
    const signLink = depositLink(signPageUrl, item);
    await github.postNote(item.repo, item.number, badFaithNote({ kind: item.kind, signLink, ...deposit }));
  }

  return {
    async onWebhook(event, payload) {
      const item = itemOf(event, payload);
      if (!item) return;
      const source = `webhook ${event} ${payload.action}`;
      if (payload.action === "closed" && accepted(payload)) await refundAccepted(item, source, closeWitnesses(payload));
      if (payload.action === "labeled" && payload.label?.name === ACCEPTED) {
        await refundAccepted(item, source, [
          { name: "Label", value: ACCEPTED },
          { name: "Labelled by", value: `@${payload.sender?.login}` },
        ]);
      }
      if (payload.action === "labeled" && payload.label?.name === BAD_FAITH) await askForSignature(item);
    },

    async afterVerdict(item, verdict) {
      // A Deposit marked bad faith waits for the Maintainer's signature or the Timeout, whatever
      // the Contributor's standing turns into meanwhile.
      if (verdict.kind === "deposited" || item.labels.includes(BAD_FAITH)) return;
      const key = keyFor(item);
      const deposit = await escrow.depositOf(key);
      if (deposit.status !== "active") return;
      if (verdict.kind === "accepted") return refundAndLog(item, key, deposit, "check", acceptanceWitnesses(verdict));
      // Not a decision: the Deposit wasn't needed, so it goes back.
      if (verdict.kind === "exempt" || verdict.kind === "denounced") return void (await escrow.refund(key));
      // Made before the item was opened: the check ignores it, and it keeps the Contributor from
      // depositing. Only that Deposit: a newer one, made after the item opened, counts.
      if (!(await chain.depositSince(key, countsFrom(item)))) await escrow.refund(key, deposit.serial);
    },

    async relayForfeit({ repo, kind, number, sigDeadline, signature }) {
      const key = keyOf(repoIdOf(repo), kind, number);
      const deposit = await escrow.depositOf(key);
      if (deposit.status === "none") throw new Refusal(404, `There's no Deposit on this ${NOUNS[kind]}.`);
      if (deposit.status !== "active") throw new Refusal(409, `This Deposit was already ${deposit.status}.`);
      const wallet = deposit.maintainer.toLowerCase();
      const wait = Math.max(afterRevert.wait(key), afterRevert.wait(wallet));
      if (wait > 0) throw new Refusal(429, `${PAUSED_AFTER_REVERT} Try again in ${wait} s.`, { retryAfter: wait });
      const now = await escrow.now();
      if (now >= deposit.deadline) throw new Refusal(409, TIMEOUT_PASSED);
      if (now > sigDeadline) throw new Refusal(400, SIGNATURE_EXPIRED);
      const digest = forfeitDigest(await escrow.chainId(), escrow.address, {
        key,
        serial: deposit.serial,
        sigDeadline,
      });
      if (!(await escrow.isValidSignature(deposit.maintainer, digest, signature))) {
        throw notTheMaintainers(deposit.maintainer);
      }
      try {
        return await escrow.forfeit(key, sigDeadline, signature);
      } catch (error) {
        if (!(error instanceof TransactionReverted)) throw refusalFor(error, deposit.maintainer);
        afterRevert.hold(key);
        afterRevert.hold(wallet);
        throw new Refusal(
          502,
          "The Forfeit was sent but reverted on-chain, so no funds moved. Try again in 10 minutes.",
          {
            txHash: error.txHash,
          },
        );
      }
    },

    async bindRepo({ repo, maintainer, nonce, deadline, signature }) {
      if ((await escrow.now()) > deadline) throw new Refusal(400, "This proof has expired. Sign a new one.");
      const message = { repo: `github:${repo.toLowerCase()}`, maintainer, nonce, deadline };
      const digest = bindingDigest(await escrow.chainId(), escrow.address, message);
      if (!(await escrow.isValidSignature(maintainer, digest, signature))) {
        throw new Refusal(400, `This proof isn't signed by ${maintainer}. Sign it with that wallet.`);
      }
      const repoId = repoIdOf(repo);
      const installed = await github.findRepo(repoId);
      if (!installed) throw new Refusal(404, `Bona Fide isn't installed on ${repo}.`);
      const text = await github.readFile(installed, CONFIG_PATH);
      if (text === null) throw new Refusal(409, `${repo} has no ${CONFIG_PATH} on its default branch.`);
      const parsed = parseConfig(text);
      if (!parsed.ok) throw new Refusal(409, `${CONFIG_PATH} needs a fix: ${parsed.problems.join(" ")}`);
      const named = maintainerIn(text);
      if (!named) throw new Refusal(409, `${CONFIG_PATH} names no Maintainer wallet. Add \`maintainer: <address>\`.`);
      if (!isAddressEqual(named, maintainer)) {
        throw new Refusal(409, `${CONFIG_PATH} names ${named} as the Maintainer, not ${maintainer}.`);
      }
      const binding: Binding = {
        maintainer,
        forfeitBps: parsed.config.forfeitBps,
        timeoutSeconds: parsed.config.timeoutSeconds,
        amount: parsed.config.amount,
      };
      return escrow.proposeRepo(repoId, binding);
    },
  };
}

const TIMEOUT_PASSED = "The Timeout has passed, so this Deposit can't be forfeited. Anyone can now refund it in full.";
const SIGNATURE_EXPIRED = "This signature has expired. Sign again with a later deadline.";
const PAUSED_AFTER_REVERT =
  "The Keeper paused Forfeits for this Deposit or from its Maintainer's wallet after one reverted on-chain.";

function notTheMaintainers(maintainer: Address): Refusal {
  return new Refusal(
    400,
    `This isn't the Maintainer's signature for this Deposit. Sign it with the Maintainer's wallet, ${maintainer}.`,
  );
}

// Between the Keeper's reads and its transaction the chain can move on, and a smart wallet can
// answer the escrow differently than it answered the Keeper.
function refusalFor(error: unknown, maintainer: Address): unknown {
  if (!(error instanceof EscrowRejection)) return error;
  if (error.reason === "InvalidSignature") return notTheMaintainers(maintainer);
  if (error.reason === "DepositNotActive") return new Refusal(409, "This Deposit was resolved in the meantime.");
  if (error.reason === "DeadlinePassed") return new Refusal(409, TIMEOUT_PASSED);
  if (error.reason === "SignatureExpired") return new Refusal(400, SIGNATURE_EXPIRED);
  return error;
}

// parseConfig leaves `maintainer` to the Keeper. The failsafe schema keeps it a string.
function maintainerIn(text: string): Address | null {
  const settings: unknown = parse(text, { schema: "failsafe" });
  const value = (settings as Record<string, unknown> | null)?.maintainer;
  return typeof value === "string" && isAddress(value.trim()) ? getAddress(value.trim()) : null;
}

/** The earliest block time at which a Deposit counts for the item, as the check reckons it. */
function countsFrom(item: Item): Date {
  return new Date(item.createdAt.getTime() - CLOCK_SKEW_SECONDS * 1000);
}

function itemOf(event: string | null, payload: any): Item | null {
  const pr = payload.pull_request;
  if (event === "pull_request") return { ...itemFields(payload, pr), kind: "pr", headSha: pr.head.sha };
  if (event === "issues") return { ...itemFields(payload, payload.issue), kind: "issue" };
  return null;
}

/** The facts behind an acceptance the check found: the label, or an approval. */
function acceptanceWitnesses(verdict: Extract<Verdict, { kind: "accepted" }>): Witness[] {
  const accepted = verdict.approver
    ? { name: "Approved by", value: `@${verdict.approver}, with ${verdict.access ?? "write"} access` }
    : { name: "Label", value: ACCEPTED };
  return [accepted, { name: "Marked bad faith", value: "no" }];
}

function closeWitnesses(closed: any): Witness[] {
  if (closed.pull_request) {
    const by = closed.pull_request.merged_by?.login ?? closed.sender?.login;
    return [
      { name: "Merged", value: "yes" },
      { name: "Merged by", value: `@${by}` },
    ];
  }
  return [
    { name: "Closed as", value: "completed" },
    { name: "Closed by", value: `@${closed.sender.login}, not the author` },
  ];
}

// Only someone with write access can merge. Anyone can close their own issue as completed, so that
// counts only when someone else closed it.
function accepted(closed: any): boolean {
  if (closed.pull_request) return closed.pull_request.merged === true;
  const byAuthor = closed.sender?.login?.toLowerCase() === closed.issue.user.login.toLowerCase();
  return closed.issue.state_reason === "completed" && !byAuthor;
}
