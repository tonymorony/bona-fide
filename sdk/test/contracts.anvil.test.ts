import { hashTypedData, parseEventLogs, toHex, type Address, type Hex } from "viem";
import { afterAll, beforeAll, expect, test } from "vitest";
import {
  authorizationNonce,
  bountyFactoryAbi,
  bountyFundAuthorization,
  bountyWalletAbi,
  BOUNTY_STATUSES,
  DEPOSIT_STATUSES,
  depositAuthorization,
  escrowAbi,
  forfeitVerdict,
  isValidSignatureNow,
  keyOf,
  kindCode,
  payoutSignature,
  repoIdOf,
} from "../src/index.ts";
import { artifact, startAnvil, type Anvil } from "./support/anvil.ts";

// Every signature the SDK builds, made by anvil's accounts and checked by the real contracts.

const REPO = "Codertocat/Hello-World";
const FORFEIT_SINK = "0x000000000000000000000000000000000000dEaD";
const BINDING_DELAY = 3600n;
const AMOUNT = 1_000_000n;
const usdcAbi = artifact("MockUSDC").abi;

let anvil: Anvil;
let chainId: number;
let usdc: Address;
let escrow: Address;
let factory: Address;

beforeAll(async () => {
  anvil = await startAnvil();
  chainId = await anvil.client.getChainId();
  usdc = await anvil.deploy("MockUSDC", []);
  escrow = await anvil.deploy("BonaFideEscrow", [usdc, anvil.keeper, FORFEIT_SINK, BINDING_DELAY, 50_000_000n]);
  factory = await anvil.deploy("BountyWalletFactory", [usdc, anvil.keeper]);
  for (const account of [anvil.contributor, anvil.maintainer]) {
    await anvil.send(anvil.deployer, usdc, usdcAbi, "mint", [account, 100_000_000n]);
  }
  const repoId = repoIdOf(REPO);
  await anvil.send(anvil.keeper, escrow, escrowAbi, "proposeRepo", [
    repoId,
    anvil.maintainer,
    5000,
    7 * 86_400,
    AMOUNT,
  ]);
  await anvil.test.increaseTime({ seconds: Number(BINDING_DELAY) });
  await anvil.test.mine({ blocks: 1 });
  await anvil.send(anvil.keeper, escrow, escrowAbi, "activateRepo", [repoId]);
}, 120_000);

afterAll(() => anvil?.stop());

function randomBytes32(): Hex {
  return toHex(crypto.getRandomValues(new Uint8Array(32)));
}

async function depositOf(key: Hex) {
  return anvil.client.readContract({ address: escrow, abi: escrowAbi, functionName: "depositOf", args: [key] });
}

/** A one-signature Deposit, signed by the contributor and relayed by another account. */
async function signedDeposit(number: number): Promise<Hex> {
  const salt = randomBytes32();
  const validBefore = (await anvil.now()) + 600n;
  const typedData = depositAuthorization({
    chainId,
    usdc,
    escrow,
    repo: REPO,
    kind: "pr",
    number,
    from: anvil.contributor,
    value: AMOUNT,
    salt,
    validBefore,
  });
  const signature = await anvil.wallet.signTypedData({ account: anvil.contributor, ...typedData });
  const receipt = await anvil.send(anvil.relayer, escrow, escrowAbi, "depositWithAuthorization", [
    repoIdOf(REPO),
    kindCode("pr"),
    BigInt(number),
    anvil.contributor,
    0n,
    validBefore,
    salt,
    signature,
  ]);
  const [deposited] = parseEventLogs({ abi: escrowAbi, eventName: "Deposited", logs: receipt.logs });
  return deposited!.args.key;
}

test("repo ids, Deposit keys and authorization nonces match the escrow's", async () => {
  const repoId = repoIdOf(REPO);
  expect(repoIdOf(REPO.toLowerCase())).toBe(repoId);
  for (const kind of ["pr", "issue"] as const) {
    const onChain = await anvil.client.readContract({
      address: escrow,
      abi: escrowAbi,
      functionName: "keyOf",
      args: [repoId, kindCode(kind), 42n],
    });
    expect(keyOf(repoId, kind, 42)).toBe(onChain);
  }
  const key = keyOf(repoId, "pr", 42);
  const salt = randomBytes32();
  expect(authorizationNonce(key, salt)).toBe(
    await anvil.client.readContract({
      address: escrow,
      abi: escrowAbi,
      functionName: "authorizationNonce",
      args: [key, salt],
    }),
  );
});

