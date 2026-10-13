import { expect, test } from "vitest";
import type { FakeGitHub } from "./support/fake-github.ts";
import { harness } from "./support/harness.ts";
import { HEAD_SHA, NEWCOMER, payload, REPO } from "./support/webhooks.ts";

const DEPOSIT_LINK = "https://bonafide.example/deposit?repo=Codertocat%2FHello-World&kind=pr&number=2";

test("a PR from someone new gets a check asking for the Deposit", async () => {
  const { github, deliver } = harness({ config: "" });

  await deliver("pull_request", payload("pull_request", "opened", { author: NEWCOMER }));

  const check = github.checkOn(REPO, HEAD_SHA);
  expect(check).toMatchObject({
    conclusion: "pending",
    title: "Deposit needed: 1 USDC, refundable",
    detailsUrl: DEPOSIT_LINK,
  });
  expect(check?.summary).toBe(
    [
      "This repo asks for a refundable Deposit of **1 USDC** on this PR.",
      "",
      "- **Merged or accepted:** refunded in full.",
      "- **Not merged within 7 days:** refunded in full.",
      "- **Bad faith, signed by a Maintainer:** up to 50% funds open-source maintainers (Protocol Guild), and the rest is refunded.",
      "",
      "Nobody else gets any of it: not the Maintainers, and not Bona Fide.",
      "",
      `**[Make the Deposit](${DEPOSIT_LINK})**, or ask a Maintainer to vouch for you.`,
      "",
      "This check updates within seconds of the Deposit.",
    ].join("\n"),
  );
});

test("a PR that needs a Deposit also gets one comment with the link, since a check sends no email", async () => {
  const { github, deliver } = harness({ config: "" });

  await deliver("pull_request", payload("pull_request", "opened", { author: NEWCOMER }));

  const comments = github.commentsOn(REPO, 2);
  expect(comments).toHaveLength(1);
  expect(comments[0]).toContain("**Deposit needed: 1 USDC, refundable**");
  expect(comments[0]).toContain(`**[Make the Deposit](${DEPOSIT_LINK})**`);
});

test("the comment on a PR is edited in place when the PR gets new commits, never repeated", async () => {
  const { github, deliver } = harness({ config: "" });

  await deliver("pull_request", payload("pull_request", "opened", { author: NEWCOMER }));
  await deliver("pull_request", payload("pull_request", "synchronize", { author: NEWCOMER }));

  expect(github.commentsOn(REPO, 2)).toHaveLength(1);
});

test("a PR that needs no Deposit gets no comment", async () => {
  const { github, deliver } = harness({ config: "" });
  github.setPermission(REPO, "mo", "write");

  await deliver("pull_request", payload("pull_request", "opened", { author: "mo" }));

  expect(github.commentsOn(REPO, 2)).toEqual([]);
});

test.each(["admin", "write"] as const)("a collaborator with %s access passes at once", async (permission) => {
  const { github, deliver } = harness({ config: "" });
  github.setPermission(REPO, "mo", permission);

  await deliver("pull_request", payload("pull_request", "opened", { author: "mo" }));

  expect(github.checkOn(REPO, HEAD_SHA)).toMatchObject({
    conclusion: "success",
    title: "No Deposit needed: @mo is a collaborator",
  });
});

test("read access alone is not an Exemption", async () => {
  const { github, deliver } = harness({ config: "" });
  github.setPermission(REPO, NEWCOMER, "read");

  await deliver("pull_request", payload("pull_request", "opened", { author: NEWCOMER }));

  expect(github.checkOn(REPO, HEAD_SHA)?.conclusion).toBe("pending");
});

test.each(["VOUCHED.td", ".github/VOUCHED.td"])("a Contributor vouched for in %s passes at once", async (path) => {
  const { github, deliver } = harness({ config: "" });
  github.setFile(REPO, path, "# Vouched contributors\nalice\nNewcomer\n");

  await deliver("pull_request", payload("pull_request", "opened", { author: NEWCOMER }));

  expect(github.checkOn(REPO, HEAD_SHA)).toMatchObject({
    conclusion: "success",
    title: "No Deposit needed: @newcomer is vouched for",
  });
});

test.each([
  ["github:newcomer", "success"],
  ["newcomer fixed the docs twice", "success"],
  ["gitlab:newcomer", "pending"],
  ["# newcomer", "pending"],
  ["newcomer2", "pending"],
])("the VOUCHED.td line %j gives %s", async (line, conclusion) => {
  const { github, deliver } = harness({ config: "" });
  github.setFile(REPO, "VOUCHED.td", `alice\n${line}\n`);

  await deliver("pull_request", payload("pull_request", "opened", { author: NEWCOMER }));

  expect(github.checkOn(REPO, HEAD_SHA)?.conclusion).toBe(conclusion);
});

test("someone with a merged PR in the repo passes at once", async () => {
  const { github, deliver } = harness({ config: "" });
  github.addMergedPullRequest(REPO, NEWCOMER);

  await deliver("pull_request", payload("pull_request", "opened", { author: NEWCOMER }));

  expect(github.checkOn(REPO, HEAD_SHA)).toMatchObject({
    conclusion: "success",
    title: "No Deposit needed: @newcomer has a merged PR here",
  });
});

test("a PR opened with the Waiver label passes at once", async () => {
  const { github, deliver } = harness({ config: "" });

  await deliver("pull_request", payload("pull_request", "opened", { author: NEWCOMER, labels: ["bona-fide:waive"] }));

  expect(github.checkOn(REPO, HEAD_SHA)).toMatchObject({
    conclusion: "success",
    title: "No Deposit needed: a Maintainer waived it",
    summary: "A Maintainer added the `bona-fide:waive` label, so this PR needs no Deposit.",
  });
});

