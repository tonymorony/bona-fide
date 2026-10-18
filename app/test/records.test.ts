import type { Kind } from "@bona-fide/sdk";
import { expect, test, vi } from "vitest";
import { createRecordIndex, LOOKUPS_PER_TICK, type RecordLink } from "../src/records/records.ts";
import { FakeChain } from "./support/fake-chain.ts";
import { FakeGitHub } from "./support/fake-github.ts";
import { NEWCOMER } from "./support/webhooks.ts";

// A Contributor's Bona Fide record: their Deposits across every repo the App can see, read from the
// escrow's events and linked to them through the author of each PR or issue on GitHub.

const DEPOSITOR = "0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed";

type End = "accepted" | "refunded" | "forfeited" | "active";

function indexed() {
  const github = new FakeGitHub();
  const chain = new FakeChain();
  const saved: RecordLink[] = [];
  const open = (links: RecordLink[] = []) =>
    createRecordIndex({ chain, github, fromBlock: 0n, links, save: (link) => saved.push(link) });
  let next = 100;

  /** A Deposit on a new PR or issue of `author`'s in `repo`, ended as told. */
  function deposit(repo: string, end: End, { author = NEWCOMER, kind = "pr" as Kind } = {}) {
    const number = next++;
    const fields = { repo: repoOf(repo), number, author, createdAt: new Date(0), labels: [] };
    github.addItem(kind === "pr" ? { ...fields, kind, headSha: "abc" } : { ...fields, kind });
    const event = chain.deposit({ repo, kind, number, depositor: DEPOSITOR, at: new Date(60_000) });
    if (end === "accepted") github.accept(repo, kind, number);
    if (end === "accepted" || end === "refunded") chain.refund(event.key);
    if (end === "forfeited") chain.forfeit(event.key);
    return { number, key: event.key };
  }

  function repoOf(fullName: string) {
    const [owner = "", name = ""] = fullName.split("/");
    return { owner, name, installationId: 1, private: false };
  }

  return { github, chain, saved, open, deposit };
}

/** Ticks until every lookup is done. */
async function caughtUp(index: { tick(): Promise<void> }, ticks = 10): Promise<void> {
  for (let i = 0; i < ticks; i++) await index.tick();
}

test("a record counts the Contributor's Deposits by how each ended, across repos", async () => {
  const { github, open, deposit } = indexed();
  github.addRepo("acme/widgets");
  github.addRepo("acme/gadgets");
  github.addRepo("octo/tools");
  deposit("acme/widgets", "accepted");
  deposit("acme/widgets", "accepted", { kind: "issue" });
  deposit("acme/widgets", "refunded");
  deposit("acme/gadgets", "accepted");
  deposit("acme/gadgets", "forfeited");
  deposit("octo/tools", "active");
  deposit("octo/tools", "accepted", { author: "someone-else" });
  const index = open();

  await caughtUp(index);

  expect(index.recordOf("NewComer")).toEqual({
    refunds: 3,
    repos: 2,
    otherRefunds: 1,
    forfeits: 1,
    active: 1,
    forfeitsAnywhere: 1,
    forfeitReposAnywhere: 1,
    complete: true,
  });
  expect(index.recordOf("someone-else")).toMatchObject({ refunds: 1, repos: 1 });
  expect(index.recordOf("stranger")).toMatchObject({ refunds: 0, forfeitsAnywhere: 0, complete: true });
});

test("a private repo's Deposits never show in the counts, but its Forfeit counts anywhere", async () => {
  const { github, open, deposit } = indexed();
  github.addRepo("acme/widgets");
  github.addRepo("acme/secret", 1, true);
  deposit("acme/widgets", "accepted");
  deposit("acme/secret", "accepted");
  deposit("acme/secret", "accepted");
  deposit("acme/secret", "forfeited");
  const index = open();

  await caughtUp(index);

  expect(index.recordOf(NEWCOMER)).toEqual({
    refunds: 1,
    repos: 1,
    otherRefunds: 0,
    forfeits: 0,
    active: 0,
    forfeitsAnywhere: 1,
    forfeitReposAnywhere: 1,
    complete: true,
  });
});

test("a Refund in the Contributor's own repo isn't counted as accepted work", async () => {
  const { github, open, deposit } = indexed();
  github.addRepo("newcomer/playground");
  deposit("newcomer/playground", "accepted");
  const index = open();

  await caughtUp(index);

  expect(index.recordOf(NEWCOMER)).toMatchObject({ refunds: 0, repos: 0, otherRefunds: 1 });
});

