import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { createServer, type AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import {
  createPublicClient,
  createTestClient,
  createWalletClient,
  defineChain,
  getAddress,
  http,
  pad,
  parseEther,
  type Abi,
  type Address,
  type Hex,
  type LocalAccount,
} from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { keyOf, kindCode, repoIdOf, type Kind } from "../../src/keys.ts";
import type { LiveNetwork } from "../../src/network.ts";
import { forfeitVerdict } from "../../src/typed-data.ts";

const CONTRACTS = fileURLToPath(new URL("../../../contracts/", import.meta.url));
export const BINDING_DELAY = 3600;
/** Where the local router "mints": a stand-in for Protocol Guild's vest. */
const RECIPIENT = "0x000000000000000000000000000000000000bEEF";

/** anvil with Arc testnet's chain id, so what the pages sign reads as it would on Arc. */
export const LOCAL_CHAIN_ID = 5042002;

export function artifact(name: string): { abi: Abi; bytecode: Hex } {
  const json = JSON.parse(readFileSync(`${CONTRACTS}out/${name}.sol/${name}.json`, "utf8"));
  return { abi: json.abi, bytecode: json.bytecode.object };
}

export async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

export async function until<T>(
  check: () => Promise<T | null | undefined | false>,
  what: string,
  timeoutMs = 15_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const value = await check();
      if (value) return value;
    } catch {}
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

export interface Terms {
  amount?: bigint;
  forfeitBps?: number;
  timeoutSeconds?: number;
  maintainer?: Address;
}

/**
 * A local Arc: MockUSDC with EIP-3009, the real BonaFideEscrow, and the real CharityRouter as its
 * Forfeit sink, flushing to a mock CCTP messenger. Every key is generated for this run; the Keeper's
 * address is also impersonated, so these helpers can bind repos as it.
 */
export async function startStack() {
  const port = await freePort();
  const anvil = spawn(
    "anvil",
    ["--port", String(port), "--chain-id", String(LOCAL_CHAIN_ID), "--prune-history", "1000000"],
    { stdio: "ignore" },
  );
  const url = `http://127.0.0.1:${port}`;
  const chain = defineChain({
    id: LOCAL_CHAIN_ID,
    name: "Arc Testnet (local)",
    nativeCurrency: { name: "USDC", symbol: "USDC", decimals: 18 },
    rpcUrls: { default: { http: [url] } },
  });
  const client = createPublicClient({ chain, transport: http(url) });
  const test = createTestClient({ chain, mode: "anvil", transport: http(url) });
  const dev = createWalletClient({ chain, transport: http(url) });
  await until(async () => (await client.getChainId()) === LOCAL_CHAIN_ID, "anvil");

  const [deployer] = await dev.getAddresses();
  const keeperKey = generatePrivateKey();
  const keeper = privateKeyToAccount(keeperKey).address;
  await test.impersonateAccount({ address: keeper });
  await test.setBalance({ address: keeper, value: parseEther("100") });

  const usdcArtifact = artifact("MockUSDC");
  const escrowArtifact = artifact("BonaFideEscrow");
  const routerArtifact = artifact("CharityRouter");
  const messengerArtifact = artifact("MockTokenMessengerV2");

  // One transaction at a time: anvil gives concurrent sends from one account the same nonce.
  let queue: Promise<unknown> = Promise.resolve();
  function inTurn<T>(work: () => Promise<T>): Promise<T> {
    const run = queue.then(work, work);
    queue = run.catch(() => {});
    return run;
  }

  function send(from: Address, address: Address, abi: Abi, functionName: string, args: unknown[]) {
    return inTurn(async () => {
      const hash = await dev.writeContract({ account: from, chain, address, abi, functionName, args });
      const receipt = await client.waitForTransactionReceipt({ hash });
      if (receipt.status !== "success") throw new Error(`${functionName} reverted`);
      return receipt;
    });
  }

  async function deploy({ abi, bytecode }: { abi: Abi; bytecode: Hex }, args: unknown[]): Promise<Address> {
    const hash = await dev.deployContract({ account: deployer!, chain, abi, bytecode, args });
    return getAddress((await client.waitForTransactionReceipt({ hash })).contractAddress!);
  }

  const deployBlock = await client.getBlockNumber();
  const usdc = await deploy(usdcArtifact, []);
  const messenger = await deploy(messengerArtifact, []);
  await send(deployer!, messenger, messengerArtifact.abi, "addRemoteTokenMessenger", [6, pad("0x01")]);
  const router = await deploy(routerArtifact, [usdc, messenger, 6, pad(RECIPIENT)]);
  const escrow = await deploy(escrowArtifact, [usdc, keeper, router, BigInt(BINDING_DELAY), 50_000_000n]);

  const network: LiveNetwork = {
    name: "Arc Testnet (local)",
    testnet: true,
    chainId: LOCAL_CHAIN_ID,
    rpcUrl: url,
    explorerUrl: "https://explorer.testnet.arc.io",
    usdc,
    escrow,
    escrowFromBlock: Number(deployBlock),
    router,
    forfeits: {
      recipient: "the test recipient",
      purpose: "goes to a test recipient on Base Sepolia",
      heading: "Forfeits go to a test recipient",
      destination: "A test address on Base Sepolia",
      mintInto: "the test address",
      chain: "Base Sepolia",
      address: RECIPIENT,
      url: `https://sepolia.basescan.org/address/${RECIPIENT}`,
      vests: false,
    },
    endpoints: { relayDeposit: "/relay/deposit", forfeit: "/forfeit", bindingProof: "/binding-proof" },
    links: { getUsdc: "https://faucet.circle.com", source: "", installApp: "" },
    walletConnectProjectId: "",
  };

  async function now(): Promise<bigint> {
    return (await client.getBlock()).timestamp;
  }

  async function propose(repo: string, terms: Terms = {}) {
    const { amount = 1_000_000n, forfeitBps = 5000, timeoutSeconds = 7 * 86_400, maintainer = keeper } = terms;
    return send(keeper, escrow, escrowArtifact.abi, "proposeRepo", [
      repoIdOf(repo),
      maintainer,
      forfeitBps,
      timeoutSeconds,
      amount,
    ]);
  }

  async function advance(seconds: number) {
    await test.increaseTime({ seconds });
    await test.mine({ blocks: 1 });
  }

  return {
    url,
    chain,
    client,
    network,
    usdc,
    escrow,
    router,
    keeperKey,
    usdcAbi: usdcArtifact.abi,
    escrowAbi: escrowArtifact.abi,
    routerAbi: routerArtifact.abi,
    now,
    advance,
    propose,

    /** Proposes a Binding, by default 1 USDC, 50% and 7 days, and activates it after the delay. */
    async bind(repo: string, terms: Terms = {}) {
      await propose(repo, terms);
      await advance(BINDING_DELAY);
      await send(keeper, escrow, escrowArtifact.abi, "activateRepo", [repoIdOf(repo)]);
    },

    /** A fresh key holding `usdcAmount` base units and gas. */
    async account(usdcAmount = 5_000_000n): Promise<LocalAccount & { key: Hex }> {
      const key = generatePrivateKey();
      const account = privateKeyToAccount(key);
      if (usdcAmount > 0n) await send(deployer!, usdc, usdcArtifact.abi, "mint", [account.address, usdcAmount]);
      await test.setBalance({ address: account.address, value: parseEther("10") });
      return Object.assign(account, { key });
    },

    /** A fresh key with gas and no USDC, such as the relayer's. */
    async gasKey(): Promise<Hex> {
      const key = generatePrivateKey();
      await test.setBalance({ address: privateKeyToAccount(key).address, value: parseEther("10") });
      return key;
    },

    /** Deposits from `account` with its own two transactions. */
    async deposit(account: LocalAccount, repo: string, kind: Kind, number: number, amount = 1_000_000n) {
      const own = createWalletClient({ account, chain, transport: http(url) });
      for (const [address, abi, functionName, args] of [
        [usdc, usdcArtifact.abi, "approve", [escrow, amount]],
        [escrow, escrowArtifact.abi, "deposit", [repoIdOf(repo), kindCode(kind), BigInt(number)]],
      ] as const) {
        const hash = await own.writeContract({ address, abi, functionName, args: [...args] });
        await client.waitForTransactionReceipt({ hash });
      }
    },

    /** Forfeits the item's Deposit with the Maintainer's signature, relayed by the deployer. */
    async forfeit(maintainer: LocalAccount, repo: string, kind: Kind, number: number) {
      const key = keyOf(repoIdOf(repo), kind, number);
      const { serial } = (await client.readContract({
        address: escrow,
        abi: escrowArtifact.abi,
        functionName: "depositOf",
        args: [key],
      })) as { serial: bigint };
      const sigDeadline = (await now()) + 3600n;
      const signature = await maintainer.signTypedData(
        forfeitVerdict({ chainId: LOCAL_CHAIN_ID, escrow, key, serial, sigDeadline }),
      );
      return send(deployer!, escrow, escrowArtifact.abi, "forfeit", [key, sigDeadline, signature]);
    },

    /** Refunds the item's Deposit as the Keeper. */
    refund(repo: string, kind: Kind, number: number) {
      return send(keeper, escrow, escrowArtifact.abi, "refund", [keyOf(repoIdOf(repo), kind, number)]);
    },

    /** Refunds the item's Deposit as anyone, after its Timeout. */
    refundAfterTimeout(repo: string, kind: Kind, number: number) {
      return send(deployer!, escrow, escrowArtifact.abi, "refund", [keyOf(repoIdOf(repo), kind, number)]);
    },

    flush() {
      return send(deployer!, router, routerArtifact.abi, "flush", []);
    },

    async usdcBalance(account: Address): Promise<bigint> {
      return (await client.readContract({
        address: usdc,
        abi: usdcArtifact.abi,
        functionName: "balanceOf",
        args: [account],
      })) as bigint;
    },

    async depositOf(repo: string, kind: Kind, number: number) {
      return (await client.readContract({
        address: escrow,
        abi: escrowArtifact.abi,
        functionName: "depositOf",
        args: [keyOf(repoIdOf(repo), kind, number)],
      })) as { depositor: Address; status: number; serial: bigint; amount: bigint; deadline: bigint };
    },

    mine(blocks: number) {
      return test.mine({ blocks });
    },

    automine(on: boolean) {
      return test.setAutomine(on);
    },

    /** Sends a relay request's authorization to the escrow from `relayerKey`, without waiting for it. */
    submitAuthorization(
      relayerKey: Hex,
      body: {
        repo: string;
        kind: Kind;
        number: number;
        from: Address;
        validAfter: string;
        validBefore: string;
        salt: Hex;
        signature: Hex;
      },
    ): Promise<Hex> {
      const relayer = createWalletClient({ account: privateKeyToAccount(relayerKey), chain, transport: http(url) });
      return relayer.writeContract({
        address: escrow,
        abi: escrowArtifact.abi,
        functionName: "depositWithAuthorization",
        args: [
          repoIdOf(body.repo),
          kindCode(body.kind),
          BigInt(body.number),
          body.from,
          BigInt(body.validAfter),
          BigInt(body.validBefore),
          body.salt,
          body.signature,
        ],
        gas: 300_000n,
      });
    },

    stop() {
      anvil.kill();
    },
  };
}

export type Stack = Awaited<ReturnType<typeof startStack>>;
