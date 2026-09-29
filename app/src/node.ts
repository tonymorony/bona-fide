// Runs the App on Node: the webhook handler behind node:http, and the Deposit watcher on a timer.
// With KEEPER_PRIVATE_KEY set, the Keeper's endpoints, Binding activator and Timeout refunds run
// beside them.
// With RELAYER_PRIVATE_KEY set, it also relays signed Deposits at POST /relay/deposit.
// Start it with `node src/node.ts`; Node 24 runs the TypeScript directly.

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createAppAuth } from "@octokit/auth-app";
import { Octokit } from "@octokit/rest";
import { createPublicClient, createWalletClient, http, type Address } from "viem";
import { createApp } from "./app.ts";
import { clientIpOf } from "./client-ip.ts";
import { MAX_JSON_BODY_BYTES, MAX_WEBHOOK_BODY_BYTES } from "./config.ts";
import { createEscrowChain } from "./escrow.ts";
import { createGitHub, quietLog } from "./github.ts";
import { createBindingActivator } from "./keeper/activator.ts";
import { createKeeperEscrow, keeperAccount } from "./keeper/escrow.ts";
import { createKeeper } from "./keeper/keeper.ts";
import { BINDING_PROOF_PATH, createKeeperRoutes, FORFEIT_PATH } from "./keeper/routes.ts";
import { createTimeoutRefunder } from "./keeper/timeouts.ts";
import { createDepositRelay, RELAY_DEPOSIT_PATH, relayerAccount } from "./relay/deposit.ts";
import { createDepositWatcher, pollDeposits } from "./watcher.ts";
import { createWebhookHandler } from "./webhook.ts";

function env(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Set ${name}.`);
  return value;
}

const appId = Number(env("GITHUB_APP_ID"));
const privateKey = env("GITHUB_PRIVATE_KEY").replaceAll("\\n", "\n");
const installations = new Map<number, Octokit>();
const log = quietLog();

const github = createGitHub({
  appId,
  app: new Octokit({ authStrategy: createAppAuth, auth: { appId, privateKey }, log }),
  installation(installationId) {
    let octokit = installations.get(installationId);
    if (!octokit) {
      octokit = new Octokit({ authStrategy: createAppAuth, auth: { appId, privateKey, installationId }, log });
      installations.set(installationId, octokit);
    }
    return octokit;
  },
});

const chain = createEscrowChain({
  client: createPublicClient({ transport: http(env("RPC_URL")) }),
  escrow: env("ESCROW_ADDRESS") as Address,
  fromBlock: BigInt(process.env.ESCROW_FROM_BLOCK ?? "0"),
});

const account = process.env.KEEPER_PRIVATE_KEY ? keeperAccount(process.env.KEEPER_PRIVATE_KEY) : null;
const keeperEscrow =
  account &&
  createKeeperEscrow({
    client: createPublicClient({ transport: http(env("RPC_URL")) }),
    account,
    escrow: env("ESCROW_ADDRESS") as Address,
  });
const keeper = keeperEscrow && createKeeper({ escrow: keeperEscrow, chain, github, signPageUrl: env("SIGN_PAGE_URL") });
console.log(
  account
    ? `Keeper ${account.address} signs refunds, relayed Forfeits and Bindings.`
    : "Keeper off: set KEEPER_PRIVATE_KEY to refund Deposits, relay Forfeits and bind repos.",
);

const app = createApp({
  github,
  chain,
  depositPageUrl: env("DEPOSIT_PAGE_URL"),
  setupPageUrl: env("SETUP_PAGE_URL"),
  explorerUrl: process.env.EXPLORER_URL || undefined,
  afterVerdict: keeper?.afterVerdict,
});
const webhook = createWebhookHandler({ secret: env("WEBHOOK_SECRET"), app, keeper: keeper ?? undefined });
const keeperRoutes = keeper && createKeeperRoutes(keeper);

async function handle(request: Request, clientIp: string): Promise<Response> {
  const answered = await keeperRoutes?.(request, clientIp).catch((error: unknown) => {
    console.error("keeper request failed:", error);
    return new Response(null, { status: 500 });
  });
  return answered ?? webhook(request);
}

const relayerKey = process.env.RELAYER_PRIVATE_KEY;
const relay = relayerKey
  ? createDepositRelay({
      client: createPublicClient({ transport: http(env("RPC_URL")) }),
      wallet: createWalletClient({ account: relayerAccount(relayerKey), transport: http(env("RPC_URL")) }),
      escrow: env("ESCROW_ADDRESS") as Address,
    })
  : undefined;

// Only for an App reachable solely through a reverse proxy that overwrites X-Forwarded-For.
if (!["", "0", "1"].includes(process.env.TRUST_PROXY ?? "")) {
  throw new Error("Set TRUST_PROXY to 1 to take client IPs from X-Forwarded-For, or leave it unset.");
}
const trustProxy = process.env.TRUST_PROXY === "1";
if (trustProxy) console.log("Per-IP limits count the rightmost X-Forwarded-For address (TRUST_PROXY=1).");

function route(request: Request, clientIp: string): Promise<Response> {
  if (new URL(request.url).pathname === RELAY_DEPOSIT_PATH) {
    if (relay) return relay(request, clientIp);
    return Promise.resolve(Response.json({ error: "This App doesn't relay Deposits." }, { status: 404 }));
  }
  return handle(request, clientIp);
}

const server = createServer(async (req, res) => {
  if (req.url === "/health") {
    res.writeHead(200, { "content-type": "text/plain" }).end("ok\n");
    return;
  }
  try {
    const url = new URL(`http://${req.headers.host ?? "localhost"}${req.url ?? "/"}`);
    const limit = bodyLimit(url.pathname);
    const body = await readBody(req, limit);
    if (body === null) return void tooLarge(res, limit);
    const headers = new Headers();
    for (const [name, value] of Object.entries(req.headers)) {
      if (typeof value === "string") headers.set(name, value);
    }
    const hasBody = req.method !== "GET" && req.method !== "HEAD";
    const response = await route(
      new Request(url, {
        method: req.method,
        headers,
        body: hasBody ? body : undefined,
      }),
      clientIpOf(req.socket.remoteAddress ?? "", headers.get("x-forwarded-for") ?? undefined, trustProxy),
    );
    res.writeHead(response.status, Object.fromEntries(response.headers));
    res.end(Buffer.from(await response.arrayBuffer()));
  } catch (error) {
    console.error("webhook failed:", error);
    res.writeHead(500).end();
  }
});

