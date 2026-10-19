import { expect, test } from "vitest";
import { createApp } from "../src/app.ts";
import type { Item } from "../src/ports.ts";
import { DEPOSIT_PAGE, harness, SETUP_PAGE } from "./support/harness.ts";
import { HEAD_SHA, HELLO_WORLD, NEWCOMER, payload, PR, REPO } from "./support/webhooks.ts";

const DEPOSITOR = "0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed";
const PR_OPENED_AT = Date.parse("2019-05-15T15:20:33Z");

test("a PR whose Deposit is on-chain passes, shows who paid and links the Deposit on Arc's explorer", async () => {
  const { github, chain, deliver } = harness({ config: "" });
  const { txHash } = chain.deposit({
    repo: REPO,
    kind: "pr",
    number: PR,
    depositor: DEPOSITOR,
    at: new Date(PR_OPENED_AT + 60_000),
  });

  await deliver("pull_request", payload("pull_request", "reopened", { author: NEWCOMER }));

  const check = github.checkOn(REPO, HEAD_SHA);
  expect(check).toMatchObject({ conclusion: "success", title: "Deposit received from 0x5aAe…eAed" });
  expect(check?.summary).toBe(
    `${DEPOSITOR} paid the refundable Deposit of **1 USDC** for this PR. It's refunded in full when this PR is merged or accepted, or when the Timeout ends, unless a Maintainer signs a Forfeit before then.\n\n` +
      `[View the Deposit on Arc](https://explorer.arc.io/tx/${txHash})`,
  );
});

test("when the Deposit lands, the PR's comment is edited to say so", async () => {
  const { github, chain, deliver } = harness({ config: "" });
  await deliver("pull_request", payload("pull_request", "opened", { author: NEWCOMER }));
  expect(github.commentsOn(REPO, PR)[0]).toContain("**Deposit needed: 1 USDC, refundable**");

  chain.deposit({ repo: REPO, kind: "pr", number: PR, depositor: DEPOSITOR, at: new Date(PR_OPENED_AT + 60_000) });
  await deliver("pull_request", payload("pull_request", "reopened", { author: NEWCOMER }));

  const comments = github.commentsOn(REPO, PR);
  expect(comments).toHaveLength(1);
  expect(comments[0]).toContain("**Deposit received from 0x5aAe…eAed**");
  expect(comments[0]).not.toContain("Make the Deposit");
});

test("the Deposit's link goes to the explorer the App is given, such as testnet's", async () => {
  const { github, chain, deliver } = harness({ config: "", explorerUrl: "https://explorer.testnet.arc.io" });
  const { txHash } = chain.deposit({
    repo: REPO,
    kind: "pr",
    number: PR,
    depositor: DEPOSITOR,
    at: new Date(PR_OPENED_AT + 60_000),
  });

  await deliver("pull_request", payload("pull_request", "reopened", { author: NEWCOMER }));

  expect(github.checkOn(REPO, HEAD_SHA)?.summary).toContain(
    `[View the Deposit on Arc](https://explorer.testnet.arc.io/tx/${txHash})`,
  );
});

test("a Deposit made before the PR was opened is ignored", async () => {
  const { github, chain, deliver } = harness({ config: "" });
  chain.deposit({ repo: REPO, kind: "pr", number: PR, depositor: DEPOSITOR, at: new Date(PR_OPENED_AT - 600_000) });

  await deliver("pull_request", payload("pull_request", "opened", { author: NEWCOMER }));

  expect(github.checkOn(REPO, HEAD_SHA)?.conclusion).toBe("pending");
});

test("a Deposit in the same second the PR was opened counts", async () => {
  const { github, chain, deliver } = harness({ config: "" });
  chain.deposit({ repo: REPO, kind: "pr", number: PR, depositor: DEPOSITOR, at: new Date(PR_OPENED_AT) });

  await deliver("pull_request", payload("pull_request", "opened", { author: NEWCOMER }));

  expect(github.checkOn(REPO, HEAD_SHA)?.conclusion).toBe("success");
});

// GitHub's clock stamps created_at and Arc's stamps the block, so they may disagree a little.
test.each([
  [120, "success"],
  [121, "pending"],
])("a Deposit whose block is %i s older than the PR gives %s", async (seconds, conclusion) => {
  const { github, chain, deliver } = harness({ config: "" });
  const at = new Date(PR_OPENED_AT - seconds * 1000);
  chain.deposit({ repo: REPO, kind: "pr", number: PR, depositor: DEPOSITOR, at });

  await deliver("pull_request", payload("pull_request", "opened", { author: NEWCOMER }));

  expect(github.checkOn(REPO, HEAD_SHA)?.conclusion).toBe(conclusion);
});

test("a Deposit for an issue with the same number doesn't count for the PR", async () => {
  const { github, chain, deliver } = harness({ config: "" });
  chain.deposit({ repo: REPO, kind: "issue", number: PR, depositor: DEPOSITOR, at: new Date(PR_OPENED_AT + 60_000) });

  await deliver("pull_request", payload("pull_request", "reopened", { author: NEWCOMER }));

  expect(github.checkOn(REPO, HEAD_SHA)?.conclusion).toBe("pending");
});

test("a Deposit reported by a separate watcher while the App asks for one still ends green", async () => {
  const { github, chain, deliver } = harness({ config: "" });
  const watcherProcess = createApp({ github, chain, depositPageUrl: DEPOSIT_PAGE, setupPageUrl: SETUP_PAGE });
  const item: Item = {
    repo: HELLO_WORLD,
    kind: "pr",
    number: PR,
    author: NEWCOMER,
    createdAt: new Date(PR_OPENED_AT),
    labels: [],
    headSha: HEAD_SHA,
  };
  chain.afterRead = async () => {
    chain.afterRead = undefined;
    const event = chain.deposit({
      repo: REPO,
      kind: "pr",
      number: PR,
      depositor: DEPOSITOR,
      at: new Date(PR_OPENED_AT + 1000),
    });
    await watcherProcess.settle(item, event);
  };

  await deliver("pull_request", payload("pull_request", "opened", { author: NEWCOMER }));

  expect(github.checkOn(REPO, HEAD_SHA)).toMatchObject({
    conclusion: "success",
    title: "Deposit received from 0x5aAe…eAed",
  });
});
