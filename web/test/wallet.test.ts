import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";
import { recoverTypedDataAddress, type Hex } from "viem";
import { expect, test } from "vitest";
import { forfeitVerdict } from "../src/typed-data.ts";
import {
  connect,
  discoverWallets,
  isUndeployedSmartWalletSignature,
  isUserRejection,
  signTypedData,
  switchToNetwork,
  type Provider,
} from "../src/wallet.ts";

const NETWORK = {
  name: "Arc Testnet",
  chainId: 5042002,
  rpcUrl: "https://rpc.testnet.arc.io",
  explorerUrl: "https://explorer.testnet.arc.io",
};

/** An EIP-1193 provider that answers from `handlers` and records every request. */
function fakeProvider(handlers: Record<string, (params: unknown) => unknown>) {
  const requests: { method: string; params: unknown }[] = [];
  const provider: Provider = {
    async request({ method, params }: { method: string; params?: unknown }) {
      requests.push({ method, params });
      const handler = handlers[method];
      if (!handler) throw Object.assign(new Error(`${method} isn't supported`), { code: 4200 });
      return handler(params);
    },
    on() {},
    removeListener() {},
  } as Provider;
  return { provider, requests };
}

function announce(
  target: EventTarget,
  uuid: string,
  name: string,
  provider: Provider,
  icon = "data:image/svg+xml,<svg/>",
) {
  target.dispatchEvent(
    new CustomEvent("eip6963:announceProvider", {
      detail: Object.freeze({ info: { uuid, name, icon, rdns: `test.${uuid}` }, provider }),
    }),
  );
}

test("wallets that announce themselves (EIP-6963) are listed once each, in the order they answer", () => {
  const target = new EventTarget() as EventTarget & { ethereum?: Provider };
  const seen: string[][] = [];
  target.addEventListener("eip6963:requestProvider", () => {
    announce(target, "a", "Rabby", fakeProvider({}).provider);
    announce(target, "b", "MetaMask", fakeProvider({}).provider);
  });

  const stop = discoverWallets(target, (wallets) => seen.push(wallets.map((w) => w.info.name)));
  announce(target, "a", "Rabby", fakeProvider({}).provider);
  announce(target, "c", "Frame", fakeProvider({}).provider, "https://tracker.example/icon.png");
  stop();
  announce(target, "d", "Late", fakeProvider({}).provider);

  expect(seen.at(-1)).toEqual(["Rabby", "MetaMask", "Frame"]);
});

test("an icon that isn't an inline image is dropped, so no wallet can make the page load a remote file", () => {
  const target = new EventTarget();
  let icons: string[] = [];
  const stop = discoverWallets(target, (wallets) => (icons = wallets.map((w) => w.info.icon)));
  announce(target, "a", "Inline", fakeProvider({}).provider, "data:image/png;base64,AAAA");
  announce(target, "b", "Remote", fakeProvider({}).provider, "https://tracker.example/icon.png");
  announce(target, "c", "Script", fakeProvider({}).provider, "javascript:alert(1)");
  stop();

  expect(icons).toEqual(["data:image/png;base64,AAAA", "", ""]);
});

test("a wallet that only sets window.ethereum is listed as a browser wallet", async () => {
  const target = new EventTarget() as EventTarget & { ethereum?: Provider };
  target.ethereum = fakeProvider({}).provider;
  let names: string[] = [];

  const stop = discoverWallets(target, (wallets) => (names = wallets.map((w) => w.info.name)), { legacyAfterMs: 5 });
  await new Promise((resolve) => setTimeout(resolve, 20));
  stop();

  expect(names).toEqual(["Browser wallet"]);
});

test("connecting asks for accounts and reads the wallet's network", async () => {
  const { provider } = fakeProvider({
    eth_requestAccounts: () => ["0x5aaeb6053f3e94c9b9a09f33669435e7ef1beaed"],
    eth_chainId: () => "0x1",
  });

  expect(await connect(provider)).toEqual({ account: "0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed", chainId: 1 });
});

