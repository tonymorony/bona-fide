import { repoIdOf } from "@bona-fide/sdk";
import { createWalletClient, http } from "viem";
import { afterAll, beforeAll, expect, test } from "vitest";
import { createApp } from "../src/app.ts";
import { createEscrowChain } from "../src/escrow.ts";
import { createDepositWatcher } from "../src/watcher.ts";
import { createWebhookHandler } from "../src/webhook.ts";
import { POLLING_INTERVAL, startAnvil, type Anvil } from "./support/anvil.ts";
import { FakeGitHub } from "./support/fake-github.ts";
import { DEPOSIT_PAGE, SETUP_PAGE } from "./support/harness.ts";
import { HEAD_SHA, NEWCOMER, payload, PR, SECRET, signed } from "./support/webhooks.ts";

// The real escrow on anvil and the real chain adapter; only GitHub is faked. The App's clock is
// the chain's, which the tests move ahead to wait out the binding delay.

let anvil: Anvil;

beforeAll(async () => {
  anvil = await startAnvil();
}, 120_000);

afterAll(() => anvil?.stop());

/**
 * A newcomer's PR in `repo`, whose .github/bona-fide.yml is `config`. Returns a function that
 * delivers a webhook for the PR and returns its check.
 */
async function pullRequestIn(repo: string, config = "") {
  const github = new FakeGitHub();
  github.addRepo(repo);
  github.setFile(repo, ".github/bona-fide.yml", config);
  const chain = createEscrowChain({ client: anvil.client, escrow: anvil.escrow, fromBlock: anvil.deployBlock });
  const openedAt = await anvil.now();
  const app = createApp({ github, chain, depositPageUrl: DEPOSIT_PAGE, setupPageUrl: SETUP_PAGE, now: () => openedAt });
  const handle = createWebhookHandler({ secret: SECRET, app });
  return async (action = "opened") => {
    const body = payload("pull_request", action, { author: NEWCOMER, repo, createdAt: openedAt.toISOString() });
    await handle(signed("pull_request", body));
    return github.checkOn(repo, HEAD_SHA);
  };
}

test("before the Keeper proposes a Binding, the check is neutral and offers no Deposit", async () => {
  const deliver = await pullRequestIn("bona-fide/unbound");

  const check = await deliver();

  expect(check).toMatchObject({ conclusion: "neutral", title: "No Deposit needed: not set up here yet" });
  expect(check?.summary).toContain("[finish setting up](https://bonafide.example/setup?repo=bona-fide%2Funbound)");
  expect(check?.detailsUrl).toBeUndefined();
});

test("while the Binding waits out its delay, the check says when Bona Fide starts", async () => {
  await anvil.propose("bona-fide/pending");
  const deliver = await pullRequestIn("bona-fide/pending");

  const check = await deliver();

  expect(check).toMatchObject({ conclusion: "neutral", title: "No Deposit needed: starts in about 1 hour" });
  expect(check?.detailsUrl).toBeUndefined();
});

test("once the Binding is active, the check asks for the Deposit", async () => {
  await anvil.bind("bona-fide/active");
  const deliver = await pullRequestIn("bona-fide/active");

  const check = await deliver();

  expect(check).toMatchObject({ conclusion: "pending", title: "Deposit needed: 1 USDC, refundable" });
});

test("the check asks for the active Binding's terms, and the Deposit is exactly that amount", async () => {
  await anvil.bind("bona-fide/terms", { amount: 2_500_000n, forfeitBps: 2000, timeoutSeconds: 1_209_600 });
  const deliver = await pullRequestIn("bona-fide/terms");

  const asked = await deliver();
  const { txHash } = await anvil.deposit("bona-fide/terms", "pr", PR);
  const paid = await deliver("synchronize");

  expect(asked?.title).toBe("Deposit needed: 2.50 USDC, refundable");
  expect(asked?.summary).toContain("Not merged within 14 days");
  expect(asked?.summary).toContain("up to 20% funds open-source maintainers (Protocol Guild)");
  expect(paid?.summary).toContain("paid the refundable Deposit of **2.50 USDC**");
  expect(paid?.summary).toContain(`[View the Deposit on Arc](https://explorer.arc.io/tx/${txHash})`);
}, 30_000);

