import { createPublicClient, http, zeroAddress, type Address, type Hex, type PublicClient } from "viem";
import { escrowAbi, STATUSES, usdcAbi, type Status } from "./abi.ts";
import { chainOf, type LiveNetwork, type Network } from "./network.ts";

/** A Binding's terms: USDC base units, basis points and seconds, and the Maintainer it binds. */
export interface Terms {
  maintainer: Address;
  amount: bigint;
  forfeitBps: number;
  timeoutSeconds: number;
}

export interface RepoTerms {
  active: Terms | null;
  pending: (Terms & { effectiveAt: Date }) | null;
}

/** A Deposit as the escrow snapshotted it. */
export interface DepositState {
  status: Status;
  depositor: Address;
  deadline: Date;
  maintainer: Address;
  forfeitBps: number;
  serial: bigint;
  amount: bigint;
}

export function publicClientFor(network: Network): PublicClient {
  return createPublicClient({ chain: chainOf(network), transport: http(network.rpcUrl, { retryCount: 2 }) });
}

// The escrow returns an all-zero config for "none": a Binding always names a Maintainer.
function termsFrom(config: { maintainer: Address; forfeitBps: number; timeout: number; amount: bigint }): Terms | null {
  if (config.maintainer === zeroAddress) return null;
  return {
    maintainer: config.maintainer,
    amount: config.amount,
    forfeitBps: config.forfeitBps,
    timeoutSeconds: config.timeout,
  };
}

function dateOf(seconds: bigint): Date {
  return new Date(Number(seconds) * 1000);
}

/** The reads every page makes, from the network's public RPC. */
export function createChainReader(client: PublicClient, network: LiveNetwork) {
  const escrow = { address: network.escrow, abi: escrowAbi } as const;

  return {
    async repoTerms(repoId: Hex): Promise<RepoTerms> {
      const [active, [pending, effectiveAt]] = await Promise.all([
        client.readContract({ ...escrow, functionName: "activeConfig", args: [repoId] }),
        client.readContract({ ...escrow, functionName: "pendingConfig", args: [repoId] }),
      ]);
      const proposed = termsFrom(pending);
      return { active: termsFrom(active), pending: proposed && { ...proposed, effectiveAt: dateOf(effectiveAt) } };
    },

    async depositOf(key: Hex): Promise<DepositState> {
      const d = await client.readContract({ ...escrow, functionName: "depositOf", args: [key] });
      return {
        status: STATUSES[d.status] ?? "none",
        depositor: d.depositor,
        deadline: dateOf(d.deadline),
        maintainer: d.maintainer,
        forfeitBps: d.forfeitBps,
        serial: d.serial,
        amount: d.amount,
      };
    },

    /** The latest block's time: the clock the escrow and USDC check signatures and deadlines against. */
    async now(): Promise<Date> {
      return dateOf((await client.getBlock({ blockTag: "latest" })).timestamp);
    },

    async bindingDelaySeconds(): Promise<number> {
      return Number(await client.readContract({ ...escrow, functionName: "bindingDelay" }));
    },

    usdcBalance(account: Address): Promise<bigint> {
      return client.readContract({ address: network.usdc, abi: usdcAbi, functionName: "balanceOf", args: [account] });
    },

    allowance(owner: Address): Promise<bigint> {
      return client.readContract({
        address: network.usdc,
        abi: usdcAbi,
        functionName: "allowance",
        args: [owner, network.escrow],
      });
    },

    /** Forfeited USDC waiting in the Charity router, from every repo. */
    routerBalance(): Promise<bigint> {
      return this.usdcBalance(network.router);
    },
  };
}

export type ChainReader = ReturnType<typeof createChainReader>;
