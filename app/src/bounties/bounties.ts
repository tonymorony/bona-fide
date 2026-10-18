import { payoutSignature, repoIdOf } from "@bona-fide/sdk";
import { hashTypedData, isAddressEqual, type Address, type Hex } from "viem";
import { ARC_EXPLORER_URL, CONFIG_PATH, parseConfig } from "../config.ts";
import { markdownSafe, usdc } from "../copy.ts";
import { newDecision } from "../decisions/log.ts";
import { TransactionReverted } from "../keeper/escrow.ts";
import { Refusal } from "../keeper/keeper.ts";
import { BODY_BUDGET, cut, DIFF_BUDGET } from "../model/model.ts";
import {
  fullName,
  type Chain,
  type ClosingPullRequest,
  type CommitCheck,
  type Answer,
  type Decision,
  type DecisionLog,
  type GitHub,
  type IssueClosing,
  type Model,
  type PullRequestFacts,
  type Repo,
  type Resolution,
  type ResolutionRequest,
  type Witness,
} from "../ports.ts";
import { cooldown, REVERT_COOLDOWN_MS } from "../relay/rate-limit.ts";
import { repoOf } from "../webhook.ts";
import { bountyHeldNote, bountyLink, bountyPaidNote, payeeNeededNote, transactionLink } from "./copy.ts";
import { payeeOf, payeeProblem, type Payee } from "./payee.ts";
import { RESOLUTION_QUESTION } from "./question.ts";
import { BountyRejection, type BountyWallets, type WalletBounty, type WalletState } from "./wallet.ts";

/** Most Bounties left to the Maintainer remembered in memory. */
const MAX_LEFT = 10_000;
/** Most check names a note lists, and most characters of each. */
const MAX_CHECK_NAMES = 5;
const MAX_CHECK_NAME_CHARS = 100;

export interface BountyDeps {
  github: GitHub;
  /** The escrow, for the repo's active Binding: its Maintainer's Bounty wallet is the repo's. */
  chain: Pick<Chain, "bindingOf" | "startedAt">;
  wallets: BountyWallets;
  /** The model asked whether a PR resolves the issue. Without one, every Bounty waits for the Maintainer. */
  model?: Model;
  /** The page where the Maintainer signs a Payout, linked with ?repo=owner/name&issue=N&payee=0x…. */
  bountyPageUrl: string;
  /** The block explorer each Payout's note links to. Arc mainnet's by default. */
  explorerUrl?: string;
  /** Keeps each Payout and each Bounty left to the Maintainer, for the repo page. */
  decisions?: DecisionLog;
  now?: () => Date;
  /** Hears each decision, such as to log it. */
  record?(decision: Decision): void;
}

/** A Payout the Maintainer signed, for the issue `issue` in `repo` (owner/name). */
export interface SignedPayout {
  repo: string;
  issue: number;
  payee: Address;
  deadline: bigint;
  signature: Hex;
}

export interface Bounties {
  /**
   * Acts on a verified delivery: a merged PR, an issue closed as completed, or a merged PR's author
   * naming their wallet. It resolves at once and works in the background, as the model can take
   * longer than GitHub waits for a webhook. It never rejects.
   */
  onWebhook(event: string | null, payload: any): Promise<void>;
  /** Relays a Payout the Maintainer signed and returns its transaction. Throws a Refusal. */
  relayPayout(payout: SignedPayout): Promise<Hex>;
  /** Resolves once every Bounty started so far is settled. */
  idle(): Promise<void>;
}

/** The hidden markers of the Bounty notes. Each names the issue and the Bounty's Serial, so a Bounty posted again is new. */
export function bountyMarkers(issue: number, serial: bigint) {
  const id = `issue=${issue} serial=${serial}`;
  return {
    posted: `<!-- bona-fide:bounty-posted ${id} -->`,
    paid: `<!-- bona-fide:bounty-paid ${id} -->`,
    held: `<!-- bona-fide:bounty-held ${id} -->`,
    payee: `<!-- bona-fide:bounty-payee ${id} -->`,
  };
}

interface Closing extends IssueClosing {
  merged: ClosingPullRequest[];
}

