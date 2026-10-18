import { repoIdOf } from "@bona-fide/sdk";
import { mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Address } from "viem";
import { afterAll, beforeAll, expect, test } from "vitest";
import { bountyCalls, createBountyReader } from "../src/bounty.ts";
import { publicClientFor } from "../src/chain.ts";
import { buildPages } from "../build.ts";
import { asWritten, DESKTOP, PHONE, startChrome, type Chrome, type Page, type Viewport } from "./support/chrome.ts";
import { startSite } from "./support/site.ts";
import { startStack, type Stack } from "./support/stack.ts";
import { BINDING, createTestWallet, INJECTED } from "./support/test-wallet.ts";

// The Bounty page and the repo page's Bounties, built for a local Arc with the real Bounty wallet
// factory and driven in headless Chrome with a mock wallet. POST /bounty/payout is the App's: a stub
// relays the signed Payout as the Keeper would, or fails; with no stub, the endpoint isn't there.

let stack: Stack;
let chrome: Chrome;
let site: Awaited<ReturnType<typeof startSite>>;
/** The same pages, built for a network without a Bounty wallet factory. */
let bare: Awaited<ReturnType<typeof startSite>>;
/** Answers POST /bounty/payout, while set. */
let payoutStub: ((body: any) => Promise<Response> | Response) | null = null;
const payoutBodies: unknown[] = [];
/** Acme/Bounties's Bounty wallet, once the first test creates it. */
let acmeWallet: Address;
const PAY_TX = `0x${"7a".repeat(32)}` as const;
const FRAMES = process.env.SCREENSHOTS;

async function frame(page: Page, name: string) {
  if (!FRAMES) return;
  await mkdir(FRAMES, { recursive: true });
  await page.screenshot(join(FRAMES, `${name}.png`));
}

// As the App logs them: about the issue, with the merged PR in `inputs`.
const decisions = {
  counts: { decided: 1, escalated: 1 },
  decisions: [
    {
      id: "hold-1",
      at: "2026-09-06T10:00:00.000Z",
      repo: "Acme/Bounties",
      item: { kind: "issue", number: 12 },
      serial: "2",
      type: "hold",
      inputs: { source: "merge", pr: 52, method: "keeper", titleChars: 22, bodyChars: 310, bodyLeftOut: 0 },
      suggestion: { verdict: "resolves", reasons: ["PR #52 fixes the crash issue #12 describes."] },
      witnesses: [
        { name: "Merged", value: "yes" },
        { name: "Closes the issue", value: "yes: Fixes #12" },
        { name: "Per-payout limit", value: "50 USDC, below the Bounty's 80 USDC" },
      ],
      action: "held: above the per-payout limit",
      txHash: null,
      outcome: "escalated",
      cost: { model: "claude-opus-5", inputTokens: 900, outputTokens: 60, usd: 0.006 },
    },
    {
      id: "pay-1",
      at: "2026-09-05T10:00:00.000Z",
      repo: "Acme/Bounties",
      item: { kind: "issue", number: 7 },
      serial: "1",
      type: "pay",
      inputs: { source: "merge", pr: 51, method: "keeper" },
      suggestion: { verdict: "resolves", reasons: ["PR #51 does what issue #7 asks."] },
      witnesses: [{ name: "Payee wallet", value: "0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed" }],
      action: "paid",
      txHash: PAY_TX,
      outcome: "decided",
      cost: { model: "claude-opus-5", inputTokens: 900, outputTokens: 60, usd: 0.006 },
    },
  ],
};

