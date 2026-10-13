import { readFile } from "node:fs/promises";
import { expect, test } from "vitest";

// The pages' palette, read from the stylesheets and checked against WCAG AA: 4.5:1 for text, 3:1 for
// the edges of controls and for icons.

const css = `${await readFile(new URL("../brand/brand.css", import.meta.url), "utf8")}\n${await readFile(
  new URL("../styles/app.css", import.meta.url),
  "utf8",
)}`;
const declared = new Map([...css.matchAll(/^\s*(--[\w-]+):\s*([^;]+);/gm)].map(([, name, value]) => [name!, value!]));

/** A token's colour, following `var()` to the hex it names. */
function colour(token: string): string {
  let value = declared.get(token);
  for (let hops = 0; value?.startsWith("var(") && hops < 5; hops++) value = declared.get(value.slice(4, -1));
  if (!value || !/^#[0-9a-f]{6}$/i.test(value)) throw new Error(`${token} isn't a hex colour: ${value}`);
  return value;
}

function luminance(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((at) => {
    const channel = parseInt(hex.slice(at, at + 2), 16) / 255;
    return channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
}

function contrast(a: string, b: string): number {
  const [light, dark] = [luminance(colour(a)), luminance(colour(b))].sort((x, y) => y - x);
  return (light! + 0.05) / (dark! + 0.05);
}

const SURFACES = ["--page", "--surface", "--band", "--paper", "--paper-2", "--paper-3"];

test("text meets WCAG AA (4.5:1) on every surface it can sit on", () => {
  for (const text of ["--text", "--text-2", "--ink", "--green-deep", "--warn", "--red-deep"]) {
    for (const surface of SURFACES) {
      expect(contrast(text, surface), `${text} on ${surface}`).toBeGreaterThanOrEqual(4.5);
    }
  }
  for (const [text, surface] of [
    ["--on-ink", "--ink"],
    ["--surface", "--red"],
    ["--warn", "--warn-soft"],
    ["--green-deep", "--ok-soft"],
    ["--red-deep", "--danger-soft"],
    ["--text-2", "--warn-soft"],
    ["--text-2", "--ok-soft"],
    ["--text-2", "--danger-soft"],
  ] as const) {
    expect(contrast(text, surface), `${text} on ${surface}`).toBeGreaterThanOrEqual(4.5);
  }
});

test("the edges of controls and the icons meet 3:1", () => {
  for (const surface of ["--page", "--surface"]) {
    expect(contrast("--numeral", surface), `a control's edge on ${surface}`).toBeGreaterThanOrEqual(3);
  }
  expect(contrast("--mint", "--ink"), "the icon on an ink panel").toBeGreaterThanOrEqual(3);
});

test("the brand's colours and typefaces are the landing page's, with no second theme", async () => {
  const landing = await readFile(new URL("../landing/landing.css", import.meta.url), "utf8");
  const theirs = new Map(
    [...landing.matchAll(/^\s*(--[\w-]+):\s*([^;]+);/gm)].map(([, name, value]) => [name!, value!]),
  );

  const shared = ["--page", "--band", "--paper", "--ink", "--green", "--green-deep", "--red", "--red-deep", "--mint"];
  for (const token of [...shared, "--rule", "--rule-2", "--numeral", "--on-ink", "--font-display", "--font-mono"]) {
    expect(declared.get(token), token).toBe(theirs.get(token));
  }
  expect(colour("--bg")).toBe(colour("--page"));
  expect(colour("--accent")).toBe(colour("--ink"));
  expect(css).not.toMatch(/prefers-color-scheme|data-theme/);
});
