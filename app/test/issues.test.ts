import { expect, test } from "vitest";
import { harness } from "./support/harness.ts";
import { ISSUE, NEWCOMER, payload, REPO } from "./support/webhooks.ts";

const DEPOSIT_LINK = "https://bonafide.example/deposit?repo=Codertocat%2FHello-World&kind=issue&number=1";
const REQUIRED = "bona-fide:deposit-required";

test("an issue from someone new gets one comment asking for the Deposit, and the label", async () => {
  const { github, deliver } = harness({ config: "" });

  await deliver("issues", payload("issues", "opened", { author: NEWCOMER, labels: [] }));

  const comments = github.commentsOn(REPO, ISSUE);
  expect(comments).toEqual([
    [
      "**Deposit needed: 1 USDC, refundable**",
      "",
      "This repo asks for a refundable Deposit of **1 USDC** on this issue.",
      "",
      "- **Accepted:** refunded in full.",
      "- **Not accepted within 7 days:** refunded in full.",
      "- **Bad faith, signed by a Maintainer:** up to 50% funds open-source maintainers (Protocol Guild), and the rest is refunded.",
      "",
      "Nobody else gets any of it: not the Maintainers, and not Bona Fide.",
      "",
      `**[Make the Deposit](${DEPOSIT_LINK})**, or ask a Maintainer to vouch for you.`,
      "",
      "This comment updates within seconds of the Deposit.",
    ].join("\n"),
  ]);
  expect(github.labelsOn(REPO, ISSUE)).toContain(REQUIRED);
});

test("reopening the issue doesn't add a second comment", async () => {
  const { github, deliver } = harness({ config: "" });
  await deliver("issues", payload("issues", "opened", { author: NEWCOMER, labels: [] }));

  await deliver("issues", payload("issues", "reopened", { author: NEWCOMER, labels: [REQUIRED] }));

  expect(github.commentsOn(REPO, ISSUE)).toHaveLength(1);
  expect(github.labelsOn(REPO, ISSUE)).toContain(REQUIRED);
});

test("an exempt Contributor's issue gets no comment and no label", async () => {
  const { github, deliver } = harness({ config: "" });
  github.setFile(REPO, "VOUCHED.td", "newcomer\n");

  await deliver("issues", payload("issues", "opened", { author: NEWCOMER, labels: [] }));

  expect(github.commentsOn(REPO, ISSUE)).toEqual([]);
  expect(github.labelsOn(REPO, ISSUE)).toEqual([]);
});

test("a Waiver edits the comment and removes the label", async () => {
  const { github, deliver } = harness({ config: "" });
  await deliver("issues", payload("issues", "opened", { author: NEWCOMER, labels: [] }));

  await deliver(
    "issues",
    payload("issues", "labeled", { author: NEWCOMER, label: "bona-fide:waive", labels: [REQUIRED, "bona-fide:waive"] }),
  );

  const comments = github.commentsOn(REPO, ISSUE);
  expect(comments).toHaveLength(1);
  expect(comments[0]).toContain("No Deposit needed: a Maintainer waived it");
  expect(github.labelsOn(REPO, ISSUE)).not.toContain(REQUIRED);
});

test("the bona-fide:ok label edits the comment to say the issue was accepted, and removes the label", async () => {
  const { github, deliver } = harness({ config: "" });
  await deliver("issues", payload("issues", "opened", { author: NEWCOMER, labels: [] }));

  await deliver(
    "issues",
    payload("issues", "labeled", { author: NEWCOMER, label: "bona-fide:ok", labels: [REQUIRED, "bona-fide:ok"] }),
  );

  const comments = github.commentsOn(REPO, ISSUE);
  expect(comments).toHaveLength(1);
  expect(comments[0]).toContain("No Deposit needed: a Maintainer accepted it");
  expect(comments[0]).toContain("bona-fide:ok");
  expect(github.labelsOn(REPO, ISSUE)).not.toContain(REQUIRED);
});

test("a denounced Contributor's issue gets a neutral comment and no Deposit offer", async () => {
  const { github, deliver } = harness({ config: "" });
  github.setFile(REPO, "VOUCHED.td", "-newcomer spam\n");

  await deliver("issues", payload("issues", "opened", { author: NEWCOMER, labels: [] }));

  const comments = github.commentsOn(REPO, ISSUE);
  expect(comments).toHaveLength(1);
  expect(comments[0]).toContain("**No Deposit accepted: contact the Maintainers**");
  expect(comments[0]).not.toContain("Make the Deposit");
  expect(github.labelsOn(REPO, ISSUE)).not.toContain(REQUIRED);
});

test("the App's own label doesn't re-run the check", async () => {
  const { github, deliver } = harness({ config: "" });
  await deliver("issues", payload("issues", "opened", { author: NEWCOMER, labels: [] }));
  github.setPermission(REPO, NEWCOMER, "write");

  await deliver("issues", payload("issues", "labeled", { author: NEWCOMER, label: REQUIRED, labels: [REQUIRED] }));

  expect(github.commentsOn(REPO, ISSUE)[0]).toContain("Deposit needed");
});
