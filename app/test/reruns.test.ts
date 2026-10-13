import { expect, test } from "vitest";
import type { Item } from "../src/ports.ts";
import { harness } from "./support/harness.ts";
import { HEAD_SHA, HELLO_WORLD, NEWCOMER, payload, PR, REPO, rerun, rerunAll, SUITE } from "./support/webhooks.ts";

const pr: Item = {
  repo: HELLO_WORLD,
  kind: "pr",
  number: PR,
  author: NEWCOMER,
  createdAt: new Date("2019-05-15T15:20:33Z"),
  labels: [],
  headSha: HEAD_SHA,
};

/** A newcomer's PR that was asked for a Deposit, and has since been vouched for. */
async function vouchedAfterTheCheck() {
  const h = harness({ config: "" });
  h.github.addItem(pr);
  await h.deliver("pull_request", payload("pull_request", "opened", { author: NEWCOMER }));
  const asked = h.github.checkOn(REPO, HEAD_SHA);
  h.github.setFile(REPO, "VOUCHED.td", "newcomer\n");
  return { ...h, asked };
}

test("re-running the check on a PR from a fork evaluates the PR again", async () => {
  const { github, deliver, asked } = await vouchedAfterTheCheck();

  await deliver("check_run", rerun({ externalId: asked?.externalId, pullRequests: [] }));

  expect(asked?.conclusion).toBe("pending");
  expect(github.checkOn(REPO, HEAD_SHA)).toMatchObject({
    conclusion: "success",
    title: "No Deposit needed: @newcomer is vouched for",
  });
});

test("a re-run of a check without the PR's number finds the PR GitHub lists on the run", async () => {
  const { github, deliver } = await vouchedAfterTheCheck();

  await deliver("check_run", rerun({ externalId: "", pullRequests: [PR] }));

  expect(github.checkOn(REPO, HEAD_SHA)?.conclusion).toBe("success");
});

test("re-running all checks on a PR from a fork evaluates the PR of the App's run again", async () => {
  const { github, deliver } = await vouchedAfterTheCheck();
  github.addSuite(REPO, SUITE, HEAD_SHA);

  await deliver("check_suite", rerunAll());

  expect(github.checkOn(REPO, HEAD_SHA)).toMatchObject({
    conclusion: "success",
    title: "No Deposit needed: @newcomer is vouched for",
  });
});

test("a re-run of another check changes nothing", async () => {
  const { github, deliver, asked } = await vouchedAfterTheCheck();

  await deliver("check_run", rerun({ checkName: "lint", externalId: asked?.externalId, pullRequests: [PR] }));

  expect(github.checkOn(REPO, HEAD_SHA)?.conclusion).toBe("pending");
});
