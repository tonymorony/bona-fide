// What the landing page's files promise without a browser: where it may connect, the testnet
// escrow it reads, the brand files it loads, the escrow events it counts and its colour contrast.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, test } from "node:test";
import { CONFIG, NETWORKS } from "../../landing/config.js";
import { TOPICS } from "../../landing/landing.js";
import { artifact, buildContracts } from "./support/anvil.mjs";
import { LANDING } from "./support/serve.mjs";

const html = readFileSync(join(LANDING, "index.html"), "utf8");
const css = readFileSync(join(LANDING, "landing.css"), "utf8");

describe("the page's settings", () => {
  test("reads the testnet escrow and router that are deployed on Arc Testnet", () => {
    assert.equal(CONFIG.network, "testnet");
    assert.deepEqual(NETWORKS.testnet, {
      name: "Arc Testnet",
      test: true,
      chainId: 5042002,
      rpcUrl: "https://rpc.testnet.arc.io",
      logsUrl: "https://explorer.testnet.arc.io/api/eth-rpc",
      logsRange: 0,
      explorerUrl: "https://explorer.testnet.arc.io",
      usdc: "0x3600000000000000000000000000000000000000",
      escrow: "0x05283F2c7D94D66669227Cecf75abBbd024771A7",
      escrowFromBlock: 64_367_399,
      router: "0xae079DC6536c270d2743c0721cfC41c94E12ca9f",
    });
  });

  test("names Arc mainnet by its chain and explorer", () => {
    assert.equal(NETWORKS.mainnet.chainId, 5042);
    assert.equal(NETWORKS.mainnet.explorerUrl, "https://explorer.arc.io");
    assert.equal(NETWORKS.mainnet.usdc, "0x3600000000000000000000000000000000000000");
  });

  test("links the Install buttons to the App's installation page", () => {
    assert.equal(CONFIG.installUrl, "https://github.com/apps/bona-fide-deposits/installations/new");
    assert.equal(typeof CONFIG.installOpen, "boolean");
  });
});

describe("where the page may connect", () => {
  const policy = html.match(/http-equiv="Content-Security-Policy"\s+content="([^"]+)"/)?.[1];
  const directives = Object.fromEntries(
    (policy ?? "").split(";").map((directive) => {
      const [name, ...sources] = directive.trim().split(/\s+/);
      return [name, sources];
    }),
  );

  test("allows exactly the RPC and log endpoints of its networks", () => {
    const origins = new Set(
      Object.values(NETWORKS).flatMap((network) => [network.rpcUrl, network.logsUrl].map((url) => new URL(url).origin)),
    );
    assert.deepEqual(new Set(directives["connect-src"]), origins);
  });

  test("loads scripts, styles and images from its own origin only", () => {
    assert.deepEqual(directives["default-src"], ["'none'"]);
    assert.deepEqual(directives["script-src"], ["'self'"]);
    assert.deepEqual(directives["style-src"], ["'self'"]);
    assert.deepEqual(directives["img-src"], ["'self'"]);
  });

  test("has no inline scripts, inline styles or third-party resources", () => {
    assert.doesNotMatch(html, /<script(?![^>]*\bsrc=)[^>]*>/);
    assert.doesNotMatch(html, /<style|\sstyle="/);
    for (const [, url] of html.matchAll(/\b(?:src|srcset)="([^"]+)"/g)) assert.doesNotMatch(url, /^(https?:)?\/\//);
    for (const [, url] of html.matchAll(/<link[^>]*\bhref="([^"]+)"/g)) assert.doesNotMatch(url, /^(https?:)?\/\//);
  });
});

