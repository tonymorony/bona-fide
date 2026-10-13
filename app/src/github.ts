import type { Octokit } from "@octokit/rest";
import type { Hex } from "viem";
import { repoIdOf } from "./keys.ts";
import { fullName, type GitHub, type ItemFields, type Permission, type Repo } from "./ports.ts";

export const CHECK_NAME = "Bona Fide";
const MARKER = "<!-- bona-fide -->";
const NOTE_MARKER = "<!-- bona-fide:keeper -->";
const PERMISSIONS: readonly Permission[] = ["admin", "write", "read", "none"];
const RELIST_AFTER_MS = 60_000;
/** The review states that stand until the reviewer's next one. A comment leaves the last one standing. */
const STANDING_REVIEWS = ["APPROVED", "CHANGES_REQUESTED", "DISMISSED"];

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

  async function listInstalledRepos(): Promise<Map<Hex, Repo>> {
    const found = new Map<Hex, Repo>();
    for (const { id } of await app.paginate(app.rest.apps.listInstallations, { per_page: 100 })) {
      const octokit = installation(id);
      for (const repo of await octokit.paginate(octokit.rest.apps.listReposAccessibleToInstallation, {
        per_page: 100,
      })) {
        found.set(repoIdOf(repo.full_name), { owner: repo.owner.login, name: repo.name, installationId: id });
      }
    }
    return found;
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

    async permissionOf(repo, login) {
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
    },

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
      const fields = {
        status: "completed" as const,
        conclusion: check.conclusion,
        completed_at: new Date().toISOString(),
        output: { title: check.title, summary: check.summary },
        ...(detailsUrl ? { details_url: detailsUrl } : {}),
        ...(check.externalId ? { external_id: check.externalId } : {}),
      };
      if (existing) await octokit.rest.checks.update({ ...repoParams(repo), check_run_id: existing.id, ...fields });
      else await octokit.rest.checks.create({ ...repoParams(repo), name: CHECK_NAME, head_sha: headSha, ...fields });
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

    async removeLabel(repo, number, label) {
      try {
        await api(repo).rest.issues.removeLabel({ ...repoParams(repo), issue_number: number, name: label });
      } catch (error) {
        if (!isNotFound(error)) throw error;
      }
    },

    async findRepo(repoId) {
      if (!installed.has(repoId) && Date.now() - listedAt > RELIST_AFTER_MS) {
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
  };
}

interface RestItem {
  number: number;
  user: { login: string } | null;
  created_at: string;
  labels: (string | { name?: string })[];
}

function itemFields(repo: Repo, data: RestItem): ItemFields {
  return {
    repo,
    number: data.number,
    author: data.user?.login ?? "ghost",
    createdAt: new Date(data.created_at),
    labels: data.labels.map((label) => (typeof label === "string" ? label : (label.name ?? ""))),
  };
}

function isNotFound(error: unknown): boolean {
  const status = (error as { status?: number } | null)?.status;
  return status === 404 || status === 410;
}
