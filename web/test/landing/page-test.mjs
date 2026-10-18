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

function configFor(networks, { network = "testnet", open = false, demoUrl = "" } = {}) {
  const config = { network, installUrl: CONFIG.installUrl, installOpen: open, demoUrl };
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

  async function openPage(
    t,
    { config = configFor(local), viewport = DESKTOP, scheme = "light", answers = true, reducedMotion = false } = {},
  ) {
    arcAnswers = answers;
    const site = await serveLanding({ replace: { "/config.js": config } });
    const page = await chrome.newPage({ intercept });
    t.after(async () => {
      await page.close();
      await site.close();
    });
    await page.open(site.url, viewport, scheme, { reducedMotion });
    return { page, site };
  }

  for (const viewport of [DESKTOP, PHONE]) {
    for (const scheme of ["light", "dark"]) {
      test(`renders in light at ${viewport.width} px on a ${scheme} system, with the live numbers`, async (t) => {
        const { page, site } = await openPage(t, { viewport, scheme });
        await page.waitFor(`${liveState} === "live"`, "the live numbers");

        assert.deepEqual(await page.evaluate(values), {
          deposits: "3",
          refunds: "1",
          forfeits: "1",
          routerBalance: "0.50",
        });
        assert.match(await page.evaluate(text("[data-live-status]")), /^As of block \d+$/);
        assert.equal(await page.evaluate(text("[data-network-tag]")), "ARC TESTNET · TEST NETWORK");
        assert.ok(await page.evaluate(isShown("[data-test-only]")), "the test-network note is shown");
        assert.ok(!(await page.evaluate(isShown(".built-on .live-dot"))), "no mainnet line on a test network");
        assert.deepEqual(
          await page.evaluate(
            `[...document.querySelectorAll("[data-contracts] [data-address]")].map((a) => [a.dataset.address, a.textContent, a.href])`,
          ),
          [
            ["escrow", chain.escrow, `${TESTNET.explorerUrl}/address/${chain.escrow}`],
            ["router", chain.router, `${TESTNET.explorerUrl}/address/${chain.router}`],
          ],
        );
        assert.equal(await page.evaluate(text("[data-contracts] .eyebrow")), "CONTRACTS ON ARC TESTNET");
        assert.deepEqual(
          await page.evaluate(
            `[...document.querySelectorAll(".built-on img")].map((img) => [img.alt, img.complete && img.naturalWidth > 0, img.getBoundingClientRect().height >= 32])`,
          ),
          [["Arc", true, true]],
        );
        assert.ok(!(await page.evaluate(isShown("[data-demo]"))), "no demo button without a demo");
        assert.deepEqual(
          await page.evaluate(
            `[...document.querySelectorAll("[data-install]")].map((a) => [a.textContent, a.hasAttribute("href"), a.getAttribute("aria-disabled")])`,
          ),
          [
            ["Opening with the mainnet launch", false, "true"],
            ["Opening with the mainnet launch", false, "true"],
          ],
        );
        assert.equal(await page.evaluate(`getComputedStyle(document.body).backgroundColor`), "rgb(246, 244, 249)");
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

  test("shows the demo button once config.js names the video", async (t) => {
    const demoUrl = "https://example.com/bona-fide-demo";
    const { page } = await openPage(t, { config: configFor(local, { demoUrl }) });

    assert.ok(await page.evaluate(isShown("[data-demo]")));
    assert.equal(await page.evaluate(`document.querySelector("[data-demo]").href`), demoUrl);
    assert.equal(await page.evaluate(text("[data-demo]")), "Watch the demo");
  });

  test("shows the whole Built on row on the first screen, from a small phone to a wide screen", async (t) => {
    for (const [width, height] of [
      [360, 740],
      [390, 844],
      [1280, 720],
      [1440, 900],
    ]) {
      // As on mainnet, where the row also says "Live on Arc mainnet".
      const mainnet = { ...local.testnet, name: "Arc", test: false };
      const { page } = await openPage(t, {
        config: configFor({ mainnet }, { network: "mainnet" }),
        viewport: { width, height, mobile: width < 768 },
      });
      await page.waitFor(`document.fonts.status === "loaded"`, "the fonts");
      await page.waitFor(`${liveState} === "live"`, "the live numbers");
      assert.ok(await page.evaluate(isShown(".built-on .live-dot")), "the mainnet line is shown");
      const { bottom, logo } = await page.evaluate(
        `({ bottom: document.querySelector(".built-on").getBoundingClientRect().bottom, logo: document.querySelector(".built-on img").getBoundingClientRect().height })`,
      );
      assert.ok(
        bottom <= height,
        `the Built on row ends at ${bottom} px, below the ${height} px screen at ${width} px`,
      );
      assert.ok(logo >= 32, `Arc's logo is ${logo} px tall at ${width} px`);
    }
  });

  test("fills the space beside the headline with the config file, on wide screens only", async (t) => {
    for (const [width, height] of [
      [390, 844],
      [1024, 768],
      [1280, 720],
      [1440, 900],
      [1920, 1080],
    ]) {
      const { page } = await openPage(t, { viewport: { width, height, mobile: width < 768 } });
      await page.waitFor(`document.fonts.status === "loaded"`, "the fonts");
      const shown = await page.evaluate(isShown(".hero-config"));
      assert.equal(shown, width >= 1280, `the config file ${shown ? "shows" : "hides"} at ${width} px`);
      if (!shown) continue;
      const { config, lede, title } = await page.evaluate(`({
        config: document.querySelector(".hero-config").getBoundingClientRect().toJSON(),
        lede: document.querySelector(".hero-copy .lede").getBoundingClientRect().toJSON(),
        title: document.querySelector(".hero-head").getBoundingClientRect().toJSON(),
      })`);
      assert.ok(
        config.bottom <= lede.top,
        `the config file ends at ${config.bottom} px, over the lede at ${lede.top} px`,
      );
      assert.ok(
        config.top >= title.top,
        `the config file starts at ${config.top} px, higher than the headline at ${title.top} px`,
      );
      assert.ok(config.left >= title.right, `the config file overlaps the headline at ${width} px`);
    }
  });

  test("keeps the certificate's number and seal word inside its inner frame on a small phone", async (t) => {
    const { page } = await openPage(t, { viewport: { width: 360, height: 740, mobile: true } });
    await page.waitFor(`document.fonts.status === "loaded"`, "the fonts");

    const outside = await page.evaluate(`(() => {
      const frame = document.querySelector(".cert-frame").getBoundingClientRect();
      const inset = parseFloat(getComputedStyle(document.querySelector(".cert-frame"), "::after").top);
      return [".cert-number", ".cert-seal-word", ".cert-kind"].filter((selector) => {
        const r = document.querySelector(selector).getBoundingClientRect();
        return r.left < frame.left + inset || r.right > frame.right - inset || r.bottom > frame.bottom - inset;
      });
    })()`);
    assert.deepEqual(outside, []);
  });

  test("shows every code block whole on a desktop, with no sideways scroll inside them", async (t) => {
    const { page } = await openPage(t);
    await page.waitFor(`document.fonts.status === "loaded"`, "the fonts");

    assert.deepEqual(
      await page.evaluate(
        `[...document.querySelectorAll("pre.code")].map((pre) => [pre.getAttribute("aria-label"), pre.scrollWidth <= pre.clientWidth])`,
      ),
      [
        [".github/bona-fide.yml", true],
        ["Adding the MCP server to Claude Code", true],
        [".github/bona-fide.yml", true],
      ],
    );
  });

  test("keeps the header at the top while scrolling, and lands nav links below it", async (t) => {
    const { page } = await openPage(t);
    await page.waitFor(`document.fonts.status === "loaded"`, "the fonts");

    await page.evaluate(`window.scrollTo({ top: 2000, behavior: "instant" })`);
    assert.equal(await page.evaluate(`document.querySelector("header.top").getBoundingClientRect().top`), 0);

    for (const id of ["how", "agent", "live"]) {
      const { header, section, heading } = await page.evaluate(`(async () => {
        window.scrollTo({ top: 0, behavior: "instant" });
        const done = new Promise((resolve) => { addEventListener("scrollend", resolve, { once: true }); setTimeout(resolve, 3000); });
        document.querySelector('.top-nav a[href="#${id}"]').click();
        await done;
        const target = document.getElementById("${id}");
        return {
          header: document.querySelector("header.top").getBoundingClientRect().bottom,
          section: target.getBoundingClientRect().top,
          heading: target.querySelector("h2").getBoundingClientRect().top,
        };
      })()`);
      assert.ok(section >= header, `#${id} starts at ${section} px, under the header that ends at ${header} px`);
      assert.ok(heading >= header, `#${id}'s heading starts at ${heading} px, under the header (${header} px)`);
    }
  });

  test("never scrolls sideways, from a small phone to a wide screen", async (t) => {
    for (const width of [360, 430, 768, 1440]) {
      const { page } = await openPage(t, { viewport: { width, height: 900, mobile: width < 768 } });
      await page.waitFor(`document.fonts.status === "loaded"`, "the fonts");
      assert.ok(
        await page.evaluate(`document.documentElement.scrollWidth <= window.innerWidth`),
        `sideways scroll at ${width} px`,
      );
    }
  });

  const tiltOf = `(() => { const s = document.querySelector("[data-tilt]").style; return { rx: s.getPropertyValue("--rx"), ry: s.getPropertyValue("--ry") }; })()`;
  /** Scrolls the card into view and returns the viewport point `inset` px inside its wrapper's right edge. */
  const nearRightEdge = (inset, fy) =>
    `(() => { const f = document.querySelector(".cert-float"); f.scrollIntoView({ block: "center", behavior: "instant" }); const r = f.getBoundingClientRect(); return { x: r.right - ${inset}, y: r.top + r.height * ${fy} }; })()`;

  test("tilts the certificate a few degrees toward a mouse, and eases back when it leaves", async (t) => {
    const { page } = await openPage(t);
    assert.ok(await page.evaluate(`matchMedia("(hover: hover) and (pointer: fine)").matches`), "a fine pointer");

    const corner = await page.evaluate(nearRightEdge(30, 0.1));
    await page.moveMouse(corner.x, corner.y);
    await page.waitFor(`parseFloat(${tiltOf}.ry) > 6`, "the tilt toward the top right corner");
    const { rx, ry } = await page.evaluate(tiltOf);
    assert.ok(parseFloat(rx) > 4.5 && parseFloat(rx) <= 6.5, rx);
    assert.ok(parseFloat(ry) <= 6.5, ry);

    await page.moveMouse(2, 2);
    await page.waitFor(`${tiltOf}.ry === "0.000deg" && ${tiltOf}.rx === "0.000deg"`, "the card at rest");
    assert.deepEqual(page.errors, []);
  });

  test("keeps the tilt while the mouse rests just inside the card's edge", async (t) => {
    const { page } = await openPage(t);

    const edge = await page.evaluate(nearRightEdge(12, 0.5));
    await page.moveMouse(edge.x, edge.y);
    await page.waitFor(`parseFloat(${tiltOf}.ry) > 6`, "the tilt toward the right edge");
    await new Promise((resolve) => setTimeout(resolve, 600));
    assert.ok(parseFloat((await page.evaluate(tiltOf)).ry) > 6, "still tilted after 600 ms");
  });

  test("keeps the certificate still when the visitor asks for less motion", async (t) => {
    const { page } = await openPage(t, { reducedMotion: true });

    const edge = await page.evaluate(nearRightEdge(12, 0.5));
    await page.moveMouse(edge.x, edge.y);
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.deepEqual(await page.evaluate(tiltOf), { rx: "", ry: "" });
    assert.deepEqual(
      await page.evaluate(
        `[".cert-float", ".cert-sheen", ".step-stamp", ".hero-config"].map((s) => getComputedStyle(document.querySelector(s)).animationName)`,
      ),
      ["none", "none", "none", "none"],
    );
  });

  test("says Live on Arc mainnet under the hero once mainnet has an escrow", async (t) => {
    const mainnet = { ...local.testnet, name: "Arc", test: false };
    const { page } = await openPage(t, { config: configFor({ mainnet }, { network: "mainnet" }) });
    await page.waitFor(`${liveState} === "live"`, "the live numbers");

    assert.ok(await page.evaluate(isShown(".built-on .live-dot")));
    assert.equal(await page.evaluate(text(".built-on .live-dot")), "Live on Arc mainnet");
  });

  test("waits for the mainnet launch while mainnet has no escrow", async (t) => {
    const mainnet = { ...NETWORKS.mainnet, escrow: "", router: "" };
    const { page } = await openPage(t, { config: configFor({ mainnet }, { network: "mainnet" }) });
    await page.waitFor(`${liveState} === "soon"`, "the waiting state");

    assert.match(await page.evaluate(text(".soon")), /^The escrow opens with the mainnet launch\./);
    assert.equal(await page.evaluate(text("[data-network-tag]")), "ARC");
    assert.ok(!(await page.evaluate(isShown(".stats"))));
    assert.ok(!(await page.evaluate(isShown("[data-escrow-link]"))));
    assert.ok(!(await page.evaluate(isShown("[data-contracts]"))), "no contracts to name yet");
    assert.ok(!(await page.evaluate(isShown("[data-test-only]"))));
    assert.ok(!(await page.evaluate(isShown(".built-on .live-dot"))), "no live line before the escrow opens");
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

    assert.equal(
      await page.evaluate(`document.querySelector("h1").textContent.replace(/\\s+/g, " ").trim()`),
      "Don't turn off pull requests. Ask for good faith.",
    );
    assert.ok(!(await page.evaluate(isShown("[data-demo]"))), "no demo button without JavaScript");
    assert.ok(!(await page.evaluate(isShown(".built-on .live-dot"))), "no live line without JavaScript");
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
