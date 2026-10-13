import { parseEventLogs, toHex, type Address, type Hex } from "viem";
import { afterAll, beforeAll, expect, test } from "vitest";
import { bountyWalletAbi } from "../src/abi.ts";
import { bountyCalls, createBountyReader, DEFAULT_LIMITS } from "../src/bounty.ts";
import { createChainReader, publicClientFor } from "../src/chain.ts";
import { repoIdOf } from "../src/keys.ts";
import { bountyFundAuthorization, payoutSignature, WINDOWS } from "../src/typed-data.ts";
import { LOCAL_CHAIN_ID, startStack, type Stack } from "./support/stack.ts";

// The Bounty page's typed data and contract calls, signed and sent with fresh test keys, against the
// real Bounty wallet and its factory on anvil, and read back through the pages' own reader.

let stack: Stack;
let network: Stack["network"];

beforeAll(async () => {
  stack = await startStack();
  network = stack.network;
}, 120_000);

afterAll(() => stack?.stop());

const reader = () => createBountyReader(publicClientFor(network), network);

function randomBytes32(): Hex {
  return toHex(crypto.getRandomValues(new Uint8Array(32)));
}

/** A repo bound to a fresh Maintainer, who has created their Bounty wallet. */
async function boundRepoWithWallet(repo: string, usdc = 500_000_000n) {
  const maintainer = await stack.account(usdc);
  await stack.bind(repo, { maintainer: maintainer.address });
  const wallet = await stack.createBountyWallet(maintainer, repo);
  return { maintainer, wallet };
}

test("the wallet the page creates is the Binding Maintainer's, with the page's default limits", async () => {
  const repo = "Acme/Created";
  const maintainer = await stack.account(0n);
  await stack.bind(repo, { maintainer: maintainer.address });
  const repoId = repoIdOf(repo);
  const terms = await createChainReader(publicClientFor(network), network).repoTerms(repoId);

  expect(await reader().repoWallet(repoId, terms)).toBeNull();
  await stack.sendAs(maintainer, bountyCalls.create(network.bountyFactory, repoId, DEFAULT_LIMITS));
  const wallet = await reader().repoWallet(repoId, terms);

  expect(wallet).not.toBeNull();
  expect(await reader().state(wallet!)).toEqual({
    address: wallet,
    owner: maintainer.address,
    keeper: stack.keeper,
    balance: 0n,
    reserved: 0n,
    available: 0n,
    perPayoutLimit: 50_000_000n,
    periodLimit: 200_000_000n,
    periodLength: 7 * 86_400,
    keeperEnabled: true,
    keeperAllowance: 200_000_000n,
  });
});

test("only the Binding Maintainer's wallet is the repo's: a wallet anyone else creates for it is ignored", async () => {
  const repo = "Acme/Guarded";
  const maintainer = await stack.account(0n);
  await stack.bind(repo, { maintainer: maintainer.address });
  const stranger = await stack.account(100_000_000n);
  const strangers = await stack.createBountyWallet(stranger, repo);
  await stack.fundAndPost(stranger, strangers, 100_000_000n, [[1, 100_000_000n]]);
  const repoId = repoIdOf(repo);
  const terms = await createChainReader(publicClientFor(network), network).repoTerms(repoId);

  expect(await reader().walletOf(repoId, stranger.address)).toBe(strangers);
  expect(await reader().repoWallet(repoId, terms)).toBeNull();
  expect(await reader().repoWallet(repoIdOf("acme/unbound"), { active: null, pending: null })).toBeNull();

  const own = await stack.createBountyWallet(maintainer, repo);
  expect(await reader().repoWallet(repoId, terms)).toBe(own);
});

test("funding with one signature: the page's EIP-3009 authorization is redeemed by the wallet", async () => {
  const { maintainer, wallet } = await boundRepoWithWallet("Acme/Signed-Funds");
  const authorization = {
    from: maintainer.address as Address,
    value: 30_000_000n,
    nonce: randomBytes32(),
    validBefore: (await stack.now()) + BigInt(WINDOWS.bountyFund),
  };
  const signature = await maintainer.signTypedData(
    bountyFundAuthorization({ chainId: LOCAL_CHAIN_ID, usdc: network.usdc, wallet, ...authorization }),
  );

  const receipt = await stack.sendAs(maintainer, bountyCalls.fundWithAuthorization(wallet, authorization, signature));

  const [funded] = parseEventLogs({ abi: bountyWalletAbi, logs: receipt.logs, eventName: "Funded" });
  expect(funded?.args).toEqual({ from: maintainer.address, amount: 30_000_000n });
  expect((await reader().state(wallet)).available).toBe(30_000_000n);
});

