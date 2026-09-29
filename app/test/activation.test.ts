import { expect, test, vi } from "vitest";
import type { Item } from "../src/ports.ts";
import { createDepositWatcher } from "../src/watcher.ts";
import { harness } from "./support/harness.ts";
import { HEAD_SHA, HELLO_WORLD, ISSUE, NEWCOMER, payload, PR, REPO } from "./support/webhooks.ts";

const pr: Item = {
  repo: HELLO_WORLD,
  kind: "pr",
  number: PR,
  author: NEWCOMER,
  createdAt: new Date("2019-05-15T15:20:33Z"),
  labels: [],
  headSha: HEAD_SHA,
};

const issue: Item = {
  repo: HELLO_WORLD,
  kind: "issue",
  number: ISSUE,
  author: NEWCOMER,
  createdAt: new Date("2019-05-15T15:20:18Z"),
  labels: [],
};

/** A repo whose Binding isn't active yet, watched by the App. */
async function notLiveYet() {
  const h = harness({ config: "", binding: null });
  const watcher = createDepositWatcher({ chain: h.chain, github: h.github, app: h.app });
  await watcher.tick();
  return { ...h, watcher };
}

test("once a repo's first Binding takes effect, its open PRs pass as opened before, and its open issues get nothing", async () => {
  const { github, chain, deliver, watcher } = await notLiveYet();
  github.addItem(pr);
  github.addItem(issue);
  await deliver("pull_request", payload("pull_request", "opened", { author: NEWCOMER }));
  await deliver("issues", payload("issues", "opened", { author: NEWCOMER, labels: [] }));
  const before = github.checkOn(REPO, HEAD_SHA);

  chain.activate(REPO);
  await watcher.tick();

  expect(before?.conclusion).toBe("neutral");
  expect(github.checkOn(REPO, HEAD_SHA)).toMatchObject({
    conclusion: "success",
    title: "No Deposit needed: opened before Bona Fide started here",
  });
  expect(github.commentsOn(REPO, ISSUE)).toEqual([]);
  expect(github.labelsOn(REPO, ISSUE)).toEqual([]);
});

test("once new terms take effect, open PRs opened since Bona Fide started are asked for the Deposit on them", async () => {
  const { github, chain, app, deliver } = harness({ config: "amount: 2\n" });
  const watcher = createDepositWatcher({ chain, github, app });
  github.addItem(pr);
  await deliver("pull_request", payload("pull_request", "opened", { author: NEWCOMER }));
  await watcher.tick();
  const before = github.checkOn(REPO, HEAD_SHA);

  chain.activate(REPO, { amount: 2_000_000n });
  await watcher.tick();

  expect(before?.title).toBe("Deposit needed: 1 USDC, refundable");
  expect(github.checkOn(REPO, HEAD_SHA)).toMatchObject({
    conclusion: "action_required",
    title: "Deposit needed: 2 USDC, refundable",
  });
});

test("a Binding taking effect checks only the 20 most recently updated open items again, and logs that more are open", async () => {
  const { github, chain, watcher } = await notLiveYet();
  const shaOf = (number: number) => String(number).padStart(40, "0");
  for (let number = 1; number <= 25; number++) github.addItem({ ...pr, number, headSha: shaOf(number) });
  const log = vi.spyOn(console, "log").mockImplementation(() => {});

  chain.activate(REPO);
  await watcher.tick();

  const checked = Array.from({ length: 25 }, (_, i) => i + 1).filter((n) => github.checkOn(REPO, shaOf(n)));
  expect(checked).toEqual(Array.from({ length: 20 }, (_, i) => i + 6));
  expect(log).toHaveBeenCalledWith(expect.stringMatching(/Codertocat\/Hello-World.*20/));
  log.mockRestore();
});
