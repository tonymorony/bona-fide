import {
  createWalletClient,
  custom,
  getAddress,
  numberToHex,
  type Abi,
  type Address,
  type Chain,
  type ContractFunctionArgs,
  type ContractFunctionName,
  type Hex,
  type TypedDataDefinition,
} from "viem";

/** An EIP-1193 provider, as wallets inject it. */
export interface Provider {
  request(args: { method: string; params?: unknown }): Promise<unknown>;
  /* eslint-disable @typescript-eslint/no-explicit-any -- each EIP-1193 event passes its own arguments, and a listener typed for one must still fit; review-by: 2027-04-18 */
  on?(event: string, listener: (...args: any[]) => void): void;
  removeListener?(event: string, listener: (...args: any[]) => void): void;
  /* eslint-enable @typescript-eslint/no-explicit-any */
}

/** What an EIP-6963 announcement may carry. Nothing in it is promised: discoverWallets checks it. */
interface Announcement {
  provider?: Provider;
  info?: { uuid?: unknown; name?: unknown; icon?: unknown; rdns?: unknown };
}

/** What a wallet's error may carry. Nothing in it is promised. */
interface WalletError {
  message?: unknown;
  name?: unknown;
  code?: unknown;
  data?: { originalError?: { code?: unknown } | null } | null;
  cause?: unknown;
}

export interface WalletInfo {
  uuid: string;
  name: string;
  /** A data: image, or empty. */
  icon: string;
  rdns: string;
}

export interface Wallet {
  info: WalletInfo;
  provider: Provider;
}

// EIP-6963 requires a data URI. Anything else could make the page fetch a file from elsewhere.
const INLINE_IMAGE = /^data:image\/(?:svg\+xml|png|jpeg|webp|gif)[;,]/i;

/**
 * Lists the wallets injected into the page, as they announce themselves (EIP-6963). A wallet that
 * only sets window.ethereum is listed as "Browser wallet" if no wallet announces itself.
 * Returns a function that stops listening.
 */
export function discoverWallets(
  target: EventTarget & { ethereum?: Provider },
  onChange: (wallets: Wallet[]) => void,
  { legacyAfterMs = 300 } = {},
): () => void {
  const wallets: Wallet[] = [];
  const onAnnounce = (event: Event) => {
    const detail = (event as CustomEvent<Announcement | null | undefined>).detail;
    const provider = detail?.provider;
    const uuid = detail?.info?.uuid;
    if (typeof uuid !== "string" || typeof provider?.request !== "function") return;
    if (wallets.some((wallet) => wallet.info.uuid === uuid)) return;
    const { name, icon, rdns } = detail!.info!;
    wallets.push({
      info: {
        uuid,
        name: typeof name === "string" && name.trim() ? name.trim() : "Browser wallet",
        icon: typeof icon === "string" && INLINE_IMAGE.test(icon) ? icon : "",
        rdns: typeof rdns === "string" ? rdns : "",
      },
      provider,
    });
    onChange([...wallets]);
  };
  target.addEventListener("eip6963:announceProvider", onAnnounce);
  target.dispatchEvent(new Event("eip6963:requestProvider"));
  const legacy = setTimeout(() => {
    if (wallets.length > 0 || typeof target.ethereum?.request !== "function") return;
    wallets.push({ info: { uuid: "injected", name: "Browser wallet", icon: "", rdns: "" }, provider: target.ethereum });
    onChange([...wallets]);
  }, legacyAfterMs);
  return () => {
    clearTimeout(legacy);
    target.removeEventListener("eip6963:announceProvider", onAnnounce);
  };
}

export interface Connection {
  account: Address;
  chainId: number;
}

/** Asks the wallet for its account, and reads which network it's on. */
export async function connect(provider: Provider): Promise<Connection> {
  const accounts = (await provider.request({ method: "eth_requestAccounts" })) as string[] | null | undefined;
  if (!accounts?.[0]) throw new Error("The wallet shared no account.");
  return { account: getAddress(accounts[0]), chainId: await chainIdOf(provider) };
}

/** The wallet's account without asking, if this page is already allowed to see it. */
export async function connectedAccount(provider: Provider): Promise<Address | null> {
  const accounts = (await provider.request({ method: "eth_accounts" }).catch(() => [])) as string[] | null | undefined;
  return accounts?.[0] ? getAddress(accounts[0]) : null;
}

