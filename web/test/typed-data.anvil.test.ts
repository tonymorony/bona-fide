import {
  authorizationNonce,
  bindingProof,
  depositAuthorization,
  forfeitVerdict,
  keyOf,
  repoIdOf,
} from "@bona-fide/sdk";
import { parseEventLogs, toHex, type Address, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { afterAll, beforeAll, expect, test } from "vitest";
import { createDepositRelay } from "../../app/src/relay/deposit.ts";
import { startAnvil, type Anvil } from "../../app/test/support/anvil.ts";
import { keeperHarness, startKeeperAnvil } from "../../app/test/support/keeper.ts";
import { relayKit } from "../../app/test/support/relay.ts";
import { bindingProofBody, depositRelayBody, forfeitBody } from "../src/endpoints.ts";
import { WINDOWS } from "../src/windows.ts";

// The typed data the pages ask wallets to sign, signed with fresh test keys and checked by the real
// escrow on anvil and by the App's own relay and Keeper.

const REPO = "Codertocat/Hello-World";

let anvil: Anvil;
let keeperChain: Awaited<ReturnType<typeof startKeeperAnvil>>;

beforeAll(async () => {
  [anvil, keeperChain] = await Promise.all([startAnvil(), startKeeperAnvil()]);
  await anvil.bind(REPO);
}, 120_000);

afterAll(() => {
  anvil?.stop();
  keeperChain?.anvil.stop();
});

async function chainTime(chain: Anvil): Promise<bigint> {
  return BigInt(Math.floor((await chain.now()).getTime() / 1000));
}

function randomBytes32(): Hex {
  return toHex(crypto.getRandomValues(new Uint8Array(32)));
}

test("repo ids, Deposit keys and authorization nonces match the escrow's", async () => {
  const repoId = repoIdOf(REPO);

  expect(repoIdOf(REPO.toLowerCase())).toBe(repoId);
  for (const [kind, code] of [
    ["pr", 0],
    ["issue", 1],
  ] as const) {
    const onChain = await anvil.client.readContract({
      address: anvil.escrow,
      abi: anvil.escrowAbi,
      functionName: "keyOf",
      args: [repoId, code, 42n],
    });
    expect(keyOf(repoId, kind, 42)).toBe(onChain);
  }
  const key = keyOf(repoId, "pr", 42);
  const salt = randomBytes32();
  expect(authorizationNonce(key, salt)).toBe(
    await anvil.client.readContract({
      address: anvil.escrow,
      abi: anvil.escrowAbi,
      functionName: "authorizationNonce",
      args: [key, salt],
    }),
  );
});

test("the App relays a one-signature Deposit signed from the deposit page's typed data", async () => {
  const kit = await relayKit(anvil);
  const signer = await kit.fundedSigner();
  const relay = createDepositRelay({ client: anvil.client, wallet: await kit.relayer(), escrow: anvil.escrow });
  const deposit = {
    chainId: await anvil.client.getChainId(),
    usdc: kit.usdc,
    escrow: anvil.escrow,
    repo: REPO,
    kind: "pr" as const,
    number: 7,
    from: signer.address,
    value: 1_000_000n,
    salt: randomBytes32(),
    validBefore: (await chainTime(anvil)) + BigInt(WINDOWS.deposit),
  };
  const signature = await signer.signTypedData(depositAuthorization(deposit));

  const response = await relay(
    new Request("https://app.test/relay/deposit", {
      method: "POST",
      body: JSON.stringify(depositRelayBody(deposit, signature)),
    }),
    "203.0.113.7",
  );

  expect(response.status).toBe(200);
  const { txHash } = (await response.json()) as { txHash: Hex };
  expect(await kit.depositedIn(txHash)).toMatchObject({ depositor: signer.address, amount: 1_000_000n, number: 7n });
});

test("the Keeper relays a Forfeit signed from the verdict page's typed data, and the escrow splits the Deposit", async () => {
  const { anvil: chain, keeperKey } = keeperChain;
  const maintainer = privateKeyToAccount(generatePrivateKey());
  const repo = "octo/verdict-page";
  await chain.bind(repo, { maintainer: maintainer.address });
  await chain.deposit(repo, "issue", 5);
  const key = keyOf(repoIdOf(repo), "issue", 5);
  const { serial } = (await chain.client.readContract({
    address: chain.escrow,
    abi: chain.escrowAbi,
    functionName: "depositOf",
    args: [key],
  })) as { serial: bigint };
  const sigDeadline = (await chainTime(chain)) + BigInt(WINDOWS.verdict);
  const signature = await maintainer.signTypedData(
    forfeitVerdict({ chainId: await chain.client.getChainId(), escrow: chain.escrow, key, serial, sigDeadline }),
  );

  const response = await keeperHarness(chain, keeperKey).post(
    "/forfeit",
    forfeitBody({ repo, kind: "issue", number: 5, sigDeadline, signature }),
  );

  expect(response?.status).toBe(200);
  const { txHash } = (await response!.json()) as { txHash: Hex };
  const receipt = await chain.client.getTransactionReceipt({ hash: txHash });
  const [forfeited] = parseEventLogs({ abi: chain.escrowAbi, logs: receipt.logs, eventName: "Forfeited" });
  expect(forfeited?.args).toMatchObject({ key, serial, forfeited: 500_000n, refunded: 500_000n });
});

test("the Keeper proposes the Binding for a proof signed from the setup page's typed data", async () => {
  const { anvil: chain, keeperKey } = keeperChain;
  const maintainer = privateKeyToAccount(generatePrivateKey());
  const repo = "Octo/Setup-Page";
  const harness = keeperHarness(chain, keeperKey);
  harness.github.addRepo(repo);
  harness.github.setFile(repo, ".github/bona-fide.yml", `maintainer: ${maintainer.address}\namount: 2\n`);
  const proof = {
    repo,
    maintainer: maintainer.address as Address,
    nonce: randomBytes32(),
    deadline: (await chainTime(chain)) + BigInt(WINDOWS.bindingProof),
  };
  const signature = await maintainer.signTypedData(
    bindingProof({ chainId: await chain.client.getChainId(), escrow: chain.escrow, ...proof }),
  );

  const response = await harness.post("/binding-proof", bindingProofBody(proof, signature));

  expect(response?.status).toBe(200);
  expect(await response!.json()).toMatchObject({ status: "proposed" });
  const [pending] = (await chain.client.readContract({
    address: chain.escrow,
    abi: chain.escrowAbi,
    functionName: "pendingConfig",
    args: [repoIdOf(repo)],
  })) as [{ maintainer: Address; amount: bigint }, bigint];
  expect(pending).toMatchObject({ maintainer: maintainer.address, amount: 2_000_000n });
});

test("each page signs for its own time window: 10 minutes, 30 minutes and 1 hour", () => {
  expect(WINDOWS).toEqual({ deposit: 600, bindingProof: 1800, verdict: 3600, bountyFund: 600, payout: 3600 });
});
