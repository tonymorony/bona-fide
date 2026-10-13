import { parseAbi, zeroAddress, type Address, type Hex, type LocalAccount, type PublicClient } from "viem";
import { inTurnFor, revertNameOf, sendAndWait } from "../keeper/escrow.ts";
import { isValidSignatureNow } from "../keeper/signatures.ts";

export const bountyFactoryAbi = parseAbi(["function walletOf(bytes32 repoId, address owner) view returns (address)"]);

export const bountyWalletAbi = parseAbi([
  "function bountyOf(uint64 issueNumber) view returns ((uint256 amount, uint64 serial, uint8 status, address payee))",
  "function owner() view returns (address)",
  "function perPayoutLimit() view returns (uint256)",
  "function keeperAllowance() view returns (uint256)",
  "function keeperEnabled() view returns (bool)",
  "function keeperPay(uint64 issueNumber, address payee)",
  "function payWithSignature(uint64 issueNumber, address payee, uint256 deadline, bytes signature)",
  "event Paid(uint64 indexed issueNumber, uint64 serial, address indexed payee, uint256 amount, uint8 method)",
  "error NotKeeper()",
  "error KeeperDisabled()",
  "error BountyNotOpen()",
  "error InvalidRecipient()",
  "error AbovePayoutLimit()",
  "error AbovePeriodLimit()",
  "error InvalidSignature()",
  "error SignatureExpired()",
]);

/** One of the Bounty wallet's custom errors, such as "AbovePeriodLimit". */
export type BountyWalletError = Extract<(typeof bountyWalletAbi)[number], { type: "error" }>["name"];

/** The Bounty wallet would revert with one of its custom errors. */
export class BountyRejection extends Error {
  readonly reason: BountyWalletError;

  constructor(reason: BountyWalletError) {
    super(`The Bounty wallet would revert with ${reason}.`);
    this.reason = reason;
  }
}

const PAID = bountyWalletAbi.find((item) => item.type === "event" && item.name === "Paid")!;

/** The wallet's Status enum in order. */
const STATUSES = ["none", "open", "paid", "cancelled"] as const;
export type BountyStatus = (typeof STATUSES)[number];

export interface WalletBounty {
  status: BountyStatus;
  amount: bigint;
  serial: bigint;
  /** Zero until it is paid. */
  payee: Address;
}

/** An issue's Bounty in a wallet, and what the Keeper may pay from the wallet now. */
export interface WalletState {
  owner: Address;
  bounty: WalletBounty;
  perPayoutLimit: bigint;
  /** What the Keeper could still pay in this period, before `perPayoutLimit` and the switch. */
  keeperAllowance: bigint;
  keeperEnabled: boolean;
}

/**
 * The Bounty wallets as the Keeper uses them: reads, and transactions signed with the Keeper key.
 * As for the escrow, each transaction is simulated first and sent in turn with the escrow's.
 */
export interface BountyWallets {
  /** The Keeper's address. No Payout may reach it. */
  readonly keeper: Address;
  chainId(): Promise<number>;
  /** The latest block's time, in Unix seconds. */
  now(): Promise<bigint>;
  /** Whether `signer` made `signature` over `digest`, checked as the wallet checks it. */
  isValidSignature(signer: Address, digest: Hex, signature: Hex): Promise<boolean>;
  /** The wallet `owner` created for the repo through the factory, or null. */
  walletOf(repoId: Hex, owner: Address): Promise<Address | null>;
  stateOf(wallet: Address, issueNumber: number): Promise<WalletState>;
  /**
   * Pays the issue's open Bounty to `payee` as the Keeper. Only the Bounty with `serial`: it is read
   * again just before sending. Null if it is no longer open. Throws a BountyRejection if the wallet
   * would revert, and a TransactionReverted if it reverted all the same.
   */
  keeperPay(wallet: Address, issueNumber: number, payee: Address, serial: bigint): Promise<Hex | null>;
  /** Relays the owner's signed Payout. Throws as `keeperPay` does. */
  payWithSignature(
    wallet: Address,
    issueNumber: number,
    payee: Address,
    deadline: bigint,
    signature: Hex,
  ): Promise<Hex>;
  /** The transaction that paid the issue's Bounty with this serial, or null if no Paid event names it. */
  paidTransaction(wallet: Address, issueNumber: number, serial: bigint): Promise<Hex | null>;
}

