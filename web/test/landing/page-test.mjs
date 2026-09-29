// The landing page in headless Chrome, against a local chain with the real escrow. Requests to Arc's
// RPC and explorer are answered by anvil, so the page runs as deployed except for config.js, which
// names the local contracts. With SCREENSHOTS=<folder>, it saves a picture of each render.

import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { CONFIG, NETWORKS } from "../../landing/config.js";
import { ISSUE, PR, buildContracts, startChain } from "./support/anvil.mjs";
import { DESKTOP, PHONE, startChrome } from "./support/chrome.mjs";
import { serveLanding } from "./support/serve.mjs";

const TESTNET = NETWORKS.testnet;
const SCREENSHOTS = process.env.SCREENSHOTS;

function configFor(networks, { network = "testnet", open = false } = {}) {
  const config = { network, installUrl: CONFIG.installUrl, installOpen: open };
  return `export const CONFIG = ${JSON.stringify(config)};\nexport const NETWORKS = ${JSON.stringify(networks)};\n`;
}

const liveState = `document.querySelector("[data-live]").dataset.state`;
const text = (selector) => `document.querySelector(${JSON.stringify(selector)})?.innerText.trim()`;
const values = `Object.fromEntries([...document.querySelectorAll("[data-value]")].map((el) => [el.dataset.value, el.textContent]))`;
const isShown = (selector) =>
  `(() => { const el = document.querySelector(${JSON.stringify(selector)}); return !!el && el.getClientRects().length > 0; })()`;

