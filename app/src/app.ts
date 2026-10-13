import type { Hex } from "viem";
import {
  ARC_EXPLORER_URL,
  CLOCK_SKEW_SECONDS,
  CONFIG_PATH,
  DEFAULT_EXEMPT_BOTS,
  parseConfig,
  type Config,
} from "./config.ts";
import {
  acceptedText,
  configProblemsText,
  denouncedText,
  depositedText,
  depositLink,
  depositNeededText,
  exemptText,
  inactiveText,
  setupLink,
} from "./copy.ts";
import { keyOf, repoIdOf, type Kind } from "./keys.ts";
import { ACCEPTED, BAD_FAITH, DEPOSIT_REQUIRED, WAIVER } from "./labels.ts";
import {
  fullName,
  type Binding,
  type Chain,
  type CheckRun,
  type Deposit,
  type DepositedEvent,
  type GitHub,
  type Issue,
  type Item,
  type PendingBinding,
  type PullRequest,
  type Repo,
} from "./ports.ts";
import type { Triage } from "./triage/triage.ts";
import { VOUCHED_PATHS, vouchStatus } from "./vouched.ts";

export interface AppDeps {
  github: GitHub;
  chain: Chain;
  depositPageUrl: string;
  /** The Maintainer's setup page, where they prove control of their wallet so the repo can be bound. */
  setupPageUrl: string;
  /** The block explorer a check links each Deposit's transaction to. Arc mainnet's by default. */
  explorerUrl?: string;
  /** The clock, for how long until a pending Binding takes effect. */
  now?: () => Date;
  /** Hears each verdict once it is posted, so the Keeper can refund a Deposit the check doesn't count. */
  afterVerdict?(item: Item, verdict: Verdict): Promise<void>;
  /** Reads each item whose check counts a Deposit and suggests a verdict to the Maintainer. */
  triage?: Pick<Triage, "afterVerdict">;
}

export interface App {
  /** Brings the item's check, or its comment and label, up to date. `seen` is a Deposit the caller already read. */
  settle(item: Item, seen?: DepositedEvent): Promise<void>;
  /** Reads the PR or issue from GitHub and settles it, as a re-run of its check asks. Does nothing if there's none. */
  recheck(repo: Repo, kind: Kind, number: number): Promise<void>;
  /** Rechecks the PR of each of the App's runs in a check suite, as "Re-run all checks" asks. */
  recheckSuite(repo: Repo, suiteId: number): Promise<void>;
}

export type Exemption = "waiver" | "collaborator" | "vouched" | "bot" | "merged" | "grandfathered";

/** Terms in the config that the active Binding doesn't have yet. */
export interface NewTerms {
  /** When they take effect, if the Keeper has proposed them. */
  startsAt: Date | null;
}

export type Verdict =
  /** Accepted with the bona-fide:ok label, or by `approver`'s approval of the PR, with the access they have. */
  | { kind: "accepted"; approver?: string; access?: "admin" | "write" }
  | { kind: "exempt"; exemption: Exemption }
  | { kind: "denounced" }
  | { kind: "deposited"; deposit: Deposit }
  | { kind: "needed"; binding: Binding; newTerms: NewTerms | null }
  | { kind: "inactive"; pending: PendingBinding | null };

