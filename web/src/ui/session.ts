import type { Address } from "viem";
import type { LiveNetwork } from "../network.ts";
import {
  chainIdOf,
  connect,
  connectedAccount,
  discoverWallets,
  isUserRejection,
  switchToNetwork,
  watchWallet,
  type Wallet,
} from "../wallet.ts";

/** The wallet a page is connected to, if any. */
export interface WalletSession {
  readonly wallet: Wallet | null;
  readonly account: Address | null;
  readonly chainId: number | null;
  /** The wallet is on the network this build is for. */
  readonly onNetwork: boolean;
  /** Opens the wallet picker. True once a wallet is connected; false if the person closes the picker. */
  connect(): Promise<boolean>;
  /** Asks the wallet to switch to the network, adding it if needed. */
  switchNetwork(): Promise<void>;
}

const REMEMBERED = "bona-fide:wallet";

// A wallet the person connected before: reconnecting to it asks nothing, if it still allows this page.
function remembered(): string | null {
  try {
    return localStorage.getItem(REMEMBERED);
  } catch {
    return null;
  }
}

function remember(id: string | null): void {
  try {
    if (id) localStorage.setItem(REMEMBERED, id);
    else localStorage.removeItem(REMEMBERED);
  } catch {
    // Storage can be off. The page then asks again after a reload.
  }
}

const idOf = (wallet: Wallet) => wallet.info.rdns || wallet.info.uuid;

export function createSession(network: LiveNetwork, onChange: () => void): WalletSession {
  const picker = document.querySelector<HTMLElement>("[data-picker]")!;
  const list = picker.querySelector<HTMLElement>("[data-picker-list]")!;
  const empty = picker.querySelector<HTMLElement>("[data-picker-empty]")!;
  const error = picker.querySelector<HTMLElement>("[data-picker-error]")!;
  const template = document.querySelector<HTMLTemplateElement>("template[data-picker-option]")!;

  let wallets: Wallet[] = [];
  let wallet: Wallet | null = null;
  let account: Address | null = null;
  let chainId: number | null = null;
  let stopWatching = () => {};
  let restoring = remembered();
  let settle: ((connected: boolean) => void) | null = null;
  let returnFocus: HTMLElement | null = null;
  let searched = false;

  function adopt(next: Wallet, nextAccount: Address, nextChainId: number) {
    stopWatching();
    wallet = next;
    account = nextAccount;
    chainId = nextChainId;
    stopWatching = watchWallet(next.provider, () => void refresh(next));
    remember(idOf(next));
    onChange();
  }

  async function refresh(from: Wallet) {
    if (wallet !== from) return;
    const [nextAccount, nextChainId] = await Promise.all([
      connectedAccount(from.provider),
      chainIdOf(from.provider).catch(() => null),
    ]);
    if (wallet !== from) return;
    if (!nextAccount) {
      stopWatching();
      wallet = null;
      account = null;
      chainId = null;
      remember(null);
    } else {
      account = nextAccount;
      chainId = nextChainId;
    }
    onChange();
  }

  async function restore(candidate: Wallet) {
    restoring = null;
    const quiet = await connectedAccount(candidate.provider);
    if (!quiet || wallet) return;
    adopt(candidate, quiet, await chainIdOf(candidate.provider));
  }

  function drawList() {
    const options = wallets.map((each) => {
      const option = template.content.firstElementChild!.cloneNode(true) as HTMLButtonElement;
      option.querySelector("strong")!.textContent = each.info.name;
      if (each.info.icon) {
        const icon = option.querySelector("img")!;
        icon.src = each.info.icon;
        icon.hidden = false;
        option.querySelector(".ico")!.remove();
      }
      option.addEventListener("click", () => void pick(each, option));
      return option;
    });
    list.replaceChildren(...options);
    empty.hidden = wallets.length > 0 || !searched;
  }

  async function pick(chosen: Wallet, option: HTMLButtonElement) {
    error.hidden = true;
    option.disabled = true;
    try {
      const connection = await connect(chosen.provider);
      close(true);
      adopt(chosen, connection.account, connection.chainId);
    } catch (reason) {
      error.textContent = isUserRejection(reason)
        ? `${chosen.info.name} didn't connect. Pick a wallet to go on.`
        : `Couldn't connect to ${chosen.info.name}. Try again, or pick another wallet.`;
      error.hidden = false;
    } finally {
      option.disabled = false;
    }
  }

  function close(connected: boolean) {
    picker.hidden = true;
    returnFocus?.focus({ preventScroll: true });
    settle?.(connected);
    settle = null;
  }

  discoverWallets(window, (found) => {
    wallets = found;
    drawList();
    const match = restoring && found.find((each) => idOf(each) === restoring);
    if (match) void restore(match);
  });
  // Wallets answer at once; after a moment, none means none.
  setTimeout(() => {
    searched = true;
    restoring = null;
    drawList();
  }, 400);

  picker.querySelector("[data-picker-cancel]")!.addEventListener("click", () => close(false));
  picker.addEventListener("click", (event) => {
    if (event.target === picker) close(false);
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && !picker.hidden) close(false);
  });
  const copyLink = async () => {
    const label = picker.querySelector<HTMLElement>("[data-picker-copy-label]")!;
    try {
      await navigator.clipboard.writeText(location.href);
      label.textContent = "Link copied";
    } catch {
      label.textContent = "Copy the address bar's link instead";
    }
  };
  picker.querySelector("[data-picker-copy]")!.addEventListener("click", () => void copyLink());

  return {
    get wallet() {
      return wallet;
    },
    get account() {
      return account;
    },
    get chainId() {
      return chainId;
    },
    get onNetwork() {
      return chainId === network.chainId;
    },

    connect() {
      if (wallet && account) return Promise.resolve(true);
      settle?.(false);
      returnFocus = document.activeElement as HTMLElement | null;
      error.hidden = true;
      picker.hidden = false;
      drawList();
      picker.querySelector<HTMLElement>(".wallet-option, [data-picker-copy], [data-picker-cancel]")?.focus();
      return new Promise((resolve) => (settle = resolve));
    },

    async switchNetwork() {
      if (!wallet) return;
      await switchToNetwork(wallet.provider, network);
      chainId = await chainIdOf(wallet.provider);
      onChange();
    },
  };
}

const CHAIN_NAMES: Record<number, string> = {
  1: "Ethereum",
  10: "OP Mainnet",
  137: "Polygon",
  8453: "Base",
  42161: "Arbitrum One",
  84532: "Base Sepolia",
  11155111: "Sepolia",
  5042: "Arc",
  5042002: "Arc Testnet",
};

/** A network's name for people, as far as the page knows it. */
export function chainName(chainId: number | null): string {
  if (chainId === null) return "another network";
  return CHAIN_NAMES[chainId] ?? `network ${chainId}`;
}
