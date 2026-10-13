// The decision log in an append-only JSONL file, one decision per line, for the Node host. It uses
// Node's file system, so src/index.ts doesn't export it.

import { appendFileSync, createReadStream, mkdirSync } from "node:fs";
import { open } from "node:fs/promises";
import { dirname } from "node:path";
import { createInterface } from "node:readline";
import type { Decision, DecisionLog } from "../ports.ts";
import { createDecisionLog } from "./log.ts";

export const DEFAULT_DECISIONS_PATH = "data/decisions.jsonl";

export interface DecisionFile {
  log: DecisionLog;
  /** Decisions read back from the file. */
  loaded: number;
  /** Lines that weren't a decision, such as one torn by a crash mid-write. */
  skipped: number;
}

/**
 * Reads the file's decisions into memory and appends each new one to it. A missing file is an empty
 * log, created with the first decision, readable by its owner only. The whole file is read on each
 * start, and memory keeps only the counts and the latest decisions of each repo.
 */
export async function openDecisionFile(path: string): Promise<DecisionFile> {
  const ending = await lastByte(path);
  // After a torn last line, the next decision starts a line of its own.
  let lead = ending !== null && ending !== "\n" ? "\n" : "";
  let reading = true;
  const log = createDecisionLog({
    // A decision that can't be written is still served until a restart. The error is logged in
    // full, and never stops the Refund or the note it records.
    write(decision) {
      if (reading) return;
      try {
        mkdirSync(dirname(path), { recursive: true });
        appendFileSync(path, `${lead}${JSON.stringify(decision)}\n`, { mode: 0o600 });
        lead = "";
      } catch (error) {
        console.error(`decision log: could not write decision ${decision.id} to ${path}:`, error);
      }
    },
  });
  let loaded = 0;
  let skipped = 0;
  if (ending !== null) {
    const lines = createInterface({ input: createReadStream(path, "utf8"), crlfDelay: Infinity });
    for await (const line of lines) {
      if (line.trim() === "") continue;
      const decision = parse(line);
      if (!decision) {
        skipped += 1;
        continue;
      }
      log.append(decision);
      loaded += 1;
    }
  }
  reading = false;
  return { log, loaded, skipped };
}

/** The file's last character, "" if it is empty, or null if there is no file. */
async function lastByte(path: string): Promise<string | null> {
  let file;
  try {
    file = await open(path, "r");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  try {
    const { size } = await file.stat();
    if (size === 0) return "";
    const { buffer } = await file.read(Buffer.alloc(1), 0, 1, size - 1);
    return buffer.toString("utf8");
  } finally {
    await file.close();
  }
}

function parse(line: string): Decision | null {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return null;
  }
  const d = value as Partial<Decision> | null;
  const valid =
    typeof d === "object" &&
    d !== null &&
    !Array.isArray(d) &&
    typeof d.id === "string" &&
    typeof d.at === "string" &&
    typeof d.repo === "string" &&
    typeof d.private === "boolean" &&
    (d.outcome === "decided" || d.outcome === "escalated");
  return valid ? (d as Decision) : null;
}
