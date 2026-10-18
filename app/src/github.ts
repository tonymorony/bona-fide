import { repoIdOf } from "@bona-fide/sdk";
import type { Octokit } from "@octokit/rest";
import type { Hex } from "viem";
import {
  fullName,
  type AuthoredText,
  type Closing,
  type CommitCheck,
  type GitHub,
  type IssueClosing,
  type ItemFacts,
  type ItemFields,
  type Permission,
  type Repo,
} from "./ports.ts";

export const CHECK_NAME = "Bona Fide";
const MARKER = "<!-- bona-fide -->";
const NOTE_MARKER = "<!-- bona-fide:keeper -->";
const PERMISSIONS: readonly Permission[] = ["admin", "write", "read", "none"];
const RELIST_AFTER_MS = 60_000;
/** Most pages of an issue's closing PRs read, 100 to a page. */
const MAX_CLOSING_PAGES = 5;
/** The review states that stand until the reviewer's next one. A comment leaves the last one standing. */
const STANDING_REVIEWS = ["APPROVED", "CHANGES_REQUESTED", "DISMISSED"];
/**
 * How long a listed repo is trusted before it is listed again. A repo that turns private must stop
 * having its decisions published, and the listing says whether it is.
 */
const REFRESH_AFTER_MS = 5 * 60_000;

/**
 * The `log` to give the App's Octokits. Octokit reports every failed request as an error, but
 * most of the App's 404s are expected (a repo without VOUCHED.td), and real failures reach the
 * caller as thrown errors anyway. Warnings, such as deprecations, go to `sink`.
 */
export function quietLog(sink: { warn(...args: unknown[]): void } = console) {
  return { debug() {}, info() {}, warn: (...args: unknown[]) => sink.warn(...args), error() {} };
}

export interface GitHubOptions {
  appId: number;
  /** Octokit authenticated as the App itself, to list its installations. */
  app: Octokit;
  /** Octokit authenticated as one installation. Reuse instances: each caches its token. */
  installation(installationId: number): Octokit;
}

