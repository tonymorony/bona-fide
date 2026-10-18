import { repoIdOf, type Kind } from "@bona-fide/sdk";
import type { Hex } from "viem";
import { userIdOf } from "./webhooks.ts";
import type {
  CheckRun,
  Closing,
  ClosingPullRequest,
  CommitCheck,
  GitHub,
  GitHubProfile,
  IssueClosing,
  Item,
  ItemContent,
  ItemFacts,
  Permission,
  PullRequestFacts,
  Repo,
} from "../../src/ports.ts";

interface RepoState {
  repo: Repo;
  files: Map<string, string>;
  permissions: Map<string, Permission>;
  mergedAuthors: Set<string>;
  checks: Map<string, CheckRun>;
  comments: Map<number, { id: number; body: string }[]>;
  labels: Map<number, Set<string>>;
  items: Map<string, Item>;
  notes: Map<number, string>;
  /** Comments posted with addNote, marker first. */
  markedNotes: Map<number, string[]>;
  approvals: Map<number, string[]>;
  contents: Map<string, ItemContent>;
  /** The commit of each of the App's check suites. */
  suites: Map<number, string>;
  /** How items were merged or closed, as itemFacts shows it, by "kind#number". */
  ends: Map<string, Closing>;
  /** What pullRequestFacts answers for each PR. */
  pullRequests: Map<number, PullRequestFacts>;
  /** The check runs and statuses on each commit. */
  commitChecks: Map<string, CommitCheck[]>;
  /** PRs an issue lists as closing it beyond those whose `closes` name it. */
  closingLinks: Map<number, ClosingPullRequest[]>;
  /** How an issue was closed, when not by the first merged PR that closes it. */
  closings: Map<number, { open: boolean; closedBy: number | null }>;
  /** Issues whose closing PRs GitHub lists only in part. */
  incompleteClosing: Set<number>;
  createdAt: Date;
  /** Items closed since they were added. */
  closed: Set<number>;
  /** When items were merged or closed, where it matters. */
  closedAt: Map<number, Date>;
  /** Who added a label to an item, by "number:label", when not the repo's owner. */
  labelers: Map<string, string>;
}

// An in-memory GitHub. It keeps what the App would leave visible on github.com: the latest
// "Bona Fide" check per commit, the App's comments, and each item's labels.
export class FakeGitHub implements GitHub {
  private readonly repos = new Map<string, RepoState>();
  private nextCommentId = 100;
  /** Milliseconds each call waits, like a network round trip, so concurrent work interleaves. */
  latency = 0;
  private readonly broken = new Map<string, number>();
  private readonly profiles = new Map<string, GitHubProfile>();
  /** The logins profileOf was asked about, in order. */
  readonly profileReads: string[] = [];

  addRepo(fullName: string, installationId = 1, isPrivate = false): RepoState {
    const [owner = "", name = ""] = fullName.split("/");
    const state: RepoState = {
      repo: { owner, name, installationId, private: isPrivate },
      files: new Map(),
      permissions: new Map(),
      mergedAuthors: new Set(),
      checks: new Map(),
      comments: new Map(),
      labels: new Map(),
      items: new Map(),
      notes: new Map(),
      markedNotes: new Map(),
      approvals: new Map(),
      contents: new Map(),
      suites: new Map(),
      ends: new Map(),
      pullRequests: new Map(),
      commitChecks: new Map(),
      closingLinks: new Map(),
      closings: new Map(),
      incompleteClosing: new Set(),
      createdAt: new Date(0),
      closed: new Set(),
      closedAt: new Map(),
      labelers: new Map(),
    };
    this.repos.set(fullName.toLowerCase(), state);
    return state;
  }

  hasRepo(fullName: string): boolean {
    return this.repos.has(fullName.toLowerCase());
  }

  setFile(fullName: string, path: string, content: string): void {
    this.state(fullName).files.set(path, content);
  }

  setPermission(fullName: string, login: string, permission: Permission): void {
    this.state(fullName).permissions.set(login.toLowerCase(), permission);
  }

  /** Says `login`, not the repo's owner, added `label` to the item. */
  setLabeler(fullName: string, number: number, label: string, login: string): void {
    this.state(fullName).labelers.set(`${number}:${label}`, login);
  }