beforeAll(async () => {
  stack = await startStack();
  const dir = await mkdtemp(join(tmpdir(), "bona-fide-bounty-site-"));
  const bareDir = await mkdtemp(join(tmpdir(), "bona-fide-bare-site-"));
  await buildPages({ network: stack.network, outDir: dir, landing: false });
  await buildPages({ network: { ...stack.network, bountyFactory: "" }, outDir: bareDir, landing: false });
  const endpoint = async (request: Request) => {
    const path = new URL(request.url).pathname;
    if (path === "/decisions") {
      const repo = new URL(request.url).searchParams.get("repo")?.toLowerCase();
      return Response.json(
        repo === "acme/bounties" ? decisions : { counts: { decided: 0, escalated: 0 }, decisions: [] },
      );
    }
    if (path === "/bounty/payout" && payoutStub) {
      const body = JSON.parse(await request.clone().text());
      payoutBodies.push(body);
      return payoutStub(body);
    }
    return null;
  };
  [site, bare] = await Promise.all([startSite({ dir, endpoint }), startSite({ dir: bareDir, endpoint })]);
  chrome = await startChrome();
}, 180_000);

afterAll(async () => {
  await chrome?.stop();
  await site?.stop();
  await bare?.stop();
  stack?.stop();
});

async function walletPage(account: Parameters<typeof createTestWallet>[0]["account"], startChainId?: number) {
  const wallet = createTestWallet({ account, chain: stack.chain, rpcUrl: stack.url, startChainId });
  const page = await chrome.newPage({ binding: BINDING, onBinding: wallet.onBinding, injected: INJECTED });
  return { wallet, page };
}

async function connect(page: Page, state: string) {
  await page.click('[data-action="connect"]');
  await page.click("[data-picker] .wallet-option");
  await page.waitForState(state);
}

/** Types into one of the page's fields. */
async function fill(page: Page, name: string, value: string) {
  await page.evaluate(`document.querySelector('[data-field="${name}"]').value = ${JSON.stringify(value)}`);
}

/** Waits for the card's status slot to say something, and returns it. */
async function statusOf(page: Page, card: string, timeoutMs = 30_000): Promise<string> {
  return page.waitFor<string>(
    `(() => {
      const slot = document.querySelector('[data-status="${card}"]');
      const done = slot && !slot.querySelector(".spinner") && slot.innerText.trim();
      return done || "";
    })()`,
    `the ${card} card's status`,
    timeoutMs,
  );
}

function besides(errors: string[], path: string): string[] {
  return errors.filter((error) => !(error.includes("Failed to load resource") && error.includes(path)));
}

const reader = () => createBountyReader(publicClientFor(stack.network), stack.network);

