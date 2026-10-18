import { bountyFactoryAbi, bountyWalletAbi, PAYOUT_TYPES, repoIdOf } from "@bona-fide/sdk";
import { createPublicClient, createWalletClient, getAbiItem, http, maxUint256, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { afterAll, beforeAll, expect, test } from "vitest";
import { createApp } from "../src/app.ts";
import { bountyMarkers, createBounties } from "../src/bounties/bounties.ts";
import { createBountyNotices } from "../src/bounties/posted.ts";
import { createBountyWallets } from "../src/bounties/wallet.ts";
import { createDecisionLog } from "../src/decisions/log.ts";
import { createEscrowChain } from "../src/escrow.ts";
import { createKeeperRoutes } from "../src/keeper/routes.ts";
import type { Decision, ResolutionRequest } from "../src/ports.ts";
import { createWebhookHandler } from "../src/webhook.ts";
import { artifact, POLLING_INTERVAL, type Anvil } from "./support/anvil.ts";
import { BOUNTY_PAGE, closedPr, mergedPr, PAYEE, text } from "./support/bounties.ts";
import { FakeGitHub } from "./support/fake-github.ts";
import { FakeModel, resolution } from "./support/fake-model.ts";
import { DEPOSIT_PAGE, SETUP_PAGE } from "./support/harness.ts";
import { CLIENT_IP, startKeeperAnvil } from "./support/keeper.ts";
import { HELLO_WORLD, NEWCOMER, REPO, SECRET, signed } from "./support/webhooks.ts";

// Bounties against the real BountyWalletFactory and BountyWallet on anvil, paid with the Keeper's
// key; only GitHub and the model are faked. The Maintainer's wallet pays the Keeper up to 10 USDC
// per payout and 15 USDC per day.

const PER_PAYOUT = 10_000_000n;
const PER_PERIOD = 15_000_000n;
const DAY = 86_400;
/** The wallet's Status and Method enums. */
const PAID = 2;
const BY_KEEPER = 0;
const BY_SIGNATURE = 1;

let anvil: Anvil;
let keeperKey: Hex;
let factory: Address;
let wallet: Address;

beforeAll(async () => {
  ({ anvil, keeperKey } = await startKeeperAnvil());
  await anvil.bind(REPO);
  factory = await anvil.deployArtifact("BountyWalletFactory", [anvil.usdc, anvil.keeper]);
  const factoryArtifact = artifact("BountyWalletFactory");
  await anvil.send(anvil.maintainer, factory, factoryArtifact.abi, "create", [
    repoIdOf(REPO),
    PER_PAYOUT,
    PER_PERIOD,
    DAY,
  ]);
  wallet = await anvil.client.readContract({
    address: factory,
    abi: bountyFactoryAbi,
    functionName: "walletOf",
    args: [repoIdOf(REPO), anvil.maintainer],
  });
  const usdc = artifact("MockUSDC");
  const walletArtifact = artifact("BountyWallet");
  await anvil.mint(anvil.maintainer, 100_000_000n);
  await anvil.send(anvil.maintainer, anvil.usdc, usdc.abi, "approve", [wallet, maxUint256]);
  await anvil.send(anvil.maintainer, wallet, walletArtifact.abi, "fund", [100_000_000n]);
}, 120_000);

afterAll(() => anvil?.stop());

async function postBounty(issue: number, amount: bigint): Promise<bigint> {
  await anvil.send(anvil.maintainer, wallet, artifact("BountyWallet").abi, "postBounty", [BigInt(issue), amount]);
  return (await bountyOf(issue)).serial;
}

function bountyOf(issue: number) {
  return anvil.client.readContract({
    address: wallet,
    abi: bountyWalletAbi,
    functionName: "bountyOf",
    args: [BigInt(issue)],
  });
}

async function paidEvents(issue: number) {
  return anvil.client.getLogs({
    address: wallet,
    event: getAbiItem({ abi: bountyWalletAbi, name: "Paid" }),
    args: { issueNumber: BigInt(issue) },
    fromBlock: 0n,
    strict: true,
  });
}

function harness() {
  const github = new FakeGitHub();
  github.addRepo(REPO);
  github.setFile(REPO, ".github/bona-fide.yml", "");
  const client = createPublicClient({ transport: http(anvil.url), pollingInterval: POLLING_INTERVAL });
  const chain = createEscrowChain({ client, escrow: anvil.escrow, fromBlock: anvil.deployBlock });
  const wallets = createBountyWallets({
    client,
    account: privateKeyToAccount(keeperKey),
    factory,
    fromBlock: anvil.deployBlock,
  });
  const model = new FakeModel<ResolutionRequest>();
  /** Every decision appended to the log. */
  const logged: Decision[] = [];
  const bounties = createBounties({
    github,
    chain,
    wallets,
    model,
    bountyPageUrl: BOUNTY_PAGE,
    decisions: createDecisionLog({ write: (decision) => logged.push(decision) }),
  });
  const app = createApp({ github, chain, depositPageUrl: DEPOSIT_PAGE, setupPageUrl: SETUP_PAGE });
  const handle = createWebhookHandler({ secret: SECRET, app, bounties });
  const routes = createKeeperRoutes({} as never, { bounties });

  /** A merged PR by the newcomer that closes `issue`, delivered once its facts are on GitHub. */
  async function merge(pr: number, issue: number) {
    const facts = mergedPr({
      number: pr,
      closes: [issue],
      headSha: String(pr).padStart(40, "0"),
      body: text(`Fixes #${issue}.\n\nBounty wallet: ${PAYEE}`),
    });
    github.setPullRequest(REPO, facts);
    github.setChecks(REPO, facts.headSha, [{ name: "test", state: "success" }]);
    await handle(signed("pull_request", closedPr(facts)));
    await bounties.idle();
    return facts;
  }

  const post = (body: unknown) =>
    routes(new Request("https://app.example/bounty/payout", { method: "POST", body: JSON.stringify(body) }), CLIENT_IP);

  return { github, chain, wallets, model, logged, merge, post, handle, bounties };
}

/** The Maintainer's EIP-712 Payout, signed by one of anvil's unlocked accounts. */
async function signPayout(
  signer: Address,
  message: { issueNumber: bigint; serial: bigint; payee: Address; amount: bigint; deadline: bigint },
): Promise<Hex> {
  return createWalletClient({ transport: http(anvil.url), pollingInterval: POLLING_INTERVAL }).signTypedData({
    account: signer,
    domain: {
      name: "BonaFide Bounty",
      version: "1",
      chainId: await anvil.client.getChainId(),
      verifyingContract: wallet,
    },
    types: PAYOUT_TYPES,
    primaryType: "Payout",
    message,
  });
}

async function inAnHour(): Promise<bigint> {
  return BigInt(Math.floor((await anvil.now()).getTime() / 1000) + 3600);
}

test("a merged PR that closes an issue with a Bounty within the limits is paid by the Keeper on-chain, and its notes link the Payout", async () => {
  const { github, model, logged, merge } = harness();
  model.answers = [resolution("resolves")];
  const serial = await postBounty(101, 5_000_000n);
  const before = await anvil.usdcBalance(PAYEE);

  await merge(201, 101);

  expect(await anvil.usdcBalance(PAYEE)).toBe(before + 5_000_000n);
  expect(await bountyOf(101)).toMatchObject({ status: PAID, payee: PAYEE });
  const [paid] = await paidEvents(101);
  expect(paid?.args).toMatchObject({ serial, payee: PAYEE, amount: 5_000_000n, method: BY_KEEPER });
  expect(logged).toEqual([expect.objectContaining({ type: "pay", action: "paid", txHash: paid?.transactionHash })]);
  const marker = bountyMarkers(101, serial).paid;
  for (const number of [201, 101]) {
    expect(github.markedNotesOn(REPO, number)).toEqual([
      expect.stringContaining(`[View the Payout on Arc](https://explorer.arc.io/tx/${paid?.transactionHash})`),
    ]);
    expect(github.markedNotesOn(REPO, number)[0]?.startsWith(marker)).toBe(true);
  }
}, 30_000);

test("a redelivered merge reads the Bounty as paid on-chain and sends nothing", async () => {
  const { model, merge } = harness();
  model.answers = [resolution("resolves")];
  await postBounty(103, 1_000_000n);
  await merge(203, 103);
  const restarted = harness();
  restarted.model.answers = [resolution("resolves")];
  const sent = await anvil.client.getTransactionCount({ address: anvil.keeper });

  await restarted.merge(203, 103);

  expect(await anvil.client.getTransactionCount({ address: anvil.keeper })).toBe(sent);
  expect(restarted.model.requests).toEqual([]);
  expect(await paidEvents(103)).toHaveLength(1);
}, 30_000);

test("a Bounty above the per-payout limit waits for the Maintainer, whose signed Payout the App relays", async () => {
  const { github, model, logged, merge, post } = harness();
  model.answers = [resolution("resolves")];
  const serial = await postBounty(102, 25_000_000n);

  await merge(202, 102);

  expect((await bountyOf(102)).status).not.toBe(PAID);
  expect(model.requests).toEqual([]);
  const held = github.markedNotesOn(REPO, 202)[0];
  expect(held).toContain("25 USDC is above the wallet's per-payout limit of 10 USDC.");
  expect(held).toContain(`[signs the Payout](${BOUNTY_PAGE}?repo=Codertocat%2FHello-World&issue=102&payee=${PAYEE})`);

  const deadline = await inAnHour();
  const message = { issueNumber: 102n, serial, payee: PAYEE, amount: 25_000_000n, deadline };
  const signature = await signPayout(anvil.maintainer, message);
  const before = await anvil.usdcBalance(PAYEE);
  const response = await post({ repo: REPO, issue: 102, payee: PAYEE, deadline: Number(deadline), signature });

  expect(response?.status).toBe(200);
  const { txHash } = (await response?.json()) as { txHash: Hex };
  expect(await anvil.usdcBalance(PAYEE)).toBe(before + 25_000_000n);
  const [paid] = await paidEvents(102);
  expect(paid).toMatchObject({ transactionHash: txHash, args: { method: BY_SIGNATURE, payee: PAYEE } });
  expect(logged.map((d) => [d.type, d.action, d.outcome, d.inputs?.method])).toEqual([
    ["hold", "held: above the per-payout limit", "escalated", "keeper"],
    ["pay", "paid", "escalated", "signature"],
  ]);
  expect(logged[1]?.txHash).toBe(txHash);
  const note = `The Maintainer signed the Payout.\n\n[View the Payout on Arc](https://explorer.arc.io/tx/${txHash})`;
  expect(github.markedNotesOn(REPO, 102)).toEqual([expect.stringContaining(note)]);
  expect(github.markedNotesOn(REPO, 202)).toEqual([held, expect.stringContaining(note)]);
}, 30_000);

test("a Payout signed by anyone but the wallet's owner is refused, and nothing is sent", async () => {
  const { post } = harness();
  const serial = await postBounty(104, 20_000_000n);
  const deadline = await inAnHour();
  const message = { issueNumber: 104n, serial, payee: PAYEE, amount: 20_000_000n, deadline };
  const signature = await signPayout(anvil.contributor, message);
  const sent = await anvil.client.getTransactionCount({ address: anvil.keeper });

  const response = await post({ repo: REPO, issue: 104, payee: PAYEE, deadline: Number(deadline), signature });

  expect(response?.status).toBe(400);
  expect(await response?.json()).toEqual({
    error: `This isn't the Maintainer's signature for this Bounty. Sign it with the Bounty wallet's owner, ${anvil.maintainer}.`,
    code: "bad-signature",
  });
  expect(await anvil.client.getTransactionCount({ address: anvil.keeper })).toBe(sent);
  expect((await bountyOf(104)).status).not.toBe(PAID);
}, 30_000);

test("a Payout for a Bounty already paid, or one never posted, is refused", async () => {
  const { post } = harness();
  await postBounty(105, 1_000_000n);
  await anvil.send(anvil.maintainer, wallet, artifact("BountyWallet").abi, "ownerPay", [105n, PAYEE]);
  const deadline = Number(await inAnHour());
  const signature = `0x${"ab".repeat(65)}`;

  const paid = await post({ repo: REPO, issue: 105, payee: PAYEE, deadline, signature });
  const none = await post({ repo: REPO, issue: 999, payee: PAYEE, deadline, signature });

  expect(paid?.status).toBe(409);
  expect(await paid?.json()).toEqual({ error: "This Bounty was already paid.", code: "resolved" });
  expect(none?.status).toBe(404);
  expect(await none?.json()).toEqual({ error: "There's no Bounty on this issue.", code: "not-found" });
}, 30_000);

test("a Bounty posted on-chain gets one note on its issue, and one from a wallet another account made for the repo doesn't", async () => {
  const { github, chain, wallets } = harness();
  for (const number of [106, 107, 108]) {
    github.addItem({ repo: HELLO_WORLD, kind: "issue", number, author: NEWCOMER, createdAt: new Date(0), labels: [] });
  }
  const notices = createBountyNotices({
    github,
    chain,
    wallets,
    withModel: true,
    bountyPageUrl: BOUNTY_PAGE,
    fromBlock: anvil.deployBlock,
  });
  const walletArtifact = artifact("BountyWallet");
  await anvil.send(anvil.contributor, factory, artifact("BountyWalletFactory").abi, "create", [
    repoIdOf(REPO),
    PER_PAYOUT,
    PER_PERIOD,
    DAY,
  ]);
  const theirs = await anvil.client.readContract({
    address: factory,
    abi: bountyFactoryAbi,
    functionName: "walletOf",
    args: [repoIdOf(REPO), anvil.contributor],
  });
  await anvil.send(anvil.contributor, anvil.usdc, artifact("MockUSDC").abi, "approve", [theirs, maxUint256]);
  await anvil.send(anvil.contributor, theirs, walletArtifact.abi, "fund", [1_000_000n]);
  await anvil.send(anvil.contributor, theirs, walletArtifact.abi, "postBounty", [107n, 1_000_000n]);
  const serial = await postBounty(106, 2_000_000n);

  await notices.tick();
  await notices.tick();

  expect(github.markedNotesOn(REPO, 106)).toEqual([expect.stringContaining("**Bounty: 2 USDC**")]);
  expect(github.markedNotesOn(REPO, 106)[0]?.startsWith(bountyMarkers(106, serial).posted)).toBe(true);
  expect(github.markedNotesOn(REPO, 107)).toEqual([]);

  // Later ticks read the wallets they know of.
  await postBounty(108, 3_000_000n);
  await notices.tick();

  expect(github.markedNotesOn(REPO, 108)).toEqual([expect.stringContaining("**Bounty: 3 USDC**")]);
  expect(github.markedNotesOn(REPO, 106)).toHaveLength(1);
}, 30_000);