test("fund, post, cancel, withdraw, set limits and switch the Keeper, each through the page's calls", async () => {
  const { maintainer, wallet } = await boundRepoWithWallet("Acme/Owner-Calls");
  const send = (call: Parameters<Stack["sendAs"]>[1]) => stack.sendAs(maintainer, call);

  await send(bountyCalls.approve(network.usdc, wallet, 100_000_000n));
  await send(bountyCalls.fund(wallet, 100_000_000n));
  await send(bountyCalls.post(wallet, 12, 25_000_000n));
  await send(bountyCalls.post(wallet, 13, 10_000_000n));
  await send(bountyCalls.cancel(wallet, 13));
  await send(bountyCalls.withdraw(wallet, maintainer.address, 15_000_000n));
  await send(
    bountyCalls.setLimits(wallet, { perPayoutLimit: 20_000_000n, periodLimit: 60_000_000n, periodLength: 3600 }),
  );
  await send(bountyCalls.setKeeperEnabled(wallet, false));

  expect(await reader().state(wallet)).toMatchObject({
    balance: 85_000_000n,
    reserved: 25_000_000n,
    available: 60_000_000n,
    perPayoutLimit: 20_000_000n,
    periodLimit: 60_000_000n,
    periodLength: 3600,
    keeperEnabled: false,
  });
  expect(await reader().bountyOf(wallet, 12)).toEqual({ amount: 25_000_000n, serial: 1n, status: "open", payee: null });
  expect(await reader().bountyOf(wallet, 13)).toMatchObject({ status: "cancelled" });
  expect(await reader().bountyOf(wallet, 14)).toMatchObject({ status: "none" });
  expect(await stack.usdcBalance(maintainer.address)).toBe(415_000_000n);

  await send(bountyCalls.setKeeperEnabled(wallet, true));
  expect((await reader().state(wallet)).keeperEnabled).toBe(true);
});

test("a Payout signed from the page's typed data passes payWithSignature, from any relayer, and only once", async () => {
  const { maintainer, wallet } = await boundRepoWithWallet("Acme/Signed-Payout");
  await stack.fundAndPost(maintainer, wallet, 300_000_000n, [[42, 250_000_000n]]);
  const payee = (await stack.account(0n)).address as Address;
  const relayer = await stack.account(0n);
  const { serial, amount } = await reader().bountyOf(wallet, 42);
  const deadline = (await stack.now()) + BigInt(WINDOWS.payout);
  const signature = await maintainer.signTypedData(
    payoutSignature({ chainId: LOCAL_CHAIN_ID, wallet, issueNumber: 42, serial, payee, amount, deadline }),
  );

  const receipt = await stack.sendAs(relayer, bountyCalls.payWithSignature(wallet, 42, payee, deadline, signature));

  const [paid] = parseEventLogs({ abi: bountyWalletAbi, logs: receipt.logs, eventName: "Paid" });
  expect(paid?.args).toEqual({ issueNumber: 42n, serial, payee, amount: 250_000_000n, method: 1 });
  expect(await stack.usdcBalance(payee)).toBe(250_000_000n);
  await expect(
    stack.sendAs(relayer, bountyCalls.payWithSignature(wallet, 42, payee, deadline, signature)),
  ).rejects.toThrow();
});

test("a signature for another payee, another serial or another wallet doesn't pay", async () => {
  const { maintainer, wallet } = await boundRepoWithWallet("Acme/Signed-Wrong");
  await stack.fundAndPost(maintainer, wallet, 100_000_000n, [[5, 80_000_000n]]);
  const other = await stack.createBountyWallet(maintainer, "Acme/Signed-Other");
  const payee = (await stack.account(0n)).address as Address;
  const { serial, amount } = await reader().bountyOf(wallet, 5);
  const deadline = (await stack.now()) + 600n;
  const sign = (terms: Partial<Parameters<typeof payoutSignature>[0]>) =>
    maintainer.signTypedData(
      payoutSignature({ chainId: LOCAL_CHAIN_ID, wallet, issueNumber: 5, serial, payee, amount, deadline, ...terms }),
    );
  const sendSigned = async (signature: Hex) =>
    stack.client.simulateContract({
      ...bountyCalls.payWithSignature(wallet, 5, payee, deadline, signature),
      account: maintainer.address,
    });

  await expect(sendSigned(await sign({ payee: maintainer.address }))).rejects.toThrow(/InvalidSignature/);
  await expect(sendSigned(await sign({ serial: serial + 1n }))).rejects.toThrow(/InvalidSignature/);
  await expect(sendSigned(await sign({ wallet: other }))).rejects.toThrow(/InvalidSignature/);
  await expect(sendSigned(await sign({ amount: amount - 1n }))).rejects.toThrow(/InvalidSignature/);
  await expect(sendSigned(await sign({}))).resolves.toBeTruthy();
});

test("the owner pays directly, and the page rebuilds every Bounty and how it was paid from the logs", async () => {
  const { maintainer, wallet } = await boundRepoWithWallet("Acme/History");
  const payee = (await stack.account(0n)).address as Address;
  await stack.fundAndPost(maintainer, wallet, 200_000_000n, [
    [1, 10_000_000n],
    [2, 120_000_000n],
    [3, 5_000_000n],
  ]);
  await stack.keeperPay(wallet, 1, payee);
  await stack.mine(7);
  await stack.sendAs(maintainer, bountyCalls.ownerPay(wallet, 2, payee));
  await stack.sendAs(maintainer, bountyCalls.cancel(wallet, 3));
  await stack.sendAs(maintainer, bountyCalls.post(wallet, 3, 6_000_000n));
  const progress: number[] = [];

  const rows = await reader().bounties(wallet, {
    rangeSize: 4,
    onProgress: (done, total) => progress.push(done / total),
  });

  expect(rows.map((r) => [r.issue, r.status, r.amount, r.method ?? null, r.payee ?? null])).toEqual([
    [3, "open", 6_000_000n, null, null],
    [3, "cancelled", 5_000_000n, null, null],
    [2, "paid", 120_000_000n, "owner", payee],
    [1, "paid", 10_000_000n, "keeper", payee],
  ]);
  expect(rows[2]!.closedTx).toMatch(/^0x[0-9a-f]{64}$/);
  expect(progress.at(-1)).toBe(1);
  expect(progress.length).toBeGreaterThan(2);
  expect(await reader().state(wallet)).toMatchObject({ reserved: 6_000_000n, available: 64_000_000n });
});
