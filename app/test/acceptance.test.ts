import { expect, test } from "vitest";
import { createAcceptance, type Act } from "../src/acceptance.ts";
import type { Closing, GitHub, Item, ItemFacts, Permission, PullRequest, Repo } from "../src/ports.ts";

// Whether a Maintainer accepted a PR or issue, for the check, the Keeper's early Refund and a
// Contributor's record, against a GitHub that answers who can push, who added a label and who
// approved. Each case also says which of those GitHub reads it took, since each costs a request.

const REPO: Repo = { owner: "acme", name: "widgets", installationId: 1 };
const AUTHOR = "newcomer";
const ACCESS: Record<string, Permission> = { mo: "write", ada: "admin", triager: "read", pusher: "write" };
const OK = "bona-fide:ok";
const BAD_FAITH = "bona-fide:bad-faith";
const WAIVER = "bona-fide:waive";

interface Answers {
  /** Who last added each label. */
  labelers?: Record<string, string | null>;
  approvers?: string[];
}

function acceptanceWith({ labelers = {}, approvers = [] }: Answers = {}) {
  const reads: string[] = [];
  const github: Pick<GitHub, "permissionOf" | "labeledBy" | "approvers"> = {
    async permissionOf(_repo, login) {
      reads.push(`permission ${login}`);
      return ACCESS[login.toLowerCase()] ?? "none";
    },
    async labeledBy(_repo, _number, label) {
      reads.push(`labeledBy ${label}`);
      return labelers[label] ?? null;
    },
    async approvers() {
      reads.push("approvers");
      return approvers;
    },
  };
  return { acceptance: createAcceptance(github), reads };
}

function itemOf(kind: "pr" | "issue", labels: string[] = []): Item {
  const fields = { repo: REPO, number: 7, author: AUTHOR, createdAt: new Date(0), labels };
  return kind === "pr" ? { ...fields, kind, headSha: "abc" } : { ...fields, kind };
}

const noBadFaith = { name: "Marked bad faith", value: "no" };

test.each([
  { name: "no label", labels: [], by: "mo", accepted: null, reads: [] },
  {
    name: "the label added by someone with write access",
    labels: [OK],
    by: "mo",
    accepted: { witnesses: [{ name: "Label", value: OK }, noBadFaith] },
    reads: [`labeledBy ${OK}`, "permission mo"],
  },
  {
    name: "the label added by an admin",
    labels: [OK],
    by: "ada",
    accepted: { witnesses: [{ name: "Label", value: OK }, noBadFaith] },
    reads: [`labeledBy ${OK}`, "permission ada"],
  },
  {
    name: "the label added by someone with triage access",
    labels: [OK],
    by: "triager",
    accepted: null,
    reads: [`labeledBy ${OK}`, "permission triager"],
  },
  { name: "the label added by a deleted account", labels: [OK], by: null, accepted: null, reads: [`labeledBy ${OK}`] },
  // The check passes; the Keeper still holds the Deposit (markedBadFaith).
  {
    name: "the label on an item marked bad faith",
    labels: [OK, BAD_FAITH],
    by: "mo",
    accepted: {
      witnesses: [
        { name: "Label", value: OK },
        { name: "Marked bad faith", value: "yes" },
      ],
    },
    reads: [`labeledBy ${OK}`, "permission mo"],
  },
])("the check, by label: $name", async ({ labels, by, accepted, reads }) => {
  const { acceptance, reads: read } = acceptanceWith({ labelers: { [OK]: by } });

  expect(await acceptance.ofLabel(itemOf("pr", labels))).toEqual(accepted);
  expect(read).toEqual(reads);
});

test.each([
  { name: "absent", labels: [], by: "mo", added: false, reads: [] },
  {
    name: "added by someone who can push",
    labels: [WAIVER],
    by: "mo",
    added: true,
    reads: [`labeledBy ${WAIVER}`, "permission mo"],
  },
  {
    name: "added by someone with triage access",
    labels: [WAIVER],
    by: "triager",
    added: false,
    reads: [`labeledBy ${WAIVER}`, "permission triager"],
  },
])(
  "a label such as the Waiver, $name, is a Maintainer's only when they can push",
  async ({ labels, by, added, reads }) => {
    const { acceptance, reads: read } = acceptanceWith({ labelers: { [WAIVER]: by } });

    expect(await acceptance.maintainerAdded(itemOf("issue", labels), WAIVER)).toBe(added);
    expect(read).toEqual(reads);
  },
);

