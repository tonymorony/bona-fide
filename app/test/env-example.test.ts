import { readdirSync, readFileSync } from "node:fs";
import { expect, test } from "vitest";

const SRC = new URL("../src/", import.meta.url);
const ENV_EXAMPLE = new URL("../../deploy/.env.example", import.meta.url);

/** Variables the App's source reads, as `process.env.NAME` or through the Node host's `env("NAME")`. */
function variablesRead(): string[] {
  const names = new Set<string>();
  for (const file of readdirSync(SRC, { recursive: true, encoding: "utf8" })) {
    if (!file.endsWith(".ts")) continue;
    const code = readFileSync(new URL(file, SRC), "utf8");
    for (const match of code.matchAll(/process\.env\.([A-Z][A-Z0-9_]*)|\benv\("([A-Z][A-Z0-9_]*)"\)/g)) {
      names.add((match[1] ?? match[2])!);
    }
  }
  return [...names];
}

/** `NAME=value` lines, including optional ones left commented out as `# NAME=value`. */
function variablesListed(): Map<string, string> {
  const text = readFileSync(ENV_EXAMPLE, "utf8");
  return new Map([...text.matchAll(/^#?\s*([A-Z][A-Z0-9_]*)=(.*)$/gm)].map((match) => [match[1]!, match[2]!]));
}

test("deploy/.env.example lists exactly the variables the App reads", () => {
  const read = variablesRead();

  expect(read).toContain("WEBHOOK_SECRET");
  expect([...variablesListed().keys()].sort()).toEqual(read.sort());
});

test("deploy/.env.example leaves every secret empty, so an unfilled copy can't run with a known secret", () => {
  const secrets = [...variablesListed()].filter(([name]) => /(SECRET|PRIVATE_KEY)$/.test(name));

  expect(secrets.length).toBeGreaterThan(0);
  expect(secrets.filter(([, value]) => value !== "")).toEqual([]);
});
