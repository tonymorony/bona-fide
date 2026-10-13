import type { Decision, DecisionCost, DecisionLog, DecisionOutcome } from "../ports.ts";

/** Most decisions of one repo kept in memory: as many as GET /decisions shows. Counts cover all of them. */
export const KEPT_PER_REPO = 50;

/** List prices in USD per million tokens, for the cost estimate. A model not listed has no estimate. */
const PRICES: Record<string, { input: number; output: number }> = {
  "claude-opus-5": { input: 5, output: 25 },
};

export interface DecisionLogOptions {
  /** Stores each decision appended, such as by appending it to a file. */
  write?(decision: Decision): void;
}

interface RepoDecisions {
  /** Whether the repo's latest decision was made while it was private. Then nothing of it is published. */
  private: boolean;
  counts: Record<DecisionOutcome, number>;
  /** Its latest public decisions, the newest last. */
  latest: Decision[];
}

// Decisions are kept by repo, in memory: the counts of every public decision, and the latest few.
// A private repo's decisions are neither counted nor kept, and a repo that turns private hides
// everything it had.
export function createDecisionLog({ write }: DecisionLogOptions = {}): DecisionLog {
  const repos = new Map<string, RepoDecisions>();

  function add(decision: Decision): void {
    const id = decision.repo.toLowerCase();
    let repo = repos.get(id);
    if (!repo || decision.private !== repo.private) {
      // Turning private hides what the repo had; turning public starts afresh.
      repo = { private: decision.private, counts: { decided: 0, escalated: 0 }, latest: [] };
      repos.set(id, repo);
    }
    if (repo.private) return;
    repo.counts[decision.outcome] += 1;
    repo.latest.push(decision);
    if (repo.latest.length > KEPT_PER_REPO) repo.latest.shift();
  }

  function published(repo: string): RepoDecisions | null {
    const found = repos.get(repo.toLowerCase());
    return found && !found.private ? found : null;
  }

  return {
    append(decision) {
      write?.(decision);
      add(decision);
    },

    latest(repo, max) {
      return (published(repo)?.latest ?? []).slice(-max).reverse();
    },

    counts(repo) {
      return { ...(published(repo)?.counts ?? { decided: 0, escalated: 0 }) };
    },
  };
}

/** What asking `model` cost, with an estimate in USD from its list price. A dated model id takes its model's price. */
export function decisionCost(model: string, inputTokens: number, outputTokens: number): DecisionCost {
  const price = PRICES[model] ?? PRICES[model.replace(/-\d{8}$/, "")];
  const usd = price ? Math.round(inputTokens * price.input + outputTokens * price.output) / 1_000_000 : null;
  return { model, inputTokens, outputTokens, usd };
}

/** A new decision, with its id and time. */
export function newDecision(fields: Omit<Decision, "id" | "at">, now: Date): Decision {
  return { id: crypto.randomUUID(), at: now.toISOString(), ...fields };
}
