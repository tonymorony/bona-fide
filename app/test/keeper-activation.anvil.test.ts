import { repoIdOf } from "@bona-fide/sdk";
import { createTestClient, createWalletClient, http, type Address } from "viem";
import { afterAll, beforeAll, expect, test } from "vitest";
import { createBindingActivator } from "../src/keeper/activator.ts";
import { POLLING_INTERVAL, type Anvil } from "./support/anvil.ts";
import { keeperHarness, signBinding, startKeeperAnvil } from "./support/keeper.ts";

let anvil: Anvil;
let keeperKey: `0x${string}`;

beforeAll(async () => {
  ({ anvil, keeperKey } = await startKeeperAnvil());
}, 120_000);

afterAll(() => anvil?.stop());

async function activeMaintainer(repo: string): Promise<Address> {
  const config = (await anvil.client.readContract({
    address: anvil.escrow,
    abi: anvil.escrowAbi,
    functionName: "activeConfig",
    args: [repoIdOf(repo)],
  })) as { maintainer: Address };
  return config.maintainer;
}

/** Proposes a Binding of `repo` to anvil's Maintainer through the Keeper, as a Maintainer would. */
async function propose(repo: string, config = "") {
  const harness = keeperHarness(anvil, keeperKey);
  harness.github.addRepo(repo);
  harness.github.setFile(repo, ".github/bona-fide.yml", `maintainer: "${anvil.maintainer}"\n${config}`);
  const deadline = BigInt(Math.floor((await anvil.now()).getTime() / 1000) + 3600);
  const nonce = `0x${repo.length.toString(16).padStart(64, "0")}` as const;
  const message = { repo: `github:${repo}`, maintainer: anvil.maintainer, nonce, deadline };
  const signature = await signBinding(anvil, anvil.maintainer, message);
  const response = await harness.post("/binding-proof", { ...message, repo, deadline: Number(deadline), signature });
  expect(response?.status).toBe(200);
  return harness;
}

async function wait(seconds: bigint) {
  const chain = createTestClient({ mode: "anvil", transport: http(anvil.url), pollingInterval: POLLING_INTERVAL });
  await chain.increaseTime({ seconds: Number(seconds) });
  await chain.mine({ blocks: 1 });
}

test("a proposed Binding is activated once its delay has passed, not before", async () => {
  const repo = "octo/activate-1";
  const { escrow } = await propose(repo);
  const activator = createBindingActivator({ escrow, fromBlock: anvil.deployBlock });

  await activator.tick();
  expect(await activeMaintainer(repo)).toBe("0x0000000000000000000000000000000000000000");

  await wait(anvil.bindingDelay);
  await activator.tick();
  expect(await activeMaintainer(repo)).toBe(anvil.maintainer);
}, 30_000);

async function activateAsSomeoneElse(repo: string) {
  const wallet = createWalletClient({ transport: http(anvil.url), pollingInterval: POLLING_INTERVAL });
  const hash = await wallet.writeContract({
    account: anvil.contributor,
    chain: null,
    address: anvil.escrow,
    abi: anvil.escrowAbi,
    functionName: "activateRepo",
    args: [repoIdOf(repo)],
  });
  await anvil.client.waitForTransactionReceipt({ hash });
}

test("a Binding someone else activated first is left alone", async () => {
  const repo = "octo/activate-2";
  const { escrow } = await propose(repo);
  const activator = createBindingActivator({ escrow, fromBlock: anvil.deployBlock });
  await wait(anvil.bindingDelay);
  await activateAsSomeoneElse(repo);
  const sent = await anvil.client.getTransactionCount({ address: anvil.keeper });

  await activator.tick();

  expect(await anvil.client.getTransactionCount({ address: anvil.keeper })).toBe(sent);
  expect(await activeMaintainer(repo)).toBe(anvil.maintainer);
}, 30_000);

test("a Binding someone else activates while the Keeper is about to is no error", async () => {
  const repo = "octo/activate-3";
  const { escrow } = await propose(repo);
  const racing = {
    ...escrow,
    async activateRepo(repoId: `0x${string}`) {
      await activateAsSomeoneElse(repo);
      return escrow.activateRepo(repoId);
    },
  };
  await wait(anvil.bindingDelay);

  await expect(
    createBindingActivator({ escrow: racing, fromBlock: anvil.deployBlock }).tick(),
  ).resolves.toBeUndefined();

  expect(await activeMaintainer(repo)).toBe(anvil.maintainer);
}, 30_000);

test("a Binding proposed again before its delay passed is activated after the new delay", async () => {
  const repo = "octo/activate-4";
  const { escrow } = await propose(repo);
  const activator = createBindingActivator({ escrow, fromBlock: anvil.deployBlock });
  await wait(anvil.bindingDelay / 2n);
  await propose(repo, "amount: 2\n");

  await wait(anvil.bindingDelay / 2n);
  await activator.tick();
  expect(await activeMaintainer(repo)).toBe("0x0000000000000000000000000000000000000000");

  await wait(anvil.bindingDelay / 2n);
  await activator.tick();
  const active = (await anvil.client.readContract({
    address: anvil.escrow,
    abi: anvil.escrowAbi,
    functionName: "activeConfig",
    args: [repoIdOf(repo)],
  })) as { amount: bigint };
  expect(active.amount).toBe(2_000_000n);
}, 30_000);

test("a Binding proposed again while the Keeper is about to activate it waits for its new delay", async () => {
  const repo = "octo/activate-5";
  const { escrow } = await propose(repo);
  let proposedAgain = false;
  const racing = {
    ...escrow,
    async pendingBinding(repoId: `0x${string}`) {
      if (!proposedAgain) {
        proposedAgain = true;
        await propose(repo, "amount: 3\n");
      }
      return escrow.pendingBinding(repoId);
    },
  };
  await wait(anvil.bindingDelay);

  await expect(
    createBindingActivator({ escrow: racing, fromBlock: anvil.deployBlock }).tick(),
  ).resolves.toBeUndefined();

  expect(await activeMaintainer(repo)).toBe("0x0000000000000000000000000000000000000000");
}, 30_000);