test("the Maintainer creates the Bounty wallet, funds it, posts and cancels Bounties, and sets its limits", async () => {
  const repo = "Acme/Bounties";
  const maintainer = await stack.account(500_000_000n);
  await stack.bind(repo, { maintainer: maintainer.address });
  const { page, wallet } = await walletPage(maintainer);

  await page.open(site.url(`bounties.html?repo=${repo}`));
  await page.waitForState("no-wallet");
  await frame(page, "bounties-no-wallet-1280");
  expect(await page.text()).toContain("hasn't created one");
  await connect(page, "create");
  await frame(page, "bounties-create-1280");
  expect(await page.evaluate<string>(`document.querySelector('[data-field="per-payout"]').value`)).toBe("50");
  expect(await page.evaluate<string>(`document.querySelector('[data-field="period-limit"]').value`)).toBe("200");
  await page.click('[data-action="create"]');
  await page.waitForState("manage", 30_000);
  const address = (await reader().walletOf(repoIdOf(repo), maintainer.address))!;
  expect(address).toMatch(/^0x/);
  acmeWallet = address;

  await fill(page, "fund-amount", "150");
  await page.click('[data-action="fund-sign"]');
  expect(await statusOf(page, "fund")).toContain("Funded 150 USDC.");
  expect(wallet.log.filter((call) => call.method === "eth_signTypedData_v4")).toHaveLength(1);

  for (const [issue, amount] of [
    ["7", "10"],
    ["12", "80"],
    ["13", "5"],
  ]) {
    await fill(page, "post-issue", issue!);
    await fill(page, "post-amount", amount!);
    await page.click('[data-action="post"]');
    expect(await statusOf(page, "post")).toContain(`on issue #${issue}.`);
  }
  await page.waitFor(`document.querySelectorAll("[data-bounty-rows] tr").length === 3`, "three Bounty rows");
  await page.click('[data-action="cancel-row"][data-issue="13"]');
  expect(await statusOf(page, "bounties")).toContain("Cancelled the Bounty on issue #13.");

  await fill(page, "post-issue", "14");
  await fill(page, "post-amount", "1000");
  await page.click('[data-action="post"]');
  expect(await statusOf(page, "post")).toContain("That's more than the 60 USDC available.");

  await fill(page, "withdraw-amount", "5");
  await page.click('[data-action="withdraw"]');
  expect(await statusOf(page, "withdraw")).toContain("Withdrew 5 USDC");
  // A refusal that quotes the wallet's figures goes once they change.
  expect(await page.evaluate<string>(`document.querySelector('[data-status="post"]').innerText`)).toBe("");

  await fill(page, "per-payout", "60");
  await fill(page, "period-limit", "40");
  await page.click('[data-action="set-limits"]');
  expect(await statusOf(page, "limits")).toContain("The per-payout limit is above the per-period limit");
  await fill(page, "per-payout", "60");
  await fill(page, "period-limit", "300");
  await page.evaluate(`document.querySelector('[data-field="period-length"]').value = "2592000"`);
  await page.click('[data-action="set-limits"]');
  expect(await statusOf(page, "limits")).toContain("Limits saved.");

  await page.click('[data-action="keeper-off"]');
  expect(await statusOf(page, "keeper")).toContain("Keeper payouts are off.");
  await page.waitFor(`!document.querySelector('[data-action="keeper-on"]').hidden`, "the switch back on");
  await page.click('[data-action="keeper-on"]');
  expect(await statusOf(page, "keeper")).toContain("Keeper payouts are on.");
  await page.waitFor(`document.querySelectorAll("[data-bounty-rows] tr").length === 3`, "the Bounty rows");
  await frame(page, "bounties-manage-1280");

  expect(await reader().state(address)).toMatchObject({
    balance: 145_000_000n,
    reserved: 90_000_000n,
    available: 55_000_000n,
    perPayoutLimit: 60_000_000n,
    periodLimit: 300_000_000n,
    periodLength: 30 * 86_400,
    keeperEnabled: true,
  });
  const text = await page.text();
  expect(text).toContain("55 USDC");
  expect(text).toContain("Cancelled");
  expect(text).toContain("300 USDC every 30 days");

  await page.open(site.url(`bounties.html?repo=${repo}`), PHONE);
  await page.waitForState("manage");
  await page.waitFor(`document.querySelectorAll("[data-bounty-rows] tr").length === 3`, "the Bounty rows");
  await frame(page, "bounties-manage-390");
  expect(await page.overflow()).toBeLessThanOrEqual(0);
  expect(page.errors).toEqual([]);
  await page.close();
}, 180_000);

test("only the Binding Maintainer's Bounty wallet is the repo's: another address's wallet never shows", async () => {
  const repo = "Acme/Impostor";
  const maintainer = await stack.account(0n);
  await stack.bind(repo, { maintainer: maintainer.address });
  const stranger = await stack.account(100_000_000n);
  const strangers = await stack.createBountyWallet(stranger, repo);
  await stack.fundAndPost(stranger, strangers, 77_000_000n, [[3, 77_000_000n]]);
  const { page } = await walletPage(stranger);

  await page.open(site.url(`bounties.html?repo=${repo}`));
  await page.waitForState("no-wallet");
  await connect(page, "wrong-wallet");
  await frame(page, "bounties-wrong-wallet-1280");
  let text = await page.text();
  expect(text).toContain("This isn't the Maintainer wallet");
  expect(text).not.toContain("77 USDC");
  expect(await page.evaluate(`document.querySelector('[data-show~="create"]').hidden`)).toBe(true);

  await page.open(site.url(`repo.html?repo=${repo}`));
  await page.waitFor(`!document.querySelector('[data-if="no-bounty-wallet"]').hidden`, "the repo page's Bounties");
  text = await page.text();
  expect(text).toContain("No Bounties here: the Maintainer hasn't set up a Bounty wallet.");
  expect(text).not.toContain("77 USDC");
  expect(page.errors).toEqual([]);
  await page.close();
}, 90_000);