test("the escrow takes a Deposit signed from depositAuthorization, for the PR it names", async () => {
  const key = await signedDeposit(7);

  expect(key).toBe(keyOf(repoIdOf(REPO), "pr", 7));
  const deposit = await depositOf(key);
  expect(DEPOSIT_STATUSES[deposit.status]).toBe("active");
  expect(deposit.depositor).toBe(anvil.contributor);
  expect(deposit.amount).toBe(AMOUNT);
});

test("the escrow takes a Forfeit signed from forfeitVerdict, and isValidSignatureNow agrees", async () => {
  const key = await signedDeposit(8);
  const { serial } = await depositOf(key);
  const typedData = forfeitVerdict({ chainId, escrow, key, serial, sigDeadline: (await anvil.now()) + 3600n });
  const signature = await anvil.wallet.signTypedData({ account: anvil.maintainer, ...typedData });

  expect(await isValidSignatureNow(anvil.client, anvil.maintainer, hashTypedData(typedData), signature)).toBe(true);
  expect(await isValidSignatureNow(anvil.client, anvil.contributor, hashTypedData(typedData), signature)).toBe(false);
  await anvil.send(anvil.relayer, escrow, escrowAbi, "forfeit", [key, typedData.message.sigDeadline, signature]);
  expect(DEPOSIT_STATUSES[(await depositOf(key)).status]).toBe("forfeited");
});

test("a Bounty wallet takes funding from bountyFundAuthorization and pays from payoutSignature", async () => {
  const owner = anvil.maintainer;
  await anvil.send(owner, factory, bountyFactoryAbi, "create", [repoIdOf(REPO), 5_000_000n, 10_000_000n, 86_400]);
  const wallet = await anvil.client.readContract({
    address: factory,
    abi: bountyFactoryAbi,
    functionName: "walletOf",
    args: [repoIdOf(REPO), owner],
  });

  const fund = bountyFundAuthorization({
    chainId,
    usdc,
    wallet,
    from: owner,
    value: 3_000_000n,
    nonce: randomBytes32(),
    validBefore: (await anvil.now()) + 600n,
  });
  const fundSignature = await anvil.wallet.signTypedData({ account: owner, ...fund });
  await anvil.send(owner, wallet, bountyWalletAbi, "fundWithAuthorization", [
    owner,
    fund.message.value,
    0n,
    fund.message.validBefore,
    fund.message.nonce,
    fundSignature,
  ]);
  await anvil.send(owner, wallet, bountyWalletAbi, "postBounty", [12n, 2_000_000n]);

  const bounty = await anvil.client.readContract({
    address: wallet,
    abi: bountyWalletAbi,
    functionName: "bountyOf",
    args: [12n],
  });
  const payout = payoutSignature({
    chainId,
    wallet,
    issueNumber: 12,
    serial: bounty.serial,
    payee: anvil.payee,
    amount: bounty.amount,
    deadline: (await anvil.now()) + 3600n,
  });
  const payoutSigned = await anvil.wallet.signTypedData({ account: owner, ...payout });
  await anvil.send(anvil.relayer, wallet, bountyWalletAbi, "payWithSignature", [
    12n,
    anvil.payee,
    payout.message.deadline,
    payoutSigned,
  ]);

  const paid = await anvil.client.readContract({
    address: wallet,
    abi: bountyWalletAbi,
    functionName: "bountyOf",
    args: [12n],
  });
  expect(BOUNTY_STATUSES[paid.status]).toBe("paid");
  expect(paid.payee).toBe(anvil.payee);
});

test("isValidSignatureNow asks a contract signer through ERC-1271", async () => {
  const smartWallet = await anvil.deploy("MockERC1271Wallet", [anvil.maintainer]);
  const typedData = forfeitVerdict({ chainId, escrow, key: randomBytes32(), serial: 1n, sigDeadline: 1n });
  const digest = hashTypedData(typedData);

  const byOwner = await anvil.wallet.signTypedData({ account: anvil.maintainer, ...typedData });
  const byOther = await anvil.wallet.signTypedData({ account: anvil.contributor, ...typedData });

  expect(await isValidSignatureNow(anvil.client, smartWallet, digest, byOwner)).toBe(true);
  expect(await isValidSignatureNow(anvil.client, smartWallet, digest, byOther)).toBe(false);
});
