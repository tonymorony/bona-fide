import { afterAll, beforeAll, expect, test } from "vitest";
import { createApp } from "../src/app.ts";
import { createEscrowChain } from "../src/escrow.ts";
import { createDepositWatcher, pollDeposits } from "../src/watcher.ts";
import { createWebhookHandler } from "../src/webhook.ts";
import { startAnvil, type Anvil } from "./support/anvil.ts";
import { FakeGitHub } from "./support/fake-github.ts";
import { DEPOSIT_PAGE, SETUP_PAGE } from "./support/harness.ts";
import { HEAD_SHA, HELLO_WORLD, NEWCOMER, payload, PR, REPO, SECRET, signed } from "./support/webhooks.ts";

// The real escrow on anvil and the real chain adapter; only GitHub is faked.

const POLL_MS = 1000;

let anvil: Anvil;

beforeAll(async () => {
  anvil = await startAnvil();
  await anvil.bind(REPO);
}, 120_000);

afterAll(() => anvil?.stop());

function running() {
  const github = new FakeGitHub();
  github.addRepo(REPO);
  github.setFile(REPO, ".github/bona-fide.yml", "");
  const chain = createEscrowChain({ client: anvil.client, escrow: anvil.escrow, fromBlock: anvil.deployBlock });
  const app = createApp({ github, chain, depositPageUrl: DEPOSIT_PAGE, setupPageUrl: SETUP_PAGE });
  const handle = createWebhookHandler({ secret: SECRET, app });
  const errors: unknown[] = [];
  const stop = pollDeposits(createDepositWatcher({ chain, github, app }), POLL_MS, (error) => errors.push(error));
  return { github, handle, errors, stop };
}

async function waitFor(done: () => boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!done() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 25));
}

test("the check turns green within 10 s of the Deposited event", async () => {
  const { github, handle, errors, stop } = running();
  const openedAt = await anvil.now();
  github.addItem({
    repo: HELLO_WORLD,
    kind: "pr",
    number: PR,
    author: NEWCOMER,
    createdAt: openedAt,
    labels: [],
    headSha: HEAD_SHA,
  });
  await handle(
    signed("pull_request", payload("pull_request", "opened", { author: NEWCOMER, createdAt: openedAt.toISOString() })),
  );
  expect(github.checkOn(REPO, HEAD_SHA)?.conclusion).toBe("pending");

  await anvil.deposit(REPO, "pr", PR);
  const confirmed = Date.now();
  await waitFor(() => github.checkOn(REPO, HEAD_SHA)?.conclusion === "success", 10_000);
  const elapsed = Date.now() - confirmed;
  stop();

  console.log(`check green ${elapsed} ms after the Deposit was confirmed (watcher polls every ${POLL_MS} ms)`);
  expect(errors).toEqual([]);
  expect(elapsed).toBeLessThan(10_000);
  // The contributor is anvil's third dev account, 0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC.
  expect(github.checkOn(REPO, HEAD_SHA)?.title).toBe("Deposit received from 0x3C44…93BC");
}, 30_000);

test("a Deposit made before the PR was opened never turns it green", async () => {
  const { github, handle, errors, stop } = running();
  const number = 3;
  const sha = "3333333333333333333333333333333333333333";
  const openedAt = new Date((await anvil.now()).getTime() + 600_000);
  github.addItem({
    repo: HELLO_WORLD,
    kind: "pr",
    number,
    author: NEWCOMER,
    createdAt: openedAt,
    labels: [],
    headSha: sha,
  });

  await anvil.deposit(REPO, "pr", number);
  await new Promise((resolve) => setTimeout(resolve, 2 * POLL_MS));
  await anvil.mine(1, 60);
  const opened = payload("pull_request", "opened", {
    author: NEWCOMER,
    createdAt: openedAt.toISOString(),
    headSha: sha,
  });
  opened.pull_request.number = number;
  await handle(signed("pull_request", opened));
  await new Promise((resolve) => setTimeout(resolve, 2 * POLL_MS));
  stop();

  expect(errors).toEqual([]);
  expect(github.checkOn(REPO, sha)?.conclusion).toBe("pending");
}, 30_000);