/** A repo whose Maintainer has a funded Bounty wallet with Bounty `issue` posted at `amount`. */
async function postedBounty(repo: string, issue: number, amount: bigint) {
  const maintainer = await stack.account(500_000_000n);
  await stack.bind(repo, { maintainer: maintainer.address });
  const wallet = await stack.createBountyWallet(maintainer, repo);
  await stack.fundAndPost(maintainer, wallet, 200_000_000n, [[issue, amount]]);
  const payee = (await stack.account(0n)).address as Address;
  return { maintainer, wallet, payee };
}

test("a Payout above the limits is signed on the Bounty page and relayed by the App's Keeper", async () => {
  const repo = "Acme/Signed";
  const { maintainer, wallet, payee } = await postedBounty(repo, 12, 80_000_000n);
  const relayer = await stack.account(0n);
  payoutStub = async (body) => {
    const receipt = await stack.sendAs(
      relayer,
      bountyCalls.payWithSignature(wallet, body.issue, body.payee, BigInt(body.deadline), body.signature),
    );
    return Response.json({ txHash: receipt.transactionHash });
  };
  const link = `bounties.html?repo=${repo}&issue=12&payee=${payee}`;

  try {
    const viewer = await chrome.newPage();
    await viewer.open(site.url(link));
    await viewer.waitForState("view");
    await viewer.waitFor(`!document.querySelector('[data-if="payout-connect"]').hidden`, "the Payout to connect for");
    expect(await viewer.text()).toContain("It's above the per-payout limit, 50 USDC.");
    await viewer.close();

    const { page } = await walletPage(maintainer);
    await page.open(site.url(link));
    await connect(page, "manage");
    await page.waitFor(`!document.querySelector('[data-action="pay-owner"]').closest("[hidden]")`, "the pay button");
    await frame(page, "bounties-sign-payout-1280");
    await page.click('[data-action="pay-sign"]');
    expect(await statusOf(page, "pay")).toContain(`Paid 80 USDC to ${payee.slice(0, 6)}`);
    await page.waitFor(`!document.querySelector('[data-if="payout-paid"]').hidden`, "the paid Payout");
    await frame(page, "bounties-payout-paid-1280");

    expect(payoutBodies.at(-1)).toEqual({
      repo,
      issue: 12,
      payee,
      deadline: expect.stringMatching(/^\d+$/),
      signature: expect.stringMatching(/^0x[0-9a-f]{130}$/),
    });
    expect(await stack.usdcBalance(payee)).toBe(80_000_000n);
    expect(await reader().bountyOf(wallet, 12)).toMatchObject({ status: "paid", payee });

    await page.open(site.url(link), PHONE);
    await page.waitForState("manage");
    await page.waitFor(`!document.querySelector('[data-if="payout-paid"]').hidden`, "the paid Payout");
    await frame(page, "bounties-payout-paid-390");
    expect(await page.overflow()).toBeLessThanOrEqual(0);
    expect(page.errors).toEqual([]);
    await page.close();
  } finally {
    payoutStub = null;
  }
}, 120_000);

test("when the App doesn't relay the signed Payout, the Maintainer sends it from their wallet", async () => {
  const repo = "Acme/Unrelayed";
  const { maintainer, wallet, payee } = await postedBounty(repo, 4, 70_000_000n);
  const { page, wallet: testWallet } = await walletPage(maintainer);

  await page.open(site.url(`bounties.html?repo=${repo}&issue=4&payee=${payee.toLowerCase()}`));
  await connect(page, "manage");
  await page.click('[data-action="pay-sign"]');
  await page.waitFor(`!document.querySelector('[data-if="pay-relay-failed"]').hidden`, "the relay's failure");
  await frame(page, "bounties-relay-failed-1280");
  expect(await page.text()).toContain("Bona Fide didn't send the Payout");
  await page.click('[data-action="pay-signed"]');
  expect(await statusOf(page, "pay")).toContain("Paid 70 USDC");

  expect(await reader().bountyOf(wallet, 4)).toMatchObject({ status: "paid", payee });
  const sent = testWallet.log.filter((call) => call.method === "eth_sendTransaction");
  expect(sent).toHaveLength(1);
  expect(besides(page.errors, "/bounty/payout")).toEqual([]);
  await page.close();
}, 90_000);

