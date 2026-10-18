import {
  bountyFactoryAbi,
  bountyWalletAbi,
  createBountyWalletReader,
  PAYOUT_METHODS,
  usdcAbi,
  type PayoutMethod,
} from "@bona-fide/sdk";
import type { Address, Hex, PublicClient } from "viem";
import type { RepoTerms } from "./chain.ts";
import { readInRanges } from "./history.ts";
import type { Network } from "./network.ts";

/** A network whose Bounty wallet factory is deployed. */
export type BountyNetwork = Network & { bountyFactory: Address };

export function hasBounties(network: Network): network is BountyNetwork {
  return network.bountyFactory !== "";
}

/** One posted Bounty and how it ended, rebuilt from the wallet's events. */
export interface BountyRow {
  issue: number;
  serial: bigint;
  amount: bigint;
  status: "open" | "paid" | "cancelled";
  postedTx: Hex;
  payee?: Address;
  method?: PayoutMethod;
  /** The Payout's or the cancellation's transaction. */
  closedTx?: Hex;
}

/** A decoded event of a Bounty wallet, as getLogs returns it. */
export type BountyEvent =
  | { eventName: "BountyPosted"; args: { issueNumber: bigint; serial: bigint; amount: bigint }; transactionHash: Hex }
  | {
      eventName: "BountyCancelled";
      args: { issueNumber: bigint; serial: bigint; amount: bigint };
      transactionHash: Hex;
    }
  | {
      eventName: "Paid";
      args: { issueNumber: bigint; serial: bigint; payee: Address; amount: bigint; method: number };
      transactionHash: Hex;
    }
  | { eventName: string; args: unknown; transactionHash: Hex };

/**
 * Every Bounty a wallet posted, newest first, and how each ended, from its events in chain order. A
 * Bounty is its issue and Serial: a cancelled one posted again is a new row.
 */
export function bountiesFrom(events: readonly BountyEvent[]): BountyRow[] {
  const rows = new Map<string, BountyRow>();
  const idOf = (issue: bigint, serial: bigint) => `${issue}:${serial}`;
  for (const event of events) {
    if (event.eventName === "BountyPosted") {
      const { issueNumber, serial, amount } = (event as Extract<BountyEvent, { eventName: "BountyPosted" }>).args;
      rows.set(idOf(issueNumber, serial), {
        issue: Number(issueNumber),
        serial,
        amount,
        status: "open",
        postedTx: event.transactionHash,
      });
    } else if (event.eventName === "BountyCancelled") {
      const { issueNumber, serial } = (event as Extract<BountyEvent, { eventName: "BountyCancelled" }>).args;
      const row = rows.get(idOf(issueNumber, serial));
      if (!row) continue;
      row.status = "cancelled";
      row.closedTx = event.transactionHash;
    } else if (event.eventName === "Paid") {
      const { issueNumber, serial, payee, amount, method } = (event as Extract<BountyEvent, { eventName: "Paid" }>)
        .args;
      const row = rows.get(idOf(issueNumber, serial));
      if (!row) continue;
      row.status = "paid";
      row.amount = amount;
      row.payee = payee;
      row.method = PAYOUT_METHODS[method];
      row.closedTx = event.transactionHash;
    }
  }
  return [...rows.values()].reverse();
}

const EVENTS = bountyWalletAbi.filter(
  (item) => item.type === "event" && ["BountyPosted", "BountyCancelled", "Paid"].includes(item.name),
);

/** The reads the Bounty page and the repo page make, from the network's public RPC. */
export function createBountyReader(client: PublicClient, network: BountyNetwork) {
  const reader = createBountyWalletReader(client, network.bountyFactory);

  return {
    ...reader,

    /**
     * The repo's Bounty wallet: the active Binding Maintainer's, and no one else's. Anyone can create a
     * wallet for any repo, so a wallet another address made for it is never the repo's.
     */
    async repoWallet(repoId: Hex, terms: RepoTerms): Promise<Address | null> {
      if (!terms.active) return null;
      return reader.walletOf(repoId, terms.active.maintainer);
    },

    /** Every Bounty the wallet posted, newest first, from its events since the factory was deployed. */
    async bounties(
      address: Address,
      { rangeSize, onProgress }: { rangeSize?: number; onProgress?: (done: number, total: number) => void } = {},
    ): Promise<BountyRow[]> {
      const events = await readInRanges({
        client,
        fromBlock: network.bountyFactoryFromBlock,
        rangeSize,
        onProgress,
        read: (fromBlock, toBlock) => client.getLogs({ address, events: EVENTS, fromBlock, toBlock, strict: true }),
      });
      return bountiesFrom(events);
    },
  };
}

