// What the landing page's files promise without a browser: where it may connect, the escrows it
// reads, the brand files and fonts it loads, the Built on row, the escrow events it counts, its colour
// contrast, its words, its motion and its one theme.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, test } from "node:test";
import { CONFIG, NETWORKS } from "../../landing/config.js";
import { TOPICS } from "../../landing/landing.js";
import { artifact, buildContracts } from "./support/anvil.mjs";
import { LANDING } from "./support/serve.mjs";

const html = readFileSync(join(LANDING, "index.html"), "utf8");
const css = readFileSync(join(LANDING, "landing.css"), "utf8");

describe("the page's settings", () => {
  test("shows Arc mainnet", () => {
    assert.equal(CONFIG.network, "mainnet");
  });

  test("reads the testnet escrow and router that are deployed on Arc Testnet", () => {
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

  test("reads the mainnet escrow and router that are deployed on Arc", () => {
    assert.deepEqual(NETWORKS.mainnet, {
      name: "Arc",
      test: false,
      chainId: 5042,
      rpcUrl: "https://rpc.mainnet.arc.io",
      logsUrl: "https://explorer.arc.io/api/eth-rpc",
      logsRange: 0,
      explorerUrl: "https://explorer.arc.io",
      usdc: "0x3600000000000000000000000000000000000000",
      escrow: "0xe2fe798427CFb43134FC37F6EE054c2da818fAc9",
      escrowFromBlock: 24_583_718,
      router: "0xe36fe5152C6A54946b15df3fEBDc068AF48581dc",
    });
  });

  test("links the Install buttons to the App's installation page", () => {
    assert.equal(CONFIG.installUrl, "https://github.com/apps/bona-fide-deposits/installations/new");
    assert.equal(typeof CONFIG.installOpen, "boolean");
  });

  test("names a demo video by an https URL, or none", () => {
    assert.equal(typeof CONFIG.demoUrl, "string");
    if (CONFIG.demoUrl) assert.equal(new URL(CONFIG.demoUrl).protocol, "https:");
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

  test("loads scripts, styles, images and fonts from its own origin only", () => {
    assert.deepEqual(directives["default-src"], ["'none'"]);
    assert.deepEqual(directives["script-src"], ["'self'"]);
    assert.deepEqual(directives["style-src"], ["'self'"]);
    assert.deepEqual(directives["img-src"], ["'self'"]);
    assert.deepEqual(directives["font-src"], ["'self'"]);
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
    for (const path of [
      "brand/mark.svg",
      "brand/guilloche-rosette.svg",
      "brand/guilloche-waves.svg",
      "fonts/big-shoulders-display.woff2",
      "fonts/hanken-grotesk.woff2",
      "fonts/azeret-mono.woff2",
    ]) {
      assert.ok(local.includes(path), `the page doesn't load ${path}`);
    }
    for (const path of local) assert.ok(existsSync(join(LANDING, path)), `${path} is missing`);
  });

  test("names no retired brand file", () => {
    for (const name of ["hero.svg", "lockup.svg", "mark-accent.svg", "built-on-circle.svg", "built-on-anthropic.svg"]) {
      assert.ok(!html.includes(name) && !css.includes(name), name);
    }
  });

  test("declares each font self-hosted, as a variable weight range that swaps in", () => {
    const faces = [...css.matchAll(/@font-face \{([^}]+)\}/g)].map(([, body]) => body);
    assert.equal(faces.length, 3);
    for (const face of faces) {
      assert.match(face, /src: url\("fonts\/[\w-]+\.woff2"\) format\("woff2"\);/);
      assert.match(face, /font-weight: 100 900;/);
      assert.match(face, /font-display: swap;/);
    }
  });

  test("the social card and touch icon the head names are in brand/", () => {
    for (const [, url] of html.matchAll(/content="https:\/\/bofi\.live\/(brand\/[^"]+)"/g)) {
      assert.ok(existsSync(join(LANDING, url)), `${url} is missing`);
    }
    assert.match(html, /<link rel="icon" href="brand\/favicon\.svg"/);
    assert.match(html, /<link rel="apple-touch-icon" href="brand\/apple-touch-icon\.png"/);
    assert.match(html, /<meta property="og:image" content="https:\/\/bofi\.live\/brand\/og-card\.png"/);
    assert.match(html, /<meta name="twitter:image" content="https:\/\/bofi\.live\/brand\/og-card\.png"/);
  });
});

describe("the Built on row", () => {
  const row = html.match(/<div class="built-on">([\s\S]*?)<\/div>/)?.[1] ?? "";
  const images = [...row.matchAll(/<img\b[^>]*>/g)].map(([tag]) => tag);

  test("shows Arc's logo as its only image, and nothing else but the mainnet line under it", () => {
    assert.equal(images.length, 1, images.join("\n"));
    assert.match(images[0], /src="brand\/built-on-arc\.svg"/);
    assert.match(images[0], /alt="Arc"/);
    assert.match(images[0], /height="32"/);
    assert.match(css, /\.arc-logo img \{[^}]*height: 32px;/);
    assert.deepEqual(
      [...row.matchAll(/<p class="([^"]+)"/g)].map(([, name]) => name),
      ["mono label", "mono live-dot"],
    );
    assert.match(css, /\.live-dot \{[^}]*flex-basis: 100%;/);
  });

  test("keeps no logo of Circle or Anthropic in brand/", () => {
    assert.ok(!existsSync(join(LANDING, "brand/built-on-circle.svg")));
    assert.ok(!existsSync(join(LANDING, "brand/built-on-anthropic.svg")));
  });

  test("Arc's logo is plain shapes in one ink: no script, style or outside reference", () => {
    const logo = readFileSync(join(LANDING, "brand/built-on-arc.svg"), "utf8");
    assert.doesNotMatch(logo, /<script|<style|href=|url\(/);
    assert.deepEqual([...new Set([...logo.matchAll(/fill="(#[0-9a-f]+)"/gi)].map(([, fill]) => fill))], ["#16181d"]);
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
  const colours = block(css.slice(0, css.indexOf("/* Base */")));

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
  // [foreground, background]: text needs 4.5:1; big numerals and logos, 3:1.
  const text = [
    ...["page", "surface", "band", "paper", "warn-soft"].flatMap((bg) => [
      ["text", bg],
      ["text-2", bg],
      ["ink", bg],
    ]),
    ...["page", "surface", "band", "paper", "paper-2", "paper-3"].map((bg) => ["text-3", bg]),
    ["green", "page"],
    ["green", "surface"],
    ["red", "page"],
    ["red", "surface"],
    ...["paper", "paper-2", "paper-3"].flatMap((bg) => [
      ["green-deep", bg],
      ["red-deep", bg],
    ]),
    ["on-ink", "ink"],
    ["on-ink-2", "ink"],
    ["on-ink-3", "ink"],
    ["mint", "ink"],
    ["warn", "warn-soft"],
  ];
  const large = [
    ["numeral", "surface"],
    ["numeral-on-ink", "ink"],
    ["#16181d", "page"],
  ];

  test("text meets WCAG AA (4.5:1), and big numerals and the Arc logo 3:1", () => {
    assert.equal(colours.page, "#f6f4f9");
    assert.equal(colours.ink, "#2b2459");
    const check = (fg, bg, minimum) => {
      const ratio = contrast(fg.startsWith("#") ? fg : colours[fg], colours[bg]);
      assert.ok(ratio >= minimum, `--${fg} on --${bg}: ${ratio.toFixed(2)}:1`);
    };
    for (const [fg, bg] of text) check(fg, bg, 4.5);
    for (const [fg, bg] of large) check(fg, bg, 3);
  });
});

describe("the words", () => {
  const visible = html.replace(/<[^>]+>/g, " ");

  test("use the product's terms, never another name for a Deposit, a Forfeit or the router", () => {
    assert.doesNotMatch(visible, /\b(stake|staking|bond|slash\w*|charity|donation|donate)\b/i);
  });

  test("use no glyph the self-hosted latin subsets lack: ticks and arrows are drawn", () => {
    assert.doesNotMatch(visible, /[✓✍≥→↗]/u);
  });

  test("never say Bounties are live on mainnet", () => {
    assert.match(visible, /Bounties: coming to mainnet\./);
  });

  test("say that Bona Fide keeps nothing: in the lede, the rule's clauses and the FAQ", () => {
    const text = visible.replace(/\s+/g, " ");
    assert.match(text, /Bona Fide takes nothing, and nobody profits from a rejection\./);
    assert.match(text, /§4 What Bona Fide keeps, whatever happens\. The Maintainer gets nothing either\. 0%/);
    assert.match(text, /Who gets the money from a Forfeit\?[\s+]*Never Bona Fide, and never the Maintainer\./);
  });

  test("give a way to write to the people behind it", () => {
    assert.match(html, /<a href="mailto:tlysakov@gmail\.com">Contact: tlysakov@gmail\.com<\/a>/);
  });

  test("mark the certificate as an example", () => {
    assert.match(html, /<figcaption[^>]*>\s*An example certificate, for illustration/);
  });

  test("carry the trademark line", () => {
    assert.match(
      visible.replace(/\s+/g, " "),
      /Arc is a trademark of Circle Internet Group, Inc\. and\/or its affiliates\. All other trademarks are the property of their respective owners\. Bona Fide is not affiliated with or endorsed by Circle or Anthropic\./,
    );
  });
});

describe("motion", () => {
  test("the card's float, holo and sheen and the stamp stop when the visitor asks for less motion", () => {
    const reduced = css.slice(css.lastIndexOf("@media (prefers-reduced-motion: reduce)"));
    for (const selector of [".cert-float", ".cert-holo::before", ".cert-sheen", ".step-stamp"]) {
      assert.ok(reduced.includes(selector), selector);
    }
    assert.match(reduced, /animation: none;/);
  });
});

describe("the theme", () => {
  test("is light only: the page, its stylesheet and its images ignore the system's dark setting", () => {
    assert.match(html, /<meta name="color-scheme" content="light" \/>/);
    assert.match(css, /color-scheme: light;/);
    assert.doesNotMatch(html, /prefers-color-scheme/);
    assert.doesNotMatch(css, /prefers-color-scheme/);
    for (const name of readdirSync(join(LANDING, "brand")).filter((file) => file.endsWith(".svg"))) {
      assert.doesNotMatch(readFileSync(join(LANDING, "brand", name), "utf8"), /prefers-color-scheme/, name);
    }
  });
});