export function createGitHub({ appId, app, installation }: GitHubOptions): GitHub {
  const api = (repo: Repo) => installation(repo.installationId);
  const repoParams = (repo: Repo) => ({ owner: repo.owner, repo: repo.name });
  let installed = new Map<Hex, Repo>();
  let listedAt = -Infinity;

  // Only the App's own comments: anyone can copy a marker into theirs.
  async function appComments(repo: Repo, number: number) {
    const octokit = api(repo);
    const comments = await octokit.paginate(octokit.rest.issues.listComments, {
      ...repoParams(repo),
      issue_number: number,
      per_page: 100,
    });
    return comments.filter((c) => c.performed_via_github_app?.id === appId);
  }

  // GitHub won't make the diff of a very large PR, and answers 406.
  async function diffOf(repo: Repo, number: number): Promise<string | null> {
    try {
      const { data } = await api(repo).rest.pulls.get({
        ...repoParams(repo),
        pull_number: number,
        mediaType: { format: "diff" },
      });
      return typeof data === "string" ? data : null;
    } catch (error) {
      const status = (error as { status?: number } | null)?.status;
      if (status === 406 || status === 422) return null;
      throw error;
    }
  }

  // A missing repo, PR or issue comes back as null data with a NOT_FOUND error.
  async function graphql<T>(repo: Repo, query: string, variables: Record<string, unknown>): Promise<T | null> {
    try {
      return await api(repo).graphql<T>(query, { owner: repo.owner, name: repo.name, ...variables });
    } catch (error) {
      const errors = (error as { errors?: { type?: string }[] } | null)?.errors;
      if (errors?.some((e) => e.type === "NOT_FOUND")) return null;
      throw error;
    }
  }

  async function listInstalledRepos(): Promise<Map<Hex, Repo>> {
    const found = new Map<Hex, Repo>();
    for (const { id } of await app.paginate(app.rest.apps.listInstallations, { per_page: 100 })) {
      const octokit = installation(id);
      for (const repo of await octokit.paginate(octokit.rest.apps.listReposAccessibleToInstallation, {
        per_page: 100,
      })) {
        found.set(repoIdOf(repo.full_name), {
          owner: repo.owner.login,
          name: repo.name,
          installationId: id,
          private: repo.private,
        });
      }
    }
    return found;
  }

  async function permissionOf(repo: Repo, login: string): Promise<Permission> {
    try {
      const { data } = await api(repo).rest.repos.getCollaboratorPermissionLevel({
        ...repoParams(repo),
        username: login,
      });
      return PERMISSIONS.find((p) => p === data.permission) ?? "none";
    } catch (error) {
      if (isNotFound(error)) return "none";
      throw error;
    }
  }

  // GitHub lists an item's events oldest first.
  async function labeledBy(repo: Repo, number: number, label: string): Promise<string | null> {
    const octokit = api(repo);
    let events;
    try {
      events = await octokit.paginate(octokit.rest.issues.listEvents, {
        ...repoParams(repo),
        issue_number: number,
        per_page: 100,
      });
    } catch (error) {
      if (isNotFound(error)) return null;
      throw error;
    }
    /* eslint-disable @typescript-eslint/no-unnecessary-condition -- GitHub sends null for a deleted label or account though its types don't say so; review-by: 2027-04-18 */
    const added = events.filter((e) => e.event === "labeled" && "label" in e && e.label?.name === label).at(-1);
    return added?.actor?.login ?? null;
    /* eslint-enable @typescript-eslint/no-unnecessary-condition */
  }

  return {
    async readFile(repo, path) {
      try {
        const { data } = await api(repo).rest.repos.getContent({
          ...repoParams(repo),
          path,
          mediaType: { format: "raw" },
        });
        return typeof data === "string" ? data : null;
      } catch (error) {
        if (isNotFound(error)) return null;
        throw error;
      }
    },

    permissionOf,

    async hasMergedPullRequest(repo, login) {
      try {
        const { data } = await api(repo).rest.search.issuesAndPullRequests({
          q: `repo:${fullName(repo)} is:pr is:merged author:${login}`,
          per_page: 1,
        });
        return data.total_count > 0;
      } catch (error) {
        // Search answers 422 for a login it won't look up, such as "Copilot", the author of the
        // Copilot coding agent's PRs. Without a merged PR to find, the author deposits like anyone else.
        if ((error as { status?: number } | null)?.status === 422) return false;
        throw error;
      }
    },

    async setCheck(repo, headSha, check) {
      const octokit = api(repo);
      const { data } = await octokit.rest.checks.listForRef({
        ...repoParams(repo),
        ref: headSha,
        check_name: CHECK_NAME,
        app_id: appId,
        filter: "latest",
        per_page: 1,
      });
      const existing = data.check_runs[0];
      // An update can replace a run's link but not clear it. A run created without one links to the
      // App's homepage, so a check without a link goes back to that, or to the run's own page.
      const detailsUrl = check.detailsUrl ?? existing?.app?.external_url ?? existing?.html_url;
      // A run that waits for a Deposit stays in progress. GitHub shows a finished run that asks for
      // something as failed, with a red cross on the commit, before the Contributor has done anything.
      const state =
        check.conclusion === "pending"
          ? { status: "in_progress" as const }
          : { status: "completed" as const, conclusion: check.conclusion, completed_at: new Date().toISOString() };
      const fields = {
        ...state,
        output: { title: check.title, summary: check.summary },
        ...(detailsUrl ? { details_url: detailsUrl } : {}),
        ...(check.externalId ? { external_id: check.externalId } : {}),
      };
      // GitHub ignores an update that puts a finished run back in progress, and says nothing. A new run
      // of the same name takes the finished one's place on the commit.
      const reopens = check.conclusion === "pending" && existing?.status === "completed";
      if (existing && !reopens) {
        await octokit.rest.checks.update({ ...repoParams(repo), check_run_id: existing.id, ...fields });
      } else {
        await octokit.rest.checks.create({ ...repoParams(repo), name: CHECK_NAME, head_sha: headSha, ...fields });
      }
    },

    // GitHub lists a repo's PRs among its issues, so one page holds the most recently updated of both.
    async openItems(repo, max) {
      const { data } = await api(repo).rest.issues.listForRepo({
        ...repoParams(repo),
        state: "open",
        sort: "updated",
        direction: "desc",
        per_page: max + 1,
      });
      const items = data
        .slice(0, max)
        .map((item) => ({ kind: item.pull_request ? ("pr" as const) : ("issue" as const), number: item.number }));
      return { items, more: data.length > max };
    },

    // A suite is one App's runs on one commit, so it holds a run for each PR the App checked there.
    async suitePullRequests(repo, suiteId) {
      const { data } = await api(repo).rest.checks.listForSuite({
        ...repoParams(repo),
        check_suite_id: suiteId,
        check_name: CHECK_NAME,
        filter: "latest",
        per_page: 100,
      });
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- a fork's runs list no pull_requests at all; review-by: 2027-04-18
      const numbers = data.check_runs.map((run) => Number(run.external_id || run.pull_requests?.[0]?.number));
      return [...new Set(numbers.filter((number) => Number.isSafeInteger(number) && number > 0))];
    },

    async findOwnComment(repo, number) {
      const own = (await appComments(repo, number)).find((c) => c.body?.startsWith(MARKER));
      return own?.id ?? null;
    },

    async createComment(repo, number, body) {
      await api(repo).rest.issues.createComment({
        ...repoParams(repo),
        issue_number: number,
        body: `${MARKER}\n${body}`,
      });
    },

    async updateComment(repo, commentId, body) {
      await api(repo).rest.issues.updateComment({
        ...repoParams(repo),
        comment_id: commentId,
        body: `${MARKER}\n${body}`,
      });
    },

    async addLabel(repo, number, label) {
      await api(repo).rest.issues.addLabels({ ...repoParams(repo), issue_number: number, labels: [label] });
    },

    labeledBy,

    async removeLabel(repo, number, label) {
      try {
        await api(repo).rest.issues.removeLabel({ ...repoParams(repo), issue_number: number, name: label });
      } catch (error) {
        if (!isNotFound(error)) throw error;
      }
    },

    async findRepo(repoId) {
      const age = Date.now() - listedAt;
      if (age > REFRESH_AFTER_MS || (!installed.has(repoId) && age > RELIST_AFTER_MS)) {
        installed = await listInstalledRepos();
        listedAt = Date.now();
      }
      return installed.get(repoId) ?? null;
    },

    async postNote(repo, number, body) {
      const octokit = api(repo);
      const note = (await appComments(repo, number)).find((c) => c.body?.startsWith(NOTE_MARKER));
      const text = `${NOTE_MARKER}\n${body}`;
      if (note) await octokit.rest.issues.updateComment({ ...repoParams(repo), comment_id: note.id, body: text });
      else await octokit.rest.issues.createComment({ ...repoParams(repo), issue_number: number, body: text });
    },

    async hasNote(repo, number, marker) {
      return (await appComments(repo, number)).some((c) => c.body?.startsWith(marker));
    },

    async addNote(repo, number, marker, body) {
      await api(repo).rest.issues.createComment({
        ...repoParams(repo),
        issue_number: number,
        body: `${marker}\n${body}`,
      });
    },

    // GitHub lists a PR's reviews oldest first.
    async approvers(repo, number) {
      const octokit = api(repo);
      const reviews = await octokit.paginate(octokit.rest.pulls.listReviews, {
        ...repoParams(repo),
        pull_number: number,
        per_page: 100,
      });
      const standing = new Map<string, string>();
      for (const review of reviews) {
        if (review.user && STANDING_REVIEWS.includes(review.state)) standing.set(review.user.login, review.state);
      }
      return [...standing].filter(([, state]) => state === "APPROVED").map(([login]) => login);
    },

    // Triage reads the first page of a PR's files: their names and sizes, not their contents.
    async contentOf(item) {
      const octokit = api(item.repo);
      const { data: repo } = await octokit.rest.repos.get(repoParams(item.repo));
      const repoDescription = repo.description ?? null;
      if (item.kind === "issue") {
        const { data } = await octokit.rest.issues.get({ ...repoParams(item.repo), issue_number: item.number });
        return { title: data.title, body: data.body ?? "", repoDescription };
      }
      const pull = { ...repoParams(item.repo), pull_number: item.number };
      const [{ data }, { data: files }, diff] = await Promise.all([
        octokit.rest.pulls.get(pull),
        octokit.rest.pulls.listFiles({ ...pull, per_page: 100 }),
        diffOf(item.repo, item.number),
      ]);
      const listed = files.map((file) => ({
        path: file.filename,
        additions: file.additions,
        deletions: file.deletions,
      }));
      return {
        title: data.title,
        body: data.body ?? "",
        repoDescription,
        files: { listed, total: Math.max(data.changed_files, listed.length) },
        diff,
      };
    },

    // One read, and no judgement: Acceptance weighs the facts. A deleted account's item is nobody's.
    async itemFacts(repo, kind, number) {
      try {
        if (kind === "pr") {
          const { data } = await api(repo).rest.pulls.get({ ...repoParams(repo), pull_number: number });
          // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- GitHub sends a deleted account's user as null though its types don't say so; review-by: 2027-04-18
          if (!data.user) return null;
          const closing: Closing | null = data.merged
            ? { type: "merged", by: data.merged_by?.login ?? null }
            : data.state === "closed"
              ? { type: "closed", reason: null, by: null }
              : null;
          return factsOf(data.user, data, closing);
        }
        const { data } = await api(repo).rest.issues.get({ ...repoParams(repo), issue_number: number });
        if (data.pull_request || !data.user) return null;
        const closing: Closing | null =
          data.state === "closed"
            ? { type: "closed", reason: data.state_reason ?? null, by: data.closed_by?.login ?? null }
            : null;
        return factsOf(data.user, data, closing);
      } catch (error) {
        if (isNotFound(error)) return null;
        throw error;
      }
    },

    // Two reads: the account, and a search count of merged PRs in other people's repos. Merged PRs in
    // the Contributor's own repos, or in the checked repo's owner's, don't count.
    async profileOf(repo, login) {
      const octokit = api(repo);
      let user;
      try {
        ({ data: user } = await octokit.rest.users.getByUsername({ username: login }));
      } catch (error) {
        if (isNotFound(error)) return null;
        throw error;
      }
      let mergedElsewhere = 0;
      try {
        const { data } = await octokit.rest.search.issuesAndPullRequests({
          q: `is:pr is:merged author:${login} -user:${login} -user:${repo.owner}`,
          per_page: 1,
        });
        mergedElsewhere = data.total_count;
      } catch (error) {
        // As for hasMergedPullRequest: search refuses some logins, such as "Copilot".
        if ((error as { status?: number } | null)?.status !== 422) throw error;
      }
      return {
        createdAt: new Date(user.created_at),
        publicRepos: user.public_repos,
        followers: user.followers,
        mergedElsewhere,
      };
    },

    // GraphQL has what REST lacks: the issues GitHub links a PR to as closing them, and who last
    // edited its body and each comment.
    async pullRequestFacts(repo, number) {
      const data = await graphql<{ repository: { pullRequest: GraphPullRequest | null } | null }>(
        repo,
        PULL_REQUEST_FACTS,
        { number },
      );
      const pr = data?.repository?.pullRequest;
      if (!pr) return null;
      const sameRepo = fullName(repo).toLowerCase();
      return {
        number: pr.number,
        author: pr.author?.login ?? null,
        merged: pr.merged,
        mergedAt: pr.mergedAt ? new Date(pr.mergedAt) : null,
        mergedBy: pr.mergedBy?.login ?? null,
        headSha: pr.headRefOid,
        closes: pr.closingIssuesReferences.nodes
          .filter((issue) => issue.repository.nameWithOwner.toLowerCase() === sameRepo)
          .map((issue) => issue.number),
        body: authored(pr),
        comments: pr.comments.nodes.map(authored),
      };
    },

    // GitHub lists up to 100 a page. An issue linked by more than MAX_CLOSING_PAGES pages of PRs
    // is left incomplete, and a Bounty on it waits for the Maintainer.
    async closingPullRequests(repo, issueNumber) {
      const sameRepo = fullName(repo).toLowerCase();
      const closing: IssueClosing = { prs: [], complete: false, open: false, closedBy: null };
      let after: string | null = null;
      for (let page = 0; page < MAX_CLOSING_PAGES; page++) {
        const data: { repository: { issue: GraphIssue | null } | null } | null = await graphql(
          repo,
          CLOSING_PULL_REQUESTS,
          { number: issueNumber, after },
        );
        const issue: GraphIssue | null | undefined = data?.repository?.issue;
        if (!issue) return { ...closing, complete: true };
        const references: GraphIssue["closedByPullRequestsReferences"] = issue.closedByPullRequestsReferences;
        for (const pr of references.nodes) {
          if (pr.repository.nameWithOwner.toLowerCase() !== sameRepo) continue;
          closing.prs.push({ number: pr.number, mergedAt: pr.mergedAt ? new Date(pr.mergedAt) : null });
        }
        closing.open = issue.state === "OPEN";
        const closer = issue.timelineItems.nodes.at(-1)?.closer;
        const byPr = closer?.__typename === "PullRequest" && closer.repository.nameWithOwner.toLowerCase() === sameRepo;
        closing.closedBy = !closing.open && byPr ? closer.number : null;
        if (!references.pageInfo.hasNextPage) return { ...closing, complete: true };
        after = references.pageInfo.endCursor;
      }
      return closing;
    },

    async repoCreatedAt(repo) {
      try {
        const { data } = await api(repo).rest.repos.get(repoParams(repo));
        return new Date(data.created_at);
      } catch (error) {
        if (isNotFound(error)) return null;
        throw error;
      }
    },

    // Check runs from GitHub Apps and Actions, and statuses from older CI. The App's own check is
    // about the Deposit, not the code, so it is left out.
    async checksOf(repo, sha) {
      const octokit = api(repo);
      const [runs, { data: combined }] = await Promise.all([
        octokit.paginate(octokit.rest.checks.listForRef, {
          ...repoParams(repo),
          ref: sha,
          filter: "latest",
          per_page: 100,
        }),
        octokit.rest.repos.getCombinedStatusForRef({ ...repoParams(repo), ref: sha, per_page: 100 }),
      ]);
      const checks: CommitCheck[] = runs
        .filter((run) => run.app?.id !== appId)
        .map((run) => ({ name: run.name, state: runState(run.status, run.conclusion) }));
      for (const status of combined.statuses) {
        checks.push({ name: status.context, state: statusState(status.state) });
      }
      return checks;
    },

    async getItem(repo, kind, number) {
      try {
        if (kind === "pr") {
          const { data } = await api(repo).rest.pulls.get({ ...repoParams(repo), pull_number: number });
          return { ...itemFields(repo, data), kind, headSha: data.head.sha };
        }
        const { data } = await api(repo).rest.issues.get({ ...repoParams(repo), issue_number: number });
        return data.pull_request ? null : { ...itemFields(repo, data), kind };
      } catch (error) {
        if (isNotFound(error)) return null;
        throw error;
      }
    },

    // GitHub lists a PR as an issue too.
    async isOpenIssue(repo, number) {
      try {
        const { data } = await api(repo).rest.issues.get({ ...repoParams(repo), issue_number: number });
        return !data.pull_request && data.state === "open";
      } catch (error) {
        if (isNotFound(error)) return false;
        throw error;
      }
    },
  };
}