/** One fact checked before a Payout, and why it holds the Payout back for the Maintainer, if it does. */
interface Check {
  witness: Witness;
  hold: { why: string; action: string } | null;
}

// The model can hold a Payout back, never make one alone. The Keeper pays only when the PR is merged,
// the repo is older than its Binding, GitHub links the PR as closing the issue, it was the first such
// PR merged and its merge closed the issue, its checks are green, its author named a wallet the Bounty
// wallet can pay, the Bounty is open and within the Maintainer's limits, the Keeper's payouts are on,
// and the model says the PR resolves the issue. The model never sees the witnesses, and its answer
// can't change them. Anything else is left to the Maintainer, who can sign the Payout.
export function createBounties({
  github,
  chain,
  wallets,
  model,
  bountyPageUrl,
  explorerUrl = ARC_EXPLORER_URL,
  decisions,
  now = () => new Date(),
  record,
}: BountyDeps): Bounties {
  const running = new Set<Promise<void>>();
  const queues = new Map<string, Promise<void>>();
  const afterRevert = cooldown(REVERT_COOLDOWN_MS, Date.now);
  /** The Bounties left to the Maintainer in this process, by repo, issue, Serial and PR. */
  const left = new Set<string>();

  // One Bounty at a time per issue: a merge sends both a pull_request and an issues delivery, and
  // the second must see what the first did.
  function inOrder(repo: Repo, issue: number, work: () => Promise<void>): Promise<void> {
    const id = `${fullName(repo)}#${issue}`.toLowerCase();
    const run = (queues.get(id) ?? Promise.resolve()).then(work);
    const tail = run.catch(() => {});
    queues.set(id, tail);
    void tail.then(() => {
      if (queues.get(id) === tail) queues.delete(id);
    });
    return run;
  }

  /** The repo's Bounty wallet: the one its active Binding's Maintainer created. Null without either. */
  async function walletOf(repo: Repo): Promise<Address | null> {
    const repoId = repoIdOf(fullName(repo));
    const { active } = await chain.bindingOf(repoId);
    return active ? wallets.walletOf(repoId, active.maintainer) : null;
  }

  async function bountiesOn(repo: Repo): Promise<boolean> {
    const text = await github.readFile(repo, CONFIG_PATH);
    if (text === null) return false;
    const parsed = parseConfig(text);
    return parsed.ok && parsed.config.bounties;
  }

  /**
   * What GitHub says of the issue's closing, with `merged`: the merged PRs that close it, the first
   * merged first. `known` counts even before GitHub lists it.
   */
  async function closingOf(repo: Repo, issue: number, known?: PullRequestFacts): Promise<Closing> {
    const closing = await github.closingPullRequests(repo, issue);
    const prs = [...closing.prs];
    if (known?.mergedAt && !prs.some((pr) => pr.number === known.number)) {
      prs.push({ number: known.number, mergedAt: known.mergedAt });
    }
    const merged = prs
      .filter((pr) => pr.mergedAt !== null)
      .sort((a, b) => a.mergedAt!.getTime() - b.mergedAt!.getTime() || a.number - b.number);
    return { ...closing, merged };
  }

  async function run(trigger: Trigger): Promise<void> {
    const { repo } = trigger;
    if (!(await bountiesOn(repo))) return;
    const wallet = await walletOf(repo);
    if (!wallet) return;
    if ("pr" in trigger) {
      const facts = await github.pullRequestFacts(repo, trigger.pr);
      if (!facts?.merged) return;
      for (const issue of facts.closes) {
        await inOrder(repo, issue, () => settle(repo, wallet, issue, facts, trigger.source));
      }
      return;
    }
    // The issue was closed: by the merge of a PR that closes it, maybe one whose delivery was missed.
    // Most closed issues have no Bounty, and the chain says so before GitHub is asked.
    const { status } = (await wallets.stateOf(wallet, trigger.issue)).bounty;
    if (status === "none" || status === "cancelled") return;
    // The PR whose merge closed it, or else the first merged that closes it, to leave to the Maintainer.
    const closing = await closingOf(repo, trigger.issue);
    const number = closing.closedBy ?? closing.merged[0]?.number;
    if (number === undefined) return;
    const facts = await github.pullRequestFacts(repo, number);
    if (!facts?.merged) return;
    await inOrder(repo, trigger.issue, () => settle(repo, wallet, trigger.issue, facts, trigger.source));
  }

  // The chain is read first, so a redelivery, a restart or a second PR never pays twice.
  async function settle(
    repo: Repo,
    wallet: Address,
    issue: number,
    facts: PullRequestFacts,
    source: string,
  ): Promise<void> {
    const state = await wallets.stateOf(wallet, issue);
    const { bounty } = state;
    if (bounty.status === "none" || bounty.status === "cancelled") return;
    const markers = bountyMarkers(issue, bounty.serial);
    if (bounty.status === "paid") return notePaidLater(repo, wallet, issue, bounty, facts);
    // Left to the Maintainer once: the model isn't asked again, and the Keeper doesn't pay. The note
    // says so after a restart; until then, so does memory, since a repo admin can delete the note.
    const leftId = `${fullName(repo)}#${issue}:${bounty.serial}:${facts.number}`.toLowerCase();
    if (left.has(leftId) || (await github.hasNote(repo, facts.number, markers.held))) return;

    const [closing, checks, created, started] = await Promise.all([
      closingOf(repo, issue, facts),
      github.checksOf(repo, facts.headSha),
      github.repoCreatedAt(repo),
      chain.startedAt(repoIdOf(fullName(repo))),
    ]);
    // GitHub closes the issue a moment after the merge, and the issue's own delivery settles it then.
    // An issue the merge left open isn't the merge's to pay for.
    if (closing.open) return;
    const payee = payeeOf(facts);
    const payeeAddress = payee.kind === "declared" ? payee.address : null;
    const problem = payeeAddress && payeeProblem(payeeAddress, wallet, wallets.keeper);
    const found: Check[] = [
      {
        witness: { name: "Merged", value: facts.mergedBy ? `yes, by @${facts.mergedBy}` : "yes" },
        hold: null,
      },
      repoCheck(created, started),
      {
        witness: { name: "Closes the issue", value: facts.closes.includes(issue) ? `yes, #${issue}` : "no" },
        hold: facts.closes.includes(issue)
          ? null
          : { why: "GitHub doesn't link this PR as closing the issue", action: "held: not linked" },
      },
      firstMergedCheck(facts, closing),
      closedByCheck(facts, closing),
      checksCheck(facts.headSha, checks),
      {
        witness: { name: "Payee wallet", value: payeeValue(payee, facts.author, problem) },
        hold: null,
      },
      { witness: { name: "Bounty", value: `Serial ${bounty.serial}: ${usdc(bounty.amount)}, open` }, hold: null },
      ...limitChecks(bounty, state),
      { witness: { name: "Bounties in bona-fide.yml", value: "on" }, hold: null },
    ];
    const witnesses = found.map((check) => check.witness);
    const hold = found.find((check) => check.hold)?.hold ?? null;
    const signLink = bountyLink(bountyPageUrl, repo, issue, problem ? null : payeeAddress);
    const about = { repo, issue, pr: facts.number, serial: bounty.serial, source, witnesses };

    // Without a wallet to pay, the author is asked for one, once per Bounty, whatever else holds it.
    const payeeAsked = !payeeAddress || problem ? await askForPayee(repo, issue, bounty, facts, payee, problem) : false;
    if (hold) {
      await holdForMaintainer(about, state, hold, signLink, null);
      return;
    }
    if (!payeeAddress || problem) {
      if (payeeAsked) logDecision(about, "hold", "held: payee wallet needed", { outcome: "escalated" });
      return;
    }

    if (!model) {
      const why = "no automated reviewer is set up to check that the PR resolves the issue";
      await holdForMaintainer(about, state, { why, action: "held: no model" }, signLink, null);
      return;
    }
    const request = await requestFor(repo, issue, facts);
    const answer = await model.ask(RESOLUTION_QUESTION, request);
    const asked: Asked = { inputs: inputsOf(request), answer };
    if (answer.status === "failed") {
      const why = "the automated reviewer couldn't be asked whether the PR resolves the issue";
      await holdForMaintainer(about, state, { why, action: `failed: ${answer.why}` }, signLink, asked);
      return;
    }
    if (answer.status !== "suggested" || answer.verdict !== "resolves") {
      await holdForMaintainer(about, state, modelHold(answer.verdict, answer.reasons.length > 0), signLink, asked);
      return;
    }

    let txHash: Hex | null;
    try {
      txHash = await wallets.keeperPay(wallet, issue, payeeAddress, bounty.serial);
    } catch (error) {
      if (error instanceof BountyRejection) {
        const why = `the Bounty wallet refused the Keeper's payout (${error.reason})`;
        await holdForMaintainer(
          about,
          state,
          { why, action: `held: wallet refused (${error.reason})` },
          signLink,
          asked,
        );
        return;
      }
      if (!(error instanceof TransactionReverted)) throw error;
      const why = "the Keeper's payout reverted on-chain, so nothing moved";
      await holdForMaintainer(about, state, { why, action: "failed: transaction reverted" }, signLink, asked);
      return;
    }
    // Paid or cancelled in the meantime, such as by the Maintainer's signature.
    if (!txHash) {
      const after = await wallets.stateOf(wallet, issue);
      if (after.bounty.status === "paid") await notePaidLater(repo, wallet, issue, after.bounty, facts);
      return;
    }
    logDecision(about, "pay", "paid", { outcome: "decided", txHash, asked });
    await notePaid(repo, issue, facts.number, bounty, payeeAddress, "keeper", txHash);
  }

  async function askForPayee(
    repo: Repo,
    issue: number,
    bounty: WalletBounty,
    facts: PullRequestFacts,
    payee: Payee,
    problem: string | null,
  ): Promise<boolean> {
    const marker = bountyMarkers(issue, bounty.serial).payee;
    if (!facts.author || (await github.hasNote(repo, facts.number, marker))) return false;
    let named: string | null = null;
    if (payee.kind === "invalid") {
      named = payee.written
        ? `The wallet named so far, \`${payee.written}\`, isn't a valid address: a mixed-case address must match its checksum.`
        : "The wallet named so far isn't an address.";
    } else if (payee.kind === "declared" && problem) {
      named = `The wallet named so far, ${payee.address}, can't be paid: ${problem}.`;
    }
    const body = payeeNeededNote({ issue, amount: bounty.amount, author: facts.author, problem: named });
    await github.addNote(repo, facts.number, marker, body);
    return true;
  }

  async function holdForMaintainer(
    facts: DecisionFacts,
    state: WalletState,
    hold: { why: string; action: string },
    signLink: string,
    asked: Asked | null,
  ): Promise<void> {
    const reasons = (asked?.answer.reasons ?? []).map(markdownSafe);
    const marker = bountyMarkers(facts.issue, state.bounty.serial).held;
    if (left.size >= MAX_LEFT) left.clear();
    left.add(`${fullName(facts.repo)}#${facts.issue}:${state.bounty.serial}:${facts.pr}`.toLowerCase());
    const body = bountyHeldNote({
      issue: facts.issue,
      amount: state.bounty.amount,
      why: hold.why,
      reasons,
      owner: state.owner,
      signLink,
    });
    await github.addNote(facts.repo, facts.pr, marker, body);
    logDecision(facts, "hold", hold.action, { outcome: "escalated", asked });
  }

  async function notePaid(
    repo: Repo,
    issue: number,
    pr: number | null,
    bounty: WalletBounty,
    payee: Address,
    by: "keeper" | "signature" | "unknown",
    txHash: Hex,
  ): Promise<void> {
    const marker = bountyMarkers(issue, bounty.serial).paid;
    const paid = { issue, pr, amount: bounty.amount, payee, by, txLink: transactionLink(explorerUrl, txHash) };
    if (pr !== null && !(await github.hasNote(repo, pr, marker))) {
      await github.addNote(repo, pr, marker, bountyPaidNote({ ...paid, on: "pr" }));
    }
    if (!(await github.hasNote(repo, issue, marker))) {
      await github.addNote(repo, issue, marker, bountyPaidNote({ ...paid, on: "issue" }));
    }
  }

  // Paid before this delivery: by the Keeper before a crash cut its notes short, by the Maintainer's
  // signature, or by the Maintainer directly. The notes link its transaction all the same. The PR
  // gets one only if the Bounty went to the wallet its author named.
  async function notePaidLater(
    repo: Repo,
    wallet: Address,
    issue: number,
    bounty: WalletBounty,
    facts: PullRequestFacts,
  ): Promise<void> {
    if (await github.hasNote(repo, issue, bountyMarkers(issue, bounty.serial).paid)) return;
    const txHash = await wallets.paidTransaction(wallet, issue, bounty.serial);
    if (!txHash) return;
    const payee = payeeOf(facts);
    const theirs = payee.kind === "declared" && isAddressEqual(payee.address, bounty.payee);
    await notePaid(repo, issue, theirs ? facts.number : null, bounty, bounty.payee, "unknown", txHash);
  }

  async function requestFor(repo: Repo, issue: number, facts: PullRequestFacts): Promise<ResolutionRequest> {
    const fields = { repo, author: facts.author ?? "ghost", createdAt: new Date(0), labels: [] };
    const [pr, read] = await Promise.all([
      github.contentOf({ ...fields, number: facts.number, kind: "pr", headSha: facts.headSha }),
      github.contentOf({ ...fields, number: issue, kind: "issue" }),
    ]);
    const request: ResolutionRequest = {
      repo: fullName(repo),
      repoDescription: pr.repoDescription,
      issue: { number: issue, title: read.title.slice(0, 1_000), body: cut(read.body, BODY_BUDGET) },
      pr: {
        number: facts.number,
        author: facts.author ?? "ghost",
        title: pr.title.slice(0, 1_000),
        body: cut(pr.body, BODY_BUDGET),
      },
    };
    if (pr.files) request.pr.files = { listed: pr.files.listed, leftOut: pr.files.total - pr.files.listed.length };
    if (pr.diff !== undefined) request.pr.diff = pr.diff === null ? null : cut(pr.diff, DIFF_BUDGET);
    return request;
  }

  function logDecision(
    facts: DecisionFacts,
    type: "pay" | "hold",
    action: string,
    more: { outcome: Decision["outcome"]; txHash?: Hex; asked?: Asked | null },
  ): void {
    const answer = more.asked?.answer;
    const decision = newDecision(
      {
        repo: fullName(facts.repo),
        private: facts.repo.private !== false,
        item: { kind: "issue", number: facts.issue },
        serial: String(facts.serial),
        type,
        inputs: { source: facts.source, pr: facts.pr, method: "keeper", ...more.asked?.inputs },
        suggestion: answer?.verdict ? { verdict: answer.verdict, reasons: answer.reasons } : null,
        witnesses: facts.witnesses,
        action,
        txHash: more.txHash ?? null,
        outcome: more.outcome,
        cost: answer?.cost ?? null,
      },
      now(),
    );
    safely(() => decisions?.append(decision));
    safely(() => record?.(decision));
  }

  return {
    async onWebhook(event, payload) {
      const trigger = triggerOf(event, payload);
      if (!trigger) return;
      const work = run(trigger).catch((error: unknown) => {
        // Nothing was paid or posted past the failure: the next delivery for the PR or issue, such
        // as one redelivered from the App's settings, tries again.
        console.error(`bounty after ${trigger.source} in ${fullName(trigger.repo)} failed:`, error);
      });
      running.add(work);
      void work.then(() => running.delete(work));
    },

    async relayPayout({ repo: name, issue, payee, deadline, signature }) {
      const repo = await github.findRepo(repoIdOf(name));
      if (!repo) throw new Refusal(404, `Bona Fide isn't installed on ${name}.`);
      const wallet = await walletOf(repo);
      if (!wallet) throw new Refusal(404, `${name} has no Bounty wallet: its Maintainer hasn't created one.`);
      const state = await wallets.stateOf(wallet, issue);
      const { bounty, owner } = state;
      if (bounty.status === "none") throw new Refusal(404, "There's no Bounty on this issue.");
      if (bounty.status !== "open") throw new Refusal(409, `This Bounty was already ${bounty.status}.`);
      const id = `${wallet}:${issue}`.toLowerCase();
      const wait = Math.max(afterRevert.wait(id), afterRevert.wait(owner.toLowerCase()));
      if (wait > 0) throw new Refusal(429, `${PAUSED_AFTER_REVERT} Try again in ${wait} s.`, { retryAfter: wait });
      const problem = payeeProblem(payee, wallet, wallets.keeper);
      if (problem) throw new Refusal(400, `This payee can't be paid: ${problem}.`);
      if ((await wallets.now()) > deadline) throw new Refusal(400, SIGNATURE_EXPIRED);
      const digest = hashTypedData(
        payoutSignature({
          chainId: await wallets.chainId(),
          wallet,
          issueNumber: issue,
          serial: bounty.serial,
          payee,
          amount: bounty.amount,
          deadline,
        }),
      );
      if (!(await wallets.isValidSignature(owner, digest, signature))) throw notTheOwners(owner);
      let txHash: Hex;
      try {
        txHash = await wallets.payWithSignature(wallet, issue, payee, deadline, signature);
      } catch (error) {
        if (error instanceof BountyRejection) throw refusalFor(error, owner);
        if (!(error instanceof TransactionReverted)) throw error;
        afterRevert.hold(id);
        afterRevert.hold(owner.toLowerCase());
        throw new Refusal(
          502,
          "The Payout was sent but reverted on-chain, so no funds moved. Try again in 10 minutes.",
          {
            txHash: error.txHash,
          },
        );
      }
      const witnesses: Witness[] = [
        { name: "Bounty", value: `Serial ${bounty.serial}: ${usdc(bounty.amount)}, open` },
        { name: "Payee wallet", value: payee },
        { name: "Signed by", value: `${owner}, the Bounty wallet's owner` },
      ];
      // The Payout is made: notes that fail mustn't fail the request.
      try {
        const closing = await closingOf(repo, issue);
        const pr = closing.closedBy ?? closing.merged[0]?.number;
        const decision = newDecision(
          {
            repo: fullName(repo),
            private: repo.private !== false,
            item: { kind: "issue", number: issue },
            serial: String(bounty.serial),
            type: "pay",
            inputs: { source: "POST /bounty/payout", method: "signature", ...(pr !== undefined ? { pr } : {}) },
            suggestion: null,
            witnesses,
            action: "paid",
            txHash,
            // The Maintainer decided it by signing; the App only relayed it.
            outcome: "escalated",
            cost: null,
          },
          now(),
        );
        safely(() => decisions?.append(decision));
        safely(() => record?.(decision));
        await notePaid(repo, issue, pr ?? null, bounty, payee, "signature", txHash);
      } catch (error) {
        console.error(`notes on the Payout ${txHash} failed:`, error);
      }
      return txHash;
    },

    async idle() {
      while (running.size > 0) await Promise.all(running);
    },
  };
}

