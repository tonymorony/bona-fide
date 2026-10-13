// A local anvil chain with the real BonaFideEscrow and CharityRouter, deployed from the Foundry
// artifacts. Transactions come from anvil's unlocked dev accounts through eth_sendTransaction, and
// the Maintainer signs through eth_signTypedData_v4, so no keys appear here.

import { execFileSync, spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { createServer } from "node:net";
import { fileURLToPath } from "node:url";

const CONTRACTS = fileURLToPath(new URL("../../../../contracts/", import.meta.url));
const BINDING_DELAY = 3600;
const BASE_DOMAIN = 6;
const FORFEIT_RECIPIENT = "0x000000000000000000000000000000000000bEEF";

export const PR = 0;
export const ISSUE = 1;

export function buildContracts() {
  execFileSync("forge", ["build"], { cwd: CONTRACTS, stdio: "ignore" });
}

export function artifact(name) {
  const json = JSON.parse(readFileSync(`${CONTRACTS}out/${name}.sol/${name}.json`, "utf8"));
  return { abi: json.abi, bytecode: json.bytecode.object, selectors: json.methodIdentifiers };
}

/** ABI-encodes static arguments: numbers, bigints, addresses and bytes32 values. */
function words(...values) {
  return values
    .map((value) =>
      typeof value === "string"
        ? value.slice(2).toLowerCase().padStart(64, "0")
        : BigInt(value).toString(16).padStart(64, "0"),
    )
    .join("");
}

export function rpcClient(url) {
  let id = 0;
  return async (method, params = []) => {
    const response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params }),
    });
    const answer = await response.json();
    if (answer.error) throw new Error(`${method}: ${answer.error.message}`);
    return answer.result;
  };
}