test("switching to Arc adds the network first when the wallet doesn't know it", async () => {
  let known = false;
  const { provider, requests } = fakeProvider({
    wallet_switchEthereumChain: () => {
      if (!known) throw Object.assign(new Error("Unrecognized chain ID"), { code: 4902 });
      return null;
    },
    wallet_addEthereumChain: () => {
      known = true;
      return null;
    },
  });

  await switchToNetwork(provider, NETWORK);

  expect(requests.map((r) => r.method)).toEqual([
    "wallet_switchEthereumChain",
    "wallet_addEthereumChain",
    "wallet_switchEthereumChain",
  ]);
  expect(requests[1]!.params).toEqual([
    {
      chainId: "0x4cef52",
      chainName: "Arc Testnet",
      nativeCurrency: { name: "USDC", symbol: "USDC", decimals: 18 },
      rpcUrls: ["https://rpc.testnet.arc.io"],
      blockExplorerUrls: ["https://explorer.testnet.arc.io"],
    },
  ]);
});

test("a wallet that reports an unknown chain its own way still gets Arc added", async () => {
  let known = false;
  const { provider } = fakeProvider({
    wallet_switchEthereumChain: () => {
      if (!known) throw Object.assign(new Error("…"), { code: -32603, data: { originalError: { code: 4902 } } });
      return null;
    },
    wallet_addEthereumChain: () => {
      known = true;
      return null;
    },
  });

  await expect(switchToNetwork(provider, NETWORK)).resolves.toBeUndefined();
});

test("a refused switch is the user's choice, not a missing network", async () => {
  const { provider, requests } = fakeProvider({
    wallet_switchEthereumChain: () => {
      throw Object.assign(new Error("User rejected the request."), { code: 4001 });
    },
  });

  const error = await switchToNetwork(provider, NETWORK).catch((e: unknown) => e);

  expect(isUserRejection(error)).toBe(true);
  expect(requests.map((r) => r.method)).toEqual(["wallet_switchEthereumChain"]);
});

test("typed data goes to the wallet as eth_signTypedData_v4, and the signature recovers to the signer", async () => {
  const signer = privateKeyToAccount(generatePrivateKey());
  const typedData = forfeitVerdict({
    chainId: 5042002,
    escrow: "0x05283F2c7D94D66669227Cecf75abBbd024771A7",
    key: `0x${"12".repeat(32)}`,
    serial: 41n,
    sigDeadline: 1_790_000_000n,
  });
  const { provider, requests } = fakeProvider({
    eth_signTypedData_v4: (params) => {
      const [, json] = params as [string, string];
      const { domain, types, primaryType, message } = JSON.parse(json);
      const { EIP712Domain: _, ...rest } = types;
      return signer.signTypedData({ domain, types: rest, primaryType, message });
    },
  });

  const signature = await signTypedData(provider, signer.address, typedData);

  expect(requests[0]!.method).toBe("eth_signTypedData_v4");
  expect(await recoverTypedDataAddress({ ...typedData, signature })).toBe(signer.address);
});

test("a signature from a smart wallet that isn't deployed yet (ERC-6492) is recognized", () => {
  const wrapped = `0x${"ab".repeat(100)}${"6492".repeat(16)}` as Hex;

  expect(isUndeployedSmartWalletSignature(wrapped)).toBe(true);
  expect(isUndeployedSmartWalletSignature(`0x${"ab".repeat(65)}`)).toBe(false);
});

test("a rejection is told apart from other errors", () => {
  expect(isUserRejection(Object.assign(new Error("User rejected"), { code: 4001 }))).toBe(true);
  expect(isUserRejection({ cause: { code: 4001 } })).toBe(true);
  expect(isUserRejection(Object.assign(new Error("boom"), { code: -32603 }))).toBe(false);
});
