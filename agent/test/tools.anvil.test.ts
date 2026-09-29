import type { Address, Hex } from "viem";
import { afterAll, beforeAll, expect, test } from "vitest";
import { castSign, repoIdOf, startChain, type Chain } from "./support/chain.ts";
import { connect, textOf } from "./support/mcp.ts";

const REPO = "octo/tools";
const LIMIT = 5_000_000n;

let chain: Chain;

beforeAll(async () => {
  chain = await startChain();
  await chain.bind(REPO);
}, 120_000);

afterAll(() => chain?.stop());

function options() {
  return { client: chain.client, escrow: chain.escrow, maxDeposit: LIMIT };
}

function server() {
  return connect(options());
}

test("get_deposit_rules reports the repo's active Binding and the item's key", async () => {
  const mcp = await server();

  const result = await mcp.call("get_deposit_rules", { repo: REPO, kind: "pr", number: 1 });

  expect(result.isError).toBeFalsy();
  expect(result.structuredContent).toMatchObject({
    key: await chain.keyOf(REPO, "pr", 1),
    chainId: 5042002,
    escrow: chain.escrow,
    usdc: chain.usdc,
    binding: { amount: "1000000", amountUsdc: "1", forfeitPercent: 50, timeoutDays: 7 },
    activeDeposit: null,
  });
  await mcp.close();
});

test("get_deposit_rules shows who paid an item's active Deposit", async () => {
  const { account } = await chain.contributor();
  await chain.deposit(account, REPO, "issue", 2);
  const mcp = await server();

  const result = await mcp.call("get_deposit_rules", { repo: REPO, kind: "issue", number: 2 });

  expect(result.structuredContent).toMatchObject({
    activeDeposit: { depositor: account.address, amount: "1000000", amountUsdc: "1" },
  });
  await mcp.close();
});

test("get_deposit_rules for a repo without a Binding says so, and shows a pending one", async () => {
  await chain.propose("octo/pending", 2_000_000n);
  const mcp = await server();

  const result = await mcp.call("get_deposit_rules", { repo: "octo/pending", kind: "pr", number: 1 });

  expect(result.structuredContent).toMatchObject({
    binding: null,
    pendingBinding: { amount: "2000000", amountUsdc: "2" },
  });
  expect(textOf(result)).toContain("Bona Fide isn't active for octo/pending");
  await mcp.close();
});

interface SignedPlan {
  typedData: {
    domain: Record<string, unknown>;
    message: Record<string, string>;
  };
  circleCommand: string | null;
  submit: {
    repo: string;
    kind: "pr" | "issue";
    number: number;
    from: Address;
    value: string;
    validAfter: string;
    validBefore: string;
    salt: Hex;
  };
}

test("prepare_signed_deposit returns typed data that, signed by `from`, makes the Deposit from `from`", async () => {
  const { key, account } = await chain.contributor();
  const mcp = await server();

  const result = await mcp.call("prepare_signed_deposit", { repo: REPO, kind: "pr", number: 3, from: account.address });

  expect(result.isError).toBeFalsy();
  const { typedData, submit } = result.structuredContent as unknown as SignedPlan;
  const receipt = await chain.depositWithAuthorization({ ...submit, signature: castSign(key, typedData) });
  expect(await chain.depositedIn(receipt.transactionHash)).toMatchObject({
    depositor: account.address,
    amount: 1_000_000n,
    number: 3n,
  });
  await mcp.close();
});

test("the typed data is USDC's authorization to pay the escrow exactly the Deposit, for 10 minutes", async () => {
  const { account } = await chain.contributor();
  const mcp = await server();

  const result = await mcp.call("prepare_signed_deposit", { repo: REPO, kind: "pr", number: 4, from: account.address });

  const { typedData, submit } = result.structuredContent as unknown as SignedPlan;
  expect(typedData.domain).toEqual({ name: "USDC", version: "2", chainId: 5042002, verifyingContract: chain.usdc });
  expect(typedData.message).toMatchObject({
    from: account.address,
    to: chain.escrow,
    value: "1000000",
    validAfter: "0",
    nonce: await chain.authorizationNonce(await chain.keyOf(REPO, "pr", 4), submit.salt),
  });
  expect(BigInt(typedData.message.validBefore!) - (await chain.now())).toBe(600n);
  await mcp.close();
});

test("prepare_signed_deposit gives a Circle agent wallet the command that signs exactly that typed data", async () => {
  const { account } = await chain.contributor();
  const mcp = await server();

  const result = await mcp.call("prepare_signed_deposit", { repo: REPO, kind: "pr", number: 5, from: account.address });

  const { typedData, circleCommand } = result.structuredContent as unknown as SignedPlan;
  const [, json, flags] = /^circle wallet sign typed-data '([^']+)' (.*)$/.exec(circleCommand ?? "") ?? [];
  expect(JSON.parse(json!)).toEqual(typedData);
  expect(flags).toBe(`--address ${account.address} --chain ARC-TESTNET --quiet`);
  await mcp.close();
});

