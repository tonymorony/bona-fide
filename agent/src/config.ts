import { arcMainnet, arcTestnet, USDC_DECIMALS } from "@bona-fide/sdk";
import { getAddress, isAddress, isAddressEqual, type Address } from "viem";

export interface Config {
  rpcUrl: string;
  escrow: Address;
  /** The most the tools will prepare or submit for one Deposit, in USDC base units. */
  maxDeposit: bigint;
  appUrl: string | undefined;
  /** The Bounty wallet factory, or null where none is known. */
  bountyFactory: Address | null;
  /** The block explorer of the Bona Fide deployment with this escrow, or null for another escrow. */
  explorerUrl: string | null;
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
  const factory = env.BOUNTY_FACTORY_ADDRESS || undefined;
  if (factory !== undefined && !isAddress(factory)) {
    throw new Error("BOUNTY_FACTORY_ADDRESS must be an address, such as 0x1234…abcd.");
  }
  // Bona Fide's own escrows come with their factory and explorer.
  const deployment = [arcMainnet, arcTestnet].find((known) => isAddressEqual(known.escrow, escrow));
  return {
    rpcUrl: env.RPC_URL || DEFAULT_RPC_URL,
    escrow: getAddress(escrow),
    maxDeposit: parseUsdc(env.MAX_DEPOSIT_USDC || DEFAULT_MAX_DEPOSIT_USDC),
    appUrl,
    bountyFactory: factory ? getAddress(factory) : deployment?.bountyFactory || null,
    explorerUrl: deployment?.explorerUrl ?? null,
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
