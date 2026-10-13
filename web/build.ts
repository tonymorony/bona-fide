// Builds the pages into dist/ as plain static files, for one network:
//
//   node build.ts            Arc testnet
//   node build.ts mainnet    Arc mainnet: stops while its contract addresses are missing
//
// Everything a page loads is in dist/: its script (viem bundled in), the stylesheet and the mark.
// The landing page's static files (landing/) are copied to the root of dist/, beside the pages.

import { createHash } from "node:crypto";
import { cp, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { rolldown } from "rolldown";
import { networks } from "./networks.ts";
import { problemsWith, type Network } from "./src/network.ts";

const HERE = fileURLToPath(new URL(".", import.meta.url));
export const PAGES = ["deposit", "verdict", "setup", "repo", "bounties"] as const;

const read = (path: string) => readFile(join(HERE, path), "utf8");
const shortHash = (content: string) => createHash("sha256").update(content).digest("hex").slice(0, 10);

function escapeHtml(text: string): string {
  return text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}

function valueAt(context: object, path: string): unknown {
  return path
    .split(".")
    .reduce<unknown>((value, key) => (value as Record<string, unknown> | undefined)?.[key], context);
}

async function expandPartials(html: string, depth = 0): Promise<string> {
  if (depth > 4) throw new Error("Partials nest too deep.");
  const names = [...new Set([...html.matchAll(/\{\{> ([\w-]+)\}\}/g)].map((match) => match[1]!))];
  for (const name of names) {
    const file =
      name === "lockup"
        ? "brand/lockup.html"
        : name === "icons"
          ? "pages/partials/icons.svg"
          : `pages/partials/${name}.html`;
    const partial = await expandPartials((await read(file)).trim(), depth + 1);
    html = html.replaceAll(`{{> ${name}}}`, partial);
  }
  return html;
}

/** Fills a page's template: partials, `{{#if path}}…{{/if}}` blocks, then `{{values}}`. */
async function fillTemplate(template: string, network: Network, assets: Record<string, string>): Promise<string> {
  const context = { ...network, network };
  let html = await expandPartials(template);
  html = html.replace(/\{\{#if ([\w.]+)\}\}([\s\S]*?)\{\{\/if\}\}/g, (_, path: string, body: string) =>
    valueAt(context, path) ? body : "",
  );
  html = html.replace(/\{\{([\w.:-]+)\}\}/g, (match, name: string) => {
    if (name in assets) return assets[name]!;
    if (name.startsWith("capital:")) {
      const value = String(valueAt(context, name.slice("capital:".length)) ?? "");
      if (!value) throw new Error(`Unknown placeholder ${match}.`);
      return escapeHtml(value.charAt(0).toUpperCase() + value.slice(1));
    }
    const value = valueAt(context, name);
    if (typeof value !== "string" && typeof value !== "number") throw new Error(`Unknown placeholder ${match}.`);
    return escapeHtml(String(value));
  });
  const leftover = html.match(/\{\{[^}]*\}\}/);
  if (leftover) throw new Error(`Unfilled placeholder ${leftover[0]}.`);
  return html;
}

/** Builds every page for `network` into `outDir`, and returns the files written, relative to it. */
export async function buildPages({
  network,
  outDir = join(HERE, "dist"),
  landing = true,
}: {
  network: Network;
  outDir?: string;
  /** Copy the landing page into the build, as deploys need. Tests of the pages alone turn it off. */
  landing?: boolean;
}): Promise<string[]> {
  const problems = problemsWith(network);
  if (problems.length > 0) {
    throw new Error(`Can't build the pages for ${network.name}:\n- ${problems.join("\n- ")}`);
  }
  const landingDir = join(HERE, "landing");
  const { CONFIG, NETWORKS } = await import(pathToFileURL(join(landingDir, "config.js")).href);
  if (landing && NETWORKS[CONFIG.network]?.chainId !== network.chainId) {
    throw new Error(
      `The landing page shows "${CONFIG.network}" but the pages are built for ${network.name}. ` +
        "Set network in landing/config.js to match.",
    );
  }
  await rm(outDir, { recursive: true, force: true });
  await mkdir(join(outDir, "assets"), { recursive: true });
  const written: string[] = [];
  const write = async (path: string, content: string) => {
    await writeFile(join(outDir, path), content);
    written.push(path);
  };

  const bundle = await rolldown({
    input: Object.fromEntries(PAGES.map((page) => [page, join(HERE, "src/pages", `${page}.ts`)])),
    platform: "browser",
    transform: { define: { __NETWORK__: JSON.stringify(network) } },
    logLevel: "warn",
  });
  const { output } = await bundle.write({
    dir: join(outDir, "assets"),
    format: "esm",
    entryFileNames: "[name]-[hash].js",
    chunkFileNames: "[name]-[hash].js",
    minify: true,
  });
  await bundle.close();
  const scripts = new Map<string, string>();
  const imports = new Map<string, string[]>();
  for (const chunk of output) {
    written.push(`assets/${chunk.fileName}`);
    if (chunk.type !== "chunk") continue;
    imports.set(chunk.fileName, chunk.imports);
    if (chunk.isEntry) scripts.set(chunk.name, chunk.fileName);
  }
  // Every chunk a page's script imports, however deep, so the browser fetches them all at once.
  const preloadsOf = (entry: string): string => {
    const seen = new Set<string>();
    const visit = (file: string) => {
      for (const next of imports.get(file) ?? []) {
        if (!seen.has(next)) {
          seen.add(next);
          visit(next);
        }
      }
    };
    visit(entry);
    return [...seen].map((file) => `<link rel="modulepreload" href="assets/${file}" />`).join("\n");
  };

  const css = `${await read("brand/brand.css")}\n${await read("styles/app.css")}`;
  const cssPath = `assets/app-${shortHash(css)}.css`;
  await write(cssPath, css);
  const mark = (await read("brand/mark.svg")).trim();
  const markPath = `assets/mark-${shortHash(mark)}.svg`;
  await write(markPath, `${mark}\n`);

  for (const page of PAGES) {
    const html = await fillTemplate(await read(`pages/${page}.html`), network, {
      mark,
      "asset:css": cssPath,
      "asset:mark": markPath,
      "page-script": `assets/${scripts.get(page)!}`,
      "page-preloads": preloadsOf(scripts.get(page)!),
    });
    await write(`${page}.html`, html);
  }

  if (!landing) return written;
  const landingFiles = (await readdir(landingDir, { recursive: true, withFileTypes: true }))
    .filter((entry) => entry.isFile())
    .map((entry) => join(entry.parentPath, entry.name).slice(landingDir.length + 1));
  const clashes = landingFiles.filter((file) => written.includes(file));
  if (clashes.length > 0) throw new Error(`The landing page would overwrite ${clashes.join(", ")}.`);
  await cp(landingDir, outDir, { recursive: true });
  written.push(...landingFiles);
  return written;
}

if (import.meta.main) {
  const name = process.argv[2] ?? "testnet";
  const network = networks[name as keyof typeof networks];
  if (!network) {
    console.error(`Unknown network "${name}". Build with testnet or mainnet.`);
    process.exit(1);
  }
  try {
    const files = await buildPages({ network });
    console.log(`Built the pages for ${network.name} into web/dist: ${files.length} files.`);
  } catch (error) {
    console.error((error as Error).message);
    process.exit(1);
  }
}