describe("the brand slots", () => {
  test("every file the page and its stylesheet load exists", () => {
    const local = [
      ...[...html.matchAll(/\b(?:src|srcset|href)="([^"#:]+)"/g)].map(([, path]) => path),
      ...[...css.matchAll(/url\("([^"]+)"\)/g)].map(([, path]) => path),
    ].filter((path) => path !== "./");
    assert.ok(local.includes("brand/hero-light.svg") && local.includes("brand/hero-dark.svg"));
    for (const path of local) assert.ok(existsSync(join(LANDING, path)), `${path} is missing`);
  });

  test("the social card and touch icon the head names are in brand/", () => {
    for (const [, url] of html.matchAll(/content="https:\/\/bonafide\.lysakov\.com\/(brand\/[^"]+)"/g)) {
      assert.ok(existsSync(join(LANDING, url)), `${url} is missing`);
    }
    assert.match(html, /<link rel="icon" href="brand\/favicon\.svg"/);
    assert.match(html, /<link rel="apple-touch-icon" href="brand\/apple-touch-icon\.png"/);
    assert.match(html, /<meta property="og:image" content="https:\/\/bonafide\.lysakov\.com\/brand\/og-card\.png"/);
    assert.match(html, /<meta name="twitter:image" content="https:\/\/bonafide\.lysakov\.com\/brand\/og-card\.png"/);
  });
});

describe("the escrow's events", () => {
  test("each topic is the keccak256 of the event's signature in the escrow's ABI", () => {
    buildContracts();
    const events = artifact("BonaFideEscrow").abi.filter((item) => item.type === "event");
    const topicOf = (name) => {
      const event = events.find((item) => item.name === name);
      const signature = `${name}(${event.inputs.map((input) => input.type).join(",")})`;
      return execFileSync("cast", ["keccak", signature], { encoding: "utf8" }).trim();
    };
    assert.deepEqual(TOPICS, {
      deposited: topicOf("Deposited"),
      refunded: topicOf("Refunded"),
      forfeited: topicOf("Forfeited"),
    });
  });
});

describe("colour contrast", () => {
  const block = (source) =>
    Object.fromEntries(
      [...source.matchAll(/--([\w-]+):\s*(#[0-9a-f]{6})\s*;/gi)].map(([, name, value]) => [name, value]),
    );
  const light = block(css.slice(0, css.indexOf("@media (prefers-color-scheme: dark)")));
  const dark = {
    ...light,
    ...block(css.slice(css.indexOf("@media (prefers-color-scheme: dark)"), css.indexOf("/* Base */"))),
  };

  const luminance = (hex) => {
    const [r, g, b] = [1, 3, 5].map((i) => {
      const channel = parseInt(hex.slice(i, i + 2), 16) / 255;
      return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };
  const contrast = (a, b) => {
    const [high, low] = [luminance(a), luminance(b)].sort((x, y) => y - x);
    return (high + 0.05) / (low + 0.05);
  };
  const text = [
    ["text", "bg"],
    ["text", "surface"],
    ["text", "tint"],
    ["text-2", "bg"],
    ["text-2", "surface"],
    ["text-2", "surface-2"],
    ["link", "bg"],
    ["link", "surface"],
    ["link", "tint"],
    ["warn", "warn-soft"],
  ];
  const icons = [
    ["ok", "ok-soft"],
    ["ok", "surface"],
    ["link", "tint"],
    ["warn", "warn-soft"],
  ];

  for (const [scheme, colours] of [
    ["light", light],
    ["dark", dark],
  ]) {
    test(`text meets WCAG AA (4.5:1) and icons 3:1 in ${scheme}`, () => {
      assert.equal(light.accent, "#04657e");
      assert.equal(dark.accent, "#047996");
      const check = (fg, bg, minimum, label = `--${fg} on --${bg}`) => {
        const ratio = contrast(fg.startsWith("#") ? fg : colours[fg], colours[bg]);
        assert.ok(ratio >= minimum, `${label}: ${ratio.toFixed(2)}:1`);
      };
      for (const [fg, bg] of text) check(fg, bg, 4.5);
      for (const bg of ["accent", "accent-hover"]) check("#ffffff", bg, 4.5, `white on --${bg}`);
      for (const [fg, bg] of icons) check(fg, bg, 3);
    });
  }
});
