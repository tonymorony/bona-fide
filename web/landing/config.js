// The landing page's settings. There is no build step: edit this file, then deploy.

export const CONFIG = {
  // The network the live numbers come from: "testnet" now, "mainnet" once the escrow is deployed there.
  network: "testnet",
  installUrl: "https://github.com/apps/bona-fide-deposits/installations/new",
  // While false, the Install buttons read "Opening with the mainnet launch" and don't link anywhere.
  installOpen: false,
};

// Every URL here must also be in the connect-src of index.html's Content-Security-Policy.
// logsUrl answers eth_getLogs over the escrow's whole history. Arc's public RPC answers at most
// 10,000 blocks (about 85 minutes) per call and limits how often a browser may call, so the page reads
// the logs from the block explorer's JSON-RPC endpoint instead. logsRange is the most blocks one call
// may span there, or 0 for no limit.
export const NETWORKS = {
  testnet: {
    name: "Arc Testnet",
    test: true,
    chainId: 5042002,
    rpcUrl: "https://rpc.testnet.arc.io",
    logsUrl: "https://explorer.testnet.arc.io/api/eth-rpc",
    logsRange: 0,
    explorerUrl: "https://explorer.testnet.arc.io",
    usdc: "0x3600000000000000000000000000000000000000",
    escrow: "0x05283F2c7D94D66669227Cecf75abBbd024771A7",
    escrowFromBlock: 64_367_399,
    router: "0xae079DC6536c270d2743c0721cfC41c94E12ca9f",
  },
  mainnet: {
    name: "Arc",
    test: false,
    chainId: 5042,
    rpcUrl: "https://rpc.mainnet.arc.io",
    logsUrl: "https://explorer.arc.io/api/eth-rpc",
    logsRange: 0,
    explorerUrl: "https://explorer.arc.io",
    usdc: "0x3600000000000000000000000000000000000000",
    escrow: "",
    escrowFromBlock: 0,
    router: "",
  },
};
