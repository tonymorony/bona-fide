import { chainOf } from "@bona-fide/sdk";
import { BaseError, ContractFunctionRevertedError, type Address, type Hex } from "viem";
import { createChainReader, publicClientFor } from "../chain.ts";
import type { Fetch } from "../endpoints.ts";
import { shortAddress, usdc } from "../format.ts";
import type { LiveNetwork } from "../network.ts";
import { chainName, createSession, type WalletSession } from "../ui/session.ts";
import type { View } from "../ui/dom.ts";
import { isUserRejection } from "../wallet.ts";

declare const __NETWORK__: LiveNetwork;

/** The network this build of the pages is for. */
export const network: LiveNetwork = __NETWORK__;
export const chain = chainOf(network);
export const client = publicClientFor(network);
export const reader = createChainReader(client, network);
/** The browser's fetch: the App's endpoints are on the pages' own origin. */
export const pageFetch: Fetch = (input, init) => fetch(input, init);

export function startSession(onChange: () => void): WalletSession {
  return createSession(network, onChange);
}

/** The top bar's pill and the card's wallet row. */
export function describeWallet(view: View, session: WalletSession, balance: bigint | null = null): void {
  view.flags.connected = session.account !== null;
  view.flags["on-network"] = session.account !== null && session.onNetwork;
  view.flags["off-network"] = session.account !== null && !session.onNetwork;
  view.flags["balance-known"] = session.onNetwork && balance !== null;
  if (session.account) {
    view.text["account-short"] = shortAddress(session.account);
    view.text["wallet-name"] = session.onNetwork ? network.name : (session.wallet?.info.name ?? "Browser wallet");
    view.text["wallet-network"] = session.onNetwork ? network.name : chainName(session.chainId);
  }
  if (balance !== null) view.text.balance = usdc(balance);
}

/** The escrow's or router's reason a call would revert, such as "DeadlineNotReached". */
export function revertReason(error: unknown): string | null {
  const reverted = error instanceof BaseError ? error.walk((e) => e instanceof ContractFunctionRevertedError) : null;
  if (!(reverted instanceof ContractFunctionRevertedError)) return null;
  return reverted.data?.errorName ?? reverted.reason ?? "an unknown reason";
}

/** What to say when the wallet didn't send a transaction. */
export function walletFailure(error: unknown, what: string): string {
  if (isUserRejection(error)) return `You cancelled the ${what} in your wallet. Nothing was sent.`;
  if (/insufficient funds|exceeds balance/i.test(String((error as Error)?.message ?? ""))) {
    return `Your wallet needs a little more USDC to pay the network fee for the ${what}.`;
  }
  return `Your wallet couldn't send the ${what}. Try again.`;
}

/** Makes sure a wallet is connected and on the network. False if the person didn't get there. */
export async function readyWallet(session: WalletSession, onNote: (note: string) => void): Promise<boolean> {
  if (!session.account && !(await session.connect())) return false;
  if (session.onNetwork) return true;
  try {
    await session.switchNetwork();
  } catch (error) {
    onNote(
      isUserRejection(error)
        ? `Your wallet stayed on ${chainName(session.chainId)}. Switch to ${network.name} to go on.`
        : `Your wallet couldn't switch networks. Switch to ${network.name} in your wallet, then try again.`,
    );
    return false;
  }
  return session.onNetwork;
}

export function randomBytes32(): Hex {
  return `0x${[...crypto.getRandomValues(new Uint8Array(32))].map((b) => b.toString(16).padStart(2, "0")).join("")}`;
}

export function unixSeconds(date: Date): bigint {
  return BigInt(Math.floor(date.getTime() / 1000));
}

export function sameAddress(a: Address | null | undefined, b: Address | null | undefined): boolean {
  return !!a && !!b && a.toLowerCase() === b.toLowerCase();
}

/** Seconds until `until`, for a countdown. */
export function secondsUntil(until: number): number {
  return Math.max(0, Math.ceil((until - Date.now()) / 1000));
}