test("adding the Waiver label turns the check green, and removing it asks again", async () => {
  const { github, deliver } = harness({ config: "" });
  await deliver("pull_request", payload("pull_request", "opened", { author: NEWCOMER }));

  await deliver(
    "pull_request",
    payload("pull_request", "labeled", {
      author: NEWCOMER,
      label: "bona-fide:waive",
      labels: ["bug", "bona-fide:waive"],
    }),
  );
  expect(github.checkOn(REPO, HEAD_SHA)?.conclusion).toBe("success");

  await deliver(
    "pull_request",
    payload("pull_request", "unlabeled", { author: NEWCOMER, label: "bona-fide:waive", labels: ["bug"] }),
  );
  expect(github.checkOn(REPO, HEAD_SHA)?.conclusion).toBe("pending");
});

test("the bona-fide:ok label passes the check as accepted, a push keeps it, and removing the label asks again", async () => {
  const { github, deliver } = harness({ config: "" });
  await deliver("pull_request", payload("pull_request", "opened", { author: NEWCOMER }));

  await deliver(
    "pull_request",
    payload("pull_request", "labeled", { author: NEWCOMER, label: "bona-fide:ok", labels: ["bona-fide:ok"] }),
  );
  const accepted = github.checkOn(REPO, HEAD_SHA);
  await deliver("pull_request", payload("pull_request", "synchronize", { author: NEWCOMER, labels: ["bona-fide:ok"] }));
  const pushed = github.checkOn(REPO, HEAD_SHA);
  await deliver(
    "pull_request",
    payload("pull_request", "unlabeled", { author: NEWCOMER, label: "bona-fide:ok", labels: [] }),
  );

  expect(accepted).toMatchObject({ conclusion: "success", title: "No Deposit needed: a Maintainer accepted it" });
  expect(accepted?.summary).toBe(
    "A Maintainer accepted this PR with the `bona-fide:ok` label, so it needs no Deposit.",
  );
  expect(accepted?.detailsUrl).toBeUndefined();
  expect(pushed?.conclusion).toBe("success");
  expect(github.checkOn(REPO, HEAD_SHA)?.conclusion).toBe("pending");
});

test("other labels don't re-run the check", async () => {
  const { github, deliver } = harness({ config: "" });
  await deliver("pull_request", payload("pull_request", "opened", { author: NEWCOMER }));
  github.setPermission(REPO, NEWCOMER, "write");

  await deliver(
    "pull_request",
    payload("pull_request", "labeled", { author: NEWCOMER, label: "bug", labels: ["bug"] }),
  );

  expect(github.checkOn(REPO, HEAD_SHA)?.conclusion).toBe("pending");
});

test("a denounced Contributor's PR fails with a neutral message and no Deposit offer", async () => {
  const { github, deliver } = harness({ config: "" });
  github.setFile(REPO, "VOUCHED.td", "alice\n-newcomer Submitted endless AI slop\n");

  await deliver("pull_request", payload("pull_request", "opened", { author: NEWCOMER }));

  const check = github.checkOn(REPO, HEAD_SHA);
  expect(check).toMatchObject({ conclusion: "failure", title: "No Deposit accepted: contact the Maintainers" });
  expect(check?.summary).toContain("The Maintainers of Codertocat/Hello-World can tell you more.");
  expect(check?.detailsUrl).toBeUndefined();
  expect(check?.summary).not.toContain("slop");
  expect(check?.summary).not.toContain("Make the Deposit");
});

test.each([
  ["a collaborator", (g: FakeGitHub) => g.setPermission(REPO, NEWCOMER, "admin"), []],
  ["someone with a merged PR", (g: FakeGitHub) => g.addMergedPullRequest(REPO, NEWCOMER), []],
  ["a Waiver", () => {}, ["bona-fide:waive"]],
  ["an acceptance", () => {}, ["bona-fide:ok"]],
])("denouncement overrides %s", async (_, arrange, labels) => {
  const { github, deliver } = harness({ config: "" });
  github.setFile(REPO, ".github/VOUCHED.td", "-github:newcomer\n");
  arrange(github);

  await deliver("pull_request", payload("pull_request", "opened", { author: NEWCOMER, labels }));

  expect(github.checkOn(REPO, HEAD_SHA)?.conclusion).toBe("failure");
});

test("a reopened PR is checked again", async () => {
  const { github, deliver } = harness({ config: "" });

  await deliver("pull_request", payload("pull_request", "reopened", { author: NEWCOMER }));

  expect(github.checkOn(REPO, HEAD_SHA)?.conclusion).toBe("pending");
});

test("a push to the PR puts the check on the new head commit", async () => {
  const { github, deliver } = harness({ config: "" });
  const newHead = "4f3b2a1c0d9e8f7a6b5c4d3e2f1a0b9c8d7e6f5a";

  await deliver("pull_request", payload("pull_request", "synchronize", { author: NEWCOMER, headSha: newHead }));

  expect(github.checkOn(REPO, newHead)?.conclusion).toBe("pending");
});

test("without .github/bona-fide.yml the App does nothing", async () => {
  const { github, deliver } = harness();

  const res = await deliver("pull_request", payload("pull_request", "opened", { author: NEWCOMER }));

  expect(res.status).toBe(200);
  expect(github.checkOn(REPO, HEAD_SHA)).toBeUndefined();
});