describe("the landing page", () => {
  let chain;
  let chrome;
  let local;
  let arcAnswers;
  const forward = async (body) => {
    if (!arcAnswers) return null;
    const response = await fetch(chain.url, { method: "POST", headers: { "content-type": "application/json" }, body });
    return response.text();
  };
  const intercept = { [TESTNET.rpcUrl]: forward, [TESTNET.logsUrl]: forward };

  before(async () => {
    buildContracts();
    chain = await startChain({ chainId: TESTNET.chainId });
    const repo = chain.repoId(1);
    await chain.bind(repo);
    await chain.refund(await chain.deposit(repo, PR, 1));
    await chain.forfeit(await chain.deposit(repo, PR, 2));
    await chain.deposit(repo, ISSUE, 3);
    local = {
      testnet: {
        ...TESTNET,
        escrow: chain.escrow,
        router: chain.router,
        usdc: chain.usdc,
        escrowFromBlock: chain.escrowFromBlock,
      },
      mainnet: NETWORKS.mainnet,
    };
    chrome = await startChrome();
    if (SCREENSHOTS) await mkdir(SCREENSHOTS, { recursive: true });
  });

  after(async () => {
    await chrome?.close();
    chain?.stop();
  });

  async function openPage(t, { config = configFor(local), viewport = DESKTOP, scheme = "light", answers = true } = {}) {
    arcAnswers = answers;
    const site = await serveLanding({ replace: { "/config.js": config } });
    const page = await chrome.newPage({ intercept });
    t.after(async () => {
      await page.close();
      await site.close();
    });
    await page.open(site.url, viewport, scheme);
    return { page, site };
  }

  for (const viewport of [DESKTOP, PHONE]) {
    for (const scheme of ["light", "dark"]) {
      test(`renders at ${viewport.width} px in ${scheme}, with the live numbers`, async (t) => {
        const { page, site } = await openPage(t, { viewport, scheme });
        await page.waitFor(`${liveState} === "live"`, "the live numbers");

        assert.deepEqual(await page.evaluate(values), {
          deposits: "3",
          refunds: "1",
          forfeits: "1",
          routerBalance: "0.50",
        });
        assert.match(await page.evaluate(text("[data-live-status]")), /^As of block \d+$/);
        assert.equal(await page.evaluate(text("[data-network-tag]")), "Arc Testnet · test network");
        assert.ok(await page.evaluate(isShown("[data-test-only]")), "the test-network note is shown");
        assert.equal(
          await page.evaluate(`document.querySelector('[data-address="escrow"]').href`),
          `${TESTNET.explorerUrl}/address/${chain.escrow}`,
        );
        assert.deepEqual(
          await page.evaluate(
            `[...document.querySelectorAll("[data-install]")].map((a) => [a.textContent, a.hasAttribute("href"), a.getAttribute("aria-disabled")])`,
          ),
          [
            ["Opening with the mainnet launch", false, "true"],
            ["Opening with the mainnet launch", false, "true"],
          ],
        );
        assert.equal(
          await page.evaluate(`getComputedStyle(document.body).backgroundColor`),
          scheme === "dark" ? "rgb(15, 17, 21)" : "rgb(245, 246, 248)",
        );
        assert.ok(
          await page.evaluate(`document.documentElement.scrollWidth <= window.innerWidth`),
          "no sideways scroll",
        );
        const elsewhere = page.requests.filter(
          ({ url }) => !url.startsWith(site.url) && !Object.keys(intercept).some((prefix) => url.startsWith(prefix)),
        );
        assert.deepEqual(elsewhere, [], "requests only to this site and Arc");
        assert.deepEqual(page.errors, []);
        assert.deepEqual(page.networkErrors, []);

        if (SCREENSHOTS) await page.screenshot(join(SCREENSHOTS, `landing-${viewport.width}-${scheme}.png`));
      });
    }
  }

  test("says plainly when Arc can't be reached, and tries again", async (t) => {
    const { page } = await openPage(t, { answers: false });
    await page.waitFor(`${liveState} === "unreachable"`, "the unreachable state");

    assert.ok(await page.evaluate(isShown(".alert")));
    assert.match(await page.evaluate(text(".alert")), /^Can't reach Arc Testnet right now\./);
    assert.equal(
      await page.evaluate(`document.querySelector(".alert [data-escrow-link]").href`),
      `${TESTNET.explorerUrl}/address/${chain.escrow}`,
    );
    assert.deepEqual(Object.values(await page.evaluate(values)), ["—", "—", "—", "—"]);
    assert.deepEqual(page.errors, []);
    if (SCREENSHOTS) await page.screenshot(join(SCREENSHOTS, "live-unreachable.png"), "#live");

    arcAnswers = true;
    await page.evaluate(`document.querySelector("[data-retry]").click()`);
    await page.waitFor(`${liveState} === "live"`, "the live numbers after trying again");
    assert.equal((await page.evaluate(values)).deposits, "3");
    assert.ok(!(await page.evaluate(isShown(".alert"))));
  });

  test("links both Install buttons once the App is open", async (t) => {
    const { page } = await openPage(t, { config: configFor(local, { open: true }) });

    assert.deepEqual(
      await page.evaluate(
        `[...document.querySelectorAll("[data-install]")].map((a) => [a.textContent, a.getAttribute("href"), a.hasAttribute("aria-disabled")])`,
      ),
      [
        ["Install on GitHub", CONFIG.installUrl, false],
        ["Install on GitHub", CONFIG.installUrl, false],
      ],
    );
  });

  test("waits for the mainnet launch while mainnet has no escrow", async (t) => {
    const mainnet = { ...NETWORKS.mainnet, escrow: "", router: "" };
    const { page } = await openPage(t, { config: configFor({ mainnet }, { network: "mainnet" }) });
    await page.waitFor(`${liveState} === "soon"`, "the waiting state");

    assert.match(await page.evaluate(text(".soon")), /^The escrow opens with the mainnet launch\./);
    assert.equal(await page.evaluate(text("[data-network-tag]")), "Arc");
    assert.ok(!(await page.evaluate(isShown(".stats"))));
    assert.ok(!(await page.evaluate(isShown("[data-escrow-link]"))));
    assert.ok(!(await page.evaluate(isShown("[data-test-only]"))));
    assert.deepEqual(
      page.requests.filter(({ url }) => url.startsWith("https://")),
      [],
      "no request to any network",
    );
    assert.deepEqual(page.errors, []);
    if (SCREENSHOTS) await page.screenshot(join(SCREENSHOTS, "live-mainnet-soon.png"), "#live");
  });

  test("reads without JavaScript", async (t) => {
    arcAnswers = true;
    const site = await serveLanding({ replace: { "/config.js": configFor(local) } });
    const page = await chrome.newPage({ intercept });
    t.after(async () => {
      await page.close();
      await site.close();
    });
    await page.withoutScripts();
    await page.open(site.url, PHONE, "light");

    assert.equal(await page.evaluate(text("h1")), "Refundable good-faith Deposits for open source");
    assert.match(await page.evaluate(text("#live")), /Turn on JavaScript to read these numbers live from Arc\./);
    assert.equal(await page.evaluate(text("[data-install]")), "Opening with the mainnet launch");
    if (SCREENSHOTS) await page.screenshot(join(SCREENSHOTS, "live-no-javascript.png"), "#live");
    assert.deepEqual(
      page.requests.filter(({ url }) => url.startsWith("https://")),
      [],
      "no request to any network",
    );
  });
});