  addMergedPullRequest(fullName: string, author: string): void {
    this.state(fullName).mergedAuthors.add(author.toLowerCase());
  }

  addItem(item: Item): void {
    const state = this.state(fullNameOf(item.repo));
    state.items.set(`${item.kind}#${item.number}`, item);
    state.labels.set(item.number, new Set(item.labels));
  }

  /** Closes the PR or issue, at `at` if told. Every item added is open until then. */
  close(fullName: string, number: number, at?: Date): void {
    this.state(fullName).closed.add(number);
    if (at) this.state(fullName).closedAt.set(number, at);
  }

  /** Makes reading the item fail `times` times, as GitHub does for an archived repo. */
  breakItem(kind: Kind, number: number, times = Infinity): void {
    this.broken.set(`${kind}#${number}`, times);
  }

  checkOn(fullName: string, sha: string): CheckRun | undefined {
    return this.state(fullName).checks.get(sha);
  }

  /** Gives the App's check suite for a commit its id, as GitHub groups an App's runs by commit. */
  addSuite(fullName: string, suiteId: number, headSha: string): void {
    this.state(fullName).suites.set(suiteId, headSha);
  }

  commentsOn(fullName: string, number: number): string[] {
    return (this.state(fullName).comments.get(number) ?? []).map((c) => c.body);
  }

  /** The Keeper's note on an item, if it posted one. */
  noteOn(fullName: string, number: number): string | undefined {
    return this.state(fullName).notes.get(number);
  }

  /** Deletes the item's comments posted with addNote, as a repo admin can. */
  deleteMarkedNotes(fullName: string, number: number): void {
    this.state(fullName).markedNotes.delete(number);
  }

  /** The comments posted with addNote on an item, each with its marker. */
  markedNotesOn(fullName: string, number: number): string[] {
    return this.state(fullName).markedNotes.get(number) ?? [];
  }

  /** Records `login`'s approving review of a PR. */
  approve(fullName: string, number: number, login: string): void {
    const approvals = this.state(fullName).approvals;
    approvals.set(number, [...(approvals.get(number) ?? []), login]);
  }

  /** What contentOf returns for an item: by default a title and a body, and for a PR one file and its diff. */
  setContent(fullName: string, kind: Kind, number: number, content: ItemContent): void {
    this.state(fullName).contents.set(`${kind}#${number}`, content);
  }

  /** Merges the PR, or closes the issue as completed, as `by` did: by default the repo's owner, its admin. */
  accept(fullName: string, kind: Kind, number: number, by = this.state(fullName).repo.owner): void {
    const closing: Closing = kind === "pr" ? { type: "merged", by } : { type: "closed", reason: "completed", by };
    this.state(fullName).ends.set(`${kind}#${number}`, closing);
  }

  /** The public profile profileOf answers for `login`. Without one, the account doesn't exist. */
  setProfile(login: string, profile: GitHubProfile): void {
    this.profiles.set(login.toLowerCase(), profile);
  }

  /** What pullRequestFacts answers for the PR. Its `closes` also link it to those issues. */
  setPullRequest(fullName: string, facts: PullRequestFacts): void {
    this.state(fullName).pullRequests.set(facts.number, facts);
  }

  /** Makes the issue list a PR as closing it, whatever the PR's own facts say. */
  linkClosing(fullName: string, issue: number, pr: ClosingPullRequest): void {
    const links = this.state(fullName).closingLinks;
    links.set(issue, [...(links.get(issue) ?? []), pr]);
  }

  /** Says how the issue was closed: by default, by the first merged PR that closes it, and open without one. */
  setClosing(fullName: string, issue: number, closing: { open: boolean; closedBy: number | null }): void {
    this.state(fullName).closings.set(issue, closing);
  }

  /** Makes GitHub list the issue's closing PRs only in part. */
  truncateClosing(fullName: string, issue: number): void {
    this.state(fullName).incompleteClosing.add(issue);
  }

  /** When the repo was created. By default, at the epoch, before any Binding. */
  setRepoCreatedAt(fullName: string, at: Date): void {
    this.state(fullName).createdAt = at;
  }

  /** The check runs and statuses on a commit. A commit without any has none. */
  setChecks(fullName: string, sha: string, checks: CommitCheck[]): void {
    this.state(fullName).commitChecks.set(sha, checks);
  }

