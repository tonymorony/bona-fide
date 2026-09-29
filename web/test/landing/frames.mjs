// Renders the landing page as deployed, reading the live network that config.js names (read-only
// calls), and saves a picture of it at 1280 and 390 px in light and dark:
//
//   node web/test/landing/frames.mjs [folder]      default: web/test/landing/frames/

import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { DESKTOP, PHONE, startChrome } from "./support/chrome.mjs";
import { serveLanding } from "./support/serve.mjs";

const folder = process.argv[2] ?? fileURLToPath(new URL("frames/", import.meta.url));
await mkdir(folder, { recursive: true });

const site = await serveLanding();
const chrome = await startChrome();
let failed = false;
try {
  for (const viewport of [DESKTOP, PHONE]) {
    for (const scheme of ["light", "dark"]) {
      const page = await chrome.newPage();
      await page.open(site.url, viewport, scheme);
      const state = await page.waitFor(
        `(() => { const s = document.querySelector("[data-live]").dataset.state; return s !== "loading" && s; })()`,
        "the live numbers",
        30_000,
      );
      const shown = await page.evaluate(
        `[...document.querySelectorAll("[data-value]")].map((el) => el.dataset.value + " " + el.textContent).join(", ")`,
      );
      const status = await page.evaluate(`document.querySelector("[data-live-status]").innerText`);
      const file = join(folder, `landing-${viewport.width}-${scheme}.png`);
      await page.screenshot(file);
      console.log(`${viewport.width} px, ${scheme}: ${state}. ${status}. ${shown}. Saved ${file}`);
      if (state !== "live" || page.errors.length > 0 || page.networkErrors.length > 0) {
        failed = true;
        console.error([...page.errors, ...page.networkErrors].join("\n"));
      }
      await page.close();
    }
  }
} finally {
  await chrome.close();
  await site.close();
}
process.exitCode = failed ? 1 : 0;
