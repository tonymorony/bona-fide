import { arcMainnet, arcTestnet } from "@bona-fide/sdk";
import type { Network } from "./src/network.ts";

// One build of the pages per network: `npm run build` builds testnet, `npm run build -- mainnet`
// builds mainnet. A build stops if the network's escrow or router address is missing. Without a
// bountyFactory, the pages say Bounties aren't available on the network yet. The contract addresses
// and deploy blocks come from the SDK's deployments.

const ENDPOINTS = {
  relayDeposit: "/relay/deposit",
  forfeit: "/forfeit",
  bindingProof: "/binding-proof",
  bountyPayout: "/bounty/payout",
};

export const testnet: Network = {
  ...arcTestnet,
  // The testnet router flushes through CCTP to a test address on Base Sepolia: Protocol Guild's
  // vest exists only on Base.
  forfeits: {
    recipient: "the test recipient",
    purpose: "goes to a test recipient on Base Sepolia",
    heading: "Forfeits go to a test recipient",
    destination: "A test address on Base Sepolia",
    mintInto: "the test address",
    chain: "Base Sepolia",
    address: "0x27fd2C380442C9E0da2Bb56279f4b95d97767656",
    url: "https://sepolia.basescan.org/address/0x27fd2C380442C9E0da2Bb56279f4b95d97767656",
    vests: false,
  },
  endpoints: ENDPOINTS,
  links: {
    getUsdc: "https://faucet.circle.com",
    portal: "",
    source: "",
    installApp: "",
  },
  walletConnectProjectId: "",
};

export const mainnet: Network = {
  ...arcMainnet,
  forfeits: {
    recipient: "Protocol Guild",
    purpose: "funds open-source maintainers through Protocol Guild",
    heading: "Forfeits fund open-source maintainers",
    destination: "Protocol Guild's vesting contract on Base",
    mintInto: "Protocol Guild's vesting contract",
    chain: "Base",
    address: "0xffaaCCFe120f3fC47f42102cF4F28e837cd49A20",
    url: "https://basescan.org/address/0xffaaCCFe120f3fC47f42102cF4F28e837cd49A20",
    vests: true,
  },
  endpoints: ENDPOINTS,
  links: {
    getUsdc: "",
    portal: "https://portal.arc.io",
    source: "https://github.com/tonymorony/bona-fide",
    installApp: "https://github.com/apps/bona-fide-deposits/installations/new",
  },
  walletConnectProjectId: "",
};

export const networks = { testnet, mainnet } as const;