test("the Maintainer pays a held Bounty directly, and a wrong or broken Payout link says why it can't pay", async () => {
  const repo = "Acme/Direct";
  const { maintainer, wallet, payee } = await postedBounty(repo, 9, 30_000_000n);
  const { page } = await walletPage(maintainer);

  await page.open(site.url(`bounties.html?repo=${repo}&issue=9&payee=${stack.keeper}`));
  await connect(page, "manage");
  await page.waitFor(`!document.querySelector('[data-if="payout-refused-payee"]').hidden`, "the refused payee");
  expect(await page.evaluate(`document.querySelector('[data-if="payout-actions"]').hidden`)).toBe(true);
  await page.open(site.url(`bounties.html?repo=${repo}&issue=9&payee=${payee}`));
  await page.waitForState("manage");
  expect(await page.text()).toContain("It's within your limits. The note on the PR says why the Keeper didn't pay it.");
  expect(await page.text()).toContain("anyone can make a link to this page");
  expect(await page.text()).toContain("From the link. Check it against the wallet the Contributor named on their PR.");
  await page.click('[data-action="pay-owner"]');
  expect(await statusOf(page, "pay")).toContain("Paid 30 USDC");
  expect(await reader().bountyOf(wallet, 9)).toMatchObject({ status: "paid", payee });

  await page.open(site.url(`bounties.html?repo=${repo}&issue=10&payee=${payee}`));
  await page.waitForState("manage");
  await page.waitFor(`!document.querySelector('[data-if="payout-closed"]').hidden`, "no Bounty to pay");
  expect(await page.text()).toContain("Issue #10 has no Bounty in this wallet");

  await page.open(site.url(`bounties.html?repo=${repo}&issue=10&payee=0x1234`));
  await page.waitForState("manage");
  expect(await page.text()).toContain("This Payout link is incomplete");
  expect(page.errors).toEqual([]);
  await page.close();
}, 90_000);

test("without a payee in the link, the Maintainer pastes the Contributor's wallet, checked before anything is sent", async () => {
  const repo = "Acme/No-Payee";
  const { maintainer, wallet, payee } = await postedBounty(repo, 21, 60_000_000n);
  const { page } = await walletPage(maintainer);

  await page.open(site.url(`bounties.html?repo=${repo}&issue=21`));
  await connect(page, "manage");
  await page.waitFor(`!document.querySelector('[data-if="payee-needed"]').hidden`, "the payee field");
  expect(await page.evaluate(`document.querySelector('[data-if="payout-actions"]').hidden`)).toBe(true);
  await frame(page, "bounties-payee-needed-1280");
  for (const wrong of ["0x1234", payee.replace(/[a-f]/, (c) => c.toUpperCase()), stack.keeper, wallet]) {
    if (wrong === payee) continue;
    await fill(page, "payee", wrong);
    await page.click('[data-action="use-payee"]');
    expect(await statusOf(page, "pay")).toMatch(/isn't a wallet address|can't pay that address/);
  }
  await fill(page, "payee", payee.toLowerCase());
  await page.click('[data-action="use-payee"]');
  await page.waitFor(`!document.querySelector('[data-if="payout-actions"]').hidden`, "the pay buttons");
  expect(await page.text()).toContain(payee);
  await page.click('[data-action="pay-owner"]');
  expect(await statusOf(page, "pay")).toContain("Paid 60 USDC");

  expect(await reader().bountyOf(wallet, 21)).toMatchObject({ status: "paid", payee });
  expect(page.errors).toEqual([]);
  await page.close();
}, 90_000);

