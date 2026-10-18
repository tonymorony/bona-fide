import { depositRequestIn } from "@bona-fide/sdk";
import { expect, test } from "vitest";
import { ESCROW, harness } from "./support/harness.ts";
import { HEAD_SHA, ISSUE, NEWCOMER, payload, PR, REPO } from "./support/webhooks.ts";

// While the App asks for a Deposit, its check and comment carry a Deposit request an AI agent can
// read, hidden from people; nothing else they say carries one.

const DEPOSITOR = "0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed";
const PR_OPENED_AT = Date.parse("2019-05-15T15:20:33Z");

const ASKED = {
  chainId: ESCROW.chainId,
  escrow: ESCROW.address,
  repo: REPO,
  llmsTxtUrl: "https://bonafide.example/llms.txt",
};

test("a PR's check and comment that ask for a Deposit both carry the request, on a line of its own", async () => {
  const { github, deliver } = harness({ config: "amount: 2.5", binding: { amount: 2_500_000n } });

  await deliver("pull_request", payload("pull_request", "opened", { author: NEWCOMER }));

  const check = github.checkOn(REPO, HEAD_SHA)!;
  const [comment] = github.commentsOn(REPO, PR);
  const request = {
    ...ASKED,
    kind: "pr",
    number: PR,
    amount: 2_500_000n,
    depositUrl: "https://bonafide.example/deposit?repo=Codertocat%2FHello-World&kind=pr&number=2",
  };
  expect(depositRequestIn(check.summary)).toEqual(request);
  expect(depositRequestIn(comment!)).toEqual(request);
  // A blank line before it makes it an HTML block, which GitHub doesn't show.
  expect(check.summary).toMatch(/\n\n<!-- bona-fide:deposit-request \{[^\n]*\} -->$/);
});

test("the amount is the one the escrow takes, the active Binding's, while new terms wait", async () => {
  const { github, deliver } = harness({ config: "amount: 2.5" });

  await deliver("pull_request", payload("pull_request", "opened", { author: NEWCOMER }));

  expect(depositRequestIn(github.checkOn(REPO, HEAD_SHA)!.summary)?.amount).toBe(1_000_000n);
});

test("an issue's comment that asks for a Deposit carries the request", async () => {
  const { github, deliver } = harness({ config: "" });

  await deliver("issues", payload("issues", "opened", { author: NEWCOMER, labels: [] }));

  expect(depositRequestIn(github.commentsOn(REPO, ISSUE)[0]!)).toEqual({
    ...ASKED,
    kind: "issue",
    number: ISSUE,
    amount: 1_000_000n,
    depositUrl: "https://bonafide.example/deposit?repo=Codertocat%2FHello-World&kind=issue&number=1",
  });
});

test("once the Deposit lands, the check and the comment edited in place carry no request", async () => {
  const { github, chain, deliver } = harness({ config: "" });
  await deliver("pull_request", payload("pull_request", "opened", { author: NEWCOMER }));

  chain.deposit({ repo: REPO, kind: "pr", number: PR, depositor: DEPOSITOR, at: new Date(PR_OPENED_AT + 60_000) });
  await deliver("pull_request", payload("pull_request", "reopened", { author: NEWCOMER }));

  expect(github.checkOn(REPO, HEAD_SHA)?.summary).not.toContain("bona-fide:deposit-request");
  expect(github.commentsOn(REPO, PR)).toHaveLength(1);
  expect(github.commentsOn(REPO, PR)[0]).not.toContain("bona-fide:deposit-request");
});

test("an issue's comment edited once a Maintainer waives it carries no request", async () => {
  const { github, deliver } = harness({ config: "" });
  await deliver("issues", payload("issues", "opened", { author: NEWCOMER, labels: [] }));
  const waive = "bona-fide:waive";

  await deliver("issues", payload("issues", "labeled", { author: NEWCOMER, label: waive, labels: [waive] }));

  const [comment] = github.commentsOn(REPO, ISSUE);
  expect(comment).toContain("No Deposit needed: a Maintainer waived it");
  expect(comment).not.toContain("bona-fide:deposit-request");
});

test.each([
  ["an exempt author", { config: "" }, "mo", "No Deposit needed: @mo is a collaborator"],
  ["a repo that isn't live yet", { config: "", binding: null }, NEWCOMER, "No Deposit needed: not set up here yet"],
  ["a config that needs a fix", { config: "amount: lots" }, NEWCOMER, "Paused: .github/bona-fide.yml needs a fix"],
] as const)("the check for %s carries no request", async (_, options, author, title) => {
  const { github, deliver } = harness(options);
  github.setPermission(REPO, "mo", "write");

  await deliver("pull_request", payload("pull_request", "opened", { author }));

  const check = github.checkOn(REPO, HEAD_SHA);
  expect(check?.title).toBe(title);
  expect(check?.summary).not.toContain("bona-fide:deposit-request");
  expect(github.commentsOn(REPO, PR).join("\n")).not.toContain("bona-fide:deposit-request");
});
