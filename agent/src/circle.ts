import type { Address } from "viem";

/** Circle's CLI names for the chains its agent wallets support that Bona Fide runs on. */
const CIRCLE_CHAINS: Record<number, string> = { 5042: "ARC", 5042002: "ARC-TESTNET" };

export function circleChain(chainId: number): string | null {
  return CIRCLE_CHAINS[chainId] ?? null;
}

/** Signs EIP-712 typed data with a Circle agent wallet; `--quiet` prints only the signature. */
export function signTypedDataCommand(typedData: unknown, wallet: Address, chain: string): string {
  return `circle wallet sign typed-data '${JSON.stringify(typedData)}' --address ${wallet} --chain ${chain} --quiet`;
}

/** Calls a contract function from a Circle agent wallet; `--output json` includes the transaction hash. */
export function executeCommand(
  signature: string,
  args: readonly (string | number)[],
  contract: Address,
  wallet: Address,
  chain: string,
): string {
  return `circle wallet execute "${signature}" ${args.join(" ")} --contract ${contract} --address ${wallet} --chain ${chain} --output json`;
}
