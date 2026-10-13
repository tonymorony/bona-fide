import { appendFile, mkdtemp, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { openDecisionFile } from "../src/decisions/file.ts";
import type { Decision } from "../src/ports.ts";

// The Node host keeps the decision log in an append-only JSONL file, one decision per line, and
// reads it back on start.

function decision(id: string, more: Partial<Decision> = {}): Decision {
  return {
    id,
    at: "2026-09-01T00:00:00.000Z",
    repo: "acme/widgets",
    private: false,
    item: { kind: "issue", number: 7 },
    serial: "3",
    type: "triage",
    inputs: { titleChars: 10, bodyChars: 200, bodyLeftOut: 0 },
    suggestion: { verdict: "accept", reasons: ["It reports a real bug."] },
    witnesses: [{ name: "Labels", value: "none" }],
    action: "noted-accept",
    txHash: null,
    outcome: "decided",
    cost: { model: "claude-opus-5", inputTokens: 1_200, outputTokens: 80, usd: 0.008 },
    ...more,
  };
}

async function tempPath(): Promise<string> {
  return join(await mkdtemp(join(tmpdir(), "bona-fide-decisions-")), "data", "decisions.jsonl");
}

test("decisions are appended one JSON line each, and read back after a restart", async () => {
  const path = await tempPath();
  const first = await openDecisionFile(path);
  first.log.append(decision("a"));
  first.log.append(decision("b", { outcome: "escalated", action: "drafted-verdict" }));

  const restarted = await openDecisionFile(path);

  const lines = (await readFile(path, "utf8")).split("\n");
  expect(lines).toHaveLength(3);
  expect(JSON.parse(lines[0]!)).toEqual(decision("a"));
  expect(lines[2]).toBe("");
  expect(restarted.loaded).toBe(2);
  expect(restarted.skipped).toBe(0);
  expect(restarted.log.counts("acme/widgets")).toEqual({ decided: 1, escalated: 1 });
  expect(restarted.log.latest("acme/widgets", 50).map((d) => d.id)).toEqual(["b", "a"]);
});

test("a missing file is an empty log, and nothing is written until the first decision", async () => {
  const path = await tempPath();

  const opened = await openDecisionFile(path);

  expect(opened.loaded).toBe(0);
  expect(opened.log.counts("acme/widgets")).toEqual({ decided: 0, escalated: 0 });
  await expect(readFile(path, "utf8")).rejects.toThrow();
});

test("a line torn by a crash is skipped, and the next decision starts on a line of its own", async () => {
  const path = await tempPath();
  const first = await openDecisionFile(path);
  first.log.append(decision("a"));
  await appendFile(path, JSON.stringify(decision("torn")).slice(0, 40));

  const restarted = await openDecisionFile(path);
  restarted.log.append(decision("c"));
  const again = await openDecisionFile(path);

  expect(restarted.loaded).toBe(1);
  expect(restarted.skipped).toBe(1);
  expect(again.loaded).toBe(2);
  expect(again.skipped).toBe(1);
  expect(again.log.latest("acme/widgets", 50).map((d) => d.id)).toEqual(["c", "a"]);
});

test("a line that isn't a decision is skipped", async () => {
  const path = await tempPath();
  await openDecisionFile(path).then(({ log }) => log.append(decision("a")));
  await appendFile(path, '{"hello":"world"}\n\n[]\n');

  const restarted = await openDecisionFile(path);

  expect(restarted.loaded).toBe(1);
  expect(restarted.skipped).toBe(2);
});

test("a private repo's decision is kept in the file, but not published", async () => {
  const path = await tempPath();
  await openDecisionFile(path).then(({ log }) => log.append(decision("a", { repo: "acme/secret", private: true })));

  const restarted = await openDecisionFile(path);

  expect(await readFile(path, "utf8")).toContain('"private":true');
  expect(restarted.log.latest("acme/secret", 50)).toEqual([]);
  expect(restarted.log.counts("acme/secret")).toEqual({ decided: 0, escalated: 0 });
});

test("the file is readable by its owner only, as it holds private repos' decisions too", async () => {
  const path = await tempPath();
  const { log } = await openDecisionFile(path);
  log.append(decision("a"));

  expect((await stat(path)).mode & 0o077).toBe(0);
});
