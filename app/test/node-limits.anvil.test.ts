import { spawn } from "node:child_process";
import { connect } from "node:net";
import { generatePrivateKey } from "viem/accounts";
import { afterAll, beforeAll, expect, test } from "vitest";
import { freePort, type Anvil } from "./support/anvil.ts";
import { DEPOSIT_PAGE, scratchDecisionsPath, SETUP_PAGE } from "./support/harness.ts";
import { SIGN_PAGE, startKeeperAnvil } from "./support/keeper.ts";
import { SECRET } from "./support/webhooks.ts";

// The Node host with the Keeper and the relay on, against the real escrow on anvil.

const KiB = 1024;
const MiB = 1024 * KiB;

let anvil: Anvil;
let keys: Record<string, string>;
let host: Awaited<ReturnType<typeof startHost>>;

beforeAll(async () => {
  const started = await startKeeperAnvil();
  anvil = started.anvil;
  keys = { KEEPER_PRIVATE_KEY: started.keeperKey, RELAYER_PRIVATE_KEY: generatePrivateKey() };
  host = await startHost(keys);
}, 120_000);

afterAll(() => {
  host?.stop();
  anvil?.stop();
});

async function startHost(env: Record<string, string>) {
  const port = await freePort();
  const server = spawn(process.execPath, ["src/node.ts"], {
    env: {
      ...process.env,
      PORT: String(port),
      WEBHOOK_SECRET: SECRET,
      GITHUB_APP_ID: "1234",
      GITHUB_PRIVATE_KEY: "not used here",
      RPC_URL: anvil.url,
      // The local chain refuses nothing, so the host needn't pace itself.
      RPC_RPS: "1000",
      ESCROW_ADDRESS: anvil.escrow,
      ESCROW_FROM_BLOCK: String(anvil.deployBlock),
      DEPOSIT_PAGE_URL: DEPOSIT_PAGE,
      SETUP_PAGE_URL: SETUP_PAGE,
      SIGN_PAGE_URL: SIGN_PAGE,
      ANTHROPIC_API_KEY: "",
      DECISIONS_PATH: scratchDecisionsPath(),
      ...env,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  server.stdout.on("data", (chunk) => (output += chunk));
  server.stderr.on("data", (chunk) => (output += chunk));
  let running = true;
  const exited = new Promise<number | null>((resolve) => server.on("exit", resolve));
  void exited.then(() => (running = false));
  const deadline = Date.now() + 10_000;
  while (running && !output.includes("listening") && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 50));
  }
  return { port, exited, output: () => output, stop: () => server.kill() };
}

interface RawAnswer {
  /** The status the host answered with, or null if it hadn't answered. */
  status: number | null;
  body: string;
  /** Whether the host closed the connection. */
  closed: boolean;
}

/**
 * Sends a request head and `body` over a raw connection, sends nothing more, and gives the host
 * `waitMs` to answer and close the connection. A host that waits for the rest of a body never answers.
 */
async function send(head: string, body: string | Uint8Array = "", waitMs = 3000): Promise<RawAnswer> {
  const socket = connect(host.port, "127.0.0.1");
  let received = "";
  let closed = false;
  socket.on("data", (chunk) => (received += chunk.toString("latin1")));
  socket.on("error", () => {});
  const ended = new Promise<void>((resolve) => socket.on("close", () => resolve()));
  socket.write(head);
  socket.write(body);
  await Promise.race([ended.then(() => (closed = true)), new Promise((r) => setTimeout(r, waitMs))]);
  socket.destroy();
  const status = /^HTTP\/1\.1 (\d{3})/.exec(received)?.[1];
  return { status: status ? Number(status) : null, body: received.split("\r\n\r\n")[1] ?? "", closed };
}

function head(path: string, headers: Record<string, string | number>): string {
  const lines = Object.entries({ host: "127.0.0.1", "content-type": "application/json", ...headers });
  return `POST ${path} HTTP/1.1\r\n${lines.map(([name, value]) => `${name}: ${value}`).join("\r\n")}\r\n\r\n`;
}

/** `size` bytes of body in HTTP chunked framing, without the last chunk that would end it. */
function chunked(size: number): string {
  const piece = 16 * KiB;
  let framed = "";
  for (let sent = 0; sent < size; sent += piece) {
    const length = Math.min(piece, size - sent);
    framed += `${length.toString(16)}\r\n${"x".repeat(length)}\r\n`;
  }
  return framed;
}

test.each([
  ["/webhook", MiB],
  ["/relay/deposit", 16 * KiB],
  ["/forfeit", 16 * KiB],
  ["/binding-proof", 16 * KiB],
])(
  "a body said to be over the limit for %s is refused with 413 before any of it is read",
  async (path, limit) => {
    const answer = await send(head(path, { "content-length": limit + 1 }));

    expect(answer.status).toBe(413);
    expect(JSON.parse(answer.body)).toEqual({
      error: expect.stringContaining(limit === MiB ? "1 MiB" : "16 KiB"),
      code: "too-large",
    });
    expect(answer.closed).toBe(true);
  },
  30_000,
);

test.each([
  ["/webhook", MiB],
  ["/forfeit", 16 * KiB],
])(
  "a streamed body for %s is refused with 413 as soon as it passes the limit",
  async (path, limit) => {
    const answer = await send(head(path, { "transfer-encoding": "chunked" }), chunked(limit + 1));

    expect(answer.status).toBe(413);
    expect(answer.closed).toBe(true);
  },
  30_000,
);

test.each([
  ["/webhook", MiB, 401],
  ["/forfeit", 16 * KiB, 400],
])(
  "a body of exactly the limit for %s is read as usual",
  async (path, limit, status) => {
    const json = "{}";
    const response = await fetch(`http://127.0.0.1:${host.port}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: json.padEnd(limit, " "),
    });

    expect(response.status).toBe(status);
  },
  30_000,
);

/** The statuses of 11 malformed POSTs to `path`, each with the X-Forwarded-For header `forwardedFor(i)`. */
async function elevenPosts(port: number, path: string, forwardedFor: (i: number) => string): Promise<number[]> {
  const statuses: number[] = [];
  for (let i = 0; i < 11; i++) {
    const response = await fetch(`http://127.0.0.1:${port}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-forwarded-for": forwardedFor(i) },
      body: "{",
    });
    statuses.push(response.status);
  }
  return statuses;
}

