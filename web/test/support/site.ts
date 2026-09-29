import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { createServer, type IncomingMessage } from "node:http";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import type { Address, Hex } from "viem";
import { freePort } from "./stack.ts";

const APP = fileURLToPath(new URL("../../../app/", import.meta.url));

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
};

/** Answers one of the App's JSON endpoints; null sends the request on. */
export type Endpoint = (request: Request) => Promise<Response | null> | Response | null;

async function bodyOf(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
}

/**
 * The pages' origin, as Caddy lays it out in production: the built pages as static files, and the
 * App's endpoints on the same origin. `/relay/deposit` goes to `relayUrl`, the App's Node host;
 * `endpoint` can answer any request first.
 */
export async function startSite({ dir, relayUrl, endpoint }: { dir: string; relayUrl?: string; endpoint?: Endpoint }) {
  const port = await freePort();
  const origin = `http://127.0.0.1:${port}`;
  const served: string[] = [];
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", origin);
    served.push(`${req.method} ${url.pathname}`);
    try {
      if (req.method === "POST") {
        const body = await bodyOf(req);
        const request = new Request(url, {
          method: "POST",
          headers: { "content-type": String(req.headers["content-type"] ?? "application/json") },
          body,
        });
        let response = endpoint ? await endpoint(request) : null;
        if (!response && url.pathname === "/relay/deposit" && relayUrl) {
          response = await fetch(`${relayUrl}${url.pathname}`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body,
          });
        }
        if (!response) {
          res
            .writeHead(404, { "content-type": "application/json" })
            .end(JSON.stringify({ error: "No such endpoint." }));
          return;
        }
        const headers: Record<string, string> = {};
        response.headers.forEach((value, name) => {
          if (name !== "content-encoding" && name !== "transfer-encoding" && name !== "content-length")
            headers[name] = value;
        });
        res.writeHead(response.status, headers).end(Buffer.from(await response.arrayBuffer()));
        return;
      }
      const path = normalize(decodeURIComponent(url.pathname)).replace(/^(\.\.[/\\])+/, "");
      const file = join(dir, path);
      if (!file.startsWith(dir) || !TYPES[extname(file)]) {
        res.writeHead(404).end();
        return;
      }
      const content = await readFile(file).catch(() => null);
      if (!content) {
        res.writeHead(404).end();
        return;
      }
      res.writeHead(200, { "content-type": TYPES[extname(file)]! }).end(content);
    } catch (error) {
      res.writeHead(500).end(String(error));
    }
  });
  await new Promise<void>((resolve) => server.listen(port, "127.0.0.1", resolve));
  return {
    origin,
    served,
    url: (path: string) => `${origin}/${path}`,
    stop: () => new Promise((resolve) => server.close(resolve)),
  };
}

/** Runs the Bona Fide App's Node host with its deposit relay, as a separate process. */
export async function startAppRelay({
  rpcUrl,
  escrow,
  fromBlock,
  relayerKey,
}: {
  rpcUrl: string;
  escrow: Address;
  fromBlock: number;
  relayerKey: Hex;
}) {
  const port = await freePort();
  const app = spawn(process.execPath, ["src/node.ts"], {
    cwd: APP,
    env: {
      PATH: process.env.PATH,
      PORT: String(port),
      RPC_URL: rpcUrl,
      ESCROW_ADDRESS: escrow,
      ESCROW_FROM_BLOCK: String(fromBlock),
      RELAYER_PRIVATE_KEY: relayerKey,
      WEBHOOK_SECRET: "not used here",
      GITHUB_APP_ID: "1",
      GITHUB_PRIVATE_KEY: "not used here",
      DEPOSIT_PAGE_URL: "https://pages.test/deposit.html",
      SETUP_PAGE_URL: "https://pages.test/setup.html",
      POLL_MS: "60000",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  app.stdout.on("data", (chunk) => (output += chunk));
  app.stderr.on("data", (chunk) => (output += chunk));
  const deadline = Date.now() + 15_000;
  while (!output.includes("listening") && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
  if (!output.includes("listening")) throw new Error(`The App didn't start:\n${output}`);
  return {
    url: `http://127.0.0.1:${port}`,
    output: () => output,
    stop: () => app.kill(),
  };
}