test("the repo page shows the Bounties from chain, links the Maintainer to manage them, and words Payout decisions", async () => {
  const repo = "Acme/Bounties";
  const payee = (await stack.account(0n)).address as Address;
  await stack.keeperPay(acmeWallet, 7, payee);
  const page = await chrome.newPage();

  await page.open(site.url(`repo.html?repo=${repo}`));
  await page.waitForState("live");
  await page.waitFor(`document.querySelectorAll("[data-bounty-rows] tr").length === 2`, "the Bounty rows");
  await page.waitFor(`document.querySelectorAll("[data-decisions] > li").length === 2`, "the decisions");
  await page.waitFor(`!document.body.innerText.includes("Reading Deposits")`);
  await frame(page, "repo-bounties-1280");
  const section = await page.evaluate<string>(
    asWritten(`document.querySelector('[aria-labelledby="bounties-title"]').innerText`),
  );
  expect(section).toContain("Issue #12");
  expect(section).toContain("80 USDC");
  expect(section).toContain(`Paid\nto ${payee.slice(0, 6)}`);
  expect(section).toContain("by Bona Fide");
  expect(section).toContain("Up to 60 USDC a Bounty, and 300 USDC every 30 days");
  expect(section).not.toContain("Issue #13");
  expect(section).not.toContain("Manage Bounties");
  const decided = await page.evaluate<string[]>(
    asWritten(`[...document.querySelectorAll("[data-decisions] > li")].map((li) => li.innerText)`),
  );
  expect(decided[0]).toContain("Issue #12");
  expect(decided[0]).toContain("Bounty held for PR #52");
  expect(decided[0]).toContain(
    "Paid nothing: it's above the per-payout limit. The Maintainer can pay it from the Bounty page.",
  );
  expect(decided[0]).toContain("Suggested: the PR resolves the issue");
  expect(decided[1]).toContain("Bounty Payout for PR #51");
  expect(decided[1]).toContain("Paid the Bounty in full to its payee.");
  const links = await page.evaluate<string[]>(
    `[...document.querySelectorAll("[data-decisions] a")].map((a) => a.href)`,
  );
  expect(links).toContain(`${stack.network.explorerUrl}/tx/${PAY_TX}`);
  expect(links).toContain("https://github.com/Acme/Bounties/pull/52");
  expect(links).toContain("https://github.com/Acme/Bounties/issues/12");

  await page.open(site.url(`repo.html?repo=${repo}`), PHONE);
  await page.waitFor(`document.querySelectorAll("[data-bounty-rows] tr").length === 2`, "the Bounty rows");
  await page.waitFor(`!document.body.innerText.includes("Reading Deposits")`);
  await frame(page, "repo-bounties-390");
  expect(await page.overflow()).toBeLessThanOrEqual(0);
  expect(page.errors).toEqual([]);
  await page.close();
}, 90_000);

test("the repo page links its Maintainer to the Bounty page, and nobody else", async () => {
  const repo = "Acme/Linked";
  const maintainer = await stack.account(0n);
  await stack.bind(repo, { maintainer: maintainer.address });
  const { page } = await walletPage(maintainer);
  const manage = `document.querySelector('[data-href="bounties-page"]')`;

  await page.open(site.url(`repo.html?repo=${repo}`));
  await page.waitFor(`!document.querySelector('[data-if="no-bounty-wallet"]').hidden`, "the Bounties section");
  expect(await page.evaluate(`${manage}.hidden`)).toBe(true);
  await page.open(site.url(`bounties.html?repo=${repo}`));
  await connect(page, "create");
  await page.open(site.url(`repo.html?repo=${repo}`));
  await page.waitFor(`!${manage}.hidden`, "the Manage Bounties link");
  expect(await page.evaluate<string>(`${manage}.href`)).toBe(site.url(`bounties.html?repo=Acme%2FLinked`));
  expect(page.errors).toEqual([]);
  await page.close();
}, 60_000);