test("a config the active Binding doesn't match yet says new terms are pending, and when they start once proposed", async () => {
  await anvil.bind("bona-fide/changing");
  const deliver = await pullRequestIn("bona-fide/changing", "amount: 2\n");

  const before = await deliver();
  const proposedAt = await anvil.propose("bona-fide/changing", { amount: 2_000_000n });
  const after = await deliver("synchronize");

  const startsAt = new Date(proposedAt.getTime() + anvil.bindingDelaySeconds * 1000);
  expect(before?.title).toBe("Deposit needed: 1 USDC, refundable");
  expect(before?.summary).toContain("This repo has new terms that aren't in effect yet.");
  expect(after?.title).toBe("Deposit needed: 1 USDC, refundable");
  expect(after?.summary).toContain(
    `This repo's terms change at ${startsAt.toISOString().slice(0, 16).replace("T", " ")} UTC`,
  );
}, 30_000);

test("once anyone activates the Binding, the watcher checks the repo's open PRs again, and those opened before pass", async () => {
  const repo = "bona-fide/activated";
  await anvil.propose(repo);
  const github = new FakeGitHub();
  const { repo: installed } = github.addRepo(repo);
  github.setFile(repo, ".github/bona-fide.yml", "");
  const chain = createEscrowChain({ client: anvil.client, escrow: anvil.escrow, fromBlock: anvil.deployBlock });
  const openedAt = await anvil.now();
  const app = createApp({ github, chain, depositPageUrl: DEPOSIT_PAGE, setupPageUrl: SETUP_PAGE, now: () => openedAt });
  const pr = { repo: installed, number: PR, author: NEWCOMER, createdAt: openedAt, labels: [], headSha: HEAD_SHA };
  github.addItem({ ...pr, kind: "pr" });
  await app.settle({ ...pr, kind: "pr" });
  const watcher = createDepositWatcher({ chain, github, app });
  await watcher.tick();
  const before = github.checkOn(repo, HEAD_SHA);

  await anvil.mine(1, anvil.bindingDelaySeconds);
  const wallet = createWalletClient({ transport: http(anvil.url), pollingInterval: POLLING_INTERVAL });
  const hash = await wallet.writeContract({
    account: anvil.contributor,
    chain: null,
    address: anvil.escrow,
    abi: anvil.escrowAbi,
    functionName: "activateRepo",
    args: [repoIdOf(repo)],
  });
  await anvil.client.waitForTransactionReceipt({ hash });
  await watcher.tick();

  expect(before?.conclusion).toBe("neutral");
  expect(github.checkOn(repo, HEAD_SHA)).toMatchObject({
    conclusion: "success",
    title: "No Deposit needed: opened before Bona Fide started here",
  });
}, 30_000);

// GitHub's clock stamps created_at and Arc's stamps the block, so a PR opened up to
// CLOCK_SKEW_SECONDS after the activation may have been opened before it.
test("a PR opened before the Binding took effect passes, as does one within the clock skew; one opened after it asks for the Deposit", async () => {
  const repo = "bona-fide/grandfathered";
  const github = new FakeGitHub();
  github.addRepo(repo);
  github.setFile(repo, ".github/bona-fide.yml", "");
  const chain = createEscrowChain({ client: anvil.client, escrow: anvil.escrow, fromBlock: anvil.deployBlock });
  const handle = createWebhookHandler({
    secret: SECRET,
    app: createApp({ github, chain, depositPageUrl: DEPOSIT_PAGE, setupPageUrl: SETUP_PAGE }),
  });
  const started = await anvil.bind(repo);
  async function openAt(number: number, secondsAfterStart: number) {
    const headSha = String(number).padStart(40, "0");
    const createdAt = new Date(started.getTime() + secondsAfterStart * 1000).toISOString();
    const body = payload("pull_request", "opened", { author: NEWCOMER, repo, createdAt, headSha });
    body.pull_request.number = number;
    await handle(signed("pull_request", body));
    return github.checkOn(repo, headSha)?.conclusion;
  }

  expect(await openAt(1, -3600)).toBe("success");
  expect(await openAt(2, 60)).toBe("success");
  expect(await openAt(3, 600)).toBe("pending");
}, 30_000);