interface DecisionFacts {
  repo: Repo;
  issue: number;
  pr: number;
  serial: bigint;
  source: string;
  witnesses: Witness[];
}

/** What the model read, as sizes, and what it answered. */
interface Asked {
  inputs: Record<string, number>;
  answer: Answer<Resolution>;
}

type Trigger = { repo: Repo; source: string } & ({ pr: number } | { issue: number });

// GitHub's webhook JSON; only the fields read below are relied on.
function triggerOf(event: string | null, payload: any): Trigger | null {
  const source = `webhook ${event} ${payload.action}`;
  const declares = (text: unknown) => typeof text === "string" && /bounty wallet:/i.test(text);
  if (event === "pull_request" && payload.pull_request?.merged === true) {
    const closed = payload.action === "closed";
    if (closed || (payload.action === "edited" && declares(payload.pull_request.body))) {
      return { repo: repoOf(payload), source, pr: payload.pull_request.number };
    }
  }
  // Only the PR's author names its payee, in a comment of their own on the merged PR.
  if (event === "issue_comment" && (payload.action === "created" || payload.action === "edited")) {
    const issue = payload.issue;
    const byAuthor = sameLogin(payload.comment?.user?.login, issue?.user?.login);
    if (issue?.pull_request?.merged_at && byAuthor && declares(payload.comment.body)) {
      return { repo: repoOf(payload), source, pr: issue.number };
    }
  }
  if (event === "issues" && payload.action === "closed" && payload.issue?.state_reason === "completed") {
    return { repo: repoOf(payload), source, issue: payload.issue.number };
  }
  return null;
}