  labelsOn(fullName: string, number: number): string[] {
    return [...(this.state(fullName).labels.get(number) ?? [])];
  }

  async readFile(repo: Repo, path: string): Promise<string | null> {
    await this.roundTrip();
    return this.state(fullNameOf(repo)).files.get(path) ?? null;
  }

  // As on GitHub, the owner of a user's repo is its admin.
  async permissionOf(repo: Repo, login: string): Promise<Permission> {
    await this.roundTrip();
    const set = this.state(fullNameOf(repo)).permissions.get(login.toLowerCase());
    return set ?? (login.toLowerCase() === repo.owner.toLowerCase() ? "admin" : "none");
  }

  async hasMergedPullRequest(repo: Repo, login: string): Promise<boolean> {
    await this.roundTrip();
    return this.state(fullNameOf(repo)).mergedAuthors.has(login.toLowerCase());
  }

  async setCheck(repo: Repo, headSha: string, check: CheckRun): Promise<void> {
    await this.roundTrip();
    this.state(fullNameOf(repo)).checks.set(headSha, check);
  }

  async findOwnComment(repo: Repo, number: number): Promise<number | null> {
    await this.roundTrip();
    return this.state(fullNameOf(repo)).comments.get(number)?.[0]?.id ?? null;
  }

  async createComment(repo: Repo, number: number, body: string): Promise<void> {
    await this.roundTrip();
    const comments = this.state(fullNameOf(repo)).comments;
    comments.set(number, [...(comments.get(number) ?? []), { id: this.nextCommentId++, body }]);
  }

  async updateComment(repo: Repo, commentId: number, body: string): Promise<void> {
    await this.roundTrip();
    for (const list of this.state(fullNameOf(repo)).comments.values()) {
      const comment = list.find((c) => c.id === commentId);
      if (comment) {
        comment.body = body;
        return;
      }
    }
    throw new Error(`no comment ${commentId}`);
  }

  async addLabel(repo: Repo, number: number, label: string): Promise<void> {
    await this.roundTrip();
    const labels = this.state(fullNameOf(repo)).labels;
    labels.set(number, new Set([...(labels.get(number) ?? []), label]));
  }

  async labeledBy(repo: Repo, number: number, label: string): Promise<string | null> {
    await this.roundTrip();
    return this.state(fullNameOf(repo)).labelers.get(`${number}:${label}`) ?? repo.owner;
  }

  async removeLabel(repo: Repo, number: number, label: string): Promise<void> {
    await this.roundTrip();
    this.state(fullNameOf(repo)).labels.get(number)?.delete(label);
  }

  async findRepo(repoId: Hex): Promise<Repo | null> {
    await this.roundTrip();
    for (const [fullName, state] of this.repos) {
      if (repoIdOf(fullName) === repoId) return state.repo;
    }
    return null;
  }

  async getItem(repo: Repo, kind: Kind, number: number): Promise<Item | null> {
    await this.roundTrip();
    const failures = this.broken.get(`${kind}#${number}`) ?? 0;
    if (failures > 0) {
      this.broken.set(`${kind}#${number}`, failures - 1);
      throw Object.assign(new Error("Repository was archived so is read-only."), { status: 403 });
    }
    const state = this.state(fullNameOf(repo));
    const item = state.items.get(`${kind}#${number}`);
    return item ? { ...item, labels: [...(state.labels.get(number) ?? [])] } : null;
  }

  async isOpenIssue(repo: Repo, number: number): Promise<boolean> {
    const issue = await this.getItem(repo, "issue", number);
    return issue !== null && !this.state(fullNameOf(repo)).closed.has(number);
  }

  async postNote(repo: Repo, number: number, body: string): Promise<void> {
    await this.roundTrip();
    this.state(fullNameOf(repo)).notes.set(number, body);
  }

  async hasNote(repo: Repo, number: number, marker: string): Promise<boolean> {
    await this.roundTrip();
    return (this.state(fullNameOf(repo)).markedNotes.get(number) ?? []).some((body) => body.startsWith(marker));
  }

  async addNote(repo: Repo, number: number, marker: string, body: string): Promise<void> {
    await this.roundTrip();
    const notes = this.state(fullNameOf(repo)).markedNotes;
    notes.set(number, [...(notes.get(number) ?? []), `${marker}\n${body}`]);
  }