test.each([
  {
    name: "someone with write access approves",
    approvers: ["mo"],
    labels: [],
    accepted: {
      approver: "mo",
      access: "write",
      witnesses: [{ name: "Approved by", value: "@mo, with write access" }, noBadFaith],
    },
    reads: ["approvers", "permission mo"],
  },
  {
    name: "the first approver who can push counts",
    approvers: ["triager", "ada"],
    labels: [],
    accepted: {
      approver: "ada",
      access: "admin",
      witnesses: [{ name: "Approved by", value: "@ada, with admin access" }, noBadFaith],
    },
    reads: ["approvers", "permission triager", "permission ada"],
  },
  {
    name: "only someone with triage access approves",
    approvers: ["triager"],
    labels: [],
    accepted: null,
    reads: ["approvers", "permission triager"],
  },
  { name: "nobody approves", approvers: [], labels: [], accepted: null, reads: ["approvers"] },
  { name: "the PR is marked bad faith", approvers: ["mo"], labels: [BAD_FAITH], accepted: null, reads: [] },
])("the check, by approval: $name", async ({ approvers, labels, accepted, reads }) => {
  const { acceptance, reads: read } = acceptanceWith({ approvers });
  const pr: PullRequest = {
    repo: REPO,
    number: 7,
    author: AUTHOR,
    createdAt: new Date(0),
    labels,
    kind: "pr",
    headSha: "abc",
  };

  expect(await acceptance.ofApproval(pr)).toEqual(accepted);
  expect(read).toEqual(reads);
});

const merged = (by: string | null): Closing => ({ type: "merged", by });
const closed = (reason: string | null, by: string | null): Closing => ({ type: "closed", reason, by });
const labelled = (label: string, by: string | null): Act => ({ type: "labelled", label, by });
const mergedBy = (by: string) => [
  { name: "Merged", value: "yes" },
  { name: "Merged by", value: `@${by}` },
];

test.each([
  { name: "a PR merged", kind: "pr", labels: [], act: merged("mo"), witnesses: mergedBy("mo"), reads: [] },
  // Differs from the record: only someone who can push can merge, so whoever merged, it refunds.
  {
    name: "a PR its author merged",
    kind: "pr",
    labels: [],
    act: merged(AUTHOR),
    witnesses: mergedBy(AUTHOR),
    reads: [],
  },
  // Differs from a completion and the label: bad faith never holds back a merge.
  {
    name: "a PR marked bad faith, merged",
    kind: "pr",
    labels: [BAD_FAITH],
    act: merged("mo"),
    witnesses: mergedBy("mo"),
    reads: [],
  },
  { name: "a PR closed unmerged", kind: "pr", labels: [], act: closed(null, "mo"), witnesses: null, reads: [] },
  {
    name: "an issue closed as completed by someone else who can push",
    kind: "issue",
    labels: [],
    act: closed("completed", "mo"),
    witnesses: [
      { name: "Closed as", value: "completed" },
      { name: "Closed by", value: "@mo, not the author" },
    ],
    reads: ["permission mo"],
  },
  {
    name: "an issue its author closed as completed",
    kind: "issue",
    labels: [],
    act: closed("completed", "NewComer"),
    witnesses: null,
    reads: [],
  },
  {
    name: "an issue closed as completed by someone with triage access",
    kind: "issue",
    labels: [],
    act: closed("completed", "triager"),
    witnesses: null,
    reads: ["permission triager"],
  },
  {
    name: "an issue closed as not planned",
    kind: "issue",
    labels: [],
    act: closed("not_planned", "mo"),
    witnesses: null,
    reads: [],
  },
  {
    name: "an issue marked bad faith, closed as completed",
    kind: "issue",
    labels: [BAD_FAITH],
    act: closed("completed", "mo"),
    witnesses: null,
    reads: [],
  },
  {
    name: "an issue closed as completed by nobody GitHub names",
    kind: "issue",
    labels: [],
    act: closed("completed", null),
    witnesses: null,
    reads: [],
  },
  {
    name: "the label added by someone who can push",
    kind: "issue",
    labels: [OK],
    act: labelled(OK, "mo"),
    witnesses: [
      { name: "Label", value: OK },
      { name: "Labelled by", value: "@mo" },
    ],
    reads: ["permission mo"],
  },
  {
    name: "the label added by someone with triage access",
    kind: "pr",
    labels: [OK],
    act: labelled(OK, "triager"),
    witnesses: null,
    reads: ["permission triager"],
  },
  {
    name: "the label on an item marked bad faith",
    kind: "pr",
    labels: [OK, BAD_FAITH],
    act: labelled(OK, "mo"),
    witnesses: null,
    reads: [],
  },
  { name: "another label", kind: "pr", labels: [], act: labelled("bug", "mo"), witnesses: null, reads: [] },
] as const)("the Keeper's early Refund: $name", async ({ kind, labels, act, witnesses, reads }) => {
  const { acceptance, reads: read } = acceptanceWith();

  expect(await acceptance.ofAct(itemOf(kind, [...labels]), act)).toEqual(witnesses && { witnesses });
  expect(read).toEqual(reads);
});

