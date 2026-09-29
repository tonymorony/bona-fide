import { expect, test } from "vitest";
import { harness } from "./support/harness.ts";
import { HEAD_SHA, ISSUE, NEWCOMER, payload, REPO } from "./support/webhooks.ts";

test("a PR in a repo with no Binding gets a neutral check that points Maintainers to the setup page", async () => {
  const { github, deliver } = harness({ config: "", binding: null });

  await deliver("pull_request", payload("pull_request", "opened", { author: NEWCOMER }));

  const check = github.checkOn(REPO, HEAD_SHA);
  expect(check).toMatchObject({ conclusion: "neutral", title: "No Deposit needed: not set up here yet" });
  expect(check?.summary).toBe(
    "Bona Fide starts asking for Deposits here once a Maintainer finishes setting it up.\n\n" +
      "Maintainers: [finish setting up](https://bonafide.example/setup?repo=Codertocat%2FHello-World).",
  );
  expect(check?.detailsUrl).toBeUndefined();
});

// A PR checked before the repo's first Binding takes effect was opened before Bona Fide started.
test("a PR in a repo whose Binding is pending gets a neutral check saying when Bona Fide starts", async () => {
  const { github, chain, deliver } = harness({ config: "", binding: null, now: new Date("2026-09-27T18:00:00Z") });
  chain.propose(REPO, new Date("2026-09-28T17:10:00Z"));

  await deliver("pull_request", payload("pull_request", "opened", { author: NEWCOMER }));

  const check = github.checkOn(REPO, HEAD_SHA);
  expect(check).toMatchObject({ conclusion: "neutral", title: "No Deposit needed: starts in about 23 hours" });
  expect(check?.summary).toBe(
    "Bona Fide starts in this repo at 2026-09-28 17:10 UTC or shortly after. " +
      "This PR was opened before then, so it won't need a Deposit.",
  );
  expect(check?.detailsUrl).toBeUndefined();
});

test.each([
  ["2026-09-27T19:20:00Z", "No Deposit needed: starts in about 1 hour"],
  ["2026-09-27T18:40:00Z", "No Deposit needed: starts in under an hour"],
  ["2026-09-27T17:55:00Z", "No Deposit needed: starts shortly"],
])("at 18:00 UTC, a Binding that takes effect at %s gives the title %j", async (effectiveAt, title) => {
  const { github, chain, deliver } = harness({ config: "", binding: null, now: new Date("2026-09-27T18:00:00Z") });
  chain.propose(REPO, new Date(effectiveAt));

  await deliver("pull_request", payload("pull_request", "opened", { author: NEWCOMER }));

  expect(github.checkOn(REPO, HEAD_SHA)?.title).toBe(title);
});

test("the check asks for the active Binding's amount, Timeout and forfeit share, which the escrow charges", async () => {
  const { github, deliver } = harness({
    config: "",
    binding: { amount: 2_500_000n, forfeitBps: 2000, timeoutSeconds: 1_209_600 },
  });

  await deliver("pull_request", payload("pull_request", "opened", { author: NEWCOMER }));

  const check = github.checkOn(REPO, HEAD_SHA);
  expect(check?.title).toBe("Deposit needed: 2.50 USDC, refundable");
  expect(check?.summary).toContain("refundable Deposit of **2.50 USDC**");
  expect(check?.summary).toContain("Not merged within 14 days");
  expect(check?.summary).toContain("up to 20% funds open-source maintainers (Protocol Guild)");
});

test("a Timeout that isn't a whole number of days is shown in hours, rounded up", async () => {
  const { github, deliver } = harness({ config: "", binding: { timeoutSeconds: 100_000 } });

  await deliver("pull_request", payload("pull_request", "opened", { author: NEWCOMER }));

  expect(github.checkOn(REPO, HEAD_SHA)?.summary).toContain("Not merged within 28 hours:");
});

test("a config that differs from the active Binding adds a line saying new terms are pending", async () => {
  const { github, deliver } = harness({ config: "amount: 2\n" });

  await deliver("pull_request", payload("pull_request", "opened", { author: NEWCOMER }));

  const check = github.checkOn(REPO, HEAD_SHA);
  expect(check?.title).toBe("Deposit needed: 1 USDC, refundable");
  expect(check?.summary).toContain(
    "\n\nThis repo has new terms that aren't in effect yet. A Deposit made before they are keeps the terms above.\n\n",
  );
});

test("a proposed Binding with terms other than the config's doesn't give the new terms a start time", async () => {
  const { github, chain, deliver } = harness({ config: "amount: 2\n" });
  chain.propose(REPO, new Date("2026-09-28T17:10:00Z"), { amount: 3_000_000n });

  await deliver("pull_request", payload("pull_request", "opened", { author: NEWCOMER }));

  expect(github.checkOn(REPO, HEAD_SHA)?.summary).toContain("This repo has new terms that aren't in effect yet.");
});

test("once the Keeper has proposed the config's new terms, the line says when they start", async () => {
  const { github, chain, deliver } = harness({ config: "amount: 2\n" });
  chain.propose(REPO, new Date("2026-09-28T17:10:00Z"), { amount: 2_000_000n });

  await deliver("pull_request", payload("pull_request", "opened", { author: NEWCOMER }));

  expect(github.checkOn(REPO, HEAD_SHA)?.summary).toContain(
    "This repo's terms change at 2026-09-28 17:10 UTC or shortly after. " +
      "A Deposit made before then keeps the terms above.",
  );
});

test("an issue in a repo whose Binding isn't active yet gets no comment and no label", async () => {
  const { github, chain, deliver } = harness({ config: "", binding: null });
  chain.propose(REPO, new Date("2026-09-28T17:10:00Z"));

  await deliver("issues", payload("issues", "opened", { author: NEWCOMER, labels: [] }));

  expect(github.commentsOn(REPO, ISSUE)).toEqual([]);
  expect(github.labelsOn(REPO, ISSUE)).toEqual([]);
});
