import { execFileSync, spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { createServer, type AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import { forfeitVerdict } from "@bona-fide/sdk";
import {
  createPublicClient,
  createTestClient,
  createWalletClient,
  defineChain,
  getAddress,
  http,
  keccak256,
  parseEther,
  parseEventLogs,
  stringToBytes,
  type Abi,
  type Address,
  type Hex,
  type LocalAccount,
} from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

const CONTRACTS = fileURLToPath(new URL("../../../contracts/", import.meta.url));
const FORFEIT_SINK = "0x000000000000000000000000000000000000dEaD";
const BINDING_DELAY = 3600;

/** anvil with Arc testnet's chain id, so typed data and Circle commands read as they would there. */
export const ARC_TESTNET = defineChain({
  id: 5042002,
  name: "Arc Testnet (local)",
  nativeCurrency: { name: "USDC", symbol: "USDC", decimals: 18 },
  rpcUrls: { default: { http: ["http://127.0.0.1"] } },
});

function artifact(name: string): { abi: Abi; bytecode: Hex } {
  const json = JSON.parse(readFileSync(`${CONTRACTS}out/${name}.sol/${name}.json`, "utf8"));
  return { abi: json.abi, bytecode: json.bytecode.object };
}

export function repoIdOf(repo: string): Hex {
  return keccak256(stringToBytes(`github:${repo.toLowerCase()}`));
}

const KIND_CODES = { pr: 0, issue: 1 } as const;

// The real BonaFideEscrow and the EIP-3009 MockUSDC, deployed from the Foundry artifacts. The
// deployer and Keeper are anvil's unlocked dev accounts; Contributors are fresh keys.
export async function startChain() {
  const port = await freePort();
  const anvil = spawn("anvil", ["--port", String(port), "--chain-id", String(ARC_TESTNET.id)], { stdio: "ignore" });
  const url = `http://127.0.0.1:${port}`;
  const client = createPublicClient({ chain: ARC_TESTNET, transport: http(url) });
  const test = createTestClient({ chain: ARC_TESTNET, mode: "anvil", transport: http(url) });
  const wallet = createWalletClient({ chain: ARC_TESTNET, transport: http(url) });
  await until(async () => (await client.getChainId()) === ARC_TESTNET.id);

  const [deployer, keeper, maintainer, stranger] = await wallet.getAddresses();
  const usdcArtifact = artifact("MockUSDC");
  const escrowArtifact = artifact("BonaFideEscrow");
  const factoryArtifact = artifact("BountyWalletFactory");
  const walletArtifact = artifact("BountyWallet");

  async function send(from: Address, address: Address, abi: Abi, functionName: string, args: unknown[]) {
    const hash = await wallet.writeContract({ account: from, chain: ARC_TESTNET, address, abi, functionName, args });
    return client.waitForTransactionReceipt({ hash });
  }

  async function deploy(abi: Abi, bytecode: Hex, args: unknown[]): Promise<Address> {
    const hash = await wallet.deployContract({ account: deployer!, chain: ARC_TESTNET, abi, bytecode, args });
    return getAddress((await client.waitForTransactionReceipt({ hash })).contractAddress!);
  }

  const usdc = await deploy(usdcArtifact.abi, usdcArtifact.bytecode, []);
  const escrow = await deploy(escrowArtifact.abi, escrowArtifact.bytecode, [
    usdc,
    keeper,
    FORFEIT_SINK,
    BigInt(BINDING_DELAY),
    50_000_000n,
  ]);

  const bountyFactory = await deploy(factoryArtifact.abi, factoryArtifact.bytecode, [usdc, keeper]);

  async function propose(repo: string, amount: bigint, by: Address = keeper!) {
    await send(keeper!, escrow, escrowArtifact.abi, "proposeRepo", [repoIdOf(repo), by, 5000, 7 * 86_400, amount]);
  }

  async function depositOf(key: Hex) {
    return (await client.readContract({
      address: escrow,
      abi: escrowArtifact.abi,
      functionName: "depositOf",
      args: [key],
    })) as { serial: bigint };
  }

  return {
    url,
    client,
    escrow,
    escrowAbi: escrowArtifact.abi,
    usdc,
    usdcAbi: usdcArtifact.abi,
    keeper: keeper!,
    /** A dev account that Maintains the repos bound with it. */
    maintainer: maintainer!,
    /** A dev account that Maintains nothing. */
    stranger: stranger!,
    bountyFactory,

    /** Proposes a Binding (Maintainer = the Keeper by default, 50%, 7 days) that takes effect after the binding delay. */
    propose,

    /** Binds the repo with `amount` (default 1 USDC), 50% and 7 days, and waits out the binding delay. */
    async bind(repo: string, amount = 1_000_000n, by: Address = keeper!) {
      await propose(repo, amount, by);
      await test.increaseTime({ seconds: BINDING_DELAY });
      await test.mine({ blocks: 1 });
      await send(keeper!, escrow, escrowArtifact.abi, "activateRepo", [repoIdOf(repo)]);
    },

    /** Moves the chain's time forward and mines a block at the new time. */
    async increaseTime(seconds: number) {
      await test.increaseTime({ seconds });
      await test.mine({ blocks: 1 });
    },

    /** The Keeper refunds a Deposit early, as on a merge. */
    async keeperRefund(key: Hex) {
      return send(keeper!, escrow, escrowArtifact.abi, "refund", [key]);
    },

    /** Forfeits a Deposit of a repo bound with the Keeper as its Maintainer, with its signed verdict. */
    async forfeit(key: Hex) {
      const sigDeadline = (await client.getBlock()).timestamp + 600n;
      const { serial } = await depositOf(key);
      const verdict = forfeitVerdict({ chainId: ARC_TESTNET.id, escrow, key, serial, sigDeadline });
      const signature = await wallet.signTypedData({ account: keeper!, ...verdict });
      return send(deployer!, escrow, escrowArtifact.abi, "forfeit", [key, sigDeadline, signature]);
    },

    /** Creates `owner`'s Bounty wallet for the repo, funds it and posts the Bounties, as [issue, amount]. */
    async postBounties(
      owner: Address,
      repo: string,
      limits: { perPayout: bigint; period: bigint },
      bounties: [number, bigint][],
    ): Promise<Address> {
      await send(owner, bountyFactory, factoryArtifact.abi, "create", [
        repoIdOf(repo),
        limits.perPayout,
        limits.period,
        86_400,
      ]);
      const address = (await client.readContract({
        address: bountyFactory,
        abi: factoryArtifact.abi,
        functionName: "walletOf",
        args: [repoIdOf(repo), owner],
      })) as Address;
      const total = bounties.reduce((sum, [, amount]) => sum + amount, 0n);
      await send(deployer!, usdc, usdcArtifact.abi, "mint", [owner, total]);
      await send(owner, usdc, usdcArtifact.abi, "approve", [address, total]);
      await send(owner, address, walletArtifact.abi, "fund", [total]);
      for (const [issue, amount] of bounties) {
        await send(owner, address, walletArtifact.abi, "postBounty", [BigInt(issue), amount]);
      }
      return address;
    },

    /** The Keeper pays an open Bounty within the wallet's limits. */
    async keeperPay(bountyWallet: Address, issue: number, payee: Address) {
      return send(keeper!, bountyWallet, walletArtifact.abi, "keeperPay", [BigInt(issue), payee]);
    },

    async usdcBalance(account: Address): Promise<bigint> {
      return (await client.readContract({
        address: usdc,
        abi: usdcArtifact.abi,
        functionName: "balanceOf",
        args: [account],
      })) as bigint;
    },

    /** A fresh EOA holding `amount` USDC base units and some gas, with its key for signing. */
    async contributor(amount = 5_000_000n): Promise<{ key: Hex; account: LocalAccount }> {
      const key = generatePrivateKey();
      const account = privateKeyToAccount(key);
      await send(deployer!, usdc, usdcArtifact.abi, "mint", [account.address, amount]);
      await test.setBalance({ address: account.address, value: parseEther("1") });
      return { key, account };
    },

    /** A fresh key that holds gas, for relaying. */
    async gasKey(): Promise<Hex> {
      const key = generatePrivateKey();
      await test.setBalance({ address: privateKeyToAccount(key).address, value: parseEther("10") });
      return key;
    },

    /** Deposits directly, as `account`'s own two transactions. */
    async deposit(account: LocalAccount, repo: string, kind: "pr" | "issue", number: number, amount = 1_000_000n) {
      const own = createWalletClient({ account, chain: ARC_TESTNET, transport: http(url) });
      await client.waitForTransactionReceipt({
        hash: await own.writeContract({
          address: usdc,
          abi: usdcArtifact.abi,
          functionName: "approve",
          args: [escrow, amount],
        }),
      });
      await client.waitForTransactionReceipt({
        hash: await own.writeContract({
          address: escrow,
          abi: escrowArtifact.abi,
          functionName: "deposit",
          args: [repoIdOf(repo), KIND_CODES[kind], BigInt(number)],
        }),
      });
    },

    /** Sends a prepared transaction from `account`. */
    async sendFrom(account: LocalAccount, to: Address, data: Hex) {
      const own = createWalletClient({ account, chain: ARC_TESTNET, transport: http(url) });
      return client.waitForTransactionReceipt({ hash: await own.sendTransaction({ to, data }) });
    },

    /** The Deposit a transaction made, from its Deposited event. */
    async depositedIn(hash: Hex) {
      const receipt = await client.getTransactionReceipt({ hash });
      const [event] = parseEventLogs({ abi: escrowArtifact.abi, logs: receipt.logs, eventName: "Deposited" });
      return event?.args as { depositor: Address; amount: bigint; number: bigint } | undefined;
    },

    /** The escrow's own keyOf, as a reference for the key the tools report. */
    keyOf(repo: string, kind: "pr" | "issue", number: number): Promise<Hex> {
      return client.readContract({
        address: escrow,
        abi: escrowArtifact.abi,
        functionName: "keyOf",
        args: [repoIdOf(repo), KIND_CODES[kind], BigInt(number)],
      }) as Promise<Hex>;
    },

    /** The escrow's own authorizationNonce, as a reference for the nonce the tools sign. */
    authorizationNonce(key: Hex, salt: Hex): Promise<Hex> {
      return client.readContract({
        address: escrow,
        abi: escrowArtifact.abi,
        functionName: "authorizationNonce",
        args: [key, salt],
      }) as Promise<Hex>;
    },

    /** Relays a signed authorization straight to the escrow, from a dev account. */
    async depositWithAuthorization(args: {
      repo: string;
      kind: "pr" | "issue";
      number: number;
      from: Address;
      validAfter: string;
      validBefore: string;
      salt: Hex;
      signature: Hex;
    }) {
      return send(deployer!, escrow, escrowArtifact.abi, "depositWithAuthorization", [
        repoIdOf(args.repo),
        KIND_CODES[args.kind],
        BigInt(args.number),
        args.from,
        BigInt(args.validAfter),
        BigInt(args.validBefore),
        args.salt,
        args.signature,
      ]);
    },

    async now(): Promise<bigint> {
      return (await client.getBlock()).timestamp;
    },

    stop() {
      anvil.kill();
    },
  };
}

export type Chain = Awaited<ReturnType<typeof startChain>>;

/** Signs EIP-712 typed data JSON with Foundry's cast, an implementation independent of viem. */
export function castSign(privateKey: Hex, typedData: unknown): Hex {
  return execFileSync("cast", ["wallet", "sign", "--private-key", privateKey, "--data", JSON.stringify(typedData)], {
    encoding: "utf8",
  }).trim() as Hex;
}

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
