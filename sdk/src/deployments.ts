import { defineChain, type Address } from "viem";
import { ARC_USDC } from "./usdc.ts";

/** Where Bona Fide's contracts live on one network. */
export interface Deployment {
  /** As wallets show it, such as "Arc Testnet". */
  name: string;
  /** Test USDC only. */
  testnet: boolean;
  chainId: number;
  /** A public RPC that serves getLogs and historical state. */
  rpcUrl: string;
  explorerUrl: string;
  usdc: Address;
  escrow: Address;
  /** The escrow's deploy block: no event is older, so log searches start here. */
  escrowFromBlock: number;
  /** The Charity router, the escrow's Forfeit sink. */
  router: Address;
  /** The Bounty wallet factory, or "" where it isn't deployed. */
  bountyFactory: Address | "";
  /** The factory's deploy block: no Bounty wallet is older. */
  bountyFactoryFromBlock: number;
}

/** Arc mainnet. Forfeits go through CCTP to Protocol Guild's vesting contract on Base. */
export const arcMainnet = {
  name: "Arc",
  testnet: false,
  chainId: 5042,
  rpcUrl: "https://rpc.mainnet.arc.io",
  explorerUrl: "https://explorer.arc.io",
  usdc: ARC_USDC,
  escrow: "0xe2fe798427CFb43134FC37F6EE054c2da818fAc9",
  escrowFromBlock: 24_583_718,
  router: "0xe36fe5152C6A54946b15df3fEBDc068AF48581dc",
  bountyFactory: "0xEda45D2931B1A36D5920edefA621Ff5533c98C42",
  bountyFactoryFromBlock: 26_294_417,
} as const satisfies Deployment;

/** Arc Testnet. Forfeits go through CCTP to a test address on Base Sepolia. */
export const arcTestnet = {
  name: "Arc Testnet",
  testnet: true,
  chainId: 5042002,
  rpcUrl: "https://rpc.testnet.arc.io",
  explorerUrl: "https://explorer.testnet.arc.io",
  usdc: ARC_USDC,
  escrow: "0x05283F2c7D94D66669227Cecf75abBbd024771A7",
  escrowFromBlock: 64_367_399,
  router: "0xae079DC6536c270d2743c0721cfC41c94E12ca9f",
  bountyFactory: "",
  bountyFactoryFromBlock: 0,
} as const satisfies Deployment;

/** The network as viem's chain: USDC is Arc's gas token, with 18 decimals. */
export function chainOf(network: Pick<Deployment, "chainId" | "name" | "rpcUrl" | "explorerUrl" | "testnet">) {
  return defineChain({
    id: network.chainId,
    name: network.name,
    nativeCurrency: { name: "USDC", symbol: "USDC", decimals: 18 },
    rpcUrls: { default: { http: [network.rpcUrl] } },
    blockExplorers: { default: { name: "Arc explorer", url: network.explorerUrl } },
    testnet: network.testnet,
  });
}