function sameLogin(a: unknown, b: unknown): boolean {
  return typeof a === "string" && typeof b === "string" && a.toLowerCase() === b.toLowerCase();
}

// A repo's id is its owner/name, which a rename or a deletion frees for anyone to take. A repo
// created after its Binding took effect isn't the one bound, whatever its name.
function repoCheck(created: Date | null, started: Date | null): Check {
  const name = "Repo created";
  if (created && started && created.getTime() <= started.getTime()) {
    return { witness: { name, value: "before its Binding took effect" }, hold: null };
  }
  return {
    witness: { name, value: created ? "after its Binding took effect" : "unknown" },
    hold: {
      why: "this repo is newer than its Binding, so it may have taken the name of a repo that was renamed or deleted",
      action: "held: repo newer than its Binding",
    },
  };
}

// The links a PR shows now can be added after its merge. GitHub closes an issue on merge only by
// the links the PR had then, so the issue's closer is the merge's witness.
function closedByCheck(facts: PullRequestFacts, closing: Closing): Check {
  const name = "Closed by its merge";
  if (closing.closedBy === facts.number) return { witness: { name, value: "yes" }, hold: null };
  const by = closing.closedBy === null ? "not by a merged PR" : `by #${closing.closedBy}`;
  return {
    witness: { name, value: `no: closed ${by}` },
    hold: { why: "the issue wasn't closed by this PR's merge", action: "held: not closed by its merge" },
  };
}

