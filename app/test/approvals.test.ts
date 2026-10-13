import { expect, test } from "vitest";
import { harness } from "./support/harness.ts";
import { HEAD_SHA, NEWCOMER, payload, PR, REPO, review } from "./support/webhooks.ts";

// An approval from someone who can push accepts a PR like the bona-fide:ok label: the check passes
// and names who approved, and the Keeper refunds the Deposit (see keeper-refunds.anvil.test.ts).

test.each(["write", "admin"] as const)(
  "a PR approved by someone with %s access passes, naming who approved it",
  async (permission) => {
    const { github, deliver } = harness({ config: "" });
    github.setPermission(REPO, "mo", permission);
    github.approve(REPO, PR, "mo");

    const response = await deliver("pull_request_review", review("approved", "mo", { author: NEWCOMER }));

    expect(response.status).toBe(200);
    expect(github.checkOn(REPO, HEAD_SHA)).toMatchObject({
      conclusion: "success",
      title: "No Deposit needed: @mo approved it",
      summary: "@mo, who can push to this repo, approved this PR, so it needs no Deposit.",
    });
  },
);

test.each(["read", "none"] as const)("an approval from someone with %s access accepts nothing", async (permission) => {
  const { github, deliver } = harness({ config: "" });
  github.setPermission(REPO, "passerby", permission);
  github.approve(REPO, PR, "passerby");

  await deliver("pull_request_review", review("approved", "passerby", { author: NEWCOMER }));

  expect(github.checkOn(REPO, HEAD_SHA)?.conclusion).toBe("action_required");
});

test("any approval from someone who can push is enough, whoever else approved", async () => {
  const { github, deliver } = harness({ config: "" });
  github.setPermission(REPO, "mo", "write");
  github.approve(REPO, PR, "passerby");
  github.approve(REPO, PR, "mo");

  await deliver("pull_request_review", review("approved", "mo", { author: NEWCOMER }));

  expect(github.checkOn(REPO, HEAD_SHA)?.title).toBe("No Deposit needed: @mo approved it");
});

test("an approval is ignored while the PR is marked bad faith", async () => {
  const { github, deliver } = harness({ config: "" });
  github.setPermission(REPO, "mo", "write");
  github.approve(REPO, PR, "mo");

  await deliver("pull_request_review", review("approved", "mo", { author: NEWCOMER, labels: ["bona-fide:bad-faith"] }));

  expect(github.checkOn(REPO, HEAD_SHA)?.conclusion).toBe("action_required");
});

test("a denounced Contributor's check fails even when the PR is approved", async () => {
  const { github, deliver } = harness({ config: "" });
  github.setFile(REPO, "VOUCHED.td", "-newcomer\n");
  github.setPermission(REPO, "mo", "write");
  github.approve(REPO, PR, "mo");

  await deliver("pull_request_review", review("approved", "mo", { author: NEWCOMER }));

  expect(github.checkOn(REPO, HEAD_SHA)?.conclusion).toBe("failure");
});

test.each(["commented", "changes_requested"])("a review that is %s doesn't re-check the PR", async (state) => {
  const { github, deliver } = harness({ config: "" });
  github.setPermission(REPO, "mo", "write");

  await deliver("pull_request_review", review(state, "mo", { author: NEWCOMER }));

  expect(github.checkOn(REPO, HEAD_SHA)).toBeUndefined();
});

test("after an approval, a push keeps the check green without a Deposit", async () => {
  const { github, deliver } = harness({ config: "" });
  github.setPermission(REPO, "mo", "write");
  github.approve(REPO, PR, "mo");

  await deliver("pull_request", payload("pull_request", "synchronize", { author: NEWCOMER }));

  expect(github.checkOn(REPO, HEAD_SHA)).toMatchObject({
    conclusion: "success",
    title: "No Deposit needed: @mo approved it",
  });
});
