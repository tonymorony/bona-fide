import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { createServer, type AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import { createPublicClient, createTestClient, createWalletClient, http, type Abi, type Address, type Hex } from "viem";
import { foundry } from "viem/chains";

const OUT = fileURLToPath(new URL("../../../contracts/out/", import.meta.url));

export function artifact(name: string): { abi: Abi; bytecode: Hex } {
  const json = JSON.parse(readFileSync(`${OUT}${name}.sol/${name}.json`, "utf8"));
  return { abi: json.abi, bytecode: json.bytecode.object };
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      server.close(() => resolve(port));
    });
  });
}

// anvil can answer eth_sendTransaction just before the receipt is ready (1.8 does after
// evm_increaseTime). viem then looks again one polling interval later, 4 s by default: poll fast.
export const POLLING_INTERVAL = 50;

// A local anvil chain. Transactions and signatures come from anvil's unlocked dev accounts: no keys here.
export async function startAnvil() {
  const port = await freePort();
  const child = spawn("anvil", ["--port", String(port)], { stdio: "ignore" });
  const url = `http://127.0.0.1:${port}`;
  const client = createPublicClient({ chain: foundry, transport: http(url), pollingInterval: POLLING_INTERVAL });
  const test = createTestClient({
    chain: foundry,
    mode: "anvil",
    transport: http(url),
    pollingInterval: POLLING_INTERVAL,
  });
  const wallet = createWalletClient({ chain: foundry, transport: http(url), pollingInterval: POLLING_INTERVAL });
  for (let attempt = 0; ; attempt++) {
    try {
      await client.getChainId();
      break;
    } catch (error) {
      if (attempt > 100) throw error;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
  const [deployer, keeper, contributor, maintainer, relayer, payee] = (await wallet.getAddresses()) as [
    Address,
    Address,
    Address,
    Address,
    Address,
    Address,
  ];

  return {
    client,
    test,
    wallet,
    deployer,
    keeper,
    contributor,
    maintainer,
    relayer,
    payee,

    async deploy(name: string, args: unknown[]): Promise<Address> {
      const { abi, bytecode } = artifact(name);
      const hash = await wallet.deployContract({ account: deployer, chain: foundry, abi, bytecode, args });
      return (await client.waitForTransactionReceipt({ hash })).contractAddress!;
    },

    /** Sends a transaction as one of anvil's accounts and waits for it; throws if it reverts. */
    async send(from: Address, address: Address, abi: Abi, functionName: string, args: unknown[]) {
      const { request } = await client.simulateContract({ account: from, address, abi, functionName, args });
      const receipt = await client.waitForTransactionReceipt({ hash: await wallet.writeContract(request) });
      if (receipt.status !== "success") throw new Error(`${functionName} reverted`);
      return receipt;
    },

    /** The latest block's time, in Unix seconds. */
    async now(): Promise<bigint> {
      return (await client.getBlock()).timestamp;
    },

    stop() {
      child.kill();
    },
  };
}

export type Anvil = Awaited<ReturnType<typeof startAnvil>>;
