// The Contributor records' links in an append-only JSONL file, one link per line, for the Node host.
// It uses Node's file system, so src/index.ts doesn't export it.

import { appendFileSync, createReadStream, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { createInterface } from "node:readline";
import { lastByte } from "../decisions/file.ts";
import type { RecordLink } from "./records.ts";

export const DEFAULT_RECORDS_PATH = "data/records.jsonl";

const OUTCOMES: RecordLink["outcome"][] = ["active", "accepted", "refunded", "forfeited"];

export interface RecordFile {
  /** The links read back, oldest first: a later link of the same Deposit replaces an earlier one. */
  links: RecordLink[];
  /** Appends a link. */
  save(link: RecordLink): void;
  /** Lines that weren't a link, such as one torn by a crash mid-write. */
  skipped: number;
}

/**
 * Reads the file's links and appends each new one to it. A missing file has none, and is created
 * with the first link, readable by its owner only: it names who deposited in private repos.
 */
export async function openRecordFile(path: string): Promise<RecordFile> {
  const ending = await lastByte(path);
  // After a torn last line, the next link starts a line of its own.
  let lead = ending !== null && ending !== "\n" ? "\n" : "";
  const links: RecordLink[] = [];
  let skipped = 0;
  if (ending !== null) {
    const lines = createInterface({ input: createReadStream(path, "utf8"), crlfDelay: Infinity });
    for await (const line of lines) {
      if (line.trim() === "") continue;
      const link = parse(line);
      if (link) links.push(link);
      else skipped += 1;
    }
  }
  return {
    links,
    skipped,
    save(link) {
      mkdirSync(dirname(path), { recursive: true });
      appendFileSync(path, `${lead}${JSON.stringify(link)}\n`, { mode: 0o600 });
      lead = "";
    },
  };
}

function parse(line: string): RecordLink | null {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return null;
  }
  const l = value as Partial<RecordLink> | null;
  const valid =
    typeof l === "object" &&
    l !== null &&
    !Array.isArray(l) &&
    typeof l.key === "string" &&
    /^0x[0-9a-f]{64}$/i.test(l.key) &&
    typeof l.serial === "string" &&
    /^\d+$/.test(l.serial) &&
    typeof l.repo === "string" &&
    typeof l.private === "boolean" &&
    typeof l.author === "string" &&
    OUTCOMES.includes(l.outcome as RecordLink["outcome"]);
  return valid ? (l as RecordLink) : null;
}