export function createApp({
  github,
  chain,
  depositPageUrl,
  setupPageUrl,
  explorerUrl = ARC_EXPLORER_URL,
  now = () => new Date(),
  afterVerdict,
  triage,
}: AppDeps): App {
  async function readVouched(item: Item): Promise<string> {
    for (const path of VOUCHED_PATHS) {
      const text = await github.readFile(item.repo, path);
      if (text !== null) return text;
    }
    return "";
  }

  async function judge(item: Item, config: Config, repoId: Hex, key: Hex, seen?: DepositedEvent): Promise<Verdict> {
    const vouch = vouchStatus(await readVouched(item), item.author);
    if (vouch === "denounced") return { kind: "denounced" };
    // A Maintainer's acceptance: the Keeper refunds on it, so it stands in for the Deposit from then on.
    if (item.labels.includes(ACCEPTED)) return { kind: "accepted" };
    if (item.labels.includes(WAIVER)) return { kind: "exempt", exemption: "waiver" };
    if (vouch === "vouched") return { kind: "exempt", exemption: "vouched" };
    if (isAllowedBot(item.author, config)) return { kind: "exempt", exemption: "bot" };
    const permission = await github.permissionOf(item.repo, item.author);
    if (permission === "admin" || permission === "write") return { kind: "exempt", exemption: "collaborator" };
    if (await github.hasMergedPullRequest(item.repo, item.author)) return { kind: "exempt", exemption: "merged" };
    // An approval accepts the PR like the label does, but only as late as this: it takes GitHub
    // reads, and an exempt author needs no acceptance. A PR marked bad faith waits for the Maintainer.
    const approval = item.kind === "pr" && !item.labels.includes(BAD_FAITH) ? await approvalOf(item) : null;
    if (approval) return { kind: "accepted", ...approval };
    const [deposit, binding] = await Promise.all([
      chain.depositSince(key, countsFrom(item), seen),
      chain.bindingOf(repoId),
    ]);
    // Nobody could be asked for a Deposit before the repo's first Binding took effect.
    if (binding.active && openedBefore(item, await chain.startedAt(repoId))) {
      return { kind: "exempt", exemption: "grandfathered" };
    }
    if (deposit) return { kind: "deposited", deposit };
    // Until the repo's Binding is active the escrow refuses Deposits, so asking for one would be a dead end.
    if (!binding.active) return { kind: "inactive", pending: binding.pending };
    // The escrow charges the active Binding, which trails a change to the config by the binding delay.
    return { kind: "needed", binding: binding.active, newTerms: newTermsOf(config, binding.active, binding.pending) };
  }

  /** Someone with write, maintain or admin access whose latest review approves the PR, or null. */
  async function approvalOf(pr: PullRequest): Promise<{ approver: string; access: "admin" | "write" } | null> {
    for (const login of await github.approvers(pr.repo, pr.number)) {
      const permission = await github.permissionOf(pr.repo, login);
      if (permission === "admin" || permission === "write") return { approver: login, access: permission };
    }
    return null;
  }

  function checkFor(item: Item, verdict: Verdict): CheckRun {
    switch (verdict.kind) {
      case "accepted":
        return { conclusion: "success", ...acceptedText(item.kind, verdict.approver) };
      case "exempt":
        return { conclusion: "success", ...exemptText(item.kind, verdict.exemption, item.author) };
      case "denounced":
        return { conclusion: "failure", ...denouncedText(item) };
      case "deposited":
        return { conclusion: "success", ...depositedText(item.kind, verdict.deposit, explorerUrl) };
      case "needed": {
        const link = depositLink(depositPageUrl, item);
        return {
          conclusion: "action_required",
          ...depositNeededText(item.kind, verdict.binding, verdict.newTerms, link),
          detailsUrl: link,
        };
      }
      case "inactive":
        return {
          conclusion: "neutral",
          ...inactiveText(item.kind, verdict.pending, now(), setupLink(setupPageUrl, item.repo)),
        };
    }
  }

  /** Posts the verdict and returns the item with its labels as they now stand. */
  async function publish(item: Item, verdict: Verdict): Promise<Item> {
    const check = checkFor(item, verdict);
    if (item.kind === "issue") return noteOnIssue(item, verdict, check);
    await postCheck(item, check);
    return item;
  }

  // The run keeps the PR's number, so a re-run can find the PR: GitHub lists no pull requests on
  // the check runs of a fork's commits.
  function postCheck(pr: PullRequest, check: CheckRun): Promise<void> {
    return github.setCheck(pr.repo, pr.headSha, { ...check, externalId: String(pr.number) });
  }

  // Issues have no checks: one comment, edited in place, and a label while a Deposit is needed.
  // Nothing to ask for, as for an exempt author, an accepted issue or a repo that isn't live yet,
  // starts no comment.
  async function noteOnIssue(issue: Issue, verdict: Verdict, check: CheckRun): Promise<Issue> {
    const body = `**${check.title}**\n\n${check.summary}`;
    const existing = await github.findOwnComment(issue.repo, issue.number);
    if (existing !== null) await github.updateComment(issue.repo, existing, body);
    else if (verdict.kind !== "exempt" && verdict.kind !== "accepted" && verdict.kind !== "inactive") {
      await github.createComment(issue.repo, issue.number, body);
    }

    // The label goes on with the comment, and the issue may predate both, so a comment means "maybe labelled".
    const labelled = issue.labels.includes(DEPOSIT_REQUIRED);
    if (verdict.kind === "needed" && !labelled) {
      await github.addLabel(issue.repo, issue.number, DEPOSIT_REQUIRED);
      return { ...issue, labels: [...issue.labels, DEPOSIT_REQUIRED] };
    }
    if (verdict.kind !== "needed" && (labelled || existing !== null)) {
      await github.removeLabel(issue.repo, issue.number, DEPOSIT_REQUIRED);
      return { ...issue, labels: issue.labels.filter((label) => label !== DEPOSIT_REQUIRED) };
    }
    return issue;
  }

  // Settles of one item run one at a time, so two can't both post a first comment.
  const queues = new Map<string, Promise<void>>();
  function oneAtATime(item: Item, work: () => Promise<void>): Promise<void> {
    const id = `${fullName(item.repo)}#${item.kind}${item.number}`.toLowerCase();
    const run = (queues.get(id) ?? Promise.resolve()).then(work);
    const tail = run.catch(() => {});
    queues.set(id, tail);
    void tail.then(() => {
      if (queues.get(id) === tail) queues.delete(id);
    });
    return run;
  }

  async function settleNow(item: Item, seen?: DepositedEvent): Promise<void> {
    const text = await github.readFile(item.repo, CONFIG_PATH);
    if (text === null) return;
    const parsed = parseConfig(text);
    if (!parsed.ok) {
      if (item.kind === "pr") await postCheck(item, { conclusion: "neutral", ...configProblemsText(parsed.problems) });
      return;
    }
    const repoId = repoIdOf(fullName(item.repo));
    const key = keyOf(repoId, item.kind, item.number);
    const verdict = await judge(item, parsed.config, repoId, key, seen);
    const posted = await publish(item, verdict);
    await afterVerdict?.(item, verdict);
    await triage?.afterVerdict(item, verdict, parsed.config);
    if (verdict.kind !== "needed") return;
    // A watcher elsewhere may have reported a Deposit between the read above and this post.
    const late = await chain.depositSince(key, countsFrom(item));
    if (!late) return;
    const counted: Verdict = { kind: "deposited", deposit: late };
    await publish(posted, counted);
    await triage?.afterVerdict(posted, counted, parsed.config);
  }

  const settle = (item: Item, seen?: DepositedEvent) => oneAtATime(item, () => settleNow(item, seen));

  async function recheck(repo: Repo, kind: Kind, number: number): Promise<void> {
    const item = await github.getItem(repo, kind, number);
    if (item) await settle(item);
  }

  return {
    settle,
    recheck,
    async recheckSuite(repo, suiteId) {
      for (const number of await github.suitePullRequests(repo, suiteId)) await recheck(repo, "pr", number);
    },
  };
}

/** The earliest block time at which a Deposit counts for the item. */
function countsFrom(item: Item): Date {
  return new Date(item.createdAt.getTime() - CLOCK_SKEW_SECONDS * 1000);
}

/** Whether the item may have been opened before `time`, a block time, by up to CLOCK_SKEW_SECONDS. */
function openedBefore(item: Item, time: Date | null): boolean {
  return time !== null && item.createdAt.getTime() <= time.getTime() + CLOCK_SKEW_SECONDS * 1000;
}

function isAllowedBot(login: string, config: Config): boolean {
  const wanted = login.toLowerCase();
  return [...DEFAULT_EXEMPT_BOTS, ...config.exemptBots].some((bot) => bot.toLowerCase() === wanted);
}

function newTermsOf(config: Config, active: Binding, pending: PendingBinding | null): NewTerms | null {
  if (sameTerms(config, active)) return null;
  return { startsAt: pending && sameTerms(config, pending) ? pending.effectiveAt : null };
}

function sameTerms(config: Config, binding: Binding): boolean {
  return (
    config.amount === binding.amount &&
    config.forfeitBps === binding.forfeitBps &&
    config.timeoutSeconds === binding.timeoutSeconds
  );
}