test("prepare_signed_deposit refuses a Deposit above MAX_DEPOSIT_USDC", async () => {
  await chain.bind("octo/pricey", 10_000_000n);
  const { account } = await chain.contributor();
  const mcp = await server();

  const result = await mcp.call("prepare_signed_deposit", {
    repo: "octo/pricey",
    kind: "pr",
    number: 1,
    from: account.address,
  });

  expect(result.isError).toBe(true);
  expect(textOf(result)).toContain("octo/pricey asks for 10 USDC, above your limit of 5 USDC");
  await mcp.close();
});

test("a higher MAX_DEPOSIT_USDC lets the same Deposit through", async () => {
  const { account } = await chain.contributor();
  const mcp = await connect({ client: chain.client, escrow: chain.escrow, maxDeposit: 10_000_000n });

  const result = await mcp.call("prepare_signed_deposit", {
    repo: "octo/pricey",
    kind: "pr",
    number: 2,
    from: account.address,
  });

  expect(result.isError).toBeFalsy();
  await mcp.close();
});

test.each([
  ["a repo without a Binding", "octo/unbound", 1, "Bona Fide isn't active for octo/unbound"],
  ["an item that already has a Deposit", REPO, 2, "issue #2 in octo/tools already has an active Deposit"],
])("prepare_signed_deposit refuses %s", async (_, repo, number, reason) => {
  const { account } = await chain.contributor();
  const mcp = await server();

  const result = await mcp.call("prepare_signed_deposit", { repo, kind: "issue", number, from: account.address });

  expect(result.isError).toBe(true);
  expect(textOf(result)).toContain(reason);
  await mcp.close();
});

interface TwoStepPlan {
  steps: { description: string; to: Address; data: Hex; circleCommand: string | null }[];
}

test("prepare_two_step_deposit's two transactions, sent from `from`, make the Deposit", async () => {
  const { account } = await chain.contributor();
  const mcp = await server();

  const result = await mcp.call("prepare_two_step_deposit", {
    repo: REPO,
    kind: "pr",
    number: 6,
    from: account.address,
  });

  expect(result.isError).toBeFalsy();
  const { steps } = result.structuredContent as unknown as TwoStepPlan;
  expect(steps).toHaveLength(2);
  await chain.sendFrom(account, steps[0]!.to, steps[0]!.data);
  const receipt = await chain.sendFrom(account, steps[1]!.to, steps[1]!.data);
  expect(await chain.depositedIn(receipt.transactionHash)).toMatchObject({ depositor: account.address, number: 6n });
  await mcp.close();
});

test("prepare_two_step_deposit gives a Circle agent wallet an exact approve, then the deposit", async () => {
  const { account } = await chain.contributor();
  const mcp = await server();

  const result = await mcp.call("prepare_two_step_deposit", {
    repo: REPO,
    kind: "pr",
    number: 7,
    from: account.address,
  });

  const { steps } = result.structuredContent as unknown as TwoStepPlan;
  const wallet = `--address ${account.address} --chain ARC-TESTNET --output json`;
  expect(steps.map((step) => step.circleCommand)).toEqual([
    `circle wallet execute "approve(address,uint256)" ${chain.escrow} 1000000 --contract ${chain.usdc} ${wallet}`,
    `circle wallet execute "deposit(bytes32,uint8,uint64)" ${repoIdOf(REPO)} 0 7 --contract ${chain.escrow} ${wallet}`,
  ]);
  await mcp.close();
});

test("prepare_two_step_deposit refuses a Deposit above MAX_DEPOSIT_USDC", async () => {
  const { account } = await chain.contributor();
  const mcp = await server();

  const result = await mcp.call("prepare_two_step_deposit", {
    repo: "octo/pricey",
    kind: "pr",
    number: 3,
    from: account.address,
  });

  expect(result.isError).toBe(true);
  expect(textOf(result)).toContain("above your limit of 5 USDC");
  await mcp.close();
});

const APP_URL = "https://app.test";

/** Stands in for the App: relays the body straight to the escrow, and records where it was sent. */
function relayingApp() {
  const requests: { url: string; method: string; body: Record<string, unknown> }[] = [];
  const fetch = async (input: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body));
    requests.push({ url: String(input), method: init?.method ?? "GET", body });
    const receipt = await chain.depositWithAuthorization(body);
    return Response.json({ txHash: receipt.transactionHash });
  };
  return { fetch: fetch as typeof globalThis.fetch, requests };
}

function answeringApp(status: number, body: unknown) {
  const requests: string[] = [];
  const fetch = async (input: string | URL | Request) => {
    requests.push(String(input));
    return Response.json(body, { status });
  };
  return { fetch: fetch as typeof globalThis.fetch, requests };
}

async function signedFields(number: number, repo = REPO) {
  const { key, account } = await chain.contributor();
  const mcp = await server();
  const prepared = await mcp.call("prepare_signed_deposit", { repo, kind: "pr", number, from: account.address });
  await mcp.close();
  const { typedData, submit } = prepared.structuredContent as unknown as SignedPlan;
  return { account, fields: { ...submit, signature: castSign(key, typedData) } };
}

