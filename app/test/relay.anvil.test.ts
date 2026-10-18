import { refusalIn } from "@bona-fide/sdk";
import { createPublicClient, http, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { afterAll, beforeAll, expect, test, vi } from "vitest";
import { createDepositRelay, type DepositRelayOptions } from "../src/relay/deposit.ts";
import { freePort, POLLING_INTERVAL, startAnvil, type Anvil } from "./support/anvil.ts";
import { post, RELAY_URL, relayKit, type RelayKit } from "./support/relay.ts";

// The real escrow and EIP-3009 mock USDC on anvil. Each test deposits for its own PR number.

const IP = "203.0.113.7";

let anvil: Anvil;
let kit: RelayKit;

beforeAll(async () => {
  anvil = await startAnvil();
  await anvil.bind("Codertocat/Hello-World");
  kit = await relayKit(anvil);
}, 120_000);

afterAll(() => anvil?.stop());

async function relay(options: Partial<DepositRelayOptions> = {}) {
  const wallet = await kit.relayer();
  return { wallet, handle: createDepositRelay({ client: anvil.client, wallet, escrow: anvil.escrow, ...options }) };
}

test("a signed Deposit is relayed on-chain, paid from the signer's wallet", async () => {
  const signer = await kit.fundedSigner();
  const { handle } = await relay();

  const res = await handle(post(await kit.signedDeposit(signer, { number: 10 })), IP);

  expect(res.status).toBe(200);
  const { txHash } = (await res.json()) as { txHash: Hex };
  expect(await kit.depositedIn(txHash)).toMatchObject({ depositor: signer.address, amount: 1_000_000n });
});

test("a Deposit signed for an old amount is refused with the current one, and nothing is sent", async () => {
  const repo = "octo/stale-amount";
  await anvil.bind(repo);
  await kit.rebind(repo, 2_000_000n);
  const signer = await kit.fundedSigner();
  const { wallet, handle } = await relay();

  const res = await handle(post(await kit.signedDeposit(signer, { repo, number: 12, value: 1_000_000n })), IP);

  expect(res.status).toBe(409);
  expect(await res.json()).toMatchObject({ code: "amount-changed", amount: "2000000" });
  expect(await kit.sent(wallet.account.address)).toBe(0);
});

test("a Deposit for a repo without an active Binding is refused, and nothing is sent", async () => {
  const signer = await kit.fundedSigner();
  const { wallet, handle } = await relay();

  const res = await handle(post(await kit.signedDeposit(signer, { repo: "octo/unbound", number: 13 })), IP);

  expect(res.status).toBe(409);
  const body = (await res.json()) as { error: string };
  expect(body).toMatchObject({ code: "inactive" });
  expect(body.error).toContain("isn't active for octo/unbound");
  expect(body).not.toHaveProperty("amount");
  expect(await kit.sent(wallet.account.address)).toBe(0);
});

test("a second Deposit for the same PR is refused with who paid the first, and nothing is sent", async () => {
  await anvil.deposit("Codertocat/Hello-World", "pr", 14);
  const signer = await kit.fundedSigner();
  const { wallet, handle } = await relay();

  const res = await handle(post(await kit.signedDeposit(signer, { number: 14 })), IP);

  expect(res.status).toBe(409);
  expect(await res.json()).toMatchObject({ code: "already-deposited", depositor: anvil.contributor });
  expect(await kit.sent(wallet.account.address)).toBe(0);
});

test("a Deposit signed by another key is refused with USDC's reason, and nothing is sent", async () => {
  const signer = await kit.fundedSigner();
  const impostor = await kit.fundedSigner();
  const { wallet, handle } = await relay();
  const body = { ...(await kit.signedDeposit(impostor, { number: 15 })), from: signer.address };

  const res = await handle(post(body), IP);

  expect(res.status).toBe(422);
  expect(refusalIn(await res.json())).toMatchObject({
    code: "bad-signature",
    error: expect.stringContaining("FiatTokenV2: invalid signature"),
  });
  expect(await kit.sent(wallet.account.address)).toBe(0);
});

test("an expired authorization is refused with USDC's reason, and nothing is sent", async () => {
  const signer = await kit.fundedSigner();
  const { wallet, handle } = await relay();
  const lapsed = BigInt(Math.floor((await anvil.now()).getTime() / 1000));

  const res = await handle(post(await kit.signedDeposit(signer, { number: 16, validBefore: lapsed })), IP);

  expect(res.status).toBe(422);
  expect(refusalIn(await res.json())).toMatchObject({
    code: "expired",
    error: expect.stringContaining("FiatTokenV2: authorization is expired"),
  });
  expect(await kit.sent(wallet.account.address)).toBe(0);
});

// USDC says why it refuses a bad or expired authorization, but not always why it refuses a low balance.
test("a Deposit from a wallet without enough USDC is refused as a low balance, and nothing is sent", async () => {
  const empty = privateKeyToAccount(generatePrivateKey());
  const { wallet, handle } = await relay();

  const res = await handle(post(await kit.signedDeposit(empty, { number: 26 })), IP);

  expect(res.status).toBe(422);
  expect(refusalIn(await res.json())).toMatchObject({
    code: "low-balance",
    error: expect.stringMatching(/^The Deposit would fail on-chain: /),
  });
  expect(await kit.sent(wallet.account.address)).toBe(0);
});

test("a Deposit that would fail on-chain for another reason is refused with USDC's reason", async () => {
  const signer = await kit.fundedSigner();
  const { wallet, handle } = await relay();
  const body = { ...(await kit.signedDeposit(signer, { number: 27 })), validAfter: "1900000000" };

  const res = await handle(post(body), IP);

  expect(res.status).toBe(422);
  expect(await res.json()).toEqual({
    error: "The Deposit would fail on-chain: FiatTokenV2: authorization is not yet valid.",
    code: "would-fail",
  });
  expect(await kit.sent(wallet.account.address)).toBe(0);
});

const WELL_FORMED = {
  repo: "Codertocat/Hello-World",
  kind: "pr",
  number: 11,
  from: "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC",
  value: "1000000",
  validAfter: "0",
  validBefore: "1900000000",
  salt: `0x${"ab".repeat(32)}`,
  signature: `0x${"cd".repeat(65)}`,
};

// One that expires on the way to a block reverts, and the relayer pays for it.
test("an authorization that expires within two minutes is refused before anything is read or sent", async () => {
  const { wallet, handle } = await relay({ now: () => 1_899_999_950_000 });

  const res = await handle(post(WELL_FORMED), IP);

  expect(res.status).toBe(422);
  expect(await res.json()).toEqual({
    error: "This authorization expires too soon to be relayed. Sign a new one.",
    code: "expired",
  });
  expect(await kit.sent(wallet.account.address)).toBe(0);
});

// The relayer pays for each Deposit, and an exempt item's Deposit is refunded at once, so one
// balance could go round and round.
test("one wallet's Deposits are relayed only so many times a day, then it is told when to retry", async () => {
  const signer = await kit.fundedSigner();
  const { wallet, handle } = await relay({ perDepositor: { max: 1, windowMs: 24 * 3_600_000 } });

  const first = await handle(post(await kit.signedDeposit(signer, { number: 40 })), IP);
  const second = await handle(post(await kit.signedDeposit(signer, { number: 41 })), IP);

  expect(first.status).toBe(200);
  expect(second.status).toBe(429);
  expect(refusalIn(await second.json())).toMatchObject({
    code: "rate-limited",
    error: expect.stringContaining("deposit from your own wallet"),
  });
  expect(await kit.sent(wallet.account.address)).toBe(1);
});

test("of two Deposits for one PR sent at once, only one is relayed", async () => {
  const [first, second] = [await kit.fundedSigner(), await kit.fundedSigner()];
  const { wallet, handle } = await relay();
  const bodies = [await kit.signedDeposit(first, { number: 17 }), await kit.signedDeposit(second, { number: 17 })];

  const answers = await Promise.all(bodies.map((body) => handle(post(body), IP)));
  const refused = answers.find((res) => res.status !== 200)!;

  expect(answers.map((res) => res.status).sort()).toEqual([200, 409]);
  expect(await refused.json()).toMatchObject({ code: "in-flight" });
  expect(await kit.sent(wallet.account.address)).toBe(1);
});

test("Deposits for different PRs sent at once are all relayed", async () => {
  const signers = [await kit.fundedSigner(), await kit.fundedSigner(), await kit.fundedSigner()];
  const { wallet, handle } = await relay();
  const bodies = await Promise.all(signers.map((signer, i) => kit.signedDeposit(signer, { number: 18 + i })));

  const statuses = await Promise.all(bodies.map(async (body) => (await handle(post(body), IP)).status));

  expect(statuses).toEqual([200, 200, 200]);
  expect(await kit.sent(wallet.account.address)).toBe(3);
});

test("a relayed Deposit that another one beats on-chain is reported as failed, with its transaction", async () => {
  const signer = await kit.fundedSigner();
  const { wallet, handle } = await relay();
  const body = await kit.signedDeposit(signer, { number: 21 });
  await kit.automine(false);
  try {
    const relayed = handle(post(body), IP);
    await kit.untilPending(wallet.account.address);
    await kit.frontRun("Codertocat/Hello-World", "pr", 21);
    await kit.mineBlock();

    const res = await relayed;

    expect(res.status).toBe(502);
    const { code, txHash } = refusalIn(await res.json());
    expect(code).toBe("reverted");
    expect((await anvil.client.getTransactionReceipt({ hash: txHash! })).status).toBe("reverted");
  } finally {
    await kit.automine(true);
  }
});

test("a relayed Deposit that isn't mined in time is reported with its transaction, which can still land", async () => {
  const signer = await kit.fundedSigner();
  const { handle } = await relay({ receiptTimeoutMs: 300 });
  const body = await kit.signedDeposit(signer, { number: 22 });
  await kit.automine(false);
  try {
    const res = await handle(post(body), IP);

    expect(res.status).toBe(504);
    const { code, txHash } = refusalIn(await res.json());
    expect(code).toBe("unconfirmed");
    await kit.mineBlock();
    expect(await kit.depositedIn(txHash!)).toMatchObject({ depositor: signer.address });
  } finally {
    await kit.automine(true);
  }
});

test("only POST is allowed", async () => {
  const { handle } = await relay();

  const res = await handle(new Request(RELAY_URL), IP);

  expect(res.status).toBe(405);
  expect(res.headers.get("allow")).toBe("POST");
  expect(await res.json()).toEqual({ error: "Use POST.", code: "method-not-allowed" });
});

test("when the chain can't be reached, the caller is told to retry and sees no internals", async () => {
  const rpc = `http://127.0.0.1:${await freePort()}/secret-api-key`;
  const signer = await kit.fundedSigner();
  const wallet = await kit.relayer();
  const handle = createDepositRelay({
    client: createPublicClient({ transport: http(rpc, { retryCount: 0 }), pollingInterval: POLLING_INTERVAL }),
    wallet,
    escrow: anvil.escrow,
  });
  const errors = vi.spyOn(console, "error").mockImplementation(() => {});

  const res = await handle(post(await kit.signedDeposit(signer, { number: 23 })), IP);

  expect(res.status).toBe(503);
  const body = await res.text();
  expect(body).not.toContain("secret-api-key");
  expect(JSON.parse(body)).toMatchObject({ code: "unavailable" });
  expect(errors).toHaveBeenCalled();
  errors.mockRestore();
});

test("an IP that sends too many requests is told when to retry, and other IPs go on", async () => {
  let now = 0;
  const { handle } = await relay({ perIp: { max: 2, windowMs: 60_000 }, now: () => now });
  const from = (ip: string) => handle(post("{"), ip);

  expect((await from("198.51.100.1")).status).toBe(400);
  expect((await from("198.51.100.1")).status).toBe(400);
  now = 45_000;
  const limited = await from("198.51.100.1");
  expect(limited.status).toBe(429);
  expect(limited.headers.get("retry-after")).toBe("15");
  expect(await limited.json()).toEqual({ error: "Too many requests. Try again in 15 s.", code: "rate-limited" });
  expect((await from("198.51.100.2")).status).toBe(400);
  now = 60_000;
  expect((await from("198.51.100.1")).status).toBe(400);
});

test("a repo that gets too many requests is told when to retry, whatever the IP", async () => {
  const { handle } = await relay({ perRepo: { max: 1, windowMs: 60_000 } });
  const about = (repo: string) => post({ ...WELL_FORMED, repo });

  expect((await handle(about("octo/busy"), "198.51.100.3")).status).toBe(409);
  const limited = await handle(about("Octo/Busy"), "198.51.100.4");
  expect(limited.status).toBe(429);
  expect(limited.headers.get("retry-after")).toBe("60");
  expect((await handle(about("octo/quiet"), "198.51.100.4")).status).toBe(409);
});

test.each([
  ["a body that isn't JSON", "{"],
  ["a repo that isn't owner/name", { ...WELL_FORMED, repo: "Hello-World" }],
  ["an owner GitHub wouldn't allow", { ...WELL_FORMED, repo: "Hello_World/x" }],
  ["an unknown kind", { ...WELL_FORMED, kind: "discussion" }],
  ["a number that isn't a positive whole number", { ...WELL_FORMED, number: 0 }],
  ["a from that isn't an address", { ...WELL_FORMED, from: "0x1234" }],
  ["a value that isn't a whole number of base units", { ...WELL_FORMED, value: "1.5" }],
  ["a validBefore that is missing", { ...WELL_FORMED, validBefore: undefined }],
  ["a salt that isn't 32 bytes", { ...WELL_FORMED, salt: "0x12" }],
  ["a signature that isn't hex", { ...WELL_FORMED, signature: "signed" }],
])("a request with %s is refused before anything is sent", async (_, body) => {
  const { wallet, handle } = await relay();

  const res = await handle(post(body), IP);

  expect(res.status).toBe(400);
  expect(refusalIn(await res.json())).toMatchObject({ code: "invalid", error: expect.stringMatching(/\w/) });
  expect(await kit.sent(wallet.account.address)).toBe(0);
});

test("after a relayed Deposit reverts on-chain, the relay sends none for that PR or from that wallet for 10 minutes", async () => {
  const signer = await kit.fundedSigner();
  let now = 0;
  const { wallet, handle } = await relay({ now: () => now });
  const body = await kit.signedDeposit(signer, { number: 24 });
  await kit.automine(false);
  let reverted: Response;
  try {
    const relayed = handle(post(body), IP);
    await kit.untilPending(wallet.account.address);
    await kit.frontRun("Codertocat/Hello-World", "pr", 24);
    await kit.mineBlock();
    reverted = await relayed;
  } finally {
    await kit.automine(true);
  }
  await anvil.refund("Codertocat/Hello-World", "pr", 24);

  const samePr = await handle(post(await kit.signedDeposit(await kit.fundedSigner(), { number: 24 })), IP);
  const sameWallet = await handle(post(await kit.signedDeposit(signer, { number: 25 })), IP);
  now = 10 * 60_000;
  const later = await handle(post(await kit.signedDeposit(signer, { number: 25 })), IP);

  expect(reverted.status).toBe(502);
  expect(samePr.status).toBe(429);
  expect(sameWallet.status).toBe(429);
  expect(sameWallet.headers.get("retry-after")).toBe("600");
  expect(refusalIn(await samePr.json())).toMatchObject({ code: "paused" });
  expect(refusalIn(await sameWallet.json())).toMatchObject({ code: "paused", error: expect.stringMatching(/\w/) });
  expect(later.status).toBe(200);
  expect(await kit.sent(wallet.account.address)).toBe(2);
});
