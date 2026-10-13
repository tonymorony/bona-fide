import type { Address } from "viem";
import { createApp } from "../../src/app.ts";
import { createBounties } from "../../src/bounties/bounties.ts";
import type { BountyWallets } from "../../src/bounties/wallet.ts";
import { createDecisionLog } from "../../src/decisions/log.ts";
import type { AuthoredText, CommitCheck, Decision, PullRequestFacts, Resolver } from "../../src/ports.ts";
import { createWebhookHandler } from "../../src/webhook.ts";
import { FakeChain } from "./fake-chain.ts";
import { FakeGitHub } from "./fake-github.ts";
import { FakeResolver } from "./fake-resolver.ts";
import { FakeBountyWallets, type Limits } from "./fake-wallets.ts";
import { DEPOSIT_PAGE, SETUP_PAGE } from "./harness.ts";
import { fixture, NEWCOMER, payload, REPO, SECRET, signed } from "./webhooks.ts";

export const BOUNTY_PAGE = "https://bonafide.example/bounty";
/** The Maintainer FakeChain binds by default: the owner of the repo's Bounty wallet. */
export const OWNER: Address = "0x00000000000000000000000000000000000bEEF1";
/** The wallet the newcomer names for their Bounties. */
export const PAYEE: Address = "0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed";
export const BOUNTY_ISSUE = 42;
export const BOUNTY_PR = 7;
export const TEN_USDC = 10_000_000n;
export const MERGED_AT = new Date("2026-09-30T12:00:00Z");
export const NOW = new Date("2026-09-30T12:05:00Z");

/** A PR's body or comment, written by `author` and edited by nobody. */
export function text(body: string, author = NEWCOMER, at = MERGED_AT): AuthoredText {
  return { author, editor: null, text: body, createdAt: at };
}

/** A merged PR by the newcomer that closes the Bounty's issue and names their wallet in its body. */
export function mergedPr(fields: Partial<PullRequestFacts> = {}): PullRequestFacts {
  return {
    number: BOUNTY_PR,
    author: NEWCOMER,
    merged: true,
    mergedAt: MERGED_AT,
    mergedBy: "maintainer",
    headSha: "7".repeat(40),
    closes: [BOUNTY_ISSUE],
    body: text(`Fixes #${BOUNTY_ISSUE}.\n\nBounty wallet: ${PAYEE}\n`),
    comments: [],
    ...fields,
  };
}

const GREEN: CommitCheck[] = [{ name: "test", state: "success" }];

export interface BountyHarnessOptions {
  /** The text of .github/bona-fide.yml. */
  config?: string;
  /** The model; `null` runs without one, as a host without ANTHROPIC_API_KEY. */
  resolver?: Resolver | null;
  /** The wallet's limits. */
  limits?: Limits;
  /** The Bounty's amount, 10 USDC unless told otherwise. `null` posts none. */
  amount?: bigint | null;
  /** Whether GitHub says the repo is private. */
  private?: boolean;
  /** Wallets other than the in-memory ones, such as the real ones on anvil. */
  wallets?: BountyWallets;
}

// Bounties against an in-memory GitHub, escrow and Bounty wallet: the repo is bound, its Maintainer
// has a wallet, and a Bounty is posted on issue #42.
export function bountyHarness(options: BountyHarnessOptions = {}) {
  const { config = "", limits, amount = TEN_USDC } = options;
  const github = new FakeGitHub();
  github.addRepo(REPO, 1, options.private ?? false);
  github.setFile(REPO, ".github/bona-fide.yml", config);
  const chain = new FakeChain();
  chain.bind(REPO);
  const fake = new FakeBountyWallets();
  const wallet = fake.create(REPO, OWNER, limits);
  const serial = amount === null ? 0n : fake.post(wallet, BOUNTY_ISSUE, amount);
  const resolver = options.resolver === undefined ? new FakeResolver() : options.resolver;
  /** Every decision appended to the log, private repos' included. */
  const logged: Decision[] = [];
  const log = createDecisionLog({ write: (decision) => logged.push(decision) });
  const bounties = createBounties({
    github,
    chain,
    wallets: options.wallets ?? fake,
    resolver: resolver ?? undefined,
    bountyPageUrl: BOUNTY_PAGE,
    decisions: log,
    now: () => NOW,
  });
  const app = createApp({ github, chain, depositPageUrl: DEPOSIT_PAGE, setupPageUrl: SETUP_PAGE });
  const handle = createWebhookHandler({ secret: SECRET, app, bounties });

  async function deliver(event: string, body: any): Promise<Response> {
    if (options.private) body.repository.private = true;
    const response = await handle(signed(event, body));
    await bounties.idle();
    return response;
  }

  /** GitHub knows the merged PR, and its head commit's checks are as told: green by default. */
  function addPr(facts: PullRequestFacts, checks: CommitCheck[] = GREEN): PullRequestFacts {
    github.setPullRequest(REPO, facts);
    github.setChecks(REPO, facts.headSha, checks);
    return facts;
  }

  /** Adds the PR to GitHub and delivers its merge. */
  function merge(facts: PullRequestFacts = mergedPr(), checks?: CommitCheck[]): Promise<Response> {
    addPr(facts, checks);
    return deliver("pull_request", closedPr(facts));
  }

  return {
    github,
    chain,
    wallets: fake,
    wallet,
    serial,
    resolver: resolver as FakeResolver,
    bounties,
    log,
    logged,
    deliver,
    addPr,
    merge,
  };
}

/** GitHub's pull_request delivery for the PR's merge. */
export function closedPr(facts: PullRequestFacts, merged = true) {
  const body = payload("pull_request", "closed", { author: facts.author ?? "ghost" });
  body.number = facts.number;
  Object.assign(body.pull_request, {
    number: facts.number,
    merged,
    merged_at: merged ? facts.mergedAt?.toISOString() : null,
    body: facts.body.text,
  });
  return body;
}

/** GitHub's issues delivery for the issue closed as completed, as a merge closes it. */
export function closedIssue(number = BOUNTY_ISSUE) {
  const body = payload("issues", "reopened", { labels: [] });
  body.action = "closed";
  body.issue.number = number;
  body.issue.state = "closed";
  body.issue.state_reason = "completed";
  return body;
}

/** GitHub's issue_comment delivery for a comment on a merged PR, by `by`. */
export function prComment(facts: PullRequestFacts, comment: string, by = facts.author ?? "ghost", action = "created") {
  const pr = fixture("pull_request.opened");
  return {
    action,
    issue: {
      number: facts.number,
      user: { login: facts.author ?? "ghost" },
      pull_request: { merged_at: facts.mergedAt?.toISOString() ?? null },
    },
    comment: { user: { login: by }, body: comment },
    repository: pr.repository,
    installation: { id: 1 },
    sender: { login: by },
  };
}
