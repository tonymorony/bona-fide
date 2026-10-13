import { expect, test } from "vitest";
import { harness } from "./support/harness.ts";
import { HEAD_SHA, ISSUE, NEWCOMER, payload, PR, REPO } from "./support/webhooks.ts";

// PRs and issues opened before a repo's first Binding took effect need no Deposit.

const STARTED = new Date("2026-10-01T12:00:00Z");
const DEPOSITOR = "0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed";

function secondsAfterStart(seconds: number): Date {
  return new Date(STARTED.getTime() + seconds * 1000);
}

function openedPr(at: Date) {
  return payload("pull_request", "opened", { author: NEWCOMER, createdAt: at.toISOString() });
}

test("a PR opened before Bona Fide started here passes, and needs no Deposit", async () => {
  const { github, deliver } = harness({ config: "", startedAt: STARTED });

  await deliver("pull_request", openedPr(secondsAfterStart(-3600)));

  const check = github.checkOn(REPO, HEAD_SHA);
  expect(check).toMatchObject({
    conclusion: "success",
    title: "No Deposit needed: opened before Bona Fide started here",
  });
  expect(check?.summary).toBe("This PR was opened before Bona Fide started in this repo, so it needs no Deposit.");
  expect(check?.detailsUrl).toBeUndefined();
});

test("an issue opened before Bona Fide started here gets no comment and no label", async () => {
  const { github, deliver } = harness({ config: "", startedAt: STARTED });

  await deliver(
    "issues",
    payload("issues", "opened", {
      author: NEWCOMER,
      labels: [],
      createdAt: secondsAfterStart(-3600).toISOString(),
    }),
  );

  expect(github.commentsOn(REPO, ISSUE)).toEqual([]);
  expect(github.labelsOn(REPO, ISSUE)).toEqual([]);
});

// GitHub's clock stamps created_at and Arc's stamps the block, so an item opened up to
// CLOCK_SKEW_SECONDS after the start may have been opened before it.
test.each([
  [-3600, "success"],
  [60, "success"],
  [120, "success"],
  [121, "pending"],
  [3600, "pending"],
])("a PR opened %i s after Bona Fide started here gives %s", async (seconds, conclusion) => {
  const { github, deliver } = harness({ config: "", startedAt: STARTED });

  await deliver("pull_request", openedPr(secondsAfterStart(seconds)));

  expect(github.checkOn(REPO, HEAD_SHA)?.conclusion).toBe(conclusion);
});

test("a later Binding doesn't move the start: a PR opened after the first one still needs a Deposit", async () => {
  const { github, chain, deliver } = harness({ config: "amount: 2\n", startedAt: STARTED });
  chain.activate(REPO, { amount: 2_000_000n }, secondsAfterStart(86_400));

  await deliver("pull_request", openedPr(secondsAfterStart(3600)));

  expect(github.checkOn(REPO, HEAD_SHA)).toMatchObject({
    conclusion: "pending",
    title: "Deposit needed: 2 USDC, refundable",
  });
});

test("a PR opened before Bona Fide started here passes even with a Deposit on it", async () => {
  const { github, chain, deliver } = harness({ config: "", startedAt: STARTED });
  chain.deposit({ repo: REPO, kind: "pr", number: PR, depositor: DEPOSITOR, at: secondsAfterStart(60) });

  await deliver("pull_request", openedPr(secondsAfterStart(-3600)));

  expect(github.checkOn(REPO, HEAD_SHA)?.title).toBe("No Deposit needed: opened before Bona Fide started here");
});