test.each(["/relay/deposit", "/forfeit"])(
  "with TRUST_PROXY=1, the per-IP limit on %s counts the rightmost X-Forwarded-For address",
  async (path) => {
    const proxied = await startHost({ ...keys, TRUST_PROXY: "1" });
    try {
      const manyClients = await elevenPosts(proxied.port, path, (i) => `198.51.100.${i}`);
      const oneClient = await elevenPosts(proxied.port, path, (i) => `198.51.100.${i}, 203.0.113.7`);

      expect(manyClients).toEqual(Array(11).fill(400));
      expect(oneClient).toEqual([...Array(10).fill(400), 429]);
    } finally {
      proxied.stop();
    }
  },
  30_000,
);

test("without TRUST_PROXY, the per-IP limits count the connection's address, whatever X-Forwarded-For says", async () => {
  const direct = await startHost(keys);
  try {
    const statuses = await elevenPosts(direct.port, "/relay/deposit", (i) => `198.51.100.${i}`);

    expect(statuses).toEqual([...Array(10).fill(400), 429]);
  } finally {
    direct.stop();
  }
}, 30_000);

test("a TRUST_PROXY other than 1 stops the host, rather than trusting nothing by mistake", async () => {
  const misconfigured = await startHost({ ...keys, TRUST_PROXY: "true" });

  expect(await misconfigured.exited).not.toBe(0);
  expect(misconfigured.output()).toContain("TRUST_PROXY");
}, 30_000);

test("an odd request path is answered like any other, not as an error", async () => {
  const answer = await send(head("//", { "content-length": 2 }), "{}");

  expect(answer.status).toBe(401);
  expect(host.output()).not.toMatch(/failed/);
}, 30_000);
