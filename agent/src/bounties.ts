import {
  createBountyWalletReader,
  escrowAbi,
  keeperLimitFor,
  payeeLine,
  payeeProblem,
  repoIdOf,
  type BountyStatus,
} from "@bona-fide/sdk";
import { getAddress, zeroAddress, type Address, type Hex, type PublicClient } from "viem";
import { addressLink } from "./copy.ts";
import { Refusal, usdc6 } from "./deposits.ts";

/** The issue a Bounty is posted on. */
export interface BountyTarget {
  repo: string;
  issue: number;
}

/** Why the wallet doesn't let the Keeper pay an open Bounty now, or null if it does. */
export type KeeperLimit = ReturnType<typeof keeperLimitFor>;

export interface BountyReport extends BountyTarget {
  repoId: Hex;
  factory: Address;
  /** The active Binding's Maintainer, whose Bounty wallet is the repo's, or null without a Binding. */
  maintainer: Address | null;
  /** The repo's Bounty wallet, or null while its Maintainer has none. Amounts in USDC base units. */
  wallet: {
    address: Address;
    keeperEnabled: boolean;
    perPayoutLimit: string;
    perPayoutLimitUsdc: string;
    /** What the Keeper could still pay in this period, before the per-payout limit and the switch. */
    keeperAllowance: string;
    keeperAllowanceUsdc: string;
  } | null;
  /** The issue's Bounty in that wallet, or null without a wallet. */
  bounty: {
    status: BountyStatus;
    amount: string;
    amountUsdc: string;
    serial: string;
    /** Who was paid, once it is paid. */
    payee: Address | null;
    /** Whether the wallet lets the Keeper pay it now: open, Keeper payouts on, and within both limits. */
    keeperMayPay: boolean;
    keeperLimit: KeeperLimit;
  } | null;
  /** The payee asked about: the line that names it, and why the wallet would refuse to pay it, if it would. */
  payee: { address: Address; line: string; problem: string | null } | null;
  /** The wallet's page on the block explorer, or null. */
  explorerUrl: string | null;
}

export interface BountiesOptions {
  client: PublicClient;
  escrow: Address;
  /** The Bounty wallet factory, or null or left out where none is known. */
  bountyFactory?: Address | null;
  explorerUrl?: string | null;
}

export function createBounties({ client, escrow, bountyFactory = null, explorerUrl = null }: BountiesOptions) {
  async function bounty(target: BountyTarget, payee?: Address): Promise<BountyReport> {
    if (!bountyFactory) {
      throw new Refusal(
        "This server doesn't know the Bounty wallet factory for its escrow, so it can't read Bounties. Set BOUNTY_FACTORY_ADDRESS, or ESCROW_ADDRESS to Bona Fide's escrow on Arc mainnet.",
      );
    }
    const reader = createBountyWalletReader(client, bountyFactory);
    const repoId = repoIdOf(target.repo);
    const named = payee ? getAddress(payee) : null;
    const base = { ...target, repoId, factory: bountyFactory };
    const payeeOf = (problem: string | null) => named && { address: named, line: payeeLine(named), problem };
    const active = await client.readContract({
      address: escrow,
      abi: escrowAbi,
      functionName: "activeConfig",
      args: [repoId],
    });
    // Anyone can create a wallet for any repo: the repo's own is its active Binding Maintainer's.
    const maintainer = active.maintainer === zeroAddress ? null : active.maintainer;
    const address = maintainer && (await reader.walletOf(repoId, maintainer));
    if (!address) {
      return { ...base, maintainer, wallet: null, bounty: null, payee: payeeOf(null), explorerUrl: null };
    }
    const [state, posted] = await Promise.all([reader.state(address), reader.bountyOf(address, target.issue)]);
    const limit = posted.status === "open" ? keeperLimitFor(posted.amount, state) : null;
    return {
      ...base,
      maintainer,
      wallet: {
        address,
        keeperEnabled: state.keeperEnabled,
        perPayoutLimit: state.perPayoutLimit.toString(),
        perPayoutLimitUsdc: usdc6(state.perPayoutLimit),
        keeperAllowance: state.keeperAllowance.toString(),
        keeperAllowanceUsdc: usdc6(state.keeperAllowance),
      },
      bounty: {
        status: posted.status,
        amount: posted.amount.toString(),
        amountUsdc: usdc6(posted.amount),
        serial: posted.serial.toString(),
        payee: posted.payee,
        keeperMayPay: posted.status === "open" && limit === null,
        keeperLimit: limit,
      },
      payee: payeeOf(named && payeeProblem(named, address, state.keeper)),
      explorerUrl: explorerUrl && addressLink(explorerUrl, address),
    };
  }

  return { bounty };
}