const PULL_REQUEST_FACTS = `query ($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      number
      merged
      mergedAt
      mergedBy { login }
      headRefOid
      author { login }
      editor { login }
      body
      createdAt
      closingIssuesReferences(first: 25) { nodes { number repository { nameWithOwner } } }
      comments(last: 100) { nodes { author { login } editor { login } body createdAt } }
    }
  }
}`;

// The last ClosedEvent names what closed the issue: the PR whose merge closed it, a commit, or nobody.
const CLOSING_PULL_REQUESTS = `query ($owner: String!, $name: String!, $number: Int!, $after: String) {
  repository(owner: $owner, name: $name) {
    issue(number: $number) {
      state
      timelineItems(itemTypes: [CLOSED_EVENT], last: 1) {
        nodes { ... on ClosedEvent { closer { __typename ... on PullRequest { number repository { nameWithOwner } } } } }
      }
      closedByPullRequestsReferences(first: 100, after: $after, includeClosedPrs: true) {
        pageInfo { hasNextPage endCursor }
        nodes { number mergedAt repository { nameWithOwner } }
      }
    }
  }
}`;

interface GraphText {
  author: { login: string } | null;
  editor: { login: string } | null;
  body: string;
  createdAt: string;
}

interface GraphPullRequest extends GraphText {
  number: number;
  merged: boolean;
  mergedAt: string | null;
  mergedBy: { login: string } | null;
  headRefOid: string;
  closingIssuesReferences: { nodes: { number: number; repository: { nameWithOwner: string } }[] };
  comments: { nodes: GraphText[] };
}

