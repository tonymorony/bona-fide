import { createWalletClient, http, numberToHex, type Chain, type Hex, type LocalAccount } from "viem";

// A mock EIP-1193 wallet for the pages under test. The page side announces it through EIP-6963 and
// forwards every request to Node through a DevTools binding; Node signs with a fresh test key and
// sends through the local chain, as a real wallet would.

export const BINDING = "__bonaFideTestWallet";

/** Runs in the page before its own scripts. */
export const INJECTED = `(() => {
  const pending = new Map();
  const listeners = new Map();
  let next = 0;
  const provider = {
    request({ method, params }) {
      const id = ++next;
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        window.${BINDING}(JSON.stringify({ id, method, params: params ?? [] }));
      });
    },
    on(event, listener) {
      if (!listeners.has(event)) listeners.set(event, new Set());
      listeners.get(event).add(listener);
    },
    removeListener(event, listener) {
      listeners.get(event)?.delete(listener);
    },
  };
  window.${BINDING}Reply = (id, ok, value) => {
    const call = pending.get(id);
    if (!call) return;
    pending.delete(id);
    if (ok) call.resolve(value);
    else call.reject(Object.assign(new Error(value.message), { code: value.code }));
  };
  window.${BINDING}Emit = (event, value) => {
    for (const listener of listeners.get(event) ?? []) listener(value);
  };
  const info = Object.freeze({
    uuid: "5f1d7e38-3c0e-4b58-9a70-2a3f5c1b9d10",
    name: "Test Wallet",
    icon: "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Crect width='32' height='32' rx='8' fill='%23777'/%3E%3C/svg%3E",
    rdns: "dev.bonafide.test-wallet",
  });
  const announce = () =>
    window.dispatchEvent(new CustomEvent("eip6963:announceProvider", { detail: Object.freeze({ info, provider }) }));
  window.addEventListener("eip6963:requestProvider", announce);
  announce();
})();`;

class WalletError extends Error {
  readonly code: number;

  constructor(code: number, message: string) {
    super(message);
    this.code = code;
  }
}

export interface TestWalletOptions {
  account: LocalAccount;
  /** The local chain: the wallet sends its transactions there. */
  chain: Chain;
  rpcUrl: string;
  /** The network the wallet is on at first. */
  startChainId?: number;
}

export function createTestWallet({ account, chain, rpcUrl, startChainId = chain.id }: TestWalletOptions) {
  const own = createWalletClient({ account, chain, transport: http(rpcUrl) });
  const known = new Set([startChainId]);
  let chainId = startChainId;
  let connected = false;
  const log: { method: string; params: unknown }[] = [];
  const behavior = { rejectNextSignature: false, wrapSignatureAs6492: false, rejectConnect: false };
  let emit: (event: string, value: unknown) => Promise<void> = async () => {};

  async function forward(method: string, params: unknown): Promise<unknown> {
    const response = await fetch(rpcUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    });
    const { result, error } = (await response.json()) as {
      result?: unknown;
      error?: { code: number; message: string };
    };
    if (error) throw new WalletError(error.code, error.message);
    return result;
  }

  async function handle(method: string, params: any[]): Promise<unknown> {
    log.push({ method, params });
    switch (method) {
      case "eth_requestAccounts":
        if (behavior.rejectConnect) throw new WalletError(4001, "User rejected the request.");
        connected = true;
        return [account.address];
      case "eth_accounts":
        return connected ? [account.address] : [];
      case "eth_chainId":
        return numberToHex(chainId);
      case "wallet_switchEthereumChain": {
        const target = Number(params[0].chainId);
        if (!known.has(target)) throw new WalletError(4902, `Unrecognized chain ID ${params[0].chainId}.`);
        chainId = target;
        await emit("chainChanged", numberToHex(target));
        return null;
      }
      case "wallet_addEthereumChain":
        known.add(Number(params[0].chainId));
        return null;
      case "eth_signTypedData_v4": {
        if (!connected) throw new WalletError(4100, "Not connected.");
        if (behavior.rejectNextSignature) {
          behavior.rejectNextSignature = false;
          throw new WalletError(4001, "User rejected the request.");
        }
        const { domain, types, primaryType, message } = JSON.parse(params[1]);
        const { EIP712Domain: _, ...rest } = types;
        const signature = await account.signTypedData({ domain, types: rest, primaryType, message });
        if (!behavior.wrapSignatureAs6492) return signature;
        return `0x${"00".repeat(96)}${signature.slice(2)}${"6492".repeat(16)}` as Hex;
      }
      case "eth_sendTransaction": {
        if (!connected) throw new WalletError(4100, "Not connected.");
        if (chainId !== chain.id) throw new WalletError(4901, "The wallet is on another network.");
        const [tx] = params;
        return own.sendTransaction({
          to: tx.to,
          data: tx.data,
          ...(tx.value ? { value: BigInt(tx.value) } : {}),
        });
      }
      default:
        return forward(method, params);
    }
  }

  return {
    account,
    log,
    behavior,
    get chainId() {
      return chainId;
    },

    /** Answers the page's calls, for Chrome's `onBinding`. */
    onBinding(payload: string, reply: (expression: string) => Promise<void>): void {
      const { id, method, params } = JSON.parse(payload);
      emit = (event, value) => reply(`window.${BINDING}Emit(${JSON.stringify(event)}, ${JSON.stringify(value)})`);
      handle(method, params).then(
        (value) => reply(`window.${BINDING}Reply(${id}, true, ${JSON.stringify(value ?? null)})`),
        (error: unknown) => {
          const code = error instanceof WalletError ? error.code : -32603;
          const message = error instanceof Error ? error.message : String(error);
          return reply(`window.${BINDING}Reply(${id}, false, ${JSON.stringify({ code, message })})`);
        },
      );
    },

    disconnect() {
      connected = false;
    },
  };
}

export type TestWallet = ReturnType<typeof createTestWallet>;
