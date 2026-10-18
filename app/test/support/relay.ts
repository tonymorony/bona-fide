import { keyOf, kindCode, repoIdOf, type Kind } from "@bona-fide/sdk";
import {
  createTestClient,
  createWalletClient,
  http,
  parseEther,
  parseEventLogs,
  parseGwei,
  toHex,
  type Address,
  type Hex,
  type LocalAccount,
} from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { foundry } from "viem/chains";
import { artifact, POLLING_INTERVAL, type Anvil } from "./anvil.ts";
import { REPO } from "./webhooks.ts";

export const RELAY_URL = "https://app.example/relay/deposit";

export interface SignedDepositOptions {
  repo?: string;
  kind?: Kind;
  number: number;
  value?: bigint;
  validBefore?: bigint;
}

// Signs and funds with fresh keys, as a Contributor's own wallet would; anvil's dev accounts stay the
// deployer, Keeper and Maintainer.
export async function relayKit(anvil: Anvil) {
  const wallet = createWalletClient({ chain: foundry, transport: http(anvil.url), pollingInterval: POLLING_INTERVAL });
  const test = createTestClient({
    chain: foundry,
    mode: "anvil",
    transport: http(anvil.url),
    pollingInterval: POLLING_INTERVAL,
  });
  const [deployer, keeper, contributor] = await wallet.getAddresses();
  const usdcAbi = artifact("MockUSDC").abi;
  const usdc = (await anvil.client.readContract({
    address: anvil.escrow,
    abi: anvil.escrowAbi,
    functionName: "usdc",
  })) as Address;

  async function send(from: Address, address: Address, abi: typeof usdcAbi, functionName: string, args: unknown[]) {
    const hash = await wallet.writeContract({ account: from, chain: foundry, address, abi, functionName, args });
    return anvil.client.waitForTransactionReceipt({ hash });
  }

  async function chainTime(): Promise<bigint> {
    return BigInt(Math.floor((await anvil.now()).getTime() / 1000));
  }

  return {
    usdc,

    /** A fresh EOA holding 5 USDC and no gas. */
    async fundedSigner(): Promise<LocalAccount> {
      const signer = privateKeyToAccount(generatePrivateKey());
      await send(deployer!, usdc, usdcAbi, "mint", [signer.address, 5_000_000n]);
      return signer;
    },

    /** Gives `address` gas. */
    fundGas(address: Address): Promise<void> {
      return test.setBalance({ address, value: parseEther("10") });
    },

    /** A wallet client for a fresh relayer key that holds gas. */
    async relayer() {
      const account = privateKeyToAccount(generatePrivateKey());
      await this.fundGas(account.address);
      return createWalletClient({ account, transport: http(anvil.url), pollingInterval: POLLING_INTERVAL });
    },

    /** Replaces the repo's Binding with a new amount and waits out the binding delay. */
    async rebind(repo: string, amount: bigint) {
      const repoId = repoIdOf(repo);
      await send(keeper!, anvil.escrow, anvil.escrowAbi, "proposeRepo", [repoId, keeper, 5000, 7 * 86_400, amount]);
      await test.increaseTime({ seconds: 3600 });
      await test.mine({ blocks: 1 });
      await send(keeper!, anvil.escrow, anvil.escrowAbi, "activateRepo", [repoId]);
    },

    /** The body of a relay request: an EIP-3009 ReceiveWithAuthorization signed by `signer`. */
    async signedDeposit(
      signer: LocalAccount,
      { repo = REPO, kind = "pr", number, value, validBefore }: SignedDepositOptions,
    ) {
      const salt = toHex(crypto.getRandomValues(new Uint8Array(32)));
      const key = keyOf(repoIdOf(repo), kind, number);
      const nonce = (await anvil.client.readContract({
        address: anvil.escrow,
        abi: anvil.escrowAbi,
        functionName: "authorizationNonce",
        args: [key, salt],
      })) as Hex;
      const amount = value ?? 1_000_000n;
      const before = validBefore ?? (await chainTime()) + 600n;
      const signature = await signer.signTypedData({
        domain: { name: "USDC", version: "2", chainId: foundry.id, verifyingContract: usdc },
        types: {
          ReceiveWithAuthorization: [
            { name: "from", type: "address" },
            { name: "to", type: "address" },
            { name: "value", type: "uint256" },
            { name: "validAfter", type: "uint256" },
            { name: "validBefore", type: "uint256" },
            { name: "nonce", type: "bytes32" },
          ],
        },
        primaryType: "ReceiveWithAuthorization",
        message: { from: signer.address, to: anvil.escrow, value: amount, validAfter: 0n, validBefore: before, nonce },
      });
      return {
        repo,
        kind,
        number,
        from: signer.address,
        value: amount.toString(),
        validAfter: "0",
        validBefore: before.toString(),
        salt,
        signature,
      };
    },

    /** The Deposit a relayed transaction made, read from its Deposited event. */
    async depositedIn(hash: Hex) {
      const receipt = await anvil.client.getTransactionReceipt({ hash });
      const [event] = parseEventLogs({ abi: anvil.escrowAbi, logs: receipt.logs, eventName: "Deposited" });
      return event?.args as { depositor: Address; amount: bigint; kind: number; number: bigint } | undefined;
    },

    /** Turns anvil's mining on each transaction on or off. */
    automine(on: boolean): Promise<void> {
      return test.setAutomine(on);
    },

    mineBlock(): Promise<void> {
      return test.mine({ blocks: 1 });
    },

    /** Waits until `address` has a transaction waiting to be mined. */
    async untilPending(address: Address): Promise<void> {
      const mined = await anvil.client.getTransactionCount({ address });
      while ((await anvil.client.getTransactionCount({ address, blockTag: "pending" })) === mined) {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
    },

    /** Sends a direct Deposit that outbids anything pending, without waiting for it to be mined. */
    frontRun(repo: string, kind: Kind, number: number): Promise<Hex> {
      return wallet.writeContract({
        account: contributor!,
        chain: foundry,
        address: anvil.escrow,
        abi: anvil.escrowAbi,
        functionName: "deposit",
        args: [repoIdOf(repo), kindCode(kind), BigInt(number)],
        gas: 300_000n,
        maxFeePerGas: parseGwei("500"),
        maxPriorityFeePerGas: parseGwei("400"),
      });
    },

    /** How many transactions `address` has sent. */
    sent(address: Address): Promise<number> {
      return anvil.client.getTransactionCount({ address });
    },
  };
}

export type RelayKit = Awaited<ReturnType<typeof relayKit>>;

export function post(body: unknown, init: RequestInit = {}): Request {
  return new Request(RELAY_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
    ...init,
  });
}