interface GraphIssue {
  state: "OPEN" | "CLOSED";
  timelineItems: {
    nodes: {
      closer?:
        | { __typename: "PullRequest"; number: number; repository: { nameWithOwner: string } }
        | { __typename: "Commit" | "ProjectV2" }
        | null;
    }[];
  };
  closedByPullRequestsReferences: {
    pageInfo: { hasNextPage: boolean; endCursor: string | null };
    nodes: { number: number; mergedAt: string | null; repository: { nameWithOwner: string } }[];
  };
}

function authored(text: GraphText): AuthoredText {
  return {
    author: text.author?.login ?? null,
    editor: text.editor?.login ?? null,
    text: text.body,
    createdAt: new Date(text.createdAt),
  };
}

// Neutral and skipped runs don't block a merge, so they count as green.
function runState(status: string, conclusion: string | null): CommitCheck["state"] {
  if (status !== "completed") return "pending";
  return conclusion === "success" || conclusion === "neutral" || conclusion === "skipped" ? "success" : "failure";
}

function statusState(state: string): CommitCheck["state"] {
  if (state === "success") return "success";
  return state === "pending" ? "pending" : "failure";
}

interface RestItem {
  number: number;
  user: { login: string; id: number } | null;
  created_at: string;
  labels: (string | { name?: string })[];
}

function itemFields(repo: Repo, data: RestItem): ItemFields {
  return {
    repo,
    number: data.number,
    author: data.user?.login ?? "ghost",
    ...(data.user ? { authorId: data.user.id } : {}),
    createdAt: new Date(data.created_at),
    labels: labelNames(data.labels),
  };
}

function factsOf(
  user: { login: string; id: number },
  data: Pick<RestItem, "labels"> & { closed_at: string | null },
  closing: Closing | null,
): ItemFacts {
  return {
    author: user.login,
    authorId: user.id,
    labels: labelNames(data.labels),
    closing,
    closedAt: data.closed_at ? new Date(data.closed_at) : null,
  };
}

function labelNames(labels: RestItem["labels"]): string[] {
  return labels.map((label) => (typeof label === "string" ? label : (label.name ?? "")));
}

function isNotFound(error: unknown): boolean {
  const status = (error as { status?: number } | null)?.status;
  return status === 404 || status === 410;
}
