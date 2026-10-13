import type { Hex } from "viem";
import { repoIdOf, type Kind } from "../../src/keys.ts";
import type {
  CheckRun,
  GitHub,
  GitHubProfile,
  Item,
  ItemContent,
  ItemOutcome,
  Permission,
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
  /** Items merged, or closed as completed by someone other than their author. */
  accepted: Set<string>;
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
      accepted: new Set(),
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

  addMergedPullRequest(fullName: string, author: string): void {
    this.state(fullName).mergedAuthors.add(author.toLowerCase());
  }

  addItem(item: Item): void {
    const state = this.state(fullNameOf(item.repo));
    state.items.set(`${item.kind}#${item.number}`, item);
    state.labels.set(item.number, new Set(item.labels));
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

  /** Marks the item merged, or closed as completed by someone else, as its outcome shows it. */
  accept(fullName: string, kind: Kind, number: number): void {
    this.state(fullName).accepted.add(`${kind}#${number}`);
  }

  /** The public profile profileOf answers for `login`. Without one, the account doesn't exist. */
  setProfile(login: string, profile: GitHubProfile): void {
    this.profiles.set(login.toLowerCase(), profile);
  }

  labelsOn(fullName: string, number: number): string[] {
    return [...(this.state(fullName).labels.get(number) ?? [])];
  }

  async readFile(repo: Repo, path: string): Promise<string | null> {
    await this.roundTrip();
    return this.state(fullNameOf(repo)).files.get(path) ?? null;
  }

  async permissionOf(repo: Repo, login: string): Promise<Permission> {
    await this.roundTrip();
    return this.state(fullNameOf(repo)).permissions.get(login.toLowerCase()) ?? "none";
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

  async outcomeOf(repo: Repo, kind: Kind, number: number): Promise<ItemOutcome | null> {
    const item = await this.getItem(repo, kind, number);
    if (!item) return null;
    const accepted = this.state(fullNameOf(repo)).accepted.has(`${kind}#${number}`);
    return { author: item.author, accepted: accepted || item.labels.includes("bona-fide:ok") };
  }

  async profileOf(_repo: Repo, login: string): Promise<GitHubProfile | null> {
    await this.roundTrip();
    this.profileReads.push(login);
    return this.profiles.get(login.toLowerCase()) ?? null;
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
