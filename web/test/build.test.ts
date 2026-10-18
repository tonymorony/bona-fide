import { mkdtemp, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { buildPages } from "../build.ts";
import { mainnet, testnet } from "../networks.ts";

// The landing page shows mainnet, so a build that copies it is a mainnet build.
async function built(network = mainnet, landing = true) {
  const outDir = await mkdtemp(join(tmpdir(), "bona-fide-pages-"));
  const files = await buildPages({ network, outDir, landing });
  return { outDir, files, page: (name: string) => readFile(join(outDir, name), "utf8") };
}

test("the build writes the five pages as plain files, with the landing page at the root", async () => {
  const { outDir, files } = await built();
  const top = (await readdir(outDir)).sort();
  const landingTop = await readdir(join(import.meta.dirname, "../landing"));

  expect(top).toEqual(
    ["assets", "bounties.html", "deposit.html", "repo.html", "setup.html", "verdict.html", ...landingTop].sort(),
  );
  expect(top).toContain("index.html");
  expect(files).toEqual(
    expect.arrayContaining(["deposit.html", "verdict.html", "setup.html", "repo.html", "bounties.html", "index.html"]),
  );
  expect(files.filter((file) => file.startsWith("assets/") && file.endsWith(".css"))).toHaveLength(1);
}, 60_000);

test("the stylesheet's fonts and drawings are copied into the build, with the fonts' licence", async () => {
  const { outDir, files } = await built(mainnet, false);
  const assets = files.filter((file) => file.startsWith("assets/"));
  const css = await readFile(
    join(
      outDir,
      assets.find((file) => file.endsWith(".css"))!,
    ),
    "utf8",
  );

  for (const name of ["big-shoulders-display", "hanken-grotesk", "azeret-mono"]) {
    const font = assets.find((file) => new RegExp(`^assets/${name}-[0-9a-f]{10}\\.woff2$`).test(file));
    expect(font, name).toBeDefined();
    expect(css).toContain(`url("${font!.slice("assets/".length)}")`);
    expect(await readFile(join(outDir, font!))).toEqual(
      await readFile(join(import.meta.dirname, "../landing/fonts", `${name}.woff2`)),
    );
  }
  for (const name of ["guilloche-waves", "guilloche-rosette"]) {
    const drawing = assets.find((file) => new RegExp(`^assets/${name}-[0-9a-f]{10}\\.svg$`).test(file));
    expect(drawing, name).toBeDefined();
    expect(css).toContain(`url("${drawing!.slice("assets/".length)}")`);
  }
  expect(await readFile(join(outDir, "assets/OFL.txt"), "utf8")).toContain("SIL OPEN FONT LICENSE");
  // Every file the stylesheet names is in the build: nothing points outside assets/.
  for (const [, url] of css.matchAll(/url\("([^"]+)"\)/g)) expect(assets).toContain(`assets/${url}`);
}, 60_000);

test("the pages have one theme, light, whatever the system's setting", async () => {
  const { outDir, files, page } = await built(mainnet, false);
  const css = await readFile(
    join(
      outDir,
      files.find((file) => file.endsWith(".css"))!,
    ),
    "utf8",
  );

  expect(css).not.toMatch(/prefers-color-scheme|data-theme/);
  expect(css).toMatch(/color-scheme: light;/);
  for (const name of ["deposit.html", "verdict.html", "setup.html", "repo.html", "bounties.html"]) {
    expect(await page(name)).toContain('<meta name="color-scheme" content="light" />');
  }
}, 60_000);

test("the landing page's files are copied unchanged", async () => {
  const { outDir } = await built();

  for (const name of ["index.html", "config.js", "landing.js", "landing.css", "tilt.js", "brand/built-on-arc.svg"]) {
    const source = await readFile(join(import.meta.dirname, "../landing", name));
    expect(await readFile(join(outDir, name))).toEqual(source);
  }
}, 60_000);

test("a build stops when the landing page shows another network than the pages", async () => {
  await expect(
    buildPages({ network: { ...mainnet, chainId: 1 }, outDir: await mkdtemp(join(tmpdir(), "x-")) }),
  ).rejects.toThrow(/landing page shows "mainnet"/);
});

test("each page loads only files from the build: no CDN, no tracker", async () => {
  const { page } = await built();

  for (const name of ["deposit.html", "verdict.html", "setup.html", "repo.html", "bounties.html"]) {
    const html = await page(name);
    const loaded = [...html.matchAll(/<(?:script|link|img)\b[^>]*\b(?:src|href)="([^"]+)"/g)].map((m) => m[1]!);
    expect(loaded.length).toBeGreaterThan(2);
    for (const url of loaded) expect(url).toMatch(/^assets\/[\w.-]+$/);
    expect(html).not.toMatch(/\{\{|\}\}/);
    expect(html).not.toMatch(/style="/);
  }
}, 60_000);

test("the scripts carry the network's settings and bundle viem: they fetch no code at runtime", async () => {
  const { outDir, files } = await built();
  const code = (
    await Promise.all(files.filter((f) => f.endsWith(".js")).map((f) => readFile(join(outDir, f), "utf8")))
  ).join("\n");

  expect(code).toContain(mainnet.escrow);
  expect(code).toContain(mainnet.router);
  expect(code).not.toMatch(/\bimport\(\s*["']https?:/);
  expect(code).not.toMatch(/from\s*["']https?:/);
}, 60_000);

test("a build stops while the network's contracts have no addresses", async () => {
  const network = { ...mainnet, escrow: "" as const, router: "" as const };
  await expect(buildPages({ network, outDir: await mkdtemp(join(tmpdir(), "x-")) })).rejects.toThrow(
    /Arc has no escrow address yet[\s\S]*Arc has no router address yet/,
  );
});

test("a network without a Bounty wallet factory still builds, and its pages say Bounties aren't available yet", async () => {
  const { page } = await built({ ...testnet, bountyFactory: "" }, false);

  expect(await page("bounties.html")).toContain("Bounties aren't available on Arc Testnet yet");
  expect(await page("setup.html")).not.toContain("Post Bounties on issues");
  expect(await page("bounties.html")).not.toContain("Bounty wallet factory</a>");
}, 60_000);

test("a network's Bounty wallet factory must be an address, with its deploy block", async () => {
  await expect(
    buildPages({
      network: { ...testnet, bountyFactory: "0x123" },
      outDir: await mkdtemp(join(tmpdir(), "x-")),
    }),
  ).rejects.toThrow(/bountyFactory address isn't an address/);
  await expect(
    buildPages({ network: { ...testnet, bountyFactoryFromBlock: -1 }, outDir: await mkdtemp(join(tmpdir(), "x-")) }),
  ).rejects.toThrow(/bountyFactoryFromBlock must be the factory's deploy block/);
});

test("with a factory, the setup page links the Maintainer to the Bounty page", async () => {
  const factory = "0x0000000000000000000000000000000000000b0b";
  const { page } = await built({ ...testnet, bountyFactory: factory, bountyFactoryFromBlock: 1 }, false);

  expect(await page("setup.html")).toContain("Post Bounties on issues");
  expect(await page("bounties.html")).toContain(`/address/${factory}`);
}, 60_000);

test("a build stops if a WalletConnect project ID is set, since its SDK isn't bundled", async () => {
  await expect(
    buildPages({ network: { ...testnet, walletConnectProjectId: "abc" }, outDir: await mkdtemp(join(tmpdir(), "x-")) }),
  ).rejects.toThrow(/WalletConnect/);
});

test("testnet pages send Forfeits to the test recipient, and mainnet pages to Protocol Guild", async () => {
  const test = await built(testnet, false);
  const main = await built(mainnet, false);

  const testnetText = [await test.page("deposit.html"), await test.page("repo.html"), await test.page("setup.html")];
  const mainnetText = [await main.page("deposit.html"), await main.page("repo.html"), await main.page("setup.html")];
  expect(testnetText.join()).toContain("test recipient on Base Sepolia");
  expect(testnetText.join()).not.toContain("Protocol Guild");
  expect(mainnetText.join()).toContain("funds open-source maintainers through Protocol Guild");
  expect(mainnetText.join()).not.toContain("test recipient");
  expect(testnetText[0]).toContain(">Testnet<");
  expect(mainnetText[0]).not.toContain(">Testnet<");
}, 60_000);

test("mainnet's deposit page says how to get USDC on Arc, with the card button marked as coming", async () => {
  const main = await (await built(mainnet, false)).page("deposit.html");
  const test = await (await built(testnet, false)).page("deposit.html");

  expect(main).toMatch(/<button class="btn secondary block" type="button" disabled>Buy USDC with a card: coming soon</);
  expect(main).toMatch(/withdraw USDC from an exchange on the Arc network/);
  expect(main).toContain('<a href="https://portal.arc.io" target="_blank" rel="noopener">Arc Portal</a>');
  expect(test).not.toContain("Buy USDC with a card");
  expect(test).toContain("Get test USDC");
}, 60_000);

test("the mark in the top bar comes from web/brand, and is the landing page's seal", async () => {
  const { page, files, outDir } = await built();
  const mark = (await readFile(new URL("../brand/mark.svg", import.meta.url), "utf8")).trim();

  expect(await page("deposit.html")).toContain(mark);
  expect(mark).toBe((await readFile(new URL("../landing/brand/mark.svg", import.meta.url), "utf8")).trim());
  expect(mark).not.toMatch(/prefers-color-scheme/);
  const favicon = files.find((file) => /^assets\/favicon-[0-9a-f]{10}\.svg$/.test(file))!;
  expect(await readFile(join(outDir, favicon), "utf8")).toBe(
    await readFile(new URL("../landing/brand/favicon.svg", import.meta.url), "utf8"),
  );
  expect(await page("deposit.html")).toContain(`<link rel="icon" href="${favicon}" type="image/svg+xml" />`);
}, 60_000);

test("each page preloads the chunks its script imports, so they load at once instead of one after another", async () => {
  const { page, outDir } = await built();

  for (const name of ["deposit.html", "verdict.html", "setup.html", "repo.html", "bounties.html"]) {
    const html = await page(name);
    const script = /<script type="module" src="([^"]+)"/.exec(html)![1]!;
    const preloaded = [...html.matchAll(/<link rel="modulepreload" href="([^"]+)"/g)].map((m) => m[1]!);
    const code = await readFile(join(outDir, script), "utf8");
    const imported = [...code.matchAll(/from\s*"\.\/([^"]+\.js)"/g)].map((m) => `assets/${m[1]}`);
    expect(imported.length).toBeGreaterThan(0);
    for (const chunk of imported) expect(preloaded).toContain(chunk);
  }
}, 60_000);
