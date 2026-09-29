import { getAddress, keccak256, stringToBytes, type Address, type Hex } from "viem";
import { afterAll, beforeAll, expect, test } from "vitest";
import { repoIdOf } from "../src/keys.ts";
import type { Anvil } from "./support/anvil.ts";
import { keeperHarness, signBinding, startKeeperAnvil } from "./support/keeper.ts";

let anvil: Anvil;
let keeperKey: `0x${string}`;

beforeAll(async () => {
  ({ anvil, keeperKey } = await startKeeperAnvil());
}, 120_000);

afterAll(() => anvil?.stop());

const HOUR = 3600n;

async function secondsFromNow(seconds: bigint): Promise<bigint> {
  return BigInt(Math.floor((await anvil.now()).getTime() / 1000)) + seconds;
}

/** A harness where `repo` has Bona Fide installed and this bona-fide.yml. */
function installedWith(repo: string, config: string) {
  const harness = keeperHarness(anvil, keeperKey);
  harness.github.addRepo(repo);
  harness.github.setFile(repo, ".github/bona-fide.yml", config);
  return harness;
}

async function proof(repo: string, maintainer: Address, { signer = maintainer, deadline = HOUR } = {}) {
  const message = {
    repo: `github:${repo.toLowerCase()}`,
    maintainer,
    nonce: keccak256(stringToBytes(`${repo} ${Math.random()}`)),
    deadline: await secondsFromNow(deadline),
  };
  const signature = await signBinding(anvil, signer, message);
  return { repo, maintainer, nonce: message.nonce, deadline: Number(message.deadline), signature };
}

async function pendingConfig(repo: string) {
  const [config, effectiveAt] = (await anvil.client.readContract({
    address: anvil.escrow,
    abi: anvil.escrowAbi,
    functionName: "pendingConfig",
    args: [repoIdOf(repo)],
  })) as [{ maintainer: Address; forfeitBps: number; timeout: number; amount: bigint }, bigint];
  return { ...config, effectiveAt };
}

test("a Maintainer's signed proof proposes the Binding in bona-fide.yml, effective after the delay", async () => {
  const repo = "octo/bind-1";
  const { post } = installedWith(
    repo,
    `maintainer: "${anvil.maintainer}"\namount: 2.5\nforfeit: 20%\ntimeout: 14 days\n`,
  );

  const response = await post("/binding-proof", await proof(repo, anvil.maintainer));

  expect(response?.status).toBe(200);
  const body = (await response?.json()) as { status: string; txHash: Hex; effectiveAt: number };
  expect(body).toEqual({
    status: "proposed",
    txHash: expect.stringMatching(/^0x[0-9a-f]{64}$/),
    effectiveAt: expect.any(Number),
  });
  const proposed = await pendingConfig(repo);
  expect(proposed).toEqual({
    maintainer: anvil.maintainer,
    forfeitBps: 2000,
    timeout: 14 * 86_400,
    amount: 2_500_000n,
    effectiveAt: BigInt(body.effectiveAt),
  });
  const proposedAt = await anvil.client.getBlock({
    blockNumber: (await anvil.client.getTransactionReceipt({ hash: body.txHash })).blockNumber,
  });
  expect(proposed.effectiveAt).toBe(proposedAt.timestamp + anvil.bindingDelay);
}, 30_000);

const NOTHING_PENDING = "0x0000000000000000000000000000000000000000";

test("a proof signed by another wallet is refused, and nothing is proposed", async () => {
  const repo = "octo/bind-2";
  const { post } = installedWith(repo, `maintainer: "${anvil.maintainer}"\n`);

  const response = await post("/binding-proof", await proof(repo, anvil.maintainer, { signer: anvil.contributor }));

  expect(response?.status).toBe(400);
  expect(await response?.json()).toEqual({
    error: `This proof isn't signed by ${anvil.maintainer}. Sign it with that wallet.`,
  });
  expect((await pendingConfig(repo)).maintainer).toBe(NOTHING_PENDING);
}, 30_000);

test("a proof for a wallet other than the one in bona-fide.yml is refused", async () => {
  const repo = "octo/bind-3";
  const { post } = installedWith(repo, `maintainer: "${anvil.maintainer}"\n`);

  const response = await post("/binding-proof", await proof(repo, anvil.contributor));

  expect(response?.status).toBe(409);
  expect(await response?.json()).toEqual({
    error: `.github/bona-fide.yml names ${anvil.maintainer} as the Maintainer, not ${anvil.contributor}.`,
  });
  expect((await pendingConfig(repo)).maintainer).toBe(NOTHING_PENDING);
}, 30_000);

test.each([
  ["another chain", { chainId: 1 }],
  ["another escrow", { verifyingContract: "0x000000000000000000000000000000000000b0fa" as Address }],
])(
  "a proof signed for %s is refused",
  async (_, domain) => {
    const repo = "octo/bind-4";
    const { post } = installedWith(repo, `maintainer: "${anvil.maintainer}"\n`);
    const good = await proof(repo, anvil.maintainer);
    const message = {
      repo: `github:${repo}`,
      maintainer: anvil.maintainer,
      nonce: good.nonce as Hex,
      deadline: BigInt(good.deadline),
    };

    const response = await post("/binding-proof", {
      ...good,
      signature: await signBinding(anvil, anvil.maintainer, message, domain),
    });

    expect(response?.status).toBe(400);
    expect((await pendingConfig(repo)).maintainer).toBe(NOTHING_PENDING);
  },
  30_000,
);