export async function chainIdOf(provider: Provider): Promise<number> {
  return Number(await provider.request({ method: "eth_chainId" }));
}

interface NetworkDetails {
  name: string;
  chainId: number;
  rpcUrl: string;
  explorerUrl: string;
}

/** Switches the wallet to the network, adding it first if the wallet doesn't know it. */
export async function switchToNetwork(provider: Provider, network: NetworkDetails): Promise<void> {
  const chainId = numberToHex(network.chainId);
  try {
    await provider.request({ method: "wallet_switchEthereumChain", params: [{ chainId }] });
    return;
  } catch (error) {
    if (!isUnknownChain(error)) throw error;
  }
  await provider.request({
    method: "wallet_addEthereumChain",
    params: [
      {
        chainId,
        chainName: network.name,
        nativeCurrency: { name: "USDC", symbol: "USDC", decimals: 18 },
        rpcUrls: [network.rpcUrl],
        blockExplorerUrls: [network.explorerUrl],
      },
    ],
  });
  // Most wallets switch once they add a network; the rest need asking again.
  await provider.request({ method: "wallet_switchEthereumChain", params: [{ chainId }] });
}

function codesOf(error: unknown): unknown[] {
  const codes: unknown[] = [];
  for (let e = error as WalletError | null | undefined, depth = 0; e && depth < 5; e = e.cause as typeof e, depth++) {
    codes.push(e.code, e.data?.originalError?.code);
  }
  return codes;
}

/** A wallet error's message, or "" if it has none. */
export function messageOf(error: unknown): string {
  const message = (error as WalletError | null | undefined)?.message;
  // eslint-disable-next-line @typescript-eslint/no-base-to-string -- a wallet's message can be anything, and the callers' patterns read it as String() does; review-by: 2027-04-18
  return message === undefined || message === null ? "" : String(message);
}

function isUnknownChain(error: unknown): boolean {
  if (codesOf(error).includes(4902)) return true;
  return /unrecognized chain|unknown chain|wallet_addEthereumChain/i.test(messageOf(error));
}

/** The person said no in their wallet. */
export function isUserRejection(error: unknown): boolean {
  if (codesOf(error).includes(4001)) return true;
  for (let e = error as WalletError | null | undefined, depth = 0; e && depth < 5; e = e.cause as typeof e, depth++) {
    if (e.name === "UserRejectedRequestError") return true;
  }
  return false;
}

/** Asks the wallet to sign EIP-712 typed data (eth_signTypedData_v4). */
export function signTypedData(provider: Provider, account: Address, typedData: TypedDataDefinition): Promise<Hex> {
  return createWalletClient({ account, transport: custom(provider) }).signTypedData(typedData);
}

/** Asks the wallet to send a contract call. The wallet must be on `chain`: viem checks. */
export function sendContractCall<
  const abi extends Abi,
  functionName extends ContractFunctionName<abi, "nonpayable" | "payable">,
>(
  provider: Provider,
  account: Address,
  chain: Chain,
  call: {
    address: Address;
    abi: abi;
    functionName: functionName;
    args: ContractFunctionArgs<abi, "nonpayable" | "payable", functionName>;
  },
): Promise<Hex> {
  const wallet = createWalletClient({ account, chain, transport: custom(provider) });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-argument -- viem can't match a generic call to writeContract's overloads; review-by: 2027-04-18
  return wallet.writeContract({ ...call, account, chain } as any);
}

// ERC-6492 wraps a smart wallet's signature so it can be checked before the wallet is deployed.
// The escrow and USDC check signatures with OpenZeppelin's SignatureChecker, which doesn't unwrap it.
const ERC6492_SUFFIX = "6492".repeat(16);

/** The signature came from a smart wallet that isn't deployed on this chain yet, so it can't be checked. */
export function isUndeployedSmartWalletSignature(signature: Hex): boolean {
  return signature.toLowerCase().endsWith(ERC6492_SUFFIX);
}

/** Calls `onChange` when the person picks another account or network in the wallet. */
export function watchWallet(provider: Provider, onChange: () => void): () => void {
  provider.on?.("accountsChanged", onChange);
  provider.on?.("chainChanged", onChange);
  return () => {
    provider.removeListener?.("accountsChanged", onChange);
    provider.removeListener?.("chainChanged", onChange);
  };
}
