import { USDC_DECIMALS } from "@bona-fide/sdk";
import { getAddress, isAddress, type Address } from "viem";

export interface Config {
  rpcUrl: string;
  escrow: Address;
  /** The most the tools will prepare or submit for one Deposit, in USDC base units. */
  maxDeposit: bigint;
  appUrl: string | undefined;
}

export const DEFAULT_RPC_URL = "https://rpc.testnet.arc.io";
const DEFAULT_MAX_DEPOSIT_USDC = "5";

/** Reads the server's settings from environment variables, or throws saying what to fix. */
export function loadConfig(env: Record<string, string | undefined>): Config {
  const escrow = env.ESCROW_ADDRESS;
  if (!escrow) throw new Error("Set ESCROW_ADDRESS to the address of the Bona Fide escrow on Arc.");
  if (!isAddress(escrow)) throw new Error("ESCROW_ADDRESS must be an address, such as 0x1234…abcd.");
  const appUrl = env.APP_URL || undefined;
  if (appUrl !== undefined && !URL.canParse(appUrl)) {
    throw new Error("APP_URL must be the Bona Fide App's full URL, such as https://app.example.");
  }
  return {
    rpcUrl: env.RPC_URL || DEFAULT_RPC_URL,
    escrow: getAddress(escrow),
    maxDeposit: parseUsdc(env.MAX_DEPOSIT_USDC || DEFAULT_MAX_DEPOSIT_USDC),
    appUrl,
  };
}

function parseUsdc(text: string): bigint {
  const match = /^(\d+)(?:\.(\d{1,6}))?$/.exec(text.trim());
  const amount = match
    ? BigInt(match[1]!) * 10n ** BigInt(USDC_DECIMALS) + BigInt((match[2] ?? "").padEnd(USDC_DECIMALS, "0"))
    : 0n;
  if (amount <= 0n)
    throw new Error("MAX_DEPOSIT_USDC must be a USDC amount above 0 with at most 6 decimals, such as 5 or 0.5.");
  return amount;
}
