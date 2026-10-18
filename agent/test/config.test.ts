import { arcMainnet, arcTestnet } from "@bona-fide/sdk";
import { expect, test } from "vitest";
import { loadConfig } from "../src/config.ts";

const ESCROW = "0x1111111111111111111111111111111111111111";

test("defaults to Arc testnet and a 5 USDC limit, without a relay", () => {
  expect(loadConfig({ ESCROW_ADDRESS: ESCROW })).toEqual({
    rpcUrl: "https://rpc.testnet.arc.io",
    escrow: ESCROW,
    maxDeposit: 5_000_000n,
    appUrl: undefined,
    bountyFactory: null,
    explorerUrl: null,
  });
});

test("knows the Bounty wallet factory and the explorer of Bona Fide's own escrows", () => {
  expect(loadConfig({ ESCROW_ADDRESS: arcMainnet.escrow.toLowerCase() })).toMatchObject({
    bountyFactory: arcMainnet.bountyFactory,
    explorerUrl: arcMainnet.explorerUrl,
  });
  expect(loadConfig({ ESCROW_ADDRESS: arcTestnet.escrow })).toMatchObject({
    bountyFactory: null,
    explorerUrl: arcTestnet.explorerUrl,
  });
});

test("BOUNTY_FACTORY_ADDRESS names another Bounty wallet factory", () => {
  const factory = "0x2222222222222222222222222222222222222222";

  expect(loadConfig({ ESCROW_ADDRESS: arcMainnet.escrow, BOUNTY_FACTORY_ADDRESS: factory })).toMatchObject({
    bountyFactory: factory,
  });
});

test("reads the RPC, the App and a limit in USDC", () => {
  const config = loadConfig({
    ESCROW_ADDRESS: ESCROW,
    RPC_URL: "https://rpc.mainnet.arc.io",
    APP_URL: "https://bonafide.example",
    MAX_DEPOSIT_USDC: "0.25",
  });

  expect(config).toMatchObject({
    rpcUrl: "https://rpc.mainnet.arc.io",
    appUrl: "https://bonafide.example",
    maxDeposit: 250_000n,
  });
});

test.each([
  ["no escrow", {}, "Set ESCROW_ADDRESS"],
  ["an escrow that isn't an address", { ESCROW_ADDRESS: "0x1234" }, "ESCROW_ADDRESS must be an address"],
  ["a limit of 0", { ESCROW_ADDRESS: ESCROW, MAX_DEPOSIT_USDC: "0" }, "MAX_DEPOSIT_USDC must be"],
  ["a limit with 7 decimals", { ESCROW_ADDRESS: ESCROW, MAX_DEPOSIT_USDC: "1.0000001" }, "MAX_DEPOSIT_USDC must be"],
  ["a limit that isn't a number", { ESCROW_ADDRESS: ESCROW, MAX_DEPOSIT_USDC: "five" }, "MAX_DEPOSIT_USDC must be"],
  ["an App URL that isn't a URL", { ESCROW_ADDRESS: ESCROW, APP_URL: "bonafide" }, "APP_URL must be"],
  ["a factory that isn't an address", { ESCROW_ADDRESS: ESCROW, BOUNTY_FACTORY_ADDRESS: "0x12" }, "BOUNTY_FACTORY"],
])("refuses %s, saying what to fix", (_, env, problem) => {
  expect(() => loadConfig(env)).toThrow(problem);
});
