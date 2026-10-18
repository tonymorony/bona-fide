import { keyOf, kindCode, repoIdOf, type Kind } from "@bona-fide/sdk";
import { execFileSync, spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { createServer, type AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import {
  createPublicClient,
  createTestClient,
  createWalletClient,
  http,
  maxUint256,
  type Abi,
  type Address,
  type Hex,
} from "viem";
import { foundry } from "viem/chains";

const CONTRACTS = fileURLToPath(new URL("../../../contracts/", import.meta.url));
const FORFEIT_SINK = "0x000000000000000000000000000000000000dEaD";
const BINDING_DELAY = 3600n;

/** A Binding's terms: USDC base units, basis points and seconds, and the Maintainer it binds. */
export interface Terms {
  amount?: bigint;
  forfeitBps?: number;
  timeoutSeconds?: number;
  maintainer?: Address;
}

export function artifact(name: string): { abi: Abi; bytecode: Hex } {
  const json = JSON.parse(readFileSync(`${CONTRACTS}out/${name}.sol/${name}.json`, "utf8"));
  return { abi: json.abi, bytecode: json.bytecode.object };
}

export function buildContracts(): void {
  execFileSync("forge", ["build"], { cwd: CONTRACTS, stdio: "ignore" });
}

// A local anvil chain with MockUSDC and the real BonaFideEscrow, deployed from the Foundry artifacts.
// Transactions come from anvil's unlocked dev accounts through eth_sendTransaction: no keys here.
// `keeper` replaces the Keeper, such as with a key a test generated; it is impersonated so these
// helpers can send as it too. `blocksBefore` empty blocks come before the deploy, as on a real chain.
export async function startAnvil({
  keeper: keeperOverride,
  blocksBefore = 0,
}: { keeper?: Address; blocksBefore?: number } = {}) {
  const port = await freePort();
  // The App reads state at past blocks, as Arc's public RPC allows. Keep all of anvil's states in
  // memory: states it moves to disk are sometimes unreadable for a moment under load.
  const anvil = spawn("anvil", ["--port", String(port), "--prune-history", "1000000"], { stdio: "ignore" });
  const url = `http://127.0.0.1:${port}`;
  const client = createPublicClient({ chain: foundry, transport: http(url) });
  const test = createTestClient({ chain: foundry, mode: "anvil", transport: http(url) });
  const wallet = createWalletClient({ chain: foundry, transport: http(url) });
  await until(async () => (await client.getChainId()) === foundry.id);

  const [deployer, devKeeper, contributor, maintainer] = await wallet.getAddresses();
  const keeper = keeperOverride ?? devKeeper!;
  if (keeperOverride) {
    await test.impersonateAccount({ address: keeperOverride });
    await test.setBalance({ address: keeperOverride, value: 10n ** 20n });
  }
  const usdcArtifact = artifact("MockUSDC");
  const escrowArtifact = artifact("BonaFideEscrow");

  async function send(from: Address, address: Address, abi: Abi, functionName: string, args: unknown[]) {
    const hash = await wallet.writeContract({ account: from, chain: foundry, address, abi, functionName, args });
    return client.waitForTransactionReceipt({ hash });
  }

  async function deploy(abi: Abi, bytecode: Hex, args: unknown[]): Promise<Address> {
    const hash = await wallet.deployContract({ account: deployer!, chain: foundry, abi, bytecode, args });
    return (await client.waitForTransactionReceipt({ hash })).contractAddress!;
  }

  if (blocksBefore > 0) await test.mine({ blocks: blocksBefore });
  const deployBlock = await client.getBlockNumber();
  const usdc = await deploy(usdcArtifact.abi, usdcArtifact.bytecode, []);
  const escrow = await deploy(escrowArtifact.abi, escrowArtifact.bytecode, [
    usdc,
    keeper,
    FORFEIT_SINK,
    BINDING_DELAY,
    50_000_000n,
  ]);
  await send(deployer!, usdc, usdcArtifact.abi, "mint", [contributor, 100_000_000n]);
  await send(contributor!, usdc, usdcArtifact.abi, "approve", [escrow, maxUint256]);

  /** Proposes a Binding as the Keeper, by default 1 USDC, 50% and 7 days, and returns the block time. */
  async function propose(repo: string, terms: Terms = {}): Promise<Date> {
    const {
      amount = 1_000_000n,
      forfeitBps = 5000,
      timeoutSeconds = 7 * 86_400,
      maintainer: bound = maintainer!,
    } = terms;
    const receipt = await send(keeper!, escrow, escrowArtifact.abi, "proposeRepo", [
      repoIdOf(repo),
      bound,
      forfeitBps,
      timeoutSeconds,
      amount,
    ]);
    const block = await client.getBlock({ blockNumber: receipt.blockNumber });
    return new Date(Number(block.timestamp) * 1000);
  }

  return {
    url,
    client,
    escrow,
    escrowAbi: escrowArtifact.abi,
    deployBlock,
    bindingDelaySeconds: Number(BINDING_DELAY),
    contributor: contributor!,
    keeper,
    maintainer: maintainer!,
    usdc,
    forfeitSink: FORFEIT_SINK as Address,
    bindingDelay: BINDING_DELAY,
    propose,

    /**
     * Binds a repo, by default with 1 USDC, 50% and 7 days: proposes it, waits out the binding delay
     * and activates it. Returns the activation's block time, then lets 10 minutes pass, so a PR or
     * issue opened next was opened after Bona Fide started, clock skew and all.
     */
    async bind(repo: string, terms: Terms = {}): Promise<Date> {
      await propose(repo, terms);
      await test.increaseTime({ seconds: Number(BINDING_DELAY) });
      await test.mine({ blocks: 1 });
      const receipt = await send(keeper!, escrow, escrowArtifact.abi, "activateRepo", [repoIdOf(repo)]);
      const block = await client.getBlock({ blockNumber: receipt.blockNumber });
      await test.mine({ blocks: 1, interval: 600 });
      return new Date(Number(block.timestamp) * 1000);
    },

    /** Deposits as the contributor, and returns the block time and the transaction. */
    async deposit(repo: string, kind: Kind, number: number): Promise<{ at: Date; txHash: Hex }> {
      const receipt = await send(contributor!, escrow, escrowArtifact.abi, "deposit", [
        repoIdOf(repo),
        kindCode(kind),
        BigInt(number),
      ]);
      const block = await client.getBlock({ blockNumber: receipt.blockNumber });
      return { at: new Date(Number(block.timestamp) * 1000), txHash: receipt.transactionHash };
    },

    /** Relays a Forfeit of the item's active Deposit, signed by the Maintainer (EIP-712). */
    async forfeit(repo: string, kind: Kind, number: number) {
      const key = keyOf(repoIdOf(repo), kind, number);
      const { serial } = (await client.readContract({
        address: escrow,
        abi: escrowArtifact.abi,
        functionName: "depositOf",
        args: [key],
      })) as { serial: bigint };
      const sigDeadline = BigInt(Math.floor((await this.now()).getTime() / 1000) + 3600);
      const signature = await wallet.signTypedData({
        account: maintainer!,
        domain: { name: "BonaFide", version: "1", chainId: foundry.id, verifyingContract: escrow },
        types: {
          Forfeit: [
            { name: "key", type: "bytes32" },
            { name: "serial", type: "uint256" },
            { name: "sigDeadline", type: "uint256" },
          ],
        },
        primaryType: "Forfeit",
        message: { key, serial, sigDeadline },
      });
      await send(deployer!, escrow, escrowArtifact.abi, "forfeit", [key, sigDeadline, signature]);
    },

    /** Sends a transaction as `from`, one of anvil's unlocked accounts or the Keeper, and waits for its receipt. */
    send,

    /** Mints MockUSDC to `to`. */
    async mint(to: Address, amount: bigint) {
      await send(deployer!, usdc, usdcArtifact.abi, "mint", [to, amount]);
    },

    /** Deploys a contract from contracts/, such as a mock. */
    deployArtifact(name: string, args: unknown[]): Promise<Address> {
      const { abi, bytecode } = artifact(name);
      return deploy(abi, bytecode, args);
    },

    /** Refunds the item's active Deposit as the Keeper. */
    async refund(repo: string, kind: Kind, number: number) {
      await send(keeper, escrow, escrowArtifact.abi, "refund", [keyOf(repoIdOf(repo), kind, number)]);
    },

    async usdcBalance(account: Address): Promise<bigint> {
      return (await client.readContract({
        address: usdc,
        abi: usdcArtifact.abi,
        functionName: "balanceOf",
        args: [account],
      })) as bigint;
    },

    /** Mines `blocks` empty blocks, `interval` seconds apart. */
    async mine(blocks: number, interval = 1) {
      await test.mine({ blocks, interval });
    },

    blockNumber(): Promise<bigint> {
      return client.getBlockNumber({ cacheTime: 0 });
    },

    async now(): Promise<Date> {
      const block = await client.getBlock();
      return new Date(Number(block.timestamp) * 1000);
    },

    stop() {
      anvil.kill();
    },
  };
}

export type Anvil = Awaited<ReturnType<typeof startAnvil>>;

export async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function until(ready: () => Promise<boolean>, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      if (await ready()) return;
    } catch {}
    if (Date.now() > deadline) throw new Error("anvil did not start");
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}