export interface BountyWalletsOptions {
  client: PublicClient;
  /** The Keeper's account, the one its escrow transactions use. */
  account: LocalAccount;
  factory: Address;
  /** The factory's deploy block. No Payout is older, so searches start here. */
  fromBlock?: bigint;
}

export function createBountyWallets({ client, account, factory, fromBlock = 0n }: BountyWalletsOptions): BountyWallets {
  const inTurn = inTurnFor(account);
  let chainId: Promise<number> | undefined;

  function read<const F extends "owner" | "perPayoutLimit" | "keeperAllowance" | "keeperEnabled">(
    wallet: Address,
    functionName: F,
  ) {
    return client.readContract({ address: wallet, abi: bountyWalletAbi, functionName });
  }

  async function bountyOf(wallet: Address, issueNumber: number): Promise<WalletBounty> {
    const b = await client.readContract({
      address: wallet,
      abi: bountyWalletAbi,
      functionName: "bountyOf",
      args: [BigInt(issueNumber)],
    });
    return { status: STATUSES[b.status] ?? "none", amount: b.amount, serial: b.serial, payee: b.payee };
  }

  return {
    keeper: account.address,

    chainId() {
      chainId ??= client.getChainId();
      return chainId;
    },

    async now() {
      return (await client.getBlock({ blockTag: "latest" })).timestamp;
    },

    isValidSignature(signer, digest, signature) {
      return isValidSignatureNow(client, signer, digest, signature);
    },

    async walletOf(repoId, owner) {
      const wallet = await client.readContract({
        address: factory,
        abi: bountyFactoryAbi,
        functionName: "walletOf",
        args: [repoId, owner],
      });
      return wallet === zeroAddress ? null : wallet;
    },

    async stateOf(wallet, issueNumber) {
      const [owner, bounty, perPayoutLimit, keeperAllowance, keeperEnabled] = await Promise.all([
        read(wallet, "owner"),
        bountyOf(wallet, issueNumber),
        read(wallet, "perPayoutLimit"),
        read(wallet, "keeperAllowance"),
        read(wallet, "keeperEnabled"),
      ]);
      return { owner, bounty, perPayoutLimit, keeperAllowance, keeperEnabled };
    },

    keeperPay(wallet, issueNumber, payee, serial) {
      return inTurn(async () => {
        const bounty = await bountyOf(wallet, issueNumber);
        if (bounty.status !== "open" || bounty.serial !== serial) return null;
        const { request } = await rejecting(
          client.simulateContract({
            account,
            address: wallet,
            abi: bountyWalletAbi,
            functionName: "keeperPay",
            args: [BigInt(issueNumber), payee],
          }),
        );
        return (await sendAndWait(client, request)).transactionHash;
      });
    },

    payWithSignature(wallet, issueNumber, payee, deadline, signature) {
      return inTurn(async () => {
        const { request } = await rejecting(
          client.simulateContract({
            account,
            address: wallet,
            abi: bountyWalletAbi,
            functionName: "payWithSignature",
            args: [BigInt(issueNumber), payee, deadline, signature],
          }),
        );
        return (await sendAndWait(client, request)).transactionHash;
      });
    },

    async paidTransaction(wallet, issueNumber, serial) {
      const logs = await client.getLogs({
        address: wallet,
        event: PAID,
        args: { issueNumber: BigInt(issueNumber) },
        fromBlock,
        strict: true,
      });
      return logs.find((log) => log.args.serial === serial)?.transactionHash ?? null;
    },
  };
}

async function rejecting<T>(simulation: Promise<T>): Promise<T> {
  try {
    return await simulation;
  } catch (error) {
    const reason = revertNameOf(error);
    throw isWalletError(reason) ? new BountyRejection(reason) : error;
  }
}

function isWalletError(name: string | undefined): name is BountyWalletError {
  return bountyWalletAbi.some((item) => item.type === "error" && item.name === name);
}