export type BountyReader = ReturnType<typeof createBountyReader>;

/** A Bounty wallet's first limits, or new ones: USDC base units, and seconds. */
export interface BountyLimits {
  perPayoutLimit: bigint;
  periodLimit: bigint;
  periodLength: number;
}

/** What the Bounty page suggests for a new wallet: up to 50 USDC a Bounty, and 200 USDC a week, without asking. */
export const DEFAULT_LIMITS: BountyLimits = {
  perPayoutLimit: 50_000_000n,
  periodLimit: 200_000_000n,
  periodLength: 7 * 86_400,
};

/** The wallet accepts periods from 1 hour to 365 days. */
export const PERIOD_LENGTHS = { min: 3600, max: 365 * 86_400 } as const;

/** The transactions the Bounty page sends, as contract calls for the connected wallet. */
export const bountyCalls = {
  create: (factory: Address, repoId: Hex, limits: BountyLimits) =>
    ({
      address: factory,
      abi: bountyFactoryAbi,
      functionName: "create",
      args: [repoId, limits.perPayoutLimit, limits.periodLimit, limits.periodLength],
    }) as const,

  approve: (usdc: Address, wallet: Address, amount: bigint) =>
    ({ address: usdc, abi: usdcAbi, functionName: "approve", args: [wallet, amount] }) as const,

  fund: (wallet: Address, amount: bigint) =>
    ({ address: wallet, abi: bountyWalletAbi, functionName: "fund", args: [amount] }) as const,

  /** Redeems the owner's EIP-3009 authorization, made with `bountyFundAuthorization`. */
  fundWithAuthorization: (
    wallet: Address,
    authorization: { from: Address; value: bigint; validBefore: bigint; nonce: Hex },
    signature: Hex,
  ) =>
    ({
      address: wallet,
      abi: bountyWalletAbi,
      functionName: "fundWithAuthorization",
      args: [authorization.from, authorization.value, 0n, authorization.validBefore, authorization.nonce, signature],
    }) as const,

  post: (wallet: Address, issue: number, amount: bigint) =>
    ({ address: wallet, abi: bountyWalletAbi, functionName: "postBounty", args: [BigInt(issue), amount] }) as const,

  cancel: (wallet: Address, issue: number) =>
    ({ address: wallet, abi: bountyWalletAbi, functionName: "cancelBounty", args: [BigInt(issue)] }) as const,

  ownerPay: (wallet: Address, issue: number, payee: Address) =>
    ({ address: wallet, abi: bountyWalletAbi, functionName: "ownerPay", args: [BigInt(issue), payee] }) as const,

  payWithSignature: (wallet: Address, issue: number, payee: Address, deadline: bigint, signature: Hex) =>
    ({
      address: wallet,
      abi: bountyWalletAbi,
      functionName: "payWithSignature",
      args: [BigInt(issue), payee, deadline, signature],
    }) as const,

  withdraw: (wallet: Address, to: Address, amount: bigint) =>
    ({ address: wallet, abi: bountyWalletAbi, functionName: "withdraw", args: [to, amount] }) as const,

  setLimits: (wallet: Address, limits: BountyLimits) =>
    ({
      address: wallet,
      abi: bountyWalletAbi,
      functionName: "setLimits",
      args: [limits.perPayoutLimit, limits.periodLimit, limits.periodLength],
    }) as const,

  setKeeperEnabled: (wallet: Address, enabled: boolean) =>
    ({ address: wallet, abi: bountyWalletAbi, functionName: "setKeeperEnabled", args: [enabled] }) as const,
};