export async function freePort() {
  const server = createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function until(ready, what = "anvil to start", timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      if (await ready()) return;
    } catch {}
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

/**
 * Starts anvil with USDC, the forfeit router and the escrow deployed, and a Contributor who holds
 * 100 USDC and has approved the escrow. Each Binding is 1 USDC, a 50% forfeit share and 7 days.
 */
export async function startChain({ chainId = 5042002 } = {}) {
  const port = await freePort();
  const anvil = spawn("anvil", ["--port", String(port), "--chain-id", String(chainId)], { stdio: "ignore" });
  const url = `http://127.0.0.1:${port}`;
  const rpc = rpcClient(url);
  try {
    await until(async () => Number(await rpc("eth_chainId")) === chainId);
  } catch (error) {
    anvil.kill();
    throw error;
  }

  const [deployer, keeper, contributor, maintainer] = await rpc("eth_accounts");
  const artifacts = Object.fromEntries(
    ["MockUSDC", "MockTokenMessengerV2", "CharityRouter", "BonaFideEscrow"].map((name) => [name, artifact(name)]),
  );
  const data = (contract, signature, ...args) => `0x${artifacts[contract].selectors[signature]}${words(...args)}`;

  async function transact(from, to, input) {
    const hash = await rpc("eth_sendTransaction", [{ from, ...(to ? { to } : {}), data: input }]);
    // Since anvil 1.8, eth_sendTransaction may answer before the block that holds the transaction.
    let receipt = null;
    await until(
      async () => (receipt = await rpc("eth_getTransactionReceipt", [hash])) !== null,
      `the receipt of ${hash}`,
    );
    if (receipt.status !== "0x1") throw new Error(`transaction ${hash} failed`);
    return receipt;
  }
  const deploy = async (contract, ...args) =>
    (await transact(deployer, null, artifacts[contract].bytecode + words(...args))).contractAddress;

  const usdc = await deploy("MockUSDC");
  const messenger = await deploy("MockTokenMessengerV2");
  await transact(
    deployer,
    messenger,
    data("MockTokenMessengerV2", "addRemoteTokenMessenger(uint32,bytes32)", BASE_DOMAIN, `0x${"11".repeat(32)}`),
  );
  const router = await deploy("CharityRouter", usdc, messenger, BASE_DOMAIN, `0x${words(FORFEIT_RECIPIENT)}`);
  const escrowReceipt = await transact(
    deployer,
    null,
    artifacts.BonaFideEscrow.bytecode + words(usdc, keeper, router, BINDING_DELAY, 50_000_000),
  );
  const escrow = escrowReceipt.contractAddress;
  const escrowFromBlock = Number(escrowReceipt.blockNumber);
  await transact(deployer, usdc, data("MockUSDC", "mint(address,uint256)", contributor, 100_000_000));
  await transact(contributor, usdc, data("MockUSDC", "approve(address,uint256)", escrow, 2n ** 256n - 1n));

  const read = (to, input) => rpc("eth_call", [{ to, data: input }, "latest"]);
  const keyOf = (repo, kind, number) =>
    read(escrow, data("BonaFideEscrow", "keyOf(bytes32,uint8,uint64)", repo, kind, number));

  return {
    url,
    chainId,
    escrow,
    router,
    usdc,
    escrowFromBlock,
    rpc,

    /** The landing page's settings for this chain: one RPC for state and logs, with no range limit. */
    network(overrides = {}) {
      return {
        name: "Arc Testnet",
        test: true,
        chainId,
        rpcUrl: url,
        logsUrl: url,
        logsRange: 0,
        explorerUrl: "https://explorer.testnet.arc.io",
        usdc,
        escrow,
        escrowFromBlock,
        router,
        ...overrides,
      };
    },

    repoId(n) {
      return `0x${words(n)}`;
    },

    /** Proposes a Binding as the Keeper, waits out the Binding delay and activates it. */
    async bind(repo) {
      await transact(
        keeper,
        escrow,
        data(
          "BonaFideEscrow",
          "proposeRepo(bytes32,address,uint16,uint32,uint256)",
          repo,
          maintainer,
          5000,
          7 * 86_400,
          1_000_000,
        ),
      );
      await rpc("evm_increaseTime", [BINDING_DELAY]);
      await rpc("evm_mine");
      await transact(keeper, escrow, data("BonaFideEscrow", "activateRepo(bytes32)", repo));
    },

    /** Deposits as the Contributor, and returns the Deposit's key. */
    async deposit(repo, kind, number) {
      await transact(contributor, escrow, data("BonaFideEscrow", "deposit(bytes32,uint8,uint64)", repo, kind, number));
      return keyOf(repo, kind, number);
    },

    async refund(key) {
      await transact(keeper, escrow, data("BonaFideEscrow", "refund(bytes32)", key));
    },

    /** Forfeits a Deposit with the Maintainer's EIP-712 signature, relayed by another account. */
    async forfeit(key) {
      const record = await read(escrow, data("BonaFideEscrow", "depositOf(bytes32)", key));
      const serial = BigInt(`0x${record.slice(2 + 64 * 5, 2 + 64 * 6)}`);
      const { timestamp } = await rpc("eth_getBlockByNumber", ["latest", false]);
      const sigDeadline = BigInt(timestamp) + 3600n;
      const typedData = {
        types: {
          EIP712Domain: [
            { name: "name", type: "string" },
            { name: "version", type: "string" },
            { name: "chainId", type: "uint256" },
            { name: "verifyingContract", type: "address" },
          ],
          Forfeit: [
            { name: "key", type: "bytes32" },
            { name: "serial", type: "uint256" },
            { name: "sigDeadline", type: "uint256" },
          ],
        },
        primaryType: "Forfeit",
        domain: { name: "BonaFide", version: "1", chainId, verifyingContract: escrow },
        message: { key, serial: serial.toString(), sigDeadline: sigDeadline.toString() },
      };
      const signature = (await rpc("eth_signTypedData_v4", [maintainer, JSON.stringify(typedData)])).slice(2);
      const padded = signature.padEnd(Math.ceil(signature.length / 64) * 64, "0");
      await transact(
        deployer,
        escrow,
        `0x${artifacts.BonaFideEscrow.selectors["forfeit(bytes32,uint256,bytes)"]}${words(key, sigDeadline, 0x60, signature.length / 2)}${padded}`,
      );
    },

    async usdcBalance(account) {
      return BigInt(await read(usdc, data("MockUSDC", "balanceOf(address)", account)));
    },

    stop() {
      anvil.kill();
    },
  };
}
