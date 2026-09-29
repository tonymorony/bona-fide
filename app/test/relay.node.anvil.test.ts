import { spawn } from "node:child_process";
import type { Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { afterAll, beforeAll, expect, test } from "vitest";
import { freePort, startAnvil, type Anvil } from "./support/anvil.ts";
import { DEPOSIT_PAGE, SETUP_PAGE } from "./support/harness.ts";
import { relayKit, type RelayKit } from "./support/relay.ts";
import { SECRET } from "./support/webhooks.ts";

let anvil: Anvil;
let kit: RelayKit;

beforeAll(async () => {
  anvil = await startAnvil();
  await anvil.bind("Codertocat/Hello-World");
  kit = await relayKit(anvil);
}, 120_000);

afterAll(() => anvil?.stop());

async function startApp(env: Record<string, string>) {
  const port = await freePort();
  const server = spawn(process.execPath, ["src/node.ts"], {
    env: {
      ...process.env,
      PORT: String(port),
      WEBHOOK_SECRET: SECRET,
      GITHUB_APP_ID: "1234",
      GITHUB_PRIVATE_KEY: "not used by the relay",
      RPC_URL: anvil.url,
      ESCROW_ADDRESS: anvil.escrow,
      ESCROW_FROM_BLOCK: String(anvil.deployBlock),
      DEPOSIT_PAGE_URL: DEPOSIT_PAGE,
      SETUP_PAGE_URL: SETUP_PAGE,
      ...env,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  server.stdout.on("data", (chunk) => (output += chunk));
  server.stderr.on("data", (chunk) => (output += chunk));
  const exited = new Promise<number | null>((resolve) => server.on("exit", resolve));
  let running = true;
  void exited.then(() => (running = false));
  const deadline = Date.now() + 10_000;
  while (running && !output.includes("listening") && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 50));
  }
  return {
    exited,
    relay: (body: unknown) =>
      fetch(`http://127.0.0.1:${port}/relay/deposit`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
    output: () => output,
    stop: () => server.kill(),
  };
}

test("the Node host relays POST /relay/deposit with RELAYER_PRIVATE_KEY, and never prints the key", async () => {
  const relayerKey = generatePrivateKey();
  await kit.fundGas(privateKeyToAccount(relayerKey).address);
  const signer = await kit.fundedSigner();
  const app = await startApp({ RELAYER_PRIVATE_KEY: relayerKey });
  try {
    const res = await app.relay(await kit.signedDeposit(signer, { number: 30 }));

    expect(res.status).toBe(200);
    const { txHash } = (await res.json()) as { txHash: Hex };
    expect(await kit.depositedIn(txHash)).toMatchObject({ depositor: signer.address });
    await new Promise((r) => setTimeout(r, 1500));
    expect(app.output()).not.toContain(relayerKey.slice(2));
  } finally {
    app.stop();
  }
}, 30_000);

test("without RELAYER_PRIVATE_KEY the Node host doesn't relay", async () => {
  const app = await startApp({});
  try {
    const res = await app.relay({});
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "This App doesn't relay Deposits." });
  } finally {
    app.stop();
  }
}, 30_000);

test("a malformed RELAYER_PRIVATE_KEY stops the host without printing it", async () => {
  const truncated = generatePrivateKey().slice(0, -2);
  const app = await startApp({ RELAYER_PRIVATE_KEY: truncated });

  expect(await app.exited).not.toBe(0);
  expect(app.output()).toContain("The relayer key must be 32 bytes of hex.");
  expect(app.output()).not.toContain(truncated.slice(2));
}, 30_000);
