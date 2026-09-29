import {
  createTestClient,
  http,
  isAddressEqual,
  parseEventLogs,
  toFunctionSelector,
  type Abi,
  type Address,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { formatAbiItem } from "viem/utils";
import { afterAll, beforeAll, expect, test } from "vitest";
import { createBindingActivator } from "../src/keeper/activator.ts";
import { createTimeoutRefunder } from "../src/keeper/timeouts.ts";
import { EscrowRejection, keeperAbi } from "../src/keeper/escrow.ts";
import { keyOf, repoIdOf, type Kind } from "../src/keys.ts";
import { artifact, type Anvil } from "./support/anvil.ts";
import { keeperHarness, signBinding, signForfeit, startKeeperAnvil } from "./support/keeper.ts";
import { NEWCOMER, payload, REPO } from "./support/webhooks.ts";

// The real escrow and the Keeper's own key: whatever the Keeper is asked to do, USDC moves only as
// the escrow allows.

let anvil: Anvil;
let keeperKey: `0x${string}`;

beforeAll(async () => {
  ({ anvil, keeperKey } = await startKeeperAnvil());
  await anvil.bind(REPO);
}, 120_000);

afterAll(() => anvil?.stop());

const KEEPER_CALLS = [
  "refund(bytes32)",
  "forfeit(bytes32,uint256,bytes)",
  "proposeRepo(bytes32,address,uint16,uint32,uint256)",
  "activateRepo(bytes32)",
].map((signature) => toFunctionSelector(`function ${signature}`));

async function secondsFromNow(seconds: number): Promise<bigint> {
  return BigInt(Math.floor((await anvil.now()).getTime() / 1000) + seconds);
}

async function serialOf(kind: Kind, number: number): Promise<bigint> {
  const deposit = (await anvil.client.readContract({
    address: anvil.escrow,
    abi: anvil.escrowAbi,
    functionName: "depositOf",
    args: [keyOf(repoIdOf(REPO), kind, number)],
  })) as { serial: bigint };
  return deposit.serial;
}

function event(name: string, kind: Kind, number: number, change: (body: any) => void = () => {}) {
  const body = payload(kind === "pr" ? "pull_request" : "issues", name, { author: NEWCOMER, labels: [] });
  (kind === "pr" ? body.pull_request : body.issue).number = number;
  change(body);
  return body;
}

test("across every Keeper path, USDC leaves the escrow only to its Depositor or the Forfeit sink", async () => {
  const { deliver, post, escrow, github } = keeperHarness(anvil, keeperKey);
  const chain = createTestClient({ mode: "anvil", transport: http(anvil.url) });
  const from = (await anvil.blockNumber()) + 1n;
  const at = (date: Date) => date.toISOString();

  // Refunds: a merge, a completion, the bona-fide:ok label, a Deposit made before its PR, a Waiver,
  // the Timeout.
  await anvil.deposit(REPO, "pr", 301);
  await deliver(
    "pull_request",
    event("closed", "pr", 301, (b) => (b.pull_request.merged = true)),
  );
  await anvil.deposit(REPO, "issue", 302);
  await deliver(
    "issues",
    event("reopened", "issue", 302, (b) => {
      b.action = "closed";
      b.issue.state_reason = "completed";
      b.sender.login = "maintainer";
    }),
  );
  await anvil.deposit(REPO, "pr", 303);
  await deliver(
    "pull_request",
    event("labeled", "pr", 303, (b) => (b.label = { name: "bona-fide:ok" })),
  );
  await anvil.deposit(REPO, "pr", 304);
  await anvil.mine(1, 3 * 60);
  const openedAt = at(await anvil.now());
  await deliver(
    "pull_request",
    event("opened", "pr", 304, (b) => (b.pull_request.created_at = openedAt)),
  );
  await anvil.deposit(REPO, "pr", 305);
  await deliver(
    "pull_request",
    event("labeled", "pr", 305, (b) => {
      b.label = { name: "bona-fide:waive" };
      b.pull_request.labels = [{ name: "bona-fide:waive" }];
    }),
  );
  await anvil.deposit(REPO, "issue", 307);
  await chain.increaseTime({ seconds: 7 * 86_400 });
  await chain.mine({ blocks: 1 });
  await createTimeoutRefunder({ escrow, fromBlock: from }).tick();

  // Forfeits: the label alone, a Forfeit signed by the Keeper and one by the Depositor, then the
  // Maintainer's.
  await anvil.deposit(REPO, "pr", 306);
  await deliver(
    "pull_request",
    event("labeled", "pr", 306, (b) => (b.label = { name: "bona-fide:bad-faith" })),
  );
  const key = keyOf(repoIdOf(REPO), "pr", 306);
  const message = { key, serial: await serialOf("pr", 306), sigDeadline: await secondsFromNow(3600) };
  const forfeit = (signature: Hex) =>
    post("/forfeit", { repo: REPO, kind: "pr", number: 306, sigDeadline: Number(message.sigDeadline), signature });
  const keeperSigned = await privateKeyToAccount(keeperKey).signTypedData({
    domain: {
      name: "BonaFide",
      version: "1",
      chainId: await anvil.client.getChainId(),
      verifyingContract: anvil.escrow,
    },
    types: {
      Forfeit: [
        { name: "key", type: "bytes32" },
        { name: "serial", type: "uint256" },
        { name: "sigDeadline", type: "uint256" },
      ],
    },
    primaryType: "Forfeit",
    message,
  });
  expect((await forfeit(keeperSigned))?.status).toBe(400);
  expect((await forfeit(await signForfeit(anvil, anvil.contributor, message)))?.status).toBe(400);
  expect((await forfeit(await signForfeit(anvil, anvil.maintainer, message)))?.status).toBe(200);

  // A Binding, proposed and then activated.
  const repo = "octo/funds";
  github.addRepo(repo);
  github.setFile(repo, ".github/bona-fide.yml", `maintainer: "${anvil.maintainer}"\n`);
  const binding = {
    repo: `github:${repo}`,
    maintainer: anvil.maintainer,
    nonce: `0x${"42".repeat(32)}` as Hex,
    deadline: await secondsFromNow(3600),
  };
  const bound = await post("/binding-proof", {
    ...binding,
    repo,
    deadline: Number(binding.deadline),
    signature: await signBinding(anvil, anvil.maintainer, binding),
  });
  expect(bound?.status).toBe(200);
  await chain.increaseTime({ seconds: Number(anvil.bindingDelay) });
  await chain.mine({ blocks: 1 });
  await createBindingActivator({ escrow, fromBlock: from }).tick();

  const to = await anvil.blockNumber();
  const keeperTxs = [];
  for (let n = from; n <= to; n++) {
    const block = await anvil.client.getBlock({ blockNumber: n, includeTransactions: true });
    keeperTxs.push(...block.transactions.filter((tx) => isAddressEqual(tx.from, anvil.keeper)));
  }
  expect(keeperTxs.length).toBeGreaterThanOrEqual(9);
  for (const tx of keeperTxs) {
    expect(tx.to && isAddressEqual(tx.to, anvil.escrow)).toBe(true);
    expect(KEEPER_CALLS).toContain(tx.input.slice(0, 10));
  }

  const usdcAbi = artifact("MockUSDC").abi as Abi;
  const transfers = parseEventLogs({
    abi: usdcAbi,
    eventName: "Transfer",
    logs: await anvil.client.getLogs({ address: anvil.usdc, fromBlock: from, toBlock: to }),
  }) as unknown as { args: { from: Address; to: Address; value: bigint } }[];
  const paidOut = transfers.filter((t) => isAddressEqual(t.args.from, anvil.escrow));
  expect(paidOut.length).toBeGreaterThanOrEqual(8);
  for (const { args } of paidOut) {
    expect([anvil.contributor, anvil.forfeitSink].some((allowed) => isAddressEqual(allowed, args.to))).toBe(true);
  }
  const forfeits = parseEventLogs({
    abi: anvil.escrowAbi,
    eventName: "Forfeited",
    logs: await anvil.client.getLogs({ address: anvil.escrow, fromBlock: from, toBlock: to }),
  }) as unknown as { args: { forfeited: bigint; refunded: bigint } }[];
  expect(forfeits).toHaveLength(1);
  for (const { args } of forfeits) expect(args.forfeited * 2n).toBeLessThanOrEqual(args.forfeited + args.refunded);
  expect(await anvil.usdcBalance(anvil.keeper)).toBe(0n);
  console.log(
    `Keeper sent ${keeperTxs.length} transactions; ${paidOut.length} USDC transfers left the escrow, all to the Depositor or the Forfeit sink`,
  );
}, 60_000);

test("with its key alone, the Keeper can't forfeit a Deposit or activate a Binding early", async () => {
  const { escrow, post, github } = keeperHarness(anvil, keeperKey);
  await anvil.deposit(REPO, "pr", 311);
  const message = {
    key: keyOf(repoIdOf(REPO), "pr", 311),
    serial: await serialOf("pr", 311),
    sigDeadline: await secondsFromNow(3600),
  };
  const keeperSigned = await privateKeyToAccount(keeperKey).signTypedData({
    domain: {
      name: "BonaFide",
      version: "1",
      chainId: await anvil.client.getChainId(),
      verifyingContract: anvil.escrow,
    },
    types: {
      Forfeit: [
        { name: "key", type: "bytes32" },
        { name: "serial", type: "uint256" },
        { name: "sigDeadline", type: "uint256" },
      ],
    },
    primaryType: "Forfeit",
    message,
  });

  await expect(escrow.forfeit(message.key, message.sigDeadline, keeperSigned)).rejects.toEqual(
    new EscrowRejection("InvalidSignature"),
  );

  const repo = "octo/early";
  github.addRepo(repo);
  github.setFile(repo, ".github/bona-fide.yml", `maintainer: "${anvil.maintainer}"\n`);
  const binding = {
    repo: `github:${repo}`,
    maintainer: anvil.maintainer,
    nonce: `0x${"43".repeat(32)}` as Hex,
    deadline: await secondsFromNow(3600),
  };
  await post("/binding-proof", {
    ...binding,
    repo,
    deadline: Number(binding.deadline),
    signature: await signBinding(anvil, anvil.maintainer, binding),
  });

  await expect(escrow.activateRepo(repoIdOf(repo))).rejects.toEqual(new EscrowRejection("NotYetEffective"));
}, 30_000);

test("the Keeper's escrow ABI matches the Foundry artifact", () => {
  const built = artifact("BonaFideEscrow").abi as Abi;
  for (const item of keeperAbi) {
    const match = built.find((b) => b.type === item.type && "name" in b && b.name === item.name);
    expect(match && formatAbiItem(match)).toBe(formatAbiItem(item));
  }
});
