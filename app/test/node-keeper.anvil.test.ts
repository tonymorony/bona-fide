import { spawn } from "node:child_process";
import { createPublicClient, createTestClient, http, type Address } from "viem";
import { nonceManager, privateKeyToAccount } from "viem/accounts";
import { afterAll, beforeAll, expect, test } from "vitest";
import { createKeeperEscrow, keeperAccount } from "../src/keeper/escrow.ts";
import { keyOf, repoIdOf } from "../src/keys.ts";
import { freePort, type Anvil } from "./support/anvil.ts";
import { DEPOSIT_PAGE, scratchDecisionsPath, SETUP_PAGE } from "./support/harness.ts";
import { SIGN_PAGE, startKeeperAnvil } from "./support/keeper.ts";
import { REPO, SECRET } from "./support/webhooks.ts";

let anvil: Anvil;
let keeperKey: `0x${string}`;

beforeAll(async () => {
  ({ anvil, keeperKey } = await startKeeperAnvil());
  await anvil.bind(REPO);
}, 120_000);

afterAll(() => anvil?.stop());

function startHost(env: Record<string, string>) {
  const server = spawn(process.execPath, ["src/node.ts"], {
    env: {
      ...process.env,
      WEBHOOK_SECRET: SECRET,
      GITHUB_APP_ID: "1234",
      GITHUB_PRIVATE_KEY: "not used here",
      RPC_URL: anvil.url,
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
  const exited = new Promise<number | null>((resolve) => server.on("exit", resolve));
  return {
    output: () => output,
    exited,
    stop: () => server.kill(),
    async until(done: () => boolean | Promise<boolean>, timeoutMs = 10_000) {
      const deadline = Date.now() + timeoutMs;
      while (!(await done()) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
    },
  };
}

test("the Node host serves the Keeper's endpoints, names the Keeper, and never prints its key", async () => {
  const port = await freePort();
  const host = startHost({ PORT: String(port), KEEPER_PRIVATE_KEY: keeperKey });
  try {
    await host.until(() => host.output().includes("listening"));

    const response = await fetch(`http://127.0.0.1:${port}/forfeit`, {
      method: "POST",
      body: JSON.stringify({ repo: REPO, kind: "pr", number: 999, sigDeadline: 1, signature: `0x${"11".repeat(65)}` }),
    });

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "There's no Deposit on this PR." });
    expect((await fetch(`http://127.0.0.1:${port}/binding-proof`, { method: "OPTIONS" })).status).toBe(204);
    expect(host.output()).toContain(`Keeper ${privateKeyToAccount(keeperKey).address}`);
    expect(host.output().toLowerCase()).not.toContain(keeperKey.slice(2).toLowerCase());
  } finally {
    host.stop();
  }
}, 30_000);

test("with an Anthropic key, the Node host turns triage on, names its model, and never prints the key", async () => {
  const port = await freePort();
  const apiKey = "sk-ant-api03-not-a-real-key";
  const host = startHost({
    PORT: String(port),
    KEEPER_PRIVATE_KEY: keeperKey,
    ANTHROPIC_API_KEY: apiKey,
    TRIAGE_MODEL: "claude-sonnet-5",
  });
  try {
    await host.until(() => host.output().includes("listening"));

    expect(host.output()).toContain("Triage asks claude-sonnet-5 about each PR and issue that holds a Deposit.");
    expect(host.output()).not.toContain(apiKey);
  } finally {
    host.stop();
  }
}, 30_000);

test.each([
  ["without an Anthropic key", {}, "Triage off: set ANTHROPIC_API_KEY"],
  [
    "without the Keeper",
    { KEEPER_PRIVATE_KEY: "", ANTHROPIC_API_KEY: "sk-ant-api03-x" },
    "Triage off: it needs the Keeper.",
  ],
])(
  "%s, the Node host says triage is off",
  async (_, env, line) => {
    const port = await freePort();
    const host = startHost({ PORT: String(port), KEEPER_PRIVATE_KEY: keeperKey, ...env });
    try {
      await host.until(() => host.output().includes("listening"));

      expect(host.output()).toContain(line);
    } finally {
      host.stop();
    }
  },
  30_000,
);

test("the Node host activates a due Binding on its own", async () => {
  const repo = "octo/host-activates";
  const escrow = createKeeperEscrow({
    client: createPublicClient({ transport: http(anvil.url) }),
    account: privateKeyToAccount(keeperKey),
    escrow: anvil.escrow,
  });
  await escrow.proposeRepo(repoIdOf(repo), {
    maintainer: anvil.maintainer,
    forfeitBps: 5000,
    timeoutSeconds: 7 * 86_400,
    amount: 1_000_000n,
  });
  const chain = createTestClient({ mode: "anvil", transport: http(anvil.url) });
  await chain.increaseTime({ seconds: Number(anvil.bindingDelay) });
  await chain.mine({ blocks: 1 });
  const active = async () =>
    (
      (await anvil.client.readContract({
        address: anvil.escrow,
        abi: anvil.escrowAbi,
        functionName: "activeConfig",
        args: [repoIdOf(repo)],
      })) as { maintainer: Address }
    ).maintainer === anvil.maintainer;

  const host = startHost({ PORT: String(await freePort()), KEEPER_PRIVATE_KEY: keeperKey, ACTIVATE_MS: "200" });
  try {
    await host.until(active);

    expect(await active()).toBe(true);
  } finally {
    host.stop();
  }
}, 30_000);

test("the Node host refunds a Deposit on its own once its Timeout passes", async () => {
  await anvil.deposit(REPO, "pr", 501);
  const key = keyOf(repoIdOf(REPO), "pr", 501);
  const depositOf = async () =>
    (await anvil.client.readContract({
      address: anvil.escrow,
      abi: anvil.escrowAbi,
      functionName: "depositOf",
      args: [key],
    })) as { status: number; deadline: bigint };
  const chain = createTestClient({ mode: "anvil", transport: http(anvil.url) });
  await chain.setNextBlockTimestamp({ timestamp: (await depositOf()).deadline });
  await chain.mine({ blocks: 1 });
  const refunded = async () => (await depositOf()).status === 2;

  const host = startHost({ PORT: String(await freePort()), KEEPER_PRIVATE_KEY: keeperKey, REFUND_MS: "200" });
  try {
    await host.until(refunded);

    expect(await refunded()).toBe(true);
  } finally {
    host.stop();
  }
}, 30_000);

test("a malformed KEEPER_PRIVATE_KEY stops the host without printing it", async () => {
  const malformed = `0x${"5e".repeat(31)}zz`;
  const host = startHost({ PORT: String(await freePort()), KEEPER_PRIVATE_KEY: malformed });

  const code = await host.exited;

  expect(code).not.toBe(0);
  expect(host.output()).toContain("KEEPER_PRIVATE_KEY");
  expect(host.output()).not.toContain("5e".repeat(31));
}, 30_000);

test("two senders with the Keeper's key in one process never take the same nonce", async () => {
  const client = createPublicClient({ transport: http(anvil.url) });
  const chainId = await client.getChainId();
  const [first, second] = [keeperAccount(keeperKey), keeperAccount(keeperKey)];
  try {
    const nonces = await Promise.all(
      [first, second].map((account) => account.nonceManager?.consume({ address: account.address, chainId, client })),
    );

    expect(nonces.every((nonce) => typeof nonce === "number")).toBe(true);
    expect(new Set(nonces).size).toBe(2);
  } finally {
    nonceManager.reset({ address: first.address, chainId });
  }
});