const JSON_PATHS = [RELAY_DEPOSIT_PATH, FORFEIT_PATH, BINDING_PROOF_PATH];

function bodyLimit(path: string): number {
  return JSON_PATHS.includes(path) ? MAX_JSON_BODY_BYTES : MAX_WEBHOOK_BODY_BYTES;
}

/** The request's body, or null as soon as it passes `limit` bytes: the rest is never read. */
function readBody(req: IncomingMessage, limit: number): Promise<Buffer | null> {
  if (Number(req.headers["content-length"]) > limit) return Promise.resolve(null);
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size <= limit) return void chunks.push(chunk);
      req.pause();
      resolve(null);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

// Closing the connection is what stops the read: kept alive, Node would read the rest to reach the next request.
function tooLarge(res: ServerResponse, limit: number): void {
  const size = limit % (1024 * 1024) === 0 ? `${limit / (1024 * 1024)} MiB` : `${limit / 1024} KiB`;
  const body = JSON.stringify({ error: `The request body is over the ${size} limit.` });
  res.writeHead(413, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(body),
    connection: "close",
  });
  res.end(body);
}

const port = Number(process.env.PORT ?? 3000);
server.listen(port, () => console.log(`Bona Fide App listening on port ${port}`));

// Start one log range back, so a restart doesn't miss Deposits made in the last ~85 minutes.
// WATCH_FROM_BLOCK overrides it after a longer outage.
async function watchFrom(): Promise<bigint | undefined> {
  if (process.env.WATCH_FROM_BLOCK) return BigInt(process.env.WATCH_FROM_BLOCK);
  try {
    const latest = await chain.latestBlock();
    return latest > 10_000n ? latest - 10_000n : 0n;
  } catch (error) {
    console.error("could not read the latest block, so only new Deposits are watched:", error);
    return undefined;
  }
}

const stopWatching = pollDeposits(
  createDepositWatcher({ chain, github, app, fromBlock: await watchFrom() }),
  Number(process.env.POLL_MS ?? 1000),
  (error) => console.error("deposit watcher failed:", error),
);

const stopActivating = keeperEscrow
  ? pollDeposits(
      createBindingActivator({ escrow: keeperEscrow, fromBlock: BigInt(process.env.ESCROW_FROM_BLOCK ?? "0") }),
      Number(process.env.ACTIVATE_MS ?? 30_000),
      (error) => console.error("binding activator failed:", error),
    )
  : () => {};

const stopRefunding = keeperEscrow
  ? pollDeposits(
      createTimeoutRefunder({ escrow: keeperEscrow, fromBlock: BigInt(process.env.ESCROW_FROM_BLOCK ?? "0") }),
      Number(process.env.REFUND_MS ?? 30_000),
      (error) => console.error("timeout refunder failed:", error),
    )
  : () => {};

process.on("SIGTERM", () => {
  stopWatching();
  stopActivating();
  stopRefunding();
  server.close();
});