// Several merged PRs can close one issue: only the first merged is paid without the Maintainer.
function firstMergedCheck(facts: PullRequestFacts, closing: Closing): Check {
  if (!closing.complete) {
    return {
      witness: { name: "First merged PR that closes it", value: "unknown: too many PRs link the issue" },
      hold: {
        why: "more PRs link the issue than the App reads, so it can't tell which was merged first",
        action: "held: too many linked PRs",
      },
    };
  }
  const first = closing.merged[0];
  if (!first || first.number === facts.number) {
    return { witness: { name: "First merged PR that closes it", value: "yes" }, hold: null };
  }
  return {
    witness: { name: "First merged PR that closes it", value: `no: #${first.number} was merged first` },
    hold: { why: `#${first.number} was merged first and also closes the issue`, action: "held: merged after another" },
  };
}

// Every check run and status on the PR's head commit, the one its checks ran on: none failing or
// still running. The App's own check is about the Deposit, so it isn't among them.
function checksCheck(sha: string, checks: CommitCheck[]): Check {
  const name = `Checks on ${sha.slice(0, 7)}`;
  const failing = checks.filter((check) => check.state === "failure");
  const pending = checks.filter((check) => check.state === "pending");
  if (failing.length > 0) {
    return {
      witness: { name, value: `${failing.length} of ${checks.length} not green: ${plainNames(failing)}` },
      hold: { why: `its checks didn't all pass: ${safeNames(failing)} didn't`, action: "held: checks not green" },
    };
  }
  if (pending.length > 0) {
    return {
      witness: { name, value: `${pending.length} of ${checks.length} still running: ${plainNames(pending)}` },
      hold: {
        why: `its checks hadn't finished: ${safeNames(pending)} still running`,
        action: "held: checks not green",
      },
    };
  }
  const value = checks.length === 0 ? "none ran" : `all ${checks.length} green`;
  return { witness: { name, value }, hold: null };
}

