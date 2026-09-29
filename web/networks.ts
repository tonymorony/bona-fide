import type { Network } from "./src/network.ts";

// One build of the pages per network: `npm run build` builds testnet, `npm run build -- mainnet`
// builds mainnet. A build stops if the network's escrow or router address is missing.

const ARC_USDC = "0x3600000000000000000000000000000000000000";

const ENDPOINTS = {
  relayDeposit: "/relay/deposit",
  forfeit: "/forfeit",
  bindingProof: "/binding-proof",
};

export const testnet: Network = {
  name: "Arc Testnet",
  testnet: true,
  chainId: 5042002,
  rpcUrl: "https://rpc.testnet.arc.io",
  explorerUrl: "https://explorer.testnet.arc.io",
  usdc: ARC_USDC,
  escrow: "0x05283F2c7D94D66669227Cecf75abBbd024771A7",
  escrowFromBlock: 64_367_399,
  router: "0xae079DC6536c270d2743c0721cfC41c94E12ca9f",
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
    source: "",
    installApp: "",
  },
  walletConnectProjectId: "",
};

export const mainnet: Network = {
  name: "Arc",
  testnet: false,
  chainId: 5042,
  rpcUrl: "https://rpc.mainnet.arc.io",
  explorerUrl: "https://explorer.arc.io",
  usdc: ARC_USDC,
  escrow: "",
  escrowFromBlock: 0,
  router: "",
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
    source: "",
    installApp: "",
  },
  walletConnectProjectId: "",
};

export const networks = { testnet, mainnet } as const;
