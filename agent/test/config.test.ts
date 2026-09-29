import { expect, test } from "vitest";
import { loadConfig } from "../src/config.ts";

const ESCROW = "0x1111111111111111111111111111111111111111";

test("defaults to Arc testnet and a 5 USDC limit, without a relay", () => {
  expect(loadConfig({ ESCROW_ADDRESS: ESCROW })).toEqual({
    rpcUrl: "https://rpc.testnet.arc.io",
    escrow: ESCROW,
    maxDeposit: 5_000_000n,
    appUrl: undefined,
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
])("refuses %s, saying what to fix", (_, env, problem) => {
  expect(() => loadConfig(env)).toThrow(problem);
});
