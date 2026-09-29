import { mkdtemp, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { buildPages } from "../build.ts";
import { mainnet, testnet } from "../networks.ts";

async function built(network = testnet, landing = true) {
  const outDir = await mkdtemp(join(tmpdir(), "bona-fide-pages-"));
  const files = await buildPages({ network, outDir, landing });
  return { outDir, files, page: (name: string) => readFile(join(outDir, name), "utf8") };
}

test("the build writes the four pages as plain files, with the landing page at the root", async () => {
  const { outDir, files } = await built();
  const top = (await readdir(outDir)).sort();
  const landingTop = await readdir(join(import.meta.dirname, "../landing"));

  expect(top).toEqual(["assets", "deposit.html", "repo.html", "setup.html", "verdict.html", ...landingTop].sort());
  expect(top).toContain("index.html");
  expect(files).toEqual(
    expect.arrayContaining(["deposit.html", "verdict.html", "setup.html", "repo.html", "index.html"]),
  );
  expect(files.filter((file) => file.startsWith("assets/") && file.endsWith(".css"))).toHaveLength(1);
  expect(files.filter((file) => file.startsWith("assets/") && file.endsWith(".svg"))).toHaveLength(1);
}, 60_000);

test("the landing page's files are copied unchanged", async () => {
  const { outDir } = await built();

  for (const name of ["index.html", "config.js", "landing.js", "landing.css", "brand/hero-light.svg"]) {
    const source = await readFile(join(import.meta.dirname, "../landing", name));
    expect(await readFile(join(outDir, name))).toEqual(source);
  }
}, 60_000);

test("a build stops when the landing page shows another network than the pages", async () => {
  await expect(
    buildPages({ network: { ...testnet, chainId: 1 }, outDir: await mkdtemp(join(tmpdir(), "x-")) }),
  ).rejects.toThrow(/landing page shows "testnet"/);
});

test("each page loads only files from the build: no CDN, no tracker", async () => {
  const { page } = await built();

  for (const name of ["deposit.html", "verdict.html", "setup.html", "repo.html"]) {
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

  expect(code).toContain(testnet.escrow);
  expect(code).toContain(testnet.router);
  expect(code).not.toMatch(/\bimport\(\s*["']https?:/);
  expect(code).not.toMatch(/from\s*["']https?:/);
}, 60_000);

test("a mainnet build stops while the mainnet contracts have no addresses", async () => {
  await expect(buildPages({ network: mainnet, outDir: await mkdtemp(join(tmpdir(), "x-")) })).rejects.toThrow(
    /Arc has no escrow address yet[\s\S]*Arc has no router address yet/,
  );
});

test("a build stops if a WalletConnect project ID is set, since its SDK isn't bundled", async () => {
  await expect(
    buildPages({ network: { ...testnet, walletConnectProjectId: "abc" }, outDir: await mkdtemp(join(tmpdir(), "x-")) }),
  ).rejects.toThrow(/WalletConnect/);
});

test("testnet pages send Forfeits to the test recipient, and mainnet pages to Protocol Guild", async () => {
  const test = await built();
  const main = await built(
    {
      ...mainnet,
      escrow: "0x05283F2c7D94D66669227Cecf75abBbd024771A7",
      router: "0xae079DC6536c270d2743c0721cfC41c94E12ca9f",
    },
    false,
  );

  const testnetText = [await test.page("deposit.html"), await test.page("repo.html"), await test.page("setup.html")];
  const mainnetText = [await main.page("deposit.html"), await main.page("repo.html"), await main.page("setup.html")];
  expect(testnetText.join()).toContain("test recipient on Base Sepolia");
  expect(testnetText.join()).not.toContain("Protocol Guild");
  expect(mainnetText.join()).toContain("funds open-source maintainers through Protocol Guild");
  expect(mainnetText.join()).not.toContain("test recipient");
  expect(testnetText[0]).toContain(">Testnet<");
  expect(mainnetText[0]).not.toContain(">Testnet<");
}, 60_000);

test("the placeholder mark comes from web/brand, so the real identity is one change", async () => {
  const { page, files, outDir } = await built();
  const mark = (await readFile(new URL("../brand/mark.svg", import.meta.url), "utf8")).trim();

  expect(await page("deposit.html")).toContain(mark);
  const markFile = files.find((f) => f.endsWith(".svg"))!;
  expect((await readFile(join(outDir, markFile), "utf8")).trim()).toBe(mark);
}, 60_000);

test("each page preloads the chunks its script imports, so they load at once instead of one after another", async () => {
  const { page, outDir } = await built();

  for (const name of ["deposit.html", "verdict.html", "setup.html", "repo.html"]) {
    const html = await page(name);
    const script = /<script type="module" src="([^"]+)"/.exec(html)![1]!;
    const preloaded = [...html.matchAll(/<link rel="modulepreload" href="([^"]+)"/g)].map((m) => m[1]!);
    const code = await readFile(join(outDir, script), "utf8");
    const imported = [...code.matchAll(/from\s*"\.\/([^"]+\.js)"/g)].map((m) => `assets/${m[1]}`);
    expect(imported.length).toBeGreaterThan(0);
    for (const chunk of imported) expect(preloaded).toContain(chunk);
  }
}, 60_000);
