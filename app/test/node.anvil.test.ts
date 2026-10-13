import { spawn } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, test } from "vitest";
import { freePort, startAnvil, type Anvil } from "./support/anvil.ts";
import { DEPOSIT_PAGE, SETUP_PAGE } from "./support/harness.ts";
import { fixture, SECRET, signed } from "./support/webhooks.ts";

let anvil: Anvil;

beforeAll(async () => {
  anvil = await startAnvil();
}, 120_000);

afterAll(() => anvil?.stop());

/** Runs `src/node.ts` against the local chain and waits until it listens. */
async function startNode(env: Record<string, string> = {}) {
  const port = await freePort();
  const decisions = join(await mkdtemp(join(tmpdir(), "bona-fide-node-")), "decisions.jsonl");
  const server = spawn(process.execPath, ["src/node.ts"], {
    env: {
      ...process.env,
      PORT: String(port),
      WEBHOOK_SECRET: SECRET,
      GITHUB_APP_ID: "1234",
      GITHUB_PRIVATE_KEY: "not used by a ping",
      RPC_URL: anvil.url,
      ESCROW_ADDRESS: anvil.escrow,
      ESCROW_FROM_BLOCK: String(anvil.deployBlock),
      DEPOSIT_PAGE_URL: DEPOSIT_PAGE,
      SETUP_PAGE_URL: SETUP_PAGE,
      ANTHROPIC_API_KEY: "",
      DECISIONS_PATH: decisions,
      ...env,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  server.stdout.on("data", (chunk) => (output += chunk));
  server.stderr.on("data", (chunk) => (output += chunk));
  const deadline = Date.now() + 10_000;
  while (!output.includes("listening") && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
  return { url: `http://127.0.0.1:${port}`, output: () => output, stop: () => server.kill() };
}

async function post(url: string, request: Request): Promise<number> {
  const response = await fetch(url, { method: "POST", headers: request.headers, body: await request.text() });
  return response.status;
}

test("the Node server answers a signed ping and rejects a forged delivery", async () => {
  const node = await startNode();
  try {
    expect(await post(`${node.url}/`, signed("ping", fixture("ping")))).toBe(200);
    expect(await post(`${node.url}/`, signed("ping", fixture("ping"), "not-the-secret"))).toBe(401);
    await new Promise((r) => setTimeout(r, 1500));
    expect(node.output()).not.toMatch(/error/i);
  } finally {
    node.stop();
  }
}, 30_000);

test("the Node server answers a health check without a signature", async () => {
  const node = await startNode();
  try {
    const response = await fetch(`${node.url}/health`);

    expect(response.status).toBe(200);
    expect(await response.text()).toBe("ok\n");
  } finally {
    node.stop();
  }
}, 30_000);

test("the Node server serves the decision log it reads back on start, and never a private repo's", async () => {
  const path = join(await mkdtemp(join(tmpdir(), "bona-fide-node-")), "decisions.jsonl");
  const decision = {
    id: "a",
    at: "2026-09-01T00:00:00.000Z",
    repo: "Acme/Widgets",
    private: false,
    item: { kind: "pr", number: 7 },
    serial: "3",
    type: "early-refund",
    inputs: { source: "webhook pull_request closed" },
    suggestion: null,
    witnesses: [{ name: "Merged", value: "yes" }],
    action: "refunded",
    txHash: `0x${"ab".repeat(32)}`,
    outcome: "decided",
    cost: null,
  };
  const secret = { ...decision, id: "b", repo: "acme/secret", private: true };
  await writeFile(path, `${JSON.stringify(decision)}\n${JSON.stringify(secret)}\n{"torn":`);
  const node = await startNode({ DECISIONS_PATH: path });
  try {
    const response = await fetch(`${node.url}/decisions?repo=acme/widgets`);
    const hidden = await fetch(`${node.url}/decisions?repo=acme/secret`);
    const malformed = await fetch(`${node.url}/decisions?repo=nope`);

    expect(response.status).toBe(200);
    expect(response.headers.get("access-control-allow-origin")).toBe("*");
    const { private: _, ...published } = decision;
    expect(await response.json()).toEqual({ counts: { decided: 1, escalated: 0 }, decisions: [published] });
    expect(await hidden.json()).toEqual({ counts: { decided: 0, escalated: 0 }, decisions: [] });
    expect(malformed.status).toBe(400);
    expect(node.output()).toContain(
      `Decision log: 2 decisions read from ${path}. Skipped 1 line that isn't a decision.`,
    );
  } finally {
    node.stop();
  }
}, 30_000);
