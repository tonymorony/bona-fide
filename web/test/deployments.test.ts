import { arcMainnet, arcTestnet } from "@bona-fide/sdk";
import { readFile } from "node:fs/promises";
import { expect, test } from "vitest";
import { mainnet, testnet } from "../networks.ts";

// The landing page has no build step, so its config.js names the contracts itself: it must name the SDK's.
const landing = await import(new URL("../landing/config.js", import.meta.url).href);

test.each([
  ["mainnet", arcMainnet],
  ["testnet", arcTestnet],
] as const)("the pages and the landing page use the SDK's %s deployment", (name, deployment) => {
  const { chainId, rpcUrl, explorerUrl, usdc, escrow, escrowFromBlock, router } = deployment;
  const contracts = { chainId, rpcUrl, explorerUrl, usdc, escrow, escrowFromBlock, router };

  expect({ mainnet, testnet }[name]).toMatchObject(deployment);
  expect(landing.NETWORKS[name]).toMatchObject(contracts);
});

test("llms.txt names the SDK's mainnet contracts", async () => {
  const text = await readFile(new URL("../landing/llms.txt", import.meta.url), "utf8");

  for (const address of [arcMainnet.escrow, arcMainnet.router, arcMainnet.bountyFactory, arcMainnet.usdc]) {
    expect(text).toContain(address);
  }
});