test("submit_signed_deposit relays the signature through the App and confirms the Deposit on-chain", async () => {
  const { account, fields } = await signedFields(8);
  const app = relayingApp();
  const mcp = await connect({ ...options(), appUrl: APP_URL, fetch: app.fetch });

  const result = await mcp.call("submit_signed_deposit", fields);

  expect(result.isError).toBeFalsy();
  expect(app.requests).toMatchObject([{ url: `${APP_URL}/relay/deposit`, method: "POST", body: fields }]);
  expect(result.structuredContent).toMatchObject({ depositor: account.address, amount: "1000000", amountUsdc: "1" });
  const { txHash } = result.structuredContent as { txHash: Hex };
  expect(await chain.depositedIn(txHash)).toMatchObject({ depositor: account.address, number: 8n });
  await mcp.close();
});

test("submit_signed_deposit passes on the App's refusal, and says to sign again when the amount changed", async () => {
  const { fields } = await signedFields(9);
  const error =
    "The Deposit for octo/tools is 2 USDC, but this authorization is for 1 USDC. Sign a new one for 2 USDC.";
  const app = answeringApp(409, { error, amount: "2000000" });
  const mcp = await connect({ ...options(), appUrl: APP_URL, fetch: app.fetch });

  const result = await mcp.call("submit_signed_deposit", fields);

  expect(result.isError).toBe(true);
  expect(textOf(result)).toContain(error);
  expect(textOf(result)).toContain("prepare_signed_deposit");
  await mcp.close();
});

test("submit_signed_deposit doesn't believe an App that reports a transaction without this Deposit", async () => {
  const { fields } = await signedFields(10);
  const unrelated = await chain.contributor();
  const { transactionHash } = await chain.sendFrom(unrelated.account, unrelated.account.address, "0x");
  const app = answeringApp(200, { txHash: transactionHash });
  const mcp = await connect({ ...options(), appUrl: APP_URL, fetch: app.fetch });

  const result = await mcp.call("submit_signed_deposit", fields);

  expect(result.isError).toBe(true);
  expect(textOf(result)).toContain("didn't make this Deposit");
  await mcp.close();
});

test("submit_signed_deposit refuses a value above MAX_DEPOSIT_USDC without contacting the App", async () => {
  const { fields } = await signedFields(11);
  const app = answeringApp(200, {});
  const mcp = await connect({ ...options(), appUrl: APP_URL, fetch: app.fetch });

  const result = await mcp.call("submit_signed_deposit", { ...fields, value: "10000000" });

  expect(result.isError).toBe(true);
  expect(textOf(result)).toContain("above your limit of 5 USDC");
  expect(app.requests).toEqual([]);
  await mcp.close();
});

test("without APP_URL, submit_signed_deposit points to the two-step path", async () => {
  const { fields } = await signedFields(12);
  const mcp = await server();

  const result = await mcp.call("submit_signed_deposit", fields);

  expect(result.isError).toBe(true);
  expect(textOf(result)).toContain("prepare_two_step_deposit");
  await mcp.close();
});

test("when the App sent the Deposit but couldn't confirm it, submit_signed_deposit confirms it on-chain", async () => {
  const { account, fields } = await signedFields(13);
  const { transactionHash } = await chain.depositWithAuthorization(fields);
  const app = answeringApp(504, { error: "The Deposit was sent but isn't confirmed yet.", txHash: transactionHash });
  const mcp = await connect({ ...options(), appUrl: APP_URL, fetch: app.fetch });

  const result = await mcp.call("submit_signed_deposit", fields);

  expect(result.isError).toBeFalsy();
  expect(result.structuredContent).toMatchObject({ txHash: transactionHash, depositor: account.address });
  await mcp.close();
});

test("submit_signed_deposit refuses an App answer without a transaction", async () => {
  const { fields } = await signedFields(14);
  const app = answeringApp(200, { ok: true });
  const mcp = await connect({ ...options(), appUrl: APP_URL, fetch: app.fetch });

  const result = await mcp.call("submit_signed_deposit", fields);

  expect(result.isError).toBe(true);
  expect(textOf(result)).toContain("didn't answer with a transaction");
  await mcp.close();
});

test("when a relayed transaction isn't mined in time, submit_signed_deposit says to check again later", async () => {
  const { fields } = await signedFields(15);
  const unmined = `0x${"77".repeat(32)}`;
  const app = answeringApp(504, { error: "The Deposit was sent but isn't confirmed yet.", txHash: unmined });
  const mcp = await connect({ ...options(), appUrl: APP_URL, fetch: app.fetch, receiptTimeoutMs: 300 });

  const result = await mcp.call("submit_signed_deposit", fields);

  expect(result.isError).toBe(true);
  expect(textOf(result)).toContain(`Transaction ${unmined} isn't confirmed yet`);
  expect(textOf(result)).toContain("get_deposit_rules");
  await mcp.close();
});
