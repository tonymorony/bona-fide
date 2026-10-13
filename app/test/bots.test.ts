import { expect, test } from "vitest";
import { harness } from "./support/harness.ts";
import { HEAD_SHA, payload, REPO } from "./support/webhooks.ts";

async function checkFor(author: string, config = "") {
  const { github, deliver } = harness({ config });
  await deliver("pull_request", payload("pull_request", "opened", { author }));
  return github.checkOn(REPO, HEAD_SHA);
}

test.each(["dependabot[bot]", "renovate[bot]", "github-actions[bot]"])("%s is exempt by default", async (bot) => {
  expect(await checkFor(bot)).toMatchObject({
    conclusion: "success",
    title: `No Deposit needed: @${bot} is an allowed bot`,
    summary: `@${bot} is on this repo's list of allowed bots, so this PR needs no Deposit.`,
  });
});

test.each(["Copilot", "devin-ai-integration[bot]"])(
  "any other bot, such as the AI coding agent %s, is asked for a Deposit like anyone else",
  async (bot) => {
    expect(await checkFor(bot)).toMatchObject({
      conclusion: "pending",
      title: "Deposit needed: 1 USDC, refundable",
    });
  },
);

test("a denouncement in VOUCHED.td outranks the bot allowlist", async () => {
  const { github, deliver } = harness({ config: "" });
  github.setFile(REPO, "VOUCHED.td", "-dependabot[bot]\n");

  await deliver("pull_request", payload("pull_request", "opened", { author: "dependabot[bot]" }));

  expect(github.checkOn(REPO, HEAD_SHA)?.conclusion).toBe("failure");
});

test("a bot listed under exempt_bots in the config is exempt, whatever the case of its login", async () => {
  const check = await checkFor("pre-commit-ci[bot]", "exempt_bots:\n  - Pre-Commit-CI[bot]\n  - imgbot[bot]\n");

  expect(check).toMatchObject({
    conclusion: "success",
    title: "No Deposit needed: @pre-commit-ci[bot] is an allowed bot",
  });
});