test("a network without a factory, a repo not set up, a wrong network and a broken link each say so", async () => {
  const page = await chrome.newPage();

  await page.open(bare.url("bounties.html?repo=Acme/Bounties"));
  await page.waitForState("no-factory");
  await frame(page, "bounties-no-factory-1280");
  await page.open(bare.url("repo.html?repo=Acme/Bounties"));
  await page.waitForState("live");
  expect(await page.evaluate(`document.querySelector('[data-if="bounties-section"]').hidden`)).toBe(true);
  expect(await page.text()).not.toMatch(/Bounties aren't|No Bounties here/);

  await page.open(site.url("bounties.html?repo=acme/nowhere"));
  await page.waitForState("not-set-up");
  await frame(page, "bounties-not-set-up-1280");
  await page.open(site.url("bounties.html"));
  await page.waitForState("bad-link");
  expect(page.errors).toEqual([]);
  await page.close();

  const other = await walletPage(await stack.account(0n), 1);
  await other.page.open(site.url("bounties.html?repo=Acme/Bounties"));
  await connect(other.page, "wrong-network");
  await frame(other.page, "bounties-wrong-network-1280");
  await other.page.click('[data-action="switch-network"]');
  await other.page.waitForState("wrong-wallet");
  expect(other.page.errors).toEqual([]);
  await other.page.close();
}, 90_000);

const LIGHT_BACKGROUND = "rgb(246, 244, 249)";
const FONTS = ["Big Shoulders Display", "Hanken Grotesk"];
const LOADED_FONTS = `document.fonts.ready.then(() => [...document.fonts].filter((font) => font.status === "loaded").map((font) => font.family.replaceAll('"', "")))`;

const PAGES: [string, string, string][] = [
  ["bounties-view", "bounties.html?repo=Acme/Bounties", "view"],
  ["bounties-none", "bounties.html?repo=Acme/Impostor", "no-wallet"],
  ["repo-bounties", "repo.html?repo=Acme/Bounties", "live"],
];

test.each([
  ["1280", DESKTOP, "light"],
  ["390", PHONE, "light"],
  ["390", PHONE, "dark"],
] as [string, Viewport, "light" | "dark"][])(
  "the Bounty pages load at %s px (%s) with no console errors, no sideways scroll, and nothing from elsewhere",
  async (width, viewport, scheme) => {
    const page = await chrome.newPage();
    for (const [name, path, state] of PAGES) {
      await page.open(site.url(path), viewport, scheme);
      await page.waitForState(state);
      await page.waitFor(`!document.body.innerText.includes("Reading")`);
      // One theme: on a dark system the page stays light, in the landing page's typefaces.
      expect(await page.evaluate<string[]>(LOADED_FONTS)).toEqual(expect.arrayContaining(FONTS));
      await frame(page, `${name}-${state}-${width}${scheme === "dark" ? "-dark" : ""}`);
      expect(await page.overflow(), `${name} scrolls sideways at ${width} px`).toBeLessThanOrEqual(0);
      expect(await page.evaluate<string>("getComputedStyle(document.body).backgroundColor")).toBe(LIGHT_BACKGROUND);
    }
    expect(page.errors).toEqual([]);
    expect(page.requests.filter((url) => ![site.origin, stack.url].some((origin) => url.startsWith(origin)))).toEqual(
      [],
    );
    await page.close();
  },
  90_000,
);

test("before its script runs, the Bounty page shows only its loading card", async () => {
  const page = await chrome.newPage();
  await page.withoutScripts();

  await page.open(site.url("bounties.html?repo=Acme/Bounties"));
  const text = await page.text();
  expect(text).toContain("This page needs JavaScript");
  expect(text).not.toMatch(
    /No Bounty wallet yet|Create the Bounty wallet|Post a Bounty|This link names no repo|Can't reach/,
  );
  await page.close();
}, 30_000);
