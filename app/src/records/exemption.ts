import type { Verdict } from "../app.ts";
import { FORFEIT_REPOS, type Config } from "../config.ts";
import { recordFlagNote } from "../copy.ts";
import { decisionCost, newDecision } from "../decisions/log.ts";
import {
  fullName,
  type Advice,
  type AdviceAnswer,
  type AdviceRequest,
  type Advisor,
  type ContributorRecord,
  type ContributorRecords,
  type Decision,
  type DecisionLog,
  type GitHub,
  type GitHubProfile,
  type Item,
  type Repo,
} from "../ports.ts";
import { markdownSafe, plainReasons, ReviewFailed } from "../triage/triage.ts";

/**
 * Most merged PRs in other people's repos the score counts. It is below the default threshold, so
 * there a Record Exemption needs at least one Refund on accepted work.
 */
export const MERGED_CAP = 2;
/** How long a Contributor's GitHub profile is reused before it is read again. */
export const PROFILE_TTL_MS = 60 * 60 * 1000;
/** Most profiles remembered. Past it, the memory is emptied. */
const MAX_PROFILES = 10_000;
/** How long after the model was asked about an item a reopen or a re-run asks it again. */
export const ASK_AGAIN_MS = 10 * 60_000;
/** Most reasons a flag note shows. */
const MAX_REASONS = 3;
const DAY_MS = 86_400_000;

/** The hidden marker a flag note starts with, so a re-run doesn't post it twice. */
export const FLAG_MARKER = "<!-- bona-fide:record-flag -->";

/** What the check of an item with a Record Exemption cites: public repos' counts, when it was granted. */
export interface RecordGrant {
  refunds: number;
  repos: number;
  mergedElsewhere: number;
}

export type RecordAction = "waived" | "required" | "flagged" | "silent" | `failed: ${string}`;

export interface RecordExemptionDeps {
  github: GitHub;
  records: ContributorRecords;
  advisor: Advisor;
  /** Keeps each decision the model was asked about, and remembers the Record Exemptions granted. */
  decisions: DecisionLog;
  now?: () => Date;
  /** Hears each decision the model was asked about, such as to log it. */
  record?(decision: Decision): void;
}

export interface RecordCheck {
  /** Whether the check was re-run or the item reopened: then the model is asked again. */
  askAgain: boolean;
  /** Checks the item again, once a Record Exemption is granted. */
  recheck(): Promise<void>;
}

export interface RecordExemptions {
  /**
   * The Record Exemption granted for the item, if it still stands: the repo hasn't turned it off,
   * and none of the Contributor's Deposits has been forfeited since. It reads memory only.
   */
  exemptionOf(item: Item, config: Config): RecordGrant | null;
  /**
   * When the check asks the item's Contributor for a Deposit, weighs their record in the background
   * and resolves at once: the model can take longer than GitHub waits for a webhook. The model is
   * asked once per item and author, and again only when `check.askAgain`. It never rejects.
   */
  afterVerdict(item: Item, verdict: Verdict, config: Config, check: RecordCheck): Promise<void>;
  /** Resolves once every weighing started so far is done. */
  idle(): Promise<void>;
}

/** The score a record earns: Refunds on accepted work, and merged PRs in other people's repos up to MERGED_CAP. */
export function scoreOf(record: Pick<ContributorRecord, "refunds">, mergedElsewhere: number): number {
  return record.refunds + Math.min(mergedElsewhere, MERGED_CAP);
}

