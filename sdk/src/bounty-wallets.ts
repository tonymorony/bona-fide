import { getAddress, isAddress, isAddressEqual, zeroAddress, type Address, type Hex, type PublicClient } from "viem";
import { bountyFactoryAbi, bountyWalletAbi } from "./abi.ts";
import { BOUNTY_STATUSES, type BountyStatus } from "./enums.ts";

/** A Bounty wallet's settings and money, as it reports them. USDC in base units, times in seconds. */
export interface BountyWalletState {
  address: Address;
  owner: Address;
  keeper: Address;
  /** Its whole USDC balance: what is reserved for open Bounties, and what isn't. */
  balance: bigint;
  /** The sum of open Bounties. */
  reserved: bigint;
  /** What the owner can post as Bounties or withdraw. */
  available: bigint;
  perPayoutLimit: bigint;
  periodLimit: bigint;
  periodLength: number;
  keeperEnabled: boolean;
  /** What the Keeper could still pay in total if it paid now, before the per-payout limit and the switch. */
  keeperAllowance: bigint;
}

/** One Bounty as `bountyOf` reports it. */
export interface BountyState {
  amount: bigint;
  serial: bigint;
  status: BountyStatus;
  payee: Address | null;
}

/** The reads of the Bounty wallet factory and its wallets, from any client. */
export function createBountyWalletReader(client: PublicClient, factory: Address) {
  const wallet = (address: Address) => ({ address, abi: bountyWalletAbi }) as const;

  return {
    /**
     * `owner`'s Bounty wallet for the repo, or null while they have none. Anyone can create a wallet
     * for any repo: the repo's own is its active Binding Maintainer's.
     */
    async walletOf(repoId: Hex, owner: Address): Promise<Address | null> {
      const address = await client.readContract({
        address: factory,
        abi: bountyFactoryAbi,
        functionName: "walletOf",
        args: [repoId, owner],
      });
      return address === zeroAddress ? null : address;
    },

    async state(address: Address): Promise<BountyWalletState> {
      const at = wallet(address);
      const [owner, keeper, reserved, available, perPayoutLimit, periodLimit, periodLength, keeperEnabled, allowance] =
        await Promise.all([
          client.readContract({ ...at, functionName: "owner" }),
          client.readContract({ ...at, functionName: "keeper" }),
          client.readContract({ ...at, functionName: "reserved" }),
          client.readContract({ ...at, functionName: "available" }),
          client.readContract({ ...at, functionName: "perPayoutLimit" }),
          client.readContract({ ...at, functionName: "periodLimit" }),
          client.readContract({ ...at, functionName: "periodLength" }),
          client.readContract({ ...at, functionName: "keeperEnabled" }),
          client.readContract({ ...at, functionName: "keeperAllowance" }),
        ]);
      return {
        address,
        owner,
        keeper,
        balance: reserved + available,
        reserved,
        available,
        perPayoutLimit,
        periodLimit,
        periodLength,
        keeperEnabled,
        keeperAllowance: allowance,
      };
    },

    async bountyOf(address: Address, issue: number): Promise<BountyState> {
      const b = await client.readContract({ ...wallet(address), functionName: "bountyOf", args: [BigInt(issue)] });
      return {
        amount: b.amount,
        serial: b.serial,
        status: BOUNTY_STATUSES[b.status] ?? "none",
        payee: b.payee === zeroAddress ? null : b.payee,
      };
    },
  };
}

export type BountyWalletReader = ReturnType<typeof createBountyWalletReader>;

/** Why the Keeper can't pay a Bounty of `amount` on its own now, or null if the wallet lets it. */
export function keeperLimitFor(
  amount: bigint,
  wallet: Pick<BountyWalletState, "keeperEnabled" | "perPayoutLimit" | "keeperAllowance">,
): "off" | "per-payout" | "period" | null {
  if (!wallet.keeperEnabled) return "off";
  if (amount > wallet.perPayoutLimit) return "per-payout";
  if (amount > wallet.keeperAllowance) return "period";
  return null;
}

/** Why the wallet can't pay `payee`, as its own check refuses it, or null if it can. */
export function payeeProblem(payee: Address, wallet: Address, keeper: Address): string | null {
  if (isAddressEqual(payee, zeroAddress)) return "it is the zero address";
  if (isAddressEqual(payee, wallet)) return "it is the Bounty wallet itself";
  if (isAddressEqual(payee, keeper)) return "it is the Keeper's address";
  return null;
}

/** A line of its own, such as "Bounty wallet: 0x…". The label's case doesn't matter, and backticks are allowed. */
const PAYEE_DECLARATION = /^[ \t]*bounty wallet:[ \t]*(.*?)[ \t]*$/gim;
const HEX_ADDRESS = /^0x[0-9a-fA-F]{40}$/;

/** The line, on its own in a PR's body or comment, with which its author names their Payee. */
export function payeeLine(payee: Address): string {
  return `Bounty wallet: ${getAddress(payee)}`;
}

/**
 * What a text's last "Bounty wallet:" line names, or null without one. A line that names no address
 * gives `written`, what it says, when that looks like an address, so it can be quoted back.
 */
export type PayeeDeclaration = { address: Address } | { address: null; written: string | null };

// A mixed-case address must carry a valid EIP-55 checksum, so a typo in one isn't paid.
export function payeeDeclaredIn(text: string): PayeeDeclaration | null {
  let last: string | null = null;
  for (const match of text.matchAll(PAYEE_DECLARATION)) last = match[1]!;
  if (last === null) return null;
  const value = last
    .trim()
    .replace(/^`(.*)`$/, "$1")
    .trim();
  if (isAddress(value)) return { address: getAddress(value) };
  return { address: null, written: HEX_ADDRESS.test(value) ? value : null };
}
