import { mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { privateKeyToAccount } from "viem/accounts";
import type { Hex } from "viem";
import { afterAll, beforeAll, expect, test } from "vitest";
import { createDecisionLog } from "../../app/src/decisions/log.ts";
import { createDecisionRoutes } from "../../app/src/decisions/routes.ts";
import type { Decision } from "../../app/src/ports.ts";
import { keeperHarness } from "../../app/test/support/keeper.ts";
import type { Anvil } from "../../app/test/support/anvil.ts";
import { buildPages } from "../build.ts";
import { asWritten, DESKTOP, PHONE, startChrome, type Chrome, type Page, type Viewport } from "./support/chrome.ts";
import { startAppRelay, startSite } from "./support/site.ts";
import { startStack, type Stack } from "./support/stack.ts";
import { BINDING, createTestWallet, INJECTED } from "./support/test-wallet.ts";

// Every page, built for a local Arc and driven in headless Chrome with a mock wallet. Deposits go
// through the App's own relay, run as its Node host; Forfeits and Binding proofs go to the App's
// Keeper endpoints, with GitHub faked.

let stack: Stack;
let chrome: Chrome;
let app: Awaited<ReturnType<typeof startAppRelay>>;
let site: Awaited<ReturnType<typeof startSite>>;
let keeper: ReturnType<typeof keeperHarness>;
let relayer: Hex;
/** Answers POST /relay/deposit instead of the App, while set. */
let relayStub: ((body: any) => Promise<Response | null> | Response | null) | null = null;
/** What GET /decisions answers: the App's log, an empty one, or a failure, as when the App is down. */
let decisionsMode: "log" | "empty" | "down" = "log";
const decisionLog = createDecisionLog();
const emptyLog = createDecisionLog();
const REFUND_TX = `0x${"5e".repeat(32)}` as const;
/** The bona-fide.yml GitHub shows for a repo; missing repos get a 404. */
const githubFiles = new Map<string, string>();
/** Where to save a frame of each checked state: set SCREENSHOTS to a folder. */
const FRAMES = process.env.SCREENSHOTS;

async function frame(page: Page, name: string) {
  if (!FRAMES) return;
  await mkdir(FRAMES, { recursive: true });
  await page.screenshot(join(FRAMES, `${name}.png`));
}

/** Public repos without a bona-fide.yml. GitHub shows neither the file nor the repo of any other. */
const githubRepos = new Set<string>();

const github = {
  "https://api.github.com/": (url: string) => {
    const [, repo = "", contents] = /\/repos\/([^/]+\/[^/?]+)(\/contents\/)?/.exec(url) ?? [];
    const text = githubFiles.get(repo.toLowerCase());
    const notFound = { status: 404, body: '{"message":"Not Found"}' };
    if (!contents)
      return text !== undefined || githubRepos.has(repo.toLowerCase()) ? { status: 200, body: "{}" } : notFound;
    return text === undefined ? notFound : { status: 200, body: text };
  },
};

function seedDecisions() {
  const base = {
    repo: "Acme/Widgets",
    private: false,
    serial: "1",
    inputs: null,
    suggestion: null,
    txHash: null,
    cost: null,
  } as const;
  const logged: Omit<Decision, "id">[] = [
    {
      ...base,
      at: "2026-09-01T09:00:00.000Z",
      item: { kind: "issue", number: 8 },
      type: "triage",
      inputs: { titleChars: 31, bodyChars: 1_840, bodyLeftOut: 0 },
      suggestion: {
        verdict: "bad-faith",
        reasons: ["It links to a <img src=x onerror=alert(1)> casino.", "The body has nothing to do with Widgets."],
      },
      witnesses: [
        {
          name: "Deposit",
          value: "Serial 1: 1 USDC from 0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed, counted by the check",
        },
        { name: "Exemption", value: "none" },
        { name: "Labels", value: "none" },
        { name: "Triage in bona-fide.yml", value: "on" },
        { name: "Labels after the model answered", value: "none" },
      ],
      action: "drafted-verdict",
      outcome: "escalated",
      cost: { model: "claude-opus-5", inputTokens: 2_310, outputTokens: 142, usd: 0.0151 },
    },
    {
      ...base,
      at: "2026-09-02T10:30:00.000Z",
      item: { kind: "pr", number: 21 },
      type: "triage",
      inputs: {
        titleChars: 24,
        bodyChars: 12,
        bodyLeftOut: 0,
        files: 1,
        filesLeftOut: 0,
        diffChars: 54,
        diffLeftOut: 0,
      },
      suggestion: { verdict: "accept", reasons: ["It fixes the typo it names."] },
      witnesses: [{ name: "Labels", value: "none" }],
      action: "noted-accept",
      outcome: "decided",
      cost: { model: "claude-opus-5", inputTokens: 1_200, outputTokens: 80, usd: 0.008 },
    },
    {
      ...base,
      at: "2026-09-02T11:00:00.000Z",
      item: { kind: "pr", number: 22 },
      type: "triage",
      inputs: { titleChars: 10, bodyChars: 0, bodyLeftOut: 0 },
      witnesses: [{ name: "Labels", value: "none" }],
      action: "failed: rate limited",
      outcome: "escalated",
    },
    {
      ...base,
      at: "2026-09-03T08:15:00.000Z",
      item: { kind: "pr", number: 21 },
      type: "early-refund",
      inputs: { source: "check" },
      witnesses: [
        { name: "Deposit", value: "Serial 2: 1 USDC from 0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed" },
        { name: "Approved by", value: "@mo, with write access" },
        { name: "Marked bad faith", value: "no" },
      ],
      action: "refunded",
      txHash: REFUND_TX,
      outcome: "decided",
    },
    {
      ...base,
      serial: null,
      at: "2026-09-04T09:45:00.000Z",
      item: { kind: "pr", number: 30 },
      type: "waive",
      inputs: {
        login: "fresh-account",
        refunds: 3,
        repos: 1,
        otherRefunds: 6,
        forfeits: 0,
        active: 4,
        accountAgeDays: 9,
        publicRepos: 0,
        followers: 0,
        mergedElsewhere: 0,
      },
      suggestion: {
        verdict: "flag",
        reasons: ["The account is nine days old.", "Six Deposits were refunded only at the Timeout."],
      },
      witnesses: [
        {
          name: "Score",
          value: "3, threshold 3: 3 Refunds on accepted work, and 0 merged PRs elsewhere (at most 2 count)",
        },
        { name: "Forfeits", value: "none, in any repo" },
        { name: "Denounced in VOUCHED.td", value: "no" },
        { name: "Record Exemption in bona-fide.yml", value: "on" },
      ],
      action: "flagged",
      outcome: "escalated",
      cost: { model: "claude-opus-5", inputTokens: 612, outputTokens: 44, usd: 0.0042 },
    },
    {
      ...base,
      serial: null,
      at: "2026-09-05T14:20:00.000Z",
      item: { kind: "issue", number: 31 },
      type: "waive",
      inputs: {
        login: "newcomer",
        refunds: 4,
        repos: 3,
        otherRefunds: 1,
        forfeits: 0,
        active: 0,
        accountAgeDays: 1_826,
        publicRepos: 12,
        followers: 30,
        mergedElsewhere: 57,
      },
      suggestion: { verdict: "waive", reasons: ["Four accepted Deposits in three repos over five years."] },
      witnesses: [
        {
          name: "Score",
          value: "6, threshold 3: 4 Refunds on accepted work, and 2 merged PRs elsewhere (at most 2 count)",
        },
        { name: "Forfeits", value: "none, in any repo" },
        { name: "Denounced in VOUCHED.td", value: "no" },
        { name: "Record Exemption in bona-fide.yml", value: "on" },
      ],
      action: "waived",
      outcome: "decided",
      cost: { model: "claude-opus-5", inputTokens: 600, outputTokens: 40, usd: 0.004 },
    },
  ];
  logged.forEach((decision, i) => decisionLog.append({ id: `seeded-${i}`, ...decision }));
  decisionLog.append({ ...logged[0]!, id: "secret", repo: "Acme/Secret", private: true });
}

beforeAll(async () => {
  seedDecisions();
  stack = await startStack();
  const dir = await mkdtemp(join(tmpdir(), "bona-fide-site-"));
  await buildPages({ network: stack.network, outDir: dir, landing: false });
  const relayerKey = await stack.gasKey();
  relayer = privateKeyToAccount(relayerKey).address;
  app = await startAppRelay({
    rpcUrl: stack.url,
    escrow: stack.escrow,
    fromBlock: stack.network.escrowFromBlock,
    relayerKey,
  });
  const chainForKeeper = { url: stack.url, escrow: stack.escrow, deployBlock: BigInt(stack.network.escrowFromBlock) };
  keeper = keeperHarness(chainForKeeper as unknown as Anvil, stack.keeperKey);
  site = await startSite({
    dir,
    relayUrl: app.url,
    endpoint: async (request) => {
      if (new URL(request.url).pathname === "/decisions") {
        if (decisionsMode === "down") return new Response("<html>502 Bad Gateway</html>", { status: 502 });
        return createDecisionRoutes(decisionsMode === "log" ? decisionLog : emptyLog)(request, "127.0.0.1");
      }
      if (new URL(request.url).pathname === "/relay/deposit" && relayStub) {
        return await relayStub(JSON.parse(await request.clone().text()));
      }
      return keeper.routes(request);
    },
  });
  chrome = await startChrome();
}, 180_000);

afterAll(async () => {
  await chrome?.stop();
  await site?.stop();
  app?.stop();
  stack?.stop();
});

async function walletPage(account: Parameters<typeof createTestWallet>[0]["account"], startChainId?: number) {
  const wallet = createTestWallet({ account, chain: stack.chain, rpcUrl: stack.url, startChainId });
  const page = await chrome.newPage({
    binding: BINDING,
    onBinding: wallet.onBinding,
    injected: INJECTED,
    intercept: github,
  });
  return { wallet, page };
}

/** Connects the page's wallet through the picker, and waits for `state`. */
async function connect(page: Page, state: string) {
  await page.click('[data-action="connect"]');
  await page.click("[data-picker] .wallet-option");
  await page.waitForState(state);
}

/** Browser-level errors for failed requests to `path`: expected where a test makes an endpoint fail. */
function besides(errors: string[], path: string): string[] {
  return errors.filter((error) => !(error.includes("Failed to load resource") && error.includes(path)));
}

test("the deposit page's one signature ends in a Deposited event, sent by the App's relay", async () => {
  const repo = "Acme/Widgets";
  await stack.bind(repo);
  const contributor = await stack.account(3_000_000n);
  const { page } = await walletPage(contributor, 1);

  await page.open(site.url("deposit.html?repo=Acme/Widgets&kind=pr&number=7"));
  await page.waitForState("not-connected");
  await frame(page, "deposit-not-connected-1280");
  expect(await page.text()).toContain("1 USDC");
  await page.click('[data-action="connect"]');
  await page.waitFor("!document.querySelector('[data-picker]').hidden", "the wallet picker");
  await frame(page, "deposit-connect-1280");
  await page.click("[data-picker] .wallet-option");
  await page.waitForState("wrong-network");
  await frame(page, "deposit-wrong-network-1280");
  await page.click('[data-action="switch-network"]');
  await page.waitForState("ready");
  await frame(page, "deposit-ready-1280");
  await page.click('[data-action="sign"]');
  await page.waitForState("confirmed", 30_000);
  await frame(page, "deposit-confirmed-1280");

  const deposit = await stack.depositOf(repo, "pr", 7);
  expect(deposit).toMatchObject({ status: 1, depositor: contributor.address, amount: 1_000_000n });
  const txHash = await page.evaluate<string>(`document.querySelector('[data-href="tx-url"]').href.split("/tx/")[1]`);
  const tx = await stack.client.getTransaction({ hash: txHash as Hex });
  expect(tx.from.toLowerCase()).toBe(relayer.toLowerCase());
  expect(site.served).toContain("POST /relay/deposit");
  expect(await stack.usdcBalance(contributor.address)).toBe(2_000_000n);
  expect(page.errors).toEqual([]);
  await page.close();
}, 60_000);

test("the deposit page pays with two transactions from the Contributor's own wallet", async () => {
  const repo = "Acme/Widgets";
  const contributor = await stack.account(3_000_000n);
  const { page, wallet } = await walletPage(contributor);

  await page.open(site.url("deposit.html?repo=acme/widgets&kind=issue&number=8"));
  await connect(page, "ready");
  await page.click('[data-action="two-step"]');
  await page.waitForState("two-step-approve");
  await frame(page, "deposit-two-step-approve-1280");
  await page.click('[data-action="approve"]');
  await page.waitForState("two-step-deposit");
  await frame(page, "deposit-two-step-deposit-1280");
  await page.click('[data-action="deposit"]');
  await page.waitForState("confirmed", 30_000);

  expect(await stack.depositOf(repo, "issue", 8)).toMatchObject({ status: 1, depositor: contributor.address });
  expect(wallet.log.filter((call) => call.method === "eth_sendTransaction")).toHaveLength(2);
  expect(page.errors).toEqual([]);
  await page.close();
}, 60_000);

test("a Deposit someone already made, a repo not set up, one about to start, and a broken link", async () => {
  await stack.propose("acme/soon");
  const { page } = await walletPage(await stack.account(0n));

  await page.open(site.url("deposit.html?repo=Acme/Widgets&kind=pr&number=7"));
  await page.waitForState("already-active");
  await frame(page, "deposit-already-active-1280");
  expect(await page.text()).toContain("already has an active Deposit");

  await page.open(site.url("deposit.html?repo=acme/nowhere&kind=pr&number=1"));
  await page.waitForState("not-set-up");
  await frame(page, "deposit-not-set-up-1280");

  await page.open(site.url("deposit.html?repo=acme/soon&kind=pr&number=1"));
  await page.waitForState("not-live");
  await frame(page, "deposit-not-live-1280");
  expect(await page.text()).toMatch(/starts taking Deposits on/);

  await page.open(site.url("deposit.html?repo=acme/widgets&kind=pr"));
  await page.waitForState("bad-link");
  expect(page.errors).toEqual([]);
  await page.close();
}, 60_000);

test("too little USDC, a refused signature and a smart wallet that can't sign yet each say what to do", async () => {
  const { page, wallet } = await walletPage(await stack.account(400_000n));

  await page.open(site.url("deposit.html?repo=acme/widgets&kind=pr&number=20"));
  await connect(page, "low-balance");
  await frame(page, "deposit-low-balance-1280");
  expect(await page.text()).toContain("Add at least 0.60 USDC");
  expect(await page.text()).toContain("Buy USDC with a card: coming soon");
  expect(await page.text()).toMatch(
    /withdraw USDC from an exchange on the Arc Testnet \(local\) network, or bring it from another chain\s+in Arc Portal/,
  );

  const funded = await walletPage(await stack.account());
  await funded.page.open(site.url("deposit.html?repo=acme/widgets&kind=pr&number=20"));
  await connect(funded.page, "ready");
  funded.wallet.behavior.rejectNextSignature = true;
  await funded.page.click('[data-action="sign"]');
  await funded.page.waitFor(`document.body.innerText.includes("You cancelled the signature. Nothing was sent.")`);
  funded.wallet.behavior.wrapSignatureAs6492 = true;
  await funded.page.click('[data-action="sign"]');
  await funded.page.waitForState("cant-sign");
  await frame(funded.page, "deposit-cant-sign-1280");
  expect((await stack.depositOf("acme/widgets", "pr", 20)).status).toBe(0);
  expect(wallet.log.some((call) => call.method === "eth_signTypedData_v4")).toBe(false);
  expect([...page.errors, ...funded.page.errors]).toEqual([]);
  await page.close();
  await funded.page.close();
}, 60_000);

test("the relay's refusals and outages each get their own message, and a 429 counts down its Retry-After", async () => {
  const { page } = await walletPage(await stack.account());
  const answer = (status: number, body: object, headers: Record<string, string> = {}) =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
  const cases: [Response, string, RegExp][] = [
    [
      answer(429, { error: "Too many requests. Try again in 30 s." }, { "retry-after": "30" }),
      "429",
      /Try again in (29|30) s/,
    ],
    [answer(503, { error: "The relay can't complete this Deposit right now." }), "503", /couldn't be reached/],
    [answer(502, { error: "reverted", txHash: `0x${"ab".repeat(32)}` }), "502", /failed on-chain/],
    [answer(404, { error: "This App doesn't relay Deposits." }), "404", /One-signature Deposits are off here/],
    [answer(413, { error: "The request body is over the 16 KiB limit." }), "413", /too large to send/],
    [
      answer(422, { error: "The Deposit would fail on-chain: FiatTokenV2: invalid signature." }),
      "422",
      /didn't accept this signature/,
    ],
  ];

  await page.open(site.url("deposit.html?repo=acme/widgets&kind=pr&number=21"));
  await connect(page, "ready");
  try {
    for (const [response, name, message] of cases) {
      relayStub = () => response.clone();
      await page.click('[data-action="sign"]');
      await page.waitForState("problem");
      await page.waitFor(`/${message.source}/.test(document.body.innerText)`, `the ${name} message`);
      await frame(page, `deposit-relay-${name}-1280`);
      await page.open(site.url("deposit.html?repo=acme/widgets&kind=pr&number=21"));
      await page.waitForState("ready");
    }
  } finally {
    relayStub = null;
  }
  expect(besides(page.errors, "/relay/deposit")).toEqual([]);
  await page.close();
}, 120_000);

test("a relayed Deposit that isn't confirmed yet is watched until it lands, not signed again", async () => {
  const contributor = await stack.account();
  const { page, wallet } = await walletPage(contributor);
  const relayerKey = await stack.gasKey();

  await page.open(site.url("deposit.html?repo=acme/widgets&kind=pr&number=22"));
  await connect(page, "ready");
  try {
    relayStub = async (body) => {
      await stack.automine(false);
      const txHash = await stack.submitAuthorization(relayerKey, body);
      return Response.json({ error: "The Deposit was sent but isn't confirmed yet.", txHash }, { status: 504 });
    };
    await page.click('[data-action="sign"]');
    await page.waitForState("unconfirmed");
    await frame(page, "deposit-unconfirmed-1280");
    expect(await page.text()).toContain("Don't sign again");
    await stack.automine(true);
    await stack.mine(1);
    await page.waitForState("confirmed", 30_000);
  } finally {
    relayStub = null;
    await stack.automine(true);
  }

  expect(await stack.depositOf("acme/widgets", "pr", 22)).toMatchObject({ status: 1, depositor: contributor.address });
  expect(wallet.log.filter((call) => call.method === "eth_signTypedData_v4")).toHaveLength(1);
  expect(besides(page.errors, "/relay/deposit")).toEqual([]);
  await page.close();
}, 60_000);

test("the Maintainer signs a verdict on the verdict page, and the Keeper forfeits the Deposit", async () => {
  const repo = "acme/verdicts";
  const maintainer = await stack.account(0n);
  await stack.bind(repo, { maintainer: maintainer.address });
  const contributor = await stack.account();
  await stack.deposit(contributor, repo, "pr", 125);
  const routerBefore = await stack.usdcBalance(stack.router);

  const stranger = await walletPage(await stack.account(0n));
  await stranger.page.open(site.url(`verdict.html?repo=${repo}&kind=pr&number=125`));
  await connect(stranger.page, "wrong-wallet");
  await frame(stranger.page, "verdict-wrong-wallet-1280");
  await stranger.page.close();

  const { page } = await walletPage(maintainer);
  await page.open(site.url(`verdict.html?repo=${repo}&kind=pr&number=125`));
  await page.waitForState("not-connected");
  await connect(page, "ready");
  expect(await page.evaluate<boolean>(`document.querySelector('[data-action="sign"]').disabled`)).toBe(true);
  await page.click("[data-confirm]");
  await frame(page, "verdict-ready-1280");
  await page.click('[data-action="sign"]');
  await page.waitForState("done", 30_000);
  await frame(page, "verdict-done-1280");

  expect(await stack.depositOf(repo, "pr", 125)).toMatchObject({ status: 3 });
  expect(await stack.usdcBalance(stack.router)).toBe(routerBefore + 500_000n);
  expect(await stack.usdcBalance(contributor.address)).toBe(4_500_000n);
  expect(site.served).toContain("POST /forfeit");
  expect(page.errors).toEqual([]);
  await page.close();
}, 60_000);

test("the Maintainer proves wallet control on the setup page, and the Keeper proposes the Binding", async () => {
  const repo = "Acme/Gizmos";
  const maintainer = await stack.account(0n);
  keeper.github.addRepo(repo);
  const file = `maintainer: ${maintainer.address}\namount: 2.5\nforfeit: 25%\ntimeout: 14 days\n`;
  keeper.github.setFile(repo, ".github/bona-fide.yml", file);
  githubFiles.set(repo.toLowerCase(), file);

  const other = await walletPage(await stack.account(0n));
  await other.page.open(site.url(`setup.html?repo=${repo}`));
  await connect(other.page, "wrong-wallet");
  await frame(other.page, "setup-wrong-wallet-1280");
  await other.page.close();

  const { page } = await walletPage(maintainer);
  await page.open(site.url(`setup.html?repo=${repo}`));
  await page.waitForState("not-connected");
  expect(await page.text()).toContain("2.50 USDC");
  expect(await page.text()).toContain("Live 1 hour after your proof");
  await connect(page, "ready");
  await frame(page, "setup-ready-1280");
  await page.click('[data-action="sign"]');
  await page.waitForState("done", 30_000);
  await frame(page, "setup-done-1280");

  const [pending] = (await stack.client.readContract({
    address: stack.escrow,
    abi: stack.escrowAbi,
    functionName: "pendingConfig",
    args: [(await import("../src/keys.ts")).repoIdOf(repo)],
  })) as [{ maintainer: string; amount: bigint; forfeitBps: number; timeout: number }, bigint];
  expect(pending).toMatchObject({
    maintainer: maintainer.address,
    amount: 2_500_000n,
    forfeitBps: 2500,
    timeout: 14 * 86_400,
  });
  expect(await page.text()).toContain("2.50 USDC Deposit · 14-day Timeout · 25% bad-faith share");
  expect(page.requests.some((url) => url.startsWith("https://api.github.com/repos/Acme/Gizmos/contents/"))).toBe(true);
  expect(page.errors).toEqual([]);
  await page.close();
}, 60_000);

test("the setup page says what to fix when bona-fide.yml is missing, broken, or names no wallet", async () => {
  const { page } = await walletPage(await stack.account(0n));
  githubFiles.set("acme/broken", "amount: 51\nforfeit: 60%\n");
  githubFiles.set("acme/walletless", "amount: 1\n");
  githubRepos.add("acme/missing");

  await page.open(site.url("setup.html?repo=acme/missing"));
  await page.waitForState("no-file");
  await frame(page, "setup-no-file-1280");
  await page.open(site.url("setup.html?repo=acme/broken"));
  await page.waitForState("file-problem");
  expect(await page.text()).toContain("`forfeit` must be from 0% to 50%.");
  await page.open(site.url("setup.html?repo=acme/walletless"));
  await page.waitForState("no-maintainer");
  expect(besides(page.errors, "api.github.com")).toEqual([]);
  await page.close();
}, 60_000);

test("for a repo GitHub doesn't show, such as a private one, the Maintainer can still sign the proof", async () => {
  const repo = "acme/private";
  const maintainer = await stack.account(0n);
  keeper.github.addRepo(repo);
  keeper.github.setFile(repo, ".github/bona-fide.yml", `maintainer: ${maintainer.address}\n`);
  const { page } = await walletPage(maintainer);

  await page.open(site.url(`setup.html?repo=${repo}`));
  await page.waitForState("not-connected");
  expect(await page.text()).toContain("This page can't read bona-fide.yml");
  await connect(page, "ready");
  await frame(page, "setup-private-ready-1280");
  await page.click('[data-action="sign"]');
  await page.waitForState("done", 30_000);

  expect(await page.text()).toContain("1 USDC Deposit · 7-day Timeout · 50% bad-faith share");
  expect(besides(page.errors, "api.github.com")).toEqual([]);
  await page.close();
}, 60_000);

test("the repo page lists the Deposits, refunds a timed-out one, and sends the router's balance on", async () => {
  const repo = "Acme/Widgets";
  await stack.advance(7 * 86_400 + 60);
  const { page } = await walletPage(await stack.account(0n));

  await page.open(site.url(`repo.html?repo=${repo}`));
  await page.waitForState("live");
  await page.waitFor(`document.querySelectorAll("[data-rows] tr").length >= 3`, "the Deposit rows");
  await frame(page, "repo-default-1280");
  const text = await page.text();
  expect(text).toContain("Timeout passed");
  expect(text).toContain("0.50 USDC");
  await page.click('[data-action="refund-row"]');
  await page.click("[data-picker] .wallet-option");
  await page.waitFor(`!document.querySelector('[data-if="refund-sent"]').hidden`, "the Refund alert", 30_000);
  await frame(page, "repo-refund-sent-1280");
  await page.click('[data-action="flush"]');
  await page.waitFor(`!document.querySelector('[data-if="flushed"]').hidden`, "the flush alert", 30_000);
  await frame(page, "repo-flushed-1280");

  expect(await stack.usdcBalance(stack.router)).toBe(0n);
  const refunded = [7, 21, 22].map((n) => stack.depositOf(repo, "pr", n));
  expect((await Promise.all(refunded)).some((d) => d.status === 2)).toBe(true);
  expect(page.errors).toEqual([]);
  await page.close();
}, 90_000);

test("the repo page shows the decision log: the counts, and what was suggested, checked and done", async () => {
  const page = await chrome.newPage({ intercept: github });
  const decisions = `document.querySelectorAll("[data-decisions] > li").length`;

  await page.open(site.url("repo.html?repo=Acme/Widgets"));
  await page.waitFor(`${decisions} === 6`, "the decisions");
  await page.waitFor(`!document.body.innerText.includes("Reading Deposits")`);
  await frame(page, "repo-decisions-1280");

  const text = await page.text();
  expect(text).toMatch(/3\s+Decided by Bona Fide/);
  expect(text).toMatch(/3\s+Left to the Maintainer/);
  expect(text).toContain("Suggested: likely bad faith");
  expect(text).toContain("It links to a <img src=x onerror=alert(1)> casino.");
  expect(text).toContain("Posted a draft bad-faith verdict for the Maintainer. Nothing was forfeited.");
  expect(text).toContain("Suggested: good-faith work");
  expect(text).toContain("Posted a note suggesting the Maintainer accept it.");
  expect(text).toContain("The model couldn't be asked (rate limited). Nothing was posted.");
  expect(text).toContain("Approved by");
  expect(text).toContain("@mo, with write access");
  expect(text).toContain("Refunded the Deposit in full to its Depositor.");
  expect(text).toContain("claude-opus-5: 2,310 tokens in, 142 out, about $0.0151");
  expect(await page.evaluate(`document.querySelectorAll("[data-decisions] img").length`)).toBe(0);
  const order = await page.evaluate<string[]>(
    `[...document.querySelectorAll("[data-decisions] [data-cell=item]")].map((a) => a.textContent)`,
  );
  expect(order).toEqual(["Issue #31", "PR #30", "PR #21", "PR #22", "PR #21", "Issue #8"]);
  const links = await page.evaluate<string[]>(
    `[...document.querySelectorAll("[data-decisions] a")].map((a) => a.href)`,
  );
  expect(links).toContain("https://github.com/Acme/Widgets/pull/21");
  expect(links).toContain(`${stack.network.explorerUrl}/tx/${REFUND_TX}`);
  expect(page.errors).toEqual([]);
  await page.close();
}, 60_000);

test("the repo page shows a Record Exemption: the record read, the witnesses, and whether the check passed", async () => {
  const page = await chrome.newPage({ intercept: github });

  await page.open(site.url("repo.html?repo=Acme/Widgets"));
  await page.waitFor(`document.querySelectorAll("[data-decisions] > li").length === 6`, "the decisions");
  await page.waitFor(`!document.body.innerText.includes("Reading Deposits")`);
  await frame(page, "repo-decisions-waive-1280");

  const [waived, flagged] = await page.evaluate<string[]>(
    asWritten(`[...document.querySelectorAll("[data-decisions] > li")].slice(0, 2).map((li) => li.innerText)`),
  );
  expect(waived).toContain("Issue #31");
  expect(waived).toContain("Record Exemption");
  expect(waived).toContain("Suggested: no Deposit needed");
  expect(waived).toContain("Four accepted Deposits in three repos over five years.");
  expect(waived).toContain("6, threshold 3: 4 Refunds on accepted work, and 2 merged PRs elsewhere (at most 2 count)");
  expect(waived).toContain("none, in any repo");
  expect(waived).toContain("Passed the check: no Deposit needed.");
  expect(waived).toContain(
    "Read: @newcomer's record in public repos: 4 Refunds on accepted work in 3 repos, 1 other Refund, 0 Forfeits, 0 open Deposits. On GitHub: account 1,826 days old, 12 public repos, 30 followers, 57 merged PRs elsewhere.",
  );
  expect(waived).toMatch(/Decided/);
  expect(flagged).toContain("Suggested: ask for the Deposit, and flag the record for the Maintainer");
  expect(flagged).toContain("Six Deposits were refunded only at the Timeout.");
  expect(flagged).toContain("Kept asking for the Deposit, and posted a note for the Maintainer.");
  expect(flagged).toMatch(/Left to the Maintainer/);

  await page.open(site.url("repo.html?repo=Acme/Widgets"), PHONE);
  await page.waitFor(`document.querySelectorAll("[data-decisions] > li").length === 6`, "the decisions");
  await page.waitFor(`!document.body.innerText.includes("Reading Deposits")`);
  await frame(page, "repo-decisions-waive-390");
  expect(await page.overflow()).toBeLessThanOrEqual(0);
  expect(page.errors).toEqual([]);
  await page.close();
}, 60_000);

test("with no decisions the repo page says so, and when the log can't be read it says that, not zero", async () => {
  const page = await chrome.newPage({ intercept: github });
  try {
    decisionsMode = "empty";
    await page.open(site.url("repo.html?repo=Acme/Widgets"));
    await page.waitFor(`!document.querySelector('[data-if="no-decisions"]').hidden`, "the empty log");
    await page.waitFor(`!document.body.innerText.includes("Reading Deposits")`);
    await frame(page, "repo-decisions-empty-1280");
    expect(await page.text()).toContain("No decisions here yet.");

    decisionsMode = "down";
    await page.open(site.url("repo.html?repo=Acme/Widgets"));
    await page.waitFor(`!document.querySelector('[data-if="decisions-failed"]').hidden`, "the failure");
    await page.waitFor(`!document.body.innerText.includes("Reading Deposits")`);
    await frame(page, "repo-decisions-down-1280");
    const text = await page.text();
    expect(text).toContain("Couldn't read the decision log");
    expect(text).not.toMatch(/Decided by Bona Fide|No decisions here yet/);

    decisionsMode = "log";
    await page.click('[data-action="reload-decisions"]');
    await page.waitFor(`document.querySelectorAll("[data-decisions] > li").length === 6`, "the decisions");
    expect(besides(page.errors, "/decisions")).toEqual([]);
  } finally {
    decisionsMode = "log";
    await page.close();
  }
}, 60_000);

test("a private repo's decisions don't show on its page", async () => {
  const page = await chrome.newPage({ intercept: github });

  await page.open(site.url("repo.html?repo=Acme/Secret"));
  await page.waitFor(`!document.querySelector('[data-if="no-decisions"]').hidden`, "the empty log");

  expect(await page.text()).not.toContain("Suggested:");
  await page.close();
}, 60_000);

const LIGHT_BACKGROUND = "rgb(246, 244, 249)";
const FONTS = ["Big Shoulders Display", "Hanken Grotesk"];
const LOADED_FONTS = `document.fonts.ready.then(() => [...document.fonts].filter((font) => font.status === "loaded").map((font) => font.family.replaceAll('"', "")))`;

const PAGES: [string, string, string][] = [
  ["deposit", "deposit.html?repo=Acme/Widgets&kind=pr&number=30", "not-connected"],
  ["deposit-active", "deposit.html?repo=acme/widgets&kind=issue&number=8", "timed-out"],
  ["verdict", "verdict.html?repo=acme/verdicts&kind=pr&number=125", "resolved"],
  ["setup", "setup.html?repo=Acme/Gizmos", "done"],
  ["repo", "repo.html?repo=Acme/Widgets", "live"],
  ["repo-none", "repo.html?repo=acme/none", "not-set-up"],
];

test.each([
  ["1280", DESKTOP, "light"],
  ["390", PHONE, "light"],
  ["390", PHONE, "dark"],
] as [string, Viewport, "light" | "dark"][])(
  "every page loads at %s px (%s) with no console errors, no sideways scroll, and nothing from elsewhere",
  async (width, viewport, scheme) => {
    const page = await chrome.newPage({ intercept: github });
    const allowed = [site.origin, stack.url, "https://api.github.com/"];
    for (const [name, path, state] of PAGES) {
      await page.open(site.url(path), viewport, scheme);
      await page.waitForState(state);
      await page.waitFor(
        `!document.querySelector("[data-rows]") || !document.body.innerText.includes("Reading Deposits")`,
      );
      // One theme: on a dark system the page stays light, in the landing page's typefaces.
      expect(await page.evaluate<string[]>(LOADED_FONTS)).toEqual(expect.arrayContaining(FONTS));
      await frame(page, `${name}-${state}-${width}${scheme === "dark" ? "-dark" : ""}`);
      expect(await page.overflow(), `${name} scrolls sideways at ${width} px`).toBeLessThanOrEqual(0);
      expect(await page.evaluate<string>("getComputedStyle(document.body).backgroundColor")).toBe(LIGHT_BACKGROUND);
    }
    expect(page.errors).toEqual([]);
    expect(page.requests.filter((url) => !allowed.some((origin) => url.startsWith(origin)))).toEqual([]);
    await page.close();
  },
  90_000,
);

test("before its script runs, a page shows only its loading card, not every state at once", async () => {
  const page = await chrome.newPage();
  await page.withoutScripts();
  const stateHeadings =
    /Pay the Deposit|Deposit made|Already paid|Nothing to pay|Verdict signed|Sign before|Proof accepted|Bona Fide is live here|Why sign|Not set up here yet|Terms\n/;

  for (const [, path] of PAGES) {
    await page.open(site.url(path));
    const text = await page.text();
    expect(text).toContain("This page needs JavaScript");
    expect(text).not.toMatch(stateHeadings);
    expect(text).not.toMatch(/This link is incomplete|This link names no repo|Can't reach/);
  }
  await page.close();
}, 60_000);