  async approvers(repo: Repo, number: number): Promise<string[]> {
    await this.roundTrip();
    return this.state(fullNameOf(repo)).approvals.get(number) ?? [];
  }

  async contentOf(item: Item): Promise<ItemContent> {
    await this.roundTrip();
    const content = this.state(fullNameOf(item.repo)).contents.get(`${item.kind}#${item.number}`);
    if (content) return content;
    const text = { title: "Fix a typo in the README", body: "It said teh.", repoDescription: "My first repo" };
    if (item.kind === "issue") return text;
    const diff = "--- a/README.md\n+++ b/README.md\n@@ -1 +1 @@\n-teh\n+the\n";
    return { ...text, files: { listed: [{ path: "README.md", additions: 1, deletions: 1 }], total: 1 }, diff };
  }

  /** Every item added is open, and the last one added counts as the most recently updated. */
  async openItems(repo: Repo, max: number): Promise<{ items: { kind: Kind; number: number }[]; more: boolean }> {
    await this.roundTrip();
    const open = [...this.state(fullNameOf(repo)).items.values()].reverse();
    return { items: open.slice(0, max).map(({ kind, number }) => ({ kind, number })), more: open.length > max };
  }

  async suitePullRequests(repo: Repo, suiteId: number): Promise<number[]> {
    await this.roundTrip();
    const state = this.state(fullNameOf(repo));
    const sha = state.suites.get(suiteId);
    const number = Number(sha === undefined ? undefined : state.checks.get(sha)?.externalId);
    return Number.isSafeInteger(number) && number > 0 ? [number] : [];
  }

  async itemFacts(repo: Repo, kind: Kind, number: number): Promise<ItemFacts | null> {
    const item = await this.getItem(repo, kind, number);
    if (!item) return null;
    const state = this.state(fullNameOf(repo));
    return {
      author: item.author,
      authorId: item.authorId ?? this.idOf(item.author),
      labels: item.labels,
      closing: state.ends.get(`${kind}#${number}`) ?? null,
      closedAt: state.closedAt.get(number) ?? null,
    };
  }

  private idOf(login: string): number {
    return userIdOf(login);
  }

  async profileOf(_repo: Repo, login: string): Promise<GitHubProfile | null> {
    await this.roundTrip();
    this.profileReads.push(login);
    return this.profiles.get(login.toLowerCase()) ?? null;
  }

  async pullRequestFacts(repo: Repo, number: number): Promise<PullRequestFacts | null> {
    await this.roundTrip();
    const facts = this.state(fullNameOf(repo)).pullRequests.get(number);
    return facts ? structuredClone(facts) : null;
  }

  async closingPullRequests(repo: Repo, issueNumber: number): Promise<IssueClosing> {
    await this.roundTrip();
    const state = this.state(fullNameOf(repo));
    const linked = [...state.pullRequests.values()]
      .filter((pr) => pr.closes.includes(issueNumber))
      .map((pr) => ({ number: pr.number, mergedAt: pr.mergedAt }));
    const prs = [...linked, ...(state.closingLinks.get(issueNumber) ?? [])];
    const [first] = prs
      .filter((pr) => pr.mergedAt !== null)
      .sort((a, b) => a.mergedAt!.getTime() - b.mergedAt!.getTime() || a.number - b.number);
    const closing = state.closings.get(issueNumber) ?? { open: !first, closedBy: first?.number ?? null };
    return { prs, complete: !state.incompleteClosing.has(issueNumber), ...closing };
  }

  async repoCreatedAt(repo: Repo): Promise<Date | null> {
    await this.roundTrip();
    return this.state(fullNameOf(repo)).createdAt;
  }

  async checksOf(repo: Repo, sha: string): Promise<CommitCheck[]> {
    await this.roundTrip();
    return this.state(fullNameOf(repo)).commitChecks.get(sha) ?? [];
  }

  private async roundTrip(): Promise<void> {
    if (this.latency > 0) await new Promise((resolve) => setTimeout(resolve, this.latency));
  }

  private state(fullName: string): RepoState {
    const state = this.repos.get(fullName.toLowerCase());
    if (!state) throw new Error(`unknown repo ${fullName}`);
    return state;
  }
}

function fullNameOf(repo: Repo): string {
  return `${repo.owner}/${repo.name}`;
}
