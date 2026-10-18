import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { privateKeyToAccount } from "viem/accounts";
import { getAddress, type Address, type Hex } from "viem";
import { afterAll, beforeAll, expect, test } from "vitest";
import { startApp } from "./support/app.ts";
import { castSign, startChain, type Chain } from "./support/chain.ts";
import { textOf } from "./support/mcp.ts";

// End to end, with every piece as it runs for real: the MCP server over stdio, as Claude Code starts
// it; the App's Node host with its relay; anvil with the real escrow and the EIP-3009 mock USDC.

const REPO = "octo/agent-e2e";

let chain: Chain;
let app: Awaited<ReturnType<typeof startApp>>;
let relayer: Address;
let mcp: Client;

beforeAll(async () => {
  chain = await startChain();
  await chain.bind(REPO);
  const relayerKey = await chain.gasKey();
  relayer = privateKeyToAccount(relayerKey).address;
  app = await startApp({ rpcUrl: chain.url, escrow: chain.escrow, relayerKey });
  mcp = new Client({ name: "e2e-host", version: "1.0.0" });
  await mcp.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: ["src/main.ts"],
      cwd: fileURLToPath(new URL("..", import.meta.url)),
      env: { RPC_URL: chain.url, ESCROW_ADDRESS: chain.escrow, APP_URL: app.url, MAX_DEPOSIT_USDC: "5" },
      stderr: "pipe",
    }),
  );
}, 120_000);

afterAll(async () => {
  await mcp?.close();
  app?.stop();
  chain?.stop();
});

interface Prepared {
  typedData: unknown;
  submit: Record<string, unknown>;
}

async function call(name: string, args: Record<string, unknown>) {
  return mcp.callTool({ name, arguments: args });
}

async function prepareAndSign(key: Hex, from: Address, repo: string, number: number) {
  const prepared = await call("prepare_signed_deposit", { repo, kind: "pr", number, from });
  expect(prepared.isError).toBeFalsy();
  const { typedData, submit } = prepared.structuredContent as Prepared;
  return { ...submit, signature: castSign(key, typedData) };
}

test("an agent deposits for its PR: it reads the rules, signs with its own key, and the App relays it", async () => {
  const { key, account } = await chain.contributor();

  const rules = await call("get_deposit_rules", { repo: REPO, kind: "pr", number: 42 });
  expect(rules.structuredContent).toMatchObject({
    binding: { amountUsdc: "1" },
    activeDeposit: null,
    withinLimit: true,
  });

  const signed = await prepareAndSign(key, account.address, REPO, 42);
  const submitted = await call("submit_signed_deposit", signed);

  expect(submitted.isError).toBeFalsy();
  const { txHash } = submitted.structuredContent as { txHash: Hex };
  expect(await chain.depositedIn(txHash)).toMatchObject({
    depositor: account.address,
    amount: 1_000_000n,
    number: 42n,
  });
  expect(getAddress((await chain.client.getTransaction({ hash: txHash })).from)).toBe(relayer);
  const after = await call("get_deposit_rules", { repo: REPO, kind: "pr", number: 42 });
  expect(after.structuredContent).toMatchObject({ activeDeposit: { depositor: account.address } });
}, 60_000);

test("a signature for an amount the repo no longer asks for is refused, and the agent is told to sign again", async () => {
  const repo = "octo/agent-e2e-rebound";
  await chain.bind(repo);
  const { key, account } = await chain.contributor();
  const signed = await prepareAndSign(key, account.address, repo, 7);
  await chain.bind(repo, 2_000_000n);

  const submitted = await call("submit_signed_deposit", signed);

  expect(submitted.isError).toBe(true);
  expect(textOf(submitted)).toContain("is 2 USDC, but this authorization is for 1 USDC");
  expect(textOf(submitted)).toContain("prepare_signed_deposit");
  const rules = await call("get_deposit_rules", { repo, kind: "pr", number: 7 });
  expect(rules.structuredContent).toMatchObject({ activeDeposit: null });
}, 60_000);

test("the MCP server refuses to prepare a Deposit above MAX_DEPOSIT_USDC", async () => {
  const repo = "octo/agent-e2e-pricey";
  await chain.bind(repo, 6_000_000n);
  const { account } = await chain.contributor();

  const prepared = await call("prepare_signed_deposit", { repo, kind: "pr", number: 1, from: account.address });

  expect(prepared.isError).toBe(true);
  expect(textOf(prepared)).toContain("above your limit of 5 USDC");
}, 60_000);