test("an item labelled bona-fide:ok counts as accepted when its Deposit is refunded", async () => {
  const { github, chain, open } = indexed();
  github.addRepo("acme/widgets");
  const repo = { owner: "acme", name: "widgets", installationId: 1, private: false };
  github.addItem({
    repo,
    kind: "issue",
    number: 9,
    author: NEWCOMER,
    createdAt: new Date(0),
    labels: ["bona-fide:ok"],
  });
  const event = chain.deposit({
    repo: "acme/widgets",
    kind: "issue",
    number: 9,
    depositor: DEPOSITOR,
    at: new Date(0),
  });
  chain.refund(event.key);
  const index = open();

  await caughtUp(index);

  expect(index.recordOf(NEWCOMER)).toMatchObject({ refunds: 1, otherRefunds: 0 });
});

test("the record follows new Deposits as they are made and end, looking each up again when it ends", async () => {
  const { github, chain, open, deposit } = indexed();
  github.addRepo("acme/widgets");
  const index = open();
  const reads = vi.spyOn(github, "outcomeOf");
  await caughtUp(index);
  const { number, key } = deposit("acme/widgets", "active");

  await caughtUp(index);
  expect(index.recordOf(NEWCOMER)).toMatchObject({ refunds: 0, active: 1 });

  github.accept("acme/widgets", "pr", number);
  chain.refund(key);
  await caughtUp(index);

  expect(index.recordOf(NEWCOMER)).toMatchObject({ refunds: 1, active: 0 });
  expect(reads).toHaveBeenCalledTimes(2);
});

test("links are saved, and after a restart they are read back without asking GitHub again", async () => {
  const { github, saved, open, deposit } = indexed();
  github.addRepo("acme/widgets");
  deposit("acme/widgets", "accepted");
  deposit("acme/widgets", "forfeited");
  const first = open();
  await caughtUp(first);

  const reads = vi.spyOn(github, "outcomeOf");
  const restarted = open([...saved]);
  await caughtUp(restarted);

  // Forfeits are looked up first.
  expect(saved.map((link) => link.outcome)).toEqual(["forfeited", "accepted"]);
  expect(saved[1]).toEqual({
    key: expect.stringMatching(/^0x[0-9a-f]{64}$/),
    serial: "1",
    repo: "acme/widgets",
    private: false,
    author: NEWCOMER,
    authorId: expect.any(Number),
    outcome: "accepted",
  });
  expect(reads).not.toHaveBeenCalled();
  expect(restarted.recordOf(NEWCOMER)).toEqual(first.recordOf(NEWCOMER));
});

test("a saved link of a Deposit that has ended since is looked up again", async () => {
  const { github, chain, saved, open, deposit } = indexed();
  github.addRepo("acme/widgets");
  const { number, key } = deposit("acme/widgets", "active");
  await caughtUp(open());
  github.accept("acme/widgets", "pr", number);
  chain.refund(key);

  const restarted = open([...saved]);
  await caughtUp(restarted);

  expect(restarted.recordOf(NEWCOMER)).toMatchObject({ refunds: 1, active: 0 });
});

test("the record is incomplete until the first scan, and while a Forfeit isn't linked to its Contributor", async () => {
  const { github, open, deposit } = indexed();
  github.addRepo("acme/widgets");
  deposit("acme/widgets", "accepted");
  const { number } = deposit("acme/widgets", "forfeited");
  github.breakItem("pr", number, 1);
  const index = open();
  expect(index.recordOf(NEWCOMER).complete).toBe(false);

  await expect(index.tick()).rejects.toThrow("1 Deposit(s) not linked to their Contributor yet.");
  expect(index.recordOf(NEWCOMER)).toMatchObject({ complete: false, forfeitsAnywhere: 0 });

  await caughtUp(index);
  expect(index.recordOf(NEWCOMER)).toMatchObject({ complete: true, forfeitsAnywhere: 1 });
});

test("catching up looks up a few Deposits a tick, Forfeits first", async () => {
  const { github, open, deposit } = indexed();
  github.addRepo("acme/widgets");
  for (let i = 0; i < 12; i++) deposit("acme/widgets", "accepted");
  deposit("acme/widgets", "forfeited");
  const reads = vi.spyOn(github, "outcomeOf");
  const index = open();

  await index.tick();

  expect(reads).toHaveBeenCalledTimes(LOOKUPS_PER_TICK);
  expect(index.recordOf(NEWCOMER)).toMatchObject({ forfeitsAnywhere: 1, complete: true });
});

test("a Deposit made before its item opened is linked once it ends, and a repo the App can't see adds nothing", async () => {
  const { github, chain, open } = indexed();
  github.addRepo("acme/widgets");
  const early = chain.deposit({ repo: "acme/widgets", kind: "pr", number: 5, depositor: DEPOSITOR, at: new Date(0) });
  const unseen = chain.deposit({ repo: "gone/repo", kind: "pr", number: 1, depositor: DEPOSITOR, at: new Date(0) });
  chain.forfeit(unseen.key);
  const index = open();
  await caughtUp(index);
  const repo = { owner: "acme", name: "widgets", installationId: 1, private: false };
  github.addItem({ repo, kind: "pr", number: 5, author: NEWCOMER, createdAt: new Date(0), labels: [], headSha: "abc" });
  chain.refund(early.key);

  await caughtUp(index);

  expect(index.recordOf(NEWCOMER)).toMatchObject({ refunds: 0, otherRefunds: 1, forfeitsAnywhere: 0, complete: true });
});

