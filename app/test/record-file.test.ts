import { appendFile, mkdtemp, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { openRecordFile } from "../src/records/file.ts";
import type { RecordLink } from "../src/records/records.ts";

// The Node host keeps the Contributor records' links in an append-only JSONL file, beside the
// decision log, so a restart doesn't look every Deposit up on GitHub again.

function link(serial: string, more: Partial<RecordLink> = {}): RecordLink {
  return {
    key: `0x${"ab".repeat(32)}`,
    serial,
    repo: "acme/widgets",
    private: false,
    author: "newcomer",
    outcome: "accepted",
    ...more,
  };
}

async function tempPath(): Promise<string> {
  return join(await mkdtemp(join(tmpdir(), "bona-fide-records-")), "data", "records.jsonl");
}

test("links are appended one JSON line each, and read back after a restart", async () => {
  const path = await tempPath();
  const first = await openRecordFile(path);
  first.save(link("1", { outcome: "active" }));
  first.save(link("1"));
  first.save(link("2", { repo: "acme/secret", private: true, outcome: "forfeited" }));

  const restarted = await openRecordFile(path);

  expect(first.links).toEqual([]);
  expect(restarted.links).toEqual([
    link("1", { outcome: "active" }),
    link("1"),
    link("2", { repo: "acme/secret", private: true, outcome: "forfeited" }),
  ]);
  expect(restarted.skipped).toBe(0);
});

test("a line torn by a crash is skipped, and the next link starts on a line of its own", async () => {
  const path = await tempPath();
  (await openRecordFile(path)).save(link("1"));
  await appendFile(path, JSON.stringify(link("2")).slice(0, 30));

  const restarted = await openRecordFile(path);
  restarted.save(link("3"));
  const again = await openRecordFile(path);

  expect(restarted.skipped).toBe(1);
  expect(again.links.map((l) => l.serial)).toEqual(["1", "3"]);
  expect(again.skipped).toBe(1);
});

test("a line that isn't a link is skipped", async () => {
  const path = await tempPath();
  (await openRecordFile(path)).save(link("1"));
  await appendFile(path, `{"hello":"world"}\n${JSON.stringify(link("2", { outcome: "lost" as "active" }))}\n`);

  const restarted = await openRecordFile(path);

  expect(restarted.links).toHaveLength(1);
  expect(restarted.skipped).toBe(2);
});

test("a missing file has no links, and the file is readable by its owner only", async () => {
  const path = await tempPath();

  const opened = await openRecordFile(path);
  expect(opened.links).toEqual([]);
  await expect(readFile(path, "utf8")).rejects.toThrow();

  opened.save(link("1"));
  expect((await stat(path)).mode & 0o077).toBe(0);
});
