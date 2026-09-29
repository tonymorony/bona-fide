import { execFileSync, spawn } from "node:child_process";
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

  const [deployer, keeper] = await wallet.getAddresses();
  const usdcArtifact = artifact("MockUSDC");
  const escrowArtifact = artifact("BonaFideEscrow");

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

  async function propose(repo: string, amount: bigint) {
    await send(keeper!, escrow, escrowArtifact.abi, "proposeRepo", [repoIdOf(repo), keeper, 5000, 7 * 86_400, amount]);
  }

  return {
    url,
    client,
    escrow,
    escrowAbi: escrowArtifact.abi,
    usdc,
    usdcAbi: usdcArtifact.abi,

    /** Proposes a Binding (Maintainer = the Keeper, 50%, 7 days) that takes effect after the binding delay. */
    propose,

    /** Binds the repo with `amount` (default 1 USDC), 50% and 7 days, and waits out the binding delay. */
    async bind(repo: string, amount = 1_000_000n) {
      await propose(repo, amount);
      await test.increaseTime({ seconds: BINDING_DELAY });
      await test.mine({ blocks: 1 });
      await send(keeper!, escrow, escrowArtifact.abi, "activateRepo", [repoIdOf(repo)]);
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