test("an expired proof is refused", async () => {
  const repo = "octo/bind-5";
  const { post } = installedWith(repo, `maintainer: "${anvil.maintainer}"\n`);

  const response = await post("/binding-proof", await proof(repo, anvil.maintainer, { deadline: -1n }));

  expect(response?.status).toBe(400);
  expect(await response?.json()).toEqual({ error: "This proof has expired. Sign a new one." });
}, 30_000);

test("the same proof sent twice proposes once, so the delay doesn't restart", async () => {
  const repo = "octo/bind-6";
  const { post } = installedWith(repo, `maintainer: "${anvil.maintainer}"\n`);
  const signed = await proof(repo, anvil.maintainer);
  const first = (await (await post("/binding-proof", signed))?.json()) as { effectiveAt: number };
  await anvil.mine(1, 60);
  const sent = await anvil.client.getTransactionCount({ address: anvil.keeper });

  const again = await post("/binding-proof", signed);

  expect(await again?.json()).toEqual({ status: "pending", effectiveAt: first.effectiveAt });
  expect((await pendingConfig(repo)).effectiveAt).toBe(BigInt(first.effectiveAt));
  expect(await anvil.client.getTransactionCount({ address: anvil.keeper })).toBe(sent);
}, 30_000);

test("a proof for the Binding that is already active changes nothing", async () => {
  const repo = "octo/bind-7";
  await anvil.bind(repo);
  const { post } = installedWith(repo, `maintainer: "${anvil.maintainer}"\n`);
  const sent = await anvil.client.getTransactionCount({ address: anvil.keeper });

  const response = await post("/binding-proof", await proof(repo, anvil.maintainer));

  expect(await response?.json()).toEqual({ status: "active" });
  expect(await anvil.client.getTransactionCount({ address: anvil.keeper })).toBe(sent);
}, 30_000);

test("a proof for a repo without Bona Fide installed is refused", async () => {
  const { post } = keeperHarness(anvil, keeperKey);

  const response = await post("/binding-proof", await proof("octo/not-installed", anvil.maintainer));

  expect(response?.status).toBe(404);
  expect(await response?.json()).toEqual({ error: "Bona Fide isn't installed on octo/not-installed." });
}, 30_000);

test.each([
  ["no bona-fide.yml", null, 409, "octo/bind-8 has no .github/bona-fide.yml on its default branch."],
  [
    "a bona-fide.yml that needs a fix",
    "maintainer: '0x0000000000000000000000000000000000000001'\nforfeit: 80%\n",
    409,
    ".github/bona-fide.yml needs a fix: `forfeit` must be from 0% to 50%.",
  ],
  [
    "a bona-fide.yml without a maintainer",
    "amount: 1\n",
    409,
    ".github/bona-fide.yml names no Maintainer wallet. Add `maintainer: <address>`.",
  ],
] as const)(
  "a proof for a repo with %s is refused",
  async (_, config, status, error) => {
    const repo = "octo/bind-8";
    const harness = keeperHarness(anvil, keeperKey);
    harness.github.addRepo(repo);
    if (config !== null) harness.github.setFile(repo, ".github/bona-fide.yml", config);

    const response = await harness.post("/binding-proof", await proof(repo, anvil.maintainer));

    expect(response?.status).toBe(status);
    expect(await response?.json()).toEqual({ error });
  },
  30_000,
);

test("a Maintainer's smart-contract wallet (ERC-1271) can prove control", async () => {
  const wallet = await anvil.deployArtifact("MockERC1271Wallet", [anvil.maintainer]);
  const repo = "octo/bind-9";
  const { post } = installedWith(repo, `maintainer: "${wallet}"\n`);

  const response = await post("/binding-proof", await proof(repo, wallet, { signer: anvil.maintainer }));

  expect(response?.status).toBe(200);
  expect((await pendingConfig(repo)).maintainer).toBe(getAddress(wallet));
}, 30_000);

test.each([
  ["no JSON body", "{", "Send a JSON body with repo, maintainer, nonce, deadline and signature."],
  ["a maintainer that isn't an address", { maintainer: "alice" }, "maintainer must be a wallet address."],
  ["a nonce that isn't 32 bytes", { nonce: "0x1234" }, "nonce must be 32 bytes of hex."],
])(
  "a proof with %s is refused with the reason",
  async (_, change, error) => {
    const { routes } = keeperHarness(anvil, keeperKey);
    const good = await proof("octo/bind-10", anvil.maintainer);
    const body = typeof change === "string" ? change : JSON.stringify({ ...good, ...change });

    const response = await routes(new Request("https://app.example/binding-proof", { method: "POST", body }));

    expect(response?.status).toBe(400);
    expect(await response?.json()).toEqual({ error });
  },
  30_000,
);

test("the same proof sent twice at once proposes once", async () => {
  const repo = "octo/bind-11";
  const { post } = installedWith(repo, `maintainer: "${anvil.maintainer}"\n`);
  const signed = await proof(repo, anvil.maintainer);
  const sent = await anvil.client.getTransactionCount({ address: anvil.keeper });

  const answers = await Promise.all([post("/binding-proof", signed), post("/binding-proof", signed)]);

  const bodies = (await Promise.all(answers.map((answer) => answer?.json()))) as {
    status: string;
    effectiveAt: number;
  }[];
  expect(bodies.map((body) => body.status).sort()).toEqual(["pending", "proposed"]);
  expect(bodies[0]?.effectiveAt).toBe(bodies[1]?.effectiveAt);
  expect(await anvil.client.getTransactionCount({ address: anvil.keeper })).toBe(sent + 1);
}, 30_000);