test("an item counts once, however many Deposits were made on it, and its others count as other Refunds", async () => {
  const { github, chain, open } = indexed();
  github.addRepo("acme/widgets");
  const repo = { owner: "acme", name: "widgets", installationId: 1, private: false };
  github.addItem({ repo, kind: "pr", number: 7, author: NEWCOMER, createdAt: new Date(0), labels: [], headSha: "abc" });
  for (let i = 0; i < 3; i++) {
    const event = chain.deposit({ repo: "acme/widgets", kind: "pr", number: 7, depositor: DEPOSITOR, at: new Date(0) });
    chain.refund(event.key);
  }
  github.accept("acme/widgets", "pr", 7);
  const index = open();

  await caughtUp(index);

  expect(index.recordOf(NEWCOMER)).toMatchObject({ refunds: 1, repos: 1, otherRefunds: 2 });
});

// Work accepted before the Deposit put nothing at risk, as for old merged PRs in a repo the App
// was installed on later.
test("a Deposit made after its item was merged or closed isn't on accepted work", async () => {
  const { github, chain, open } = indexed();
  github.addRepo("acme/widgets");
  const repo = { owner: "acme", name: "widgets", installationId: 1, private: false };
  for (const [number, closedAt] of [
    [7, new Date("2026-01-01T00:00:00Z")],
    [8, new Date("2026-01-01T00:59:00Z")],
  ] as const) {
    github.addItem({ repo, kind: "pr", number, author: NEWCOMER, createdAt: new Date(0), labels: [], headSha: "abc" });
    github.accept("acme/widgets", "pr", number);
    github.close("acme/widgets", number, closedAt);
    const at = new Date("2026-01-01T01:00:00Z");
    chain.refund(chain.deposit({ repo: "acme/widgets", kind: "pr", number, depositor: DEPOSITOR, at }).key);
  }
  const index = open();

  await caughtUp(index);

  // Within CLOCK_SKEW_SECONDS of the merge, as when both happen at once, it still counts.
  expect(index.recordOf(NEWCOMER)).toMatchObject({ refunds: 1, otherRefunds: 1 });
});

test("a record follows the account through a rename, and whoever takes its old login starts afresh", async () => {
  const { github, chain, open } = indexed();
  github.addRepo("acme/widgets");
  const repo = { owner: "acme", name: "widgets", installationId: 1, private: false };
  const items = [
    { number: 1, author: "old-name", authorId: 7, end: "accepted" },
    { number: 2, author: "old-name", authorId: 7, end: "forfeited" },
    { number: 3, author: "new-name", authorId: 7, end: "accepted" },
    { number: 4, author: "old-name", authorId: 99, end: "accepted" },
  ];
  for (const { number, author, authorId, end } of items) {
    github.addItem({ repo, kind: "pr", number, author, authorId, createdAt: new Date(0), labels: [], headSha: "abc" });
    const event = chain.deposit({ repo: "acme/widgets", kind: "pr", number, depositor: DEPOSITOR, at: new Date(0) });
    if (end === "accepted") github.accept("acme/widgets", "pr", number);
    if (end === "forfeited") chain.forfeit(event.key);
    else chain.refund(event.key);
  }
  const index = open();

  await caughtUp(index);

  expect(index.recordOf("new-name", 7)).toMatchObject({ refunds: 2, forfeitsAnywhere: 1 });
  expect(index.recordOf("old-name", 99)).toMatchObject({ refunds: 1, forfeitsAnywhere: 0 });
});

test("Forfeits anywhere are counted by repo too", async () => {
  const { github, open, deposit } = indexed();
  github.addRepo("acme/widgets");
  github.addRepo("acme/secret", 1, true);
  deposit("acme/widgets", "forfeited");
  deposit("acme/widgets", "forfeited");
  deposit("acme/secret", "forfeited");
  const index = open();

  await caughtUp(index);

  expect(index.recordOf(NEWCOMER)).toMatchObject({ forfeits: 2, forfeitsAnywhere: 3, forfeitReposAnywhere: 2 });
});

test("a link saved before links named the account is looked up again", async () => {
  const { github, saved, open, deposit } = indexed();
  github.addRepo("acme/widgets");
  deposit("acme/widgets", "accepted");
  await caughtUp(open());
  const reads = vi.spyOn(github, "outcomeOf");

  const restarted = open(saved.map(({ authorId: _, ...link }) => link));
  await caughtUp(restarted);

  expect(reads).toHaveBeenCalledTimes(1);
  expect(restarted.recordOf(NEWCOMER, saved[0]!.authorId)).toMatchObject({ refunds: 1 });
});