function factsOf(closing: Closing | null, { labels = [] as string[], author = AUTHOR } = {}): ItemFacts {
  return { author, authorId: 1, labels, closing, closedAt: null };
}

test.each([
  { name: "a PR merged", facts: factsOf(merged("mo")), counts: true, reads: ["permission newcomer"] },
  // Differs from the Refund: a record counts only work someone else accepted.
  { name: "a PR its author merged", facts: factsOf(merged("NewComer")), counts: false, reads: [] },
  {
    name: "a PR merged by nobody GitHub names",
    facts: factsOf(merged(null)),
    counts: true,
    reads: ["permission newcomer"],
  },
  {
    name: "a PR merged in a repo its author can push to",
    facts: factsOf(merged("mo"), { author: "pusher" }),
    counts: false,
    reads: ["permission pusher"],
  },
  // Differs from the Refund: a record doesn't look at bad faith.
  {
    name: "a PR marked bad faith, merged",
    facts: factsOf(merged("mo"), { labels: [BAD_FAITH] }),
    counts: true,
    reads: ["permission newcomer"],
  },
  { name: "a PR closed unmerged", facts: factsOf(closed(null, null)), counts: false, reads: [] },
  {
    name: "an issue closed as completed by someone else who can push",
    facts: factsOf(closed("completed", "mo")),
    counts: true,
    reads: ["permission mo", "permission newcomer"],
  },
  {
    name: "an issue marked bad faith, closed as completed",
    facts: factsOf(closed("completed", "mo"), { labels: [BAD_FAITH] }),
    counts: true,
    reads: ["permission mo", "permission newcomer"],
  },
  {
    name: "an issue its author closed as completed",
    facts: factsOf(closed("completed", AUTHOR)),
    counts: false,
    reads: [],
  },
  {
    name: "an issue closed as completed by someone with triage access",
    facts: factsOf(closed("completed", "triager")),
    counts: false,
    reads: ["permission triager"],
  },
  {
    name: "an issue closed as not planned",
    facts: factsOf(closed("not_planned", "mo")),
    counts: false,
    reads: [],
  },
  {
    name: "an issue closed as completed by nobody GitHub names",
    facts: factsOf(closed("completed", null)),
    counts: false,
    reads: [],
  },
  {
    name: "the label added by someone who can push",
    facts: factsOf(null, { labels: [OK] }),
    labeller: "mo",
    counts: true,
    reads: [`labeledBy ${OK}`, "permission mo", "permission newcomer"],
  },
  {
    name: "the label added by someone with triage access",
    facts: factsOf(null, { labels: [OK] }),
    labeller: "triager",
    counts: false,
    reads: [`labeledBy ${OK}`, "permission triager"],
  },
  {
    name: "a PR its author merged, with the label added by someone who can push",
    facts: factsOf(merged(AUTHOR), { labels: [OK] }),
    labeller: "mo",
    counts: true,
    reads: [`labeledBy ${OK}`, "permission mo", "permission newcomer"],
  },
  // Differs from the check and the Refund: an approval alone isn't read, and doesn't count.
  { name: "a PR approved, still open", facts: factsOf(null), approvers: ["mo"], counts: false, reads: [] },
])("a Contributor's record: $name", async ({ facts, labeller = null, approvers = [], counts, reads }) => {
  const { acceptance, reads: read } = acceptanceWith({ labelers: { [OK]: labeller }, approvers });

  expect(await acceptance.forRecord(REPO, 7, facts)).toBe(counts);
  expect(read).toEqual(reads);
});