function plainNames(checks: CommitCheck[]): string {
  return listed(checks.map((check) => check.name.slice(0, MAX_CHECK_NAME_CHARS)));
}

// Check names come from the repo's CI, which a PR can change: they can't link, ping or carry HTML.
function safeNames(checks: CommitCheck[]): string {
  return listed(checks.map((check) => markdownSafe(check.name.replace(/\s+/g, " ").slice(0, MAX_CHECK_NAME_CHARS))));
}

function listed(names: string[]): string {
  const shown = names.slice(0, MAX_CHECK_NAMES).join(", ");
  return names.length > MAX_CHECK_NAMES ? `${shown} and ${names.length - MAX_CHECK_NAMES} more` : shown;
}

function limitChecks(bounty: WalletBounty, state: WalletState): Check[] {
  const { amount } = bounty;
  return [
    {
      witness: { name: "Keeper payouts", value: state.keeperEnabled ? "on" : "off" },
      hold: state.keeperEnabled
        ? null
        : { why: "the Maintainer turned the Keeper's payouts off for this wallet", action: "held: Keeper payouts off" },
    },
    {
      witness: { name: "Per-payout limit", value: usdc(state.perPayoutLimit) },
      hold:
        amount <= state.perPayoutLimit
          ? null
          : {
              why: `${usdc(amount)} is above the wallet's per-payout limit of ${usdc(state.perPayoutLimit)}`,
              action: "held: above the per-payout limit",
            },
    },
    {
      witness: { name: "Keeper allowance this period", value: `${usdc(state.keeperAllowance)} left` },
      hold:
        amount <= state.keeperAllowance
          ? null
          : {
              why: `the Keeper has only ${usdc(state.keeperAllowance)} left to pay in this period`,
              action: "held: above the period limit",
            },
    },
  ];
}