// The model can hold a Record Exemption back, never grant one alone. It is granted only when the
// score reaches the repo's threshold, Deposits on the Contributor's items were forfeited in fewer
// than FORFEIT_REPOS repos,
// the repo hasn't denounced them, and the model suggests waiving. The model never sees the
// threshold or the witnesses, and its answer can't change them.
export function createRecordExemptions({
  github,
  records,
  advisor,
  decisions,
  now = () => new Date(),
  record,
}: RecordExemptionDeps): RecordExemptions {
  const running = new Map<string, Promise<void>>();
  /** When the model was asked about each item and author in this process. After a restart, the log says. */
  const asked = new Map<string, number>();
  const profiles = new Map<string, { profile: GitHubProfile | null; at: number }>();

  function granted(item: Item): Decision | null {
    const decision = decisions.waiverOf(fullName(item.repo), item.kind, item.number);
    return decision && sameLogin(decision.inputs?.login, item.author) ? decision : null;
  }

  async function profileOf(repo: Repo, login: string): Promise<GitHubProfile | null> {
    const id = `${repo.owner}:${login}`.toLowerCase();
    const known = profiles.get(id);
    if (known && now().getTime() - known.at < PROFILE_TTL_MS) return known.profile;
    const profile = await github.profileOf(repo, login);
    if (profiles.size >= MAX_PROFILES) profiles.clear();
    profiles.set(id, { profile, at: now().getTime() });
    return profile;
  }

  async function weigh(item: Item, config: Config, recheck: () => Promise<void>): Promise<void> {
    const contributor = records.recordOf(item.author, item.authorId);
    // The witnesses first. When one fails, neither GitHub's search nor the model is asked, and
    // nothing is recorded: a skip without the model decides nothing.
    if (!contributor.complete || contributor.forfeitReposAnywhere >= FORFEIT_REPOS) return;
    if (scoreOf(contributor, Infinity) < config.recordThreshold) return;
    const profile = await profileOf(item.repo, item.author);
    if (!profile) return;
    const score = scoreOf(contributor, profile.mergedElsewhere);
    if (score < config.recordThreshold) return;

    const request: AdviceRequest = {
      repo: fullName(item.repo),
      kind: item.kind,
      number: item.number,
      login: item.author,
      record: {
        refunds: contributor.refunds,
        repos: contributor.repos,
        otherRefunds: contributor.otherRefunds,
        forfeits: contributor.forfeits,
        active: contributor.active,
      },
      profile: {
        accountAgeDays: Math.max(0, Math.floor((now().getTime() - profile.createdAt.getTime()) / DAY_MS)),
        publicRepos: profile.publicRepos,
        followers: profile.followers,
        mergedElsewhere: profile.mergedElsewhere,
      },
    };
    let answer: AdviceAnswer | null = null;
    let action: RecordAction;
    try {
      answer = await advisor.advise(request);
      action = ACTIONS[answer.suggestion?.verdict ?? "none"];
    } catch (error) {
      action = `failed: ${error instanceof ReviewFailed ? error.reason : "unexpected error"}`;
    }
    const reasons = plainReasons(answer?.suggestion?.reasons ?? [], MAX_REASONS);
    // As for triage: a suggestion with nothing for the Maintainer to check is no suggestion.
    if (answer?.suggestion && reasons.length === 0) action = "silent";
    const decision = newDecision(
      {
        repo: fullName(item.repo),
        private: item.repo.private !== false,
        item: { kind: item.kind, number: item.number },
        serial: null,
        type: "waive",
        inputs: { login: item.author, ...request.record, ...request.profile },
        suggestion: answer?.suggestion ? { verdict: answer.suggestion.verdict, reasons } : null,
        witnesses: [
          {
            name: "Score",
            value: `${score}, threshold ${config.recordThreshold}: ${count(contributor.refunds, "Refund")} on accepted work, and ${count(Math.min(profile.mergedElsewhere, MERGED_CAP), "merged PR")} elsewhere (at most ${MERGED_CAP} count)`,
          },
          { name: "Forfeits", value: `in fewer than ${FORFEIT_REPOS} repos` },
          { name: "Denounced in VOUCHED.td", value: "no" },
          { name: "Record Exemption in bona-fide.yml", value: "on" },
        ],
        action,
        txHash: null,
        // Only a waiver is the App acting on its own. Asking for the Deposit leaves the Maintainer
        // their Waiver label, and a flag asks them to look.
        outcome: action === "waived" ? "decided" : "escalated",
        cost: answer ? decisionCost(answer.model, answer.inputTokens, answer.outputTokens) : null,
      },
      now(),
    );
    if (asked.size >= MAX_PROFILES) asked.clear();
    asked.set(idOf(item), now().getTime());
    safely(() => decisions.append(decision));
    safely(() => record?.(decision));
    if (action === "waived") return recheck();
    if (action === "flagged" && !(await github.hasNote(item.repo, item.number, FLAG_MARKER))) {
      await github.addNote(item.repo, item.number, FLAG_MARKER, recordFlagNote(item.kind, reasons.map(markdownSafe)));
    }
  }

  return {
    exemptionOf(item, config) {
      if (!config.recordExemption) return null;
      const decision = granted(item);
      if (decision?.action !== "waived") return null;
      // Forfeits in FORFEIT_REPOS repos, private ones included, end it on the next check.
      if (records.recordOf(item.author, item.authorId).forfeitReposAnywhere >= FORFEIT_REPOS) return null;
      const inputs = decision.inputs!;
      return {
        refunds: Number(inputs.refunds) || 0,
        repos: Number(inputs.repos) || 0,
        mergedElsewhere: Number(inputs.mergedElsewhere) || 0,
      };
    },

    async afterVerdict(item, verdict, config, { askAgain, recheck }) {
      if (verdict.kind !== "needed" || !config.recordExemption) return;
      const id = idOf(item);
      if (running.has(id)) return;
      const last = asked.get(id);
      // Reopening or re-running asks again, but not within ASK_AGAIN_MS: each answer is paid for.
      if (
        askAgain ? last !== undefined && now().getTime() - last < ASK_AGAIN_MS : last !== undefined || granted(item)
      ) {
        return;
      }
      const work = weigh(item, config, recheck)
        .catch((error: unknown) => {
          // GitHub failed: nothing was recorded, so the next check tries again.
          console.error(`record exemption of ${id} failed:`, error);
        })
        .finally(() => running.delete(id));
      running.set(id, work);
    },

    async idle() {
      while (running.size > 0) await Promise.all(running.values());
    },
  };
}

const ACTIONS: Record<Advice | "none", RecordAction> = {
  waive: "waived",
  require: "required",
  flag: "flagged",
  none: "silent",
};

function idOf(item: Item): string {
  return `${fullName(item.repo)}#${item.kind}${item.number}:${item.author}`.toLowerCase();
}

function sameLogin(logged: unknown, login: string): boolean {
  return typeof logged === "string" && logged.toLowerCase() === login.toLowerCase();
}

function count(n: number, unit: string): string {
  return `${n} ${unit}${n === 1 ? "" : "s"}`;
}

function safely(work: () => void): void {
  try {
    work();
  } catch {
    // A log that throws mustn't stop the check.
  }
}
