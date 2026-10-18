import { isAddress, type Address } from "viem";

/** Everything a build of the pages needs to know about one network. */
export interface Network {
  /** As wallets show it, such as "Arc Testnet". */
  name: string;
  /** Test USDC only: the pages say so. */
  testnet: boolean;
  chainId: number;
  /** A public RPC that answers the pages' origin (CORS) and serves getLogs. */
  rpcUrl: string;
  explorerUrl: string;
  usdc: Address;
  escrow: Address | "";
  /** The escrow's deploy block: no event is older. */
  escrowFromBlock: number;
  /** The Charity router, the escrow's Forfeit sink. */
  router: Address | "";
  /** The Bounty wallet factory. Empty: the pages say Bounties aren't available on this network yet. */
  bountyFactory: Address | "";
  /** The factory's deploy block: no Bounty wallet is older. */
  bountyFactoryFromBlock: number;
  /** Where Forfeits end up, in the pages' words. */
  forfeits: {
    /** Who a flush sends to, mid-sentence: "Protocol Guild", "the test recipient". */
    recipient: string;
    /** What a Forfeit's share does, after an amount: "funds open-source maintainers through Protocol Guild". */
    purpose: string;
    /** The heading over the router's balance. */
    heading: string;
    /** The recipient's address, as a row value: "Protocol Guild's vesting contract on Base". */
    destination: string;
    /** What CCTP mints into, mid-sentence: "Protocol Guild's vesting contract". */
    mintInto: string;
    /** The chain the router sends to through CCTP. */
    chain: string;
    address: Address;
    /** That address on the destination chain's explorer. */
    url: string;
    /** Protocol Guild vests what it receives over a year. */
    vests: boolean;
  };
  /** The App's endpoints on the pages' origin. */
  endpoints: {
    relayDeposit: string;
    forfeit: string;
    bindingProof: string;
    bountyPayout: string;
  };
  /** Optional links; an empty one isn't shown. */
  links: {
    /** Where to get USDC on this network. */
    getUsdc: string;
    /** Arc's own app, where a wallet is funded from another chain. With it, the deposit page says how to get USDC. */
    portal: string;
    /** The source code, which also documents the agent path and the Maintainer's setup. */
    source: string;
    /** Where Maintainers install the GitHub App. */
    installApp: string;
  };
  /** From Reown's dashboard. Empty: the WalletConnect option stays hidden. */
  walletConnectProjectId: string;
}

/** A Network whose contract addresses are set. */
export type LiveNetwork = Network & { escrow: Address; router: Address };

/** What keeps a network from being built, if anything. */
export function problemsWith(network: Network): string[] {
  const problems: string[] = [];
  for (const name of ["escrow", "router", "usdc"] as const) {
    if (!network[name]) problems.push(`${network.name} has no ${name} address yet.`);
    else if (!isAddress(network[name])) problems.push(`${network.name}'s ${name} address isn't an address.`);
  }
  if (!Number.isSafeInteger(network.escrowFromBlock) || network.escrowFromBlock < 0) {
    problems.push(`${network.name}'s escrowFromBlock must be the escrow's deploy block.`);
  }
  if (network.bountyFactory && !isAddress(network.bountyFactory)) {
    problems.push(`${network.name}'s bountyFactory address isn't an address.`);
  }
  if (!Number.isSafeInteger(network.bountyFactoryFromBlock) || network.bountyFactoryFromBlock < 0) {
    problems.push(`${network.name}'s bountyFactoryFromBlock must be the factory's deploy block.`);
  }
  if (network.walletConnectProjectId) {
    problems.push(
      "WalletConnect isn't bundled: its SDK comes under the WalletConnect Community License, which the project owner must accept first. Leave walletConnectProjectId empty.",
    );
  }
  return problems;
}