function payeeValue(payee: Payee, author: string | null, problem: string | null): string {
  const who = author ? `@${author}'s` : "the author's";
  if (payee.kind === "none") return "none named";
  const where = payee.source === "body" ? `${who} PR description` : `a comment of ${who.replace(/'s$/, "")}`;
  if (payee.kind === "invalid") return `not a valid address, in ${where}`;
  return problem ? `${payee.address}, which can't be paid: ${problem}` : `${payee.address}, from ${where}`;
}

function modelHold(verdict: Resolution | null, gaveReasons: boolean): { why: string; action: string } {
  if (verdict === "partial") {
    return {
      why: "an automated reviewer thinks it only partly resolves the issue",
      action: "held: model said partial",
    };
  }
  if (verdict === "unrelated") {
    return { why: "an automated reviewer thinks it doesn't resolve the issue", action: "held: model said unrelated" };
  }
  if (verdict === "resolves" && !gaveReasons) {
    return { why: "the automated reviewer gave no reasons for its answer", action: "silent" };
  }
  return { why: "the automated reviewer gave no answer", action: "silent" };
}

function inputsOf(request: ResolutionRequest): Record<string, number> {
  const { issue, pr } = request;
  return {
    issueTitleChars: issue.title.length,
    issueBodyChars: issue.body.text.length,
    issueBodyLeftOut: issue.body.leftOut,
    titleChars: pr.title.length,
    bodyChars: pr.body.text.length,
    bodyLeftOut: pr.body.leftOut,
    ...(pr.files ? { files: pr.files.listed.length, filesLeftOut: pr.files.leftOut } : {}),
    ...(pr.diff !== undefined ? { diffChars: pr.diff?.text.length ?? 0, diffLeftOut: pr.diff?.leftOut ?? 0 } : {}),
  };
}

const SIGNATURE_EXPIRED = "This signature has expired. Sign again with a later deadline.";
const PAUSED_AFTER_REVERT =
  "The Keeper paused Payouts for this Bounty or from its Maintainer's wallet after one reverted on-chain.";

function notTheOwners(owner: Address): Refusal {
  return new Refusal(
    400,
    `This isn't the Maintainer's signature for this Bounty. Sign it with the Bounty wallet's owner, ${owner}.`,
  );
}

// Between the Keeper's reads and its transaction the chain can move on, and a smart wallet can
// answer the Bounty wallet differently than it answered the Keeper.
function refusalFor(error: BountyRejection, owner: Address): unknown {
  if (error.reason === "InvalidSignature") return notTheOwners(owner);
  if (error.reason === "BountyNotOpen") return new Refusal(409, "This Bounty was paid or cancelled in the meantime.");
  if (error.reason === "SignatureExpired") return new Refusal(400, SIGNATURE_EXPIRED);
  if (error.reason === "InvalidRecipient") return new Refusal(400, "This payee can't be paid.");
  return error;
}

function safely(work: () => void): void {
  try {
    work();
  } catch {
    // A log that throws mustn't stop a Payout or its notes.
  }
}
