import { keyOf, repoIdOf, type Kind } from "@bona-fide/sdk";
import { concat, createTestClient, http, numberToHex, size, slice, hexToBigInt, hexToNumber, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { afterAll, beforeAll, expect, test } from "vitest";
import { createKeeperRoutes } from "../src/keeper/routes.ts";
import type { Anvil } from "./support/anvil.ts";
import { keeperHarness, signForfeit, startKeeperAnvil } from "./support/keeper.ts";
import { NEWCOMER, payload, REPO } from "./support/webhooks.ts";

// The escrow's Status enum: None, Active, Refunded, Forfeited.
const ACTIVE = 1;
const FORFEITED = 3;
const HALF_USDC = 500_000n;
const HOUR = 3600n;

let anvil: Anvil;
let keeperKey: `0x${string}`;

beforeAll(async () => {
  ({ anvil, keeperKey } = await startKeeperAnvil());
  await anvil.bind(REPO);
}, 120_000);

afterAll(() => anvil?.stop());

async function depositOf(kind: Kind, number: number, repo = REPO) {
  const key = keyOf(repoIdOf(repo), kind, number);
  const deposit = (await anvil.client.readContract({
    address: anvil.escrow,
    abi: anvil.escrowAbi,
    functionName: "depositOf",
    args: [key],
  })) as { status: number; serial: bigint; deadline: bigint };
  return { key, ...deposit };
}

async function secondsFromNow(seconds: bigint): Promise<bigint> {
  return BigInt(Math.floor((await anvil.now()).getTime() / 1000)) + seconds;
}

test("a Forfeit the Maintainer signed is relayed: half to the Forfeit sink, the rest refunded", async () => {
  const { post } = keeperHarness(anvil, keeperKey);
  await anvil.deposit(REPO, "pr", 201);
  const { key, serial } = await depositOf("pr", 201);
  const sigDeadline = await secondsFromNow(HOUR);
  const signature = await signForfeit(anvil, anvil.maintainer, { key, serial, sigDeadline });
  const depositorBefore = await anvil.usdcBalance(anvil.contributor);
  const sinkBefore = await anvil.usdcBalance(anvil.forfeitSink);

  const response = await post("/forfeit", {
    repo: REPO,
    kind: "pr",
    number: 201,
    sigDeadline: Number(sigDeadline),
    signature,
  });

  expect(response?.status).toBe(200);
  expect(await response?.json()).toEqual({ txHash: expect.stringMatching(/^0x[0-9a-f]{64}$/) });
  expect((await depositOf("pr", 201)).status).toBe(FORFEITED);
  expect(await anvil.usdcBalance(anvil.forfeitSink)).toBe(sinkBefore + HALF_USDC);
  expect(await anvil.usdcBalance(anvil.contributor)).toBe(depositorBefore + HALF_USDC);
}, 30_000);

const VALID = {
  repo: REPO,
  kind: "pr",
  number: 202,
  sigDeadline: 1_790_000_000,
  signature: `0x${"ab".repeat(65)}`,
};

test.each([
  ["no JSON body", "{", "Send a JSON body with repo, kind, number, sigDeadline and signature."],
  ["a repo without an owner", { ...VALID, repo: "hello" }, "repo must be owner/name, such as octocat/hello-world."],
  [
    "an owner GitHub wouldn't allow",
    { ...VALID, repo: "hello_world/x" },
    "repo must be owner/name, such as octocat/hello-world.",
  ],
  ["an unknown kind", { ...VALID, kind: "commit" }, 'kind must be "pr" or "issue".'],
  ["a number that isn't whole", { ...VALID, number: 1.5 }, "number must be a whole number above 0."],
  ["a deadline that isn't a time", { ...VALID, sigDeadline: "soon" }, "sigDeadline must be a time in Unix seconds."],
  ["a signature that isn't hex", { ...VALID, signature: "0xzz" }, "signature must be 0x-prefixed hex."],
])("a Forfeit request with %s is refused with the reason", async (_, body, error) => {
  const { routes } = keeperHarness(anvil, keeperKey);

  const response = await routes(
    new Request("https://app.example/forfeit", {
      method: "POST",
      body: typeof body === "string" ? body : JSON.stringify(body),
    }),
  );

  expect(response?.status).toBe(400);
  expect(await response?.json()).toEqual({ error, code: "invalid" });
});

async function keeperSignature(message: { key: `0x${string}`; serial: bigint; sigDeadline: bigint }) {
  return privateKeyToAccount(keeperKey).signTypedData({
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
}

test.each([
  ["the Depositor", 203, (m: Parameters<typeof keeperSignature>[0]) => signForfeit(anvil, anvil.contributor, m)],
  ["the Keeper", 204, keeperSignature],
] as const)(
  "a Forfeit signed by %s is refused, and nothing is sent",
  async (_, number, sign) => {
    const { post } = keeperHarness(anvil, keeperKey);
    await anvil.deposit(REPO, "pr", number);
    const { key, serial } = await depositOf("pr", number);
    const sigDeadline = await secondsFromNow(HOUR);
    const sent = await anvil.client.getTransactionCount({ address: anvil.keeper });

    const response = await post("/forfeit", {
      repo: REPO,
      kind: "pr",
      number,
      sigDeadline: Number(sigDeadline),
      signature: await sign({ key, serial, sigDeadline }),
    });

    expect(response?.status).toBe(400);
    expect(await response?.json()).toEqual({
      error: `This isn't the Maintainer's signature for this Deposit. Sign it with the Maintainer's wallet, ${anvil.maintainer}.`,
      code: "bad-signature",
    });
    expect((await depositOf("pr", number)).status).toBe(ACTIVE);
    expect(await anvil.client.getTransactionCount({ address: anvil.keeper })).toBe(sent);
  },
  30_000,
);

async function signedRequest(number: number, { sigDeadline }: { sigDeadline?: bigint } = {}) {
  const { key, serial } = await depositOf("pr", number);
  const deadline = sigDeadline ?? (await secondsFromNow(HOUR));
  const signature = await signForfeit(anvil, anvil.maintainer, { key, serial, sigDeadline: deadline });
  return { repo: REPO, kind: "pr", number, sigDeadline: Number(deadline), signature };
}

test("a Forfeit for a PR without a Deposit is refused", async () => {
  const { post } = keeperHarness(anvil, keeperKey);

  const response = await post("/forfeit", { ...VALID, number: 205 });

  expect(response?.status).toBe(404);
  expect(await response?.json()).toEqual({ error: "There's no Deposit on this PR.", code: "not-found" });
});

test("a Forfeit sent again after it went through is refused", async () => {
  const { post } = keeperHarness(anvil, keeperKey);
  await anvil.deposit(REPO, "pr", 206);
  const request = await signedRequest(206);
  expect((await post("/forfeit", request))?.status).toBe(200);

  const again = await post("/forfeit", request);

  expect(again?.status).toBe(409);
  expect(await again?.json()).toEqual({ error: "This Deposit was already forfeited.", code: "resolved" });
}, 30_000);

test("a Forfeit for a refunded Deposit is refused", async () => {
  const { post } = keeperHarness(anvil, keeperKey);
  await anvil.deposit(REPO, "pr", 207);
  const request = await signedRequest(207);
  await anvil.refund(REPO, "pr", 207);

  const response = await post("/forfeit", request);

  expect(response?.status).toBe(409);
  expect(await response?.json()).toEqual({ error: "This Deposit was already refunded.", code: "resolved" });
}, 30_000);

test("a Forfeit signed for an earlier Deposit on the same PR is refused", async () => {
  const { post } = keeperHarness(anvil, keeperKey);
  await anvil.deposit(REPO, "pr", 208);
  const earlier = await signedRequest(208);
  await anvil.refund(REPO, "pr", 208);
  await anvil.deposit(REPO, "pr", 208);

  const response = await post("/forfeit", earlier);

  expect(response?.status).toBe(400);
  expect((await depositOf("pr", 208)).status).toBe(ACTIVE);
}, 30_000);

test("a Forfeit whose signature has expired is refused", async () => {
  const { post } = keeperHarness(anvil, keeperKey);
  await anvil.deposit(REPO, "pr", 209);

  const response = await post("/forfeit", await signedRequest(209, { sigDeadline: await secondsFromNow(-1n) }));

  expect(response?.status).toBe(400);
  expect(await response?.json()).toEqual({
    error: "This signature has expired. Sign again with a later deadline.",
    code: "expired",
  });
}, 30_000);

test("a Forfeit after the Timeout is refused", async () => {
  const { post } = keeperHarness(anvil, keeperKey);
  const chain = createTestClient({ mode: "anvil", transport: http(anvil.url) });
  await anvil.deposit(REPO, "pr", 210);
  const { deadline } = await depositOf("pr", 210);
  const request = await signedRequest(210, { sigDeadline: deadline + HOUR });
  const snapshot = await chain.snapshot();
  try {
    await chain.setNextBlockTimestamp({ timestamp: deadline });
    await chain.mine({ blocks: 1 });

    const response = await post("/forfeit", request);

    expect(response?.status).toBe(409);
    expect(await response?.json()).toEqual({
      error: "The Timeout has passed, so this Deposit can't be forfeited. Anyone can now refund it in full.",
      code: "timeout-passed",
    });
  } finally {
    await chain.revert({ id: snapshot });
  }
}, 30_000);

test("a Forfeit that loses a race with a refund is refused", async () => {
  const { post } = keeperHarness(anvil, keeperKey, {
    escrow: (escrow) => ({
      ...escrow,
      async forfeit(...args) {
        await anvil.refund(REPO, "pr", 211);
        return escrow.forfeit(...args);
      },
    }),
  });
  await anvil.deposit(REPO, "pr", 211);

  const response = await post("/forfeit", await signedRequest(211));

  expect(response?.status).toBe(409);
  expect(await response?.json()).toEqual({ error: "This Deposit was resolved in the meantime.", code: "resolved" });
}, 30_000);

test("a Maintainer's smart-contract wallet (ERC-1271) can sign the Forfeit", async () => {
  const { post } = keeperHarness(anvil, keeperKey);
  const wallet = await anvil.deployArtifact("MockERC1271Wallet", [anvil.maintainer]);
  const repo = "octo/wallet-maintained";
  await anvil.bind(repo, { maintainer: wallet });
  await anvil.deposit(repo, "pr", 1);
  const { key, serial } = await depositOf("pr", 1, repo);
  const sigDeadline = await secondsFromNow(HOUR);

  const response = await post("/forfeit", {
    repo,
    kind: "pr",
    number: 1,
    sigDeadline: Number(sigDeadline),
    signature: await signForfeit(anvil, anvil.maintainer, { key, serial, sigDeadline }),
  });

  expect(response?.status).toBe(200);
  expect((await depositOf("pr", 1, repo)).status).toBe(FORFEITED);
}, 30_000);

test("a Maintainer's smart-contract wallet refuses a signature from anyone else", async () => {
  const { post } = keeperHarness(anvil, keeperKey);
  const wallet = await anvil.deployArtifact("MockERC1271Wallet", [anvil.maintainer]);
  const repo = "octo/wallet-maintained-2";
  await anvil.bind(repo, { maintainer: wallet });
  await anvil.deposit(repo, "pr", 1);
  const { key, serial } = await depositOf("pr", 1, repo);
  const sigDeadline = await secondsFromNow(HOUR);

  const response = await post("/forfeit", {
    repo,
    kind: "pr",
    number: 1,
    sigDeadline: Number(sigDeadline),
    signature: await signForfeit(anvil, anvil.contributor, { key, serial, sigDeadline }),
  });

  expect(response?.status).toBe(400);
}, 30_000);

// secp256k1's group order: (r, n - s) with the other v is the same signature, which the escrow refuses.
const CURVE_ORDER = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;

test.each([
  [
    "v of 0 or 1",
    212,
    (sig: Hex) => concat([slice(sig, 0, 64), numberToHex(hexToNumber(slice(sig, 64)) - 27, { size: 1 })]),
  ],
  [
    "a high s",
    213,
    (sig: Hex) =>
      concat([
        slice(sig, 0, 32),
        numberToHex(CURVE_ORDER - hexToBigInt(slice(sig, 32, 64)), { size: 32 }),
        numberToHex(hexToNumber(slice(sig, 64)) === 27 ? 28 : 27, { size: 1 }),
      ]),
  ],
] as const)(
  "the Maintainer's signature with %s is refused, as the escrow refuses it",
  async (_, number, reshape) => {
    const { post } = keeperHarness(anvil, keeperKey);
    await anvil.deposit(REPO, "pr", number);
    const request = await signedRequest(number);
    const reshaped = reshape(request.signature);
    expect(size(reshaped)).toBe(65);

    const response = await post("/forfeit", { ...request, signature: reshaped });

    expect(response?.status).toBe(400);
    expect((await depositOf("pr", number)).status).toBe(ACTIVE);
  },
  30_000,
);

test("a signature the escrow refuses is refused, even if the Keeper's own check accepted it", async () => {
  const { post } = keeperHarness(anvil, keeperKey, {
    escrow: (escrow) => ({ ...escrow, isValidSignature: async () => true }),
  });
  await anvil.deposit(REPO, "pr", 214);
  const request = await signedRequest(214);

  const response = await post("/forfeit", { ...request, signature: `0x${"11".repeat(65)}` });

  expect(response?.status).toBe(400);
  expect((await depositOf("pr", 214)).status).toBe(ACTIVE);
}, 30_000);

function labeledItem(kind: Kind, number: number, label: string) {
  const body = payload(kind === "pr" ? "pull_request" : "issues", "labeled", {
    author: NEWCOMER,
    label,
    labels: [label],
  });
  (kind === "pr" ? body.pull_request : body.issue).number = number;
  return body;
}

test.each([
  ["PR", "pr", 221],
  ["issue", "issue", 224],
] as const)(
  "the bona-fide:bad-faith label on the %s points the Maintainer to the sign page, and moves no funds",
  async (noun, kind, number) => {
    const { deliver, github } = keeperHarness(anvil, keeperKey);
    const chain = createTestClient({ mode: "anvil", transport: http(anvil.url) });
    const snapshot = await chain.snapshot();
    try {
      await chain.setNextBlockTimestamp({ timestamp: 1_924_992_000n }); // 2031-01-01 00:00 UTC
      await anvil.deposit(REPO, kind, number);

      await deliver(kind === "pr" ? "pull_request" : "issues", labeledItem(kind, number, "bona-fide:bad-faith"));

      const note = github.noteOn(REPO, number);
      expect(note).toContain(`A Maintainer marked this ${noun} as bad faith. The label alone moves no funds.`);
      expect(note).toContain(`the Maintainer signs with ${anvil.maintainer} before 2031-01-08 00:00 UTC`);
      expect(note).toContain(
        `[Sign the Forfeit](https://bonafide.example/sign?repo=Codertocat%2FHello-World&kind=${kind}&number=${number})`,
      );
      expect(note).toContain(
        "0.50 USDC funds open-source maintainers (Protocol Guild), and 0.50 USDC is refunded to the Depositor.",
      );
      expect((await depositOf(kind, number)).status).toBe(ACTIVE);
    } finally {
      await chain.revert({ id: snapshot });
    }
  },
  30_000,
);

test("the bona-fide:bad-faith label on a PR without a Deposit posts nothing", async () => {
  const { deliver, github } = keeperHarness(anvil, keeperKey);

  await deliver("pull_request", labeledItem("pr", 222, "bona-fide:bad-faith"));

  expect(github.noteOn(REPO, 222)).toBeUndefined();
});

test.each(["/forfeit", "/binding-proof"])("a sign page on another origin can call %s", async (path) => {
  const { routes } = keeperHarness(anvil, keeperKey);

  const preflight = await routes(
    new Request(`https://app.example${path}`, {
      method: "OPTIONS",
      headers: {
        origin: "https://bonafide.example",
        "access-control-request-method": "POST",
        "access-control-request-headers": "content-type",
      },
    }),
  );
  const refused = await routes(new Request(`https://app.example${path}`, { method: "POST", body: "{" }));

  expect(preflight?.status).toBe(204);
  expect(preflight?.headers.get("access-control-allow-origin")).toBe("*");
  expect(preflight?.headers.get("access-control-allow-methods")).toContain("POST");
  expect(preflight?.headers.get("access-control-allow-headers")).toContain("content-type");
  expect(refused?.status).toBe(400);
  expect(refused?.headers.get("access-control-allow-origin")).toBe("*");
});

test("the Keeper's endpoints take only POST", async () => {
  const { routes } = keeperHarness(anvil, keeperKey);

  const response = await routes(new Request("https://app.example/forfeit"));

  expect(response?.status).toBe(405);
  expect(response?.headers.get("allow")).toBe("POST, OPTIONS");
  expect(await response?.json()).toEqual({ error: "Send a POST request.", code: "method-not-allowed" });
});

test("an IP that sends too many requests to the Keeper's endpoints is told when to retry, and other IPs go on", async () => {
  const { keeper } = keeperHarness(anvil, keeperKey);
  let now = 0;
  const routes = createKeeperRoutes(keeper, { perIp: { max: 2, windowMs: 60_000 }, now: () => now });
  const send = (path: string, ip: string) =>
    routes(new Request(`https://app.example${path}`, { method: "POST", body: "{" }), ip);

  expect((await send("/forfeit", "198.51.100.1"))?.status).toBe(400);
  expect((await send("/binding-proof", "198.51.100.1"))?.status).toBe(400);
  now = 45_000;
  const limited = await send("/forfeit", "198.51.100.1");
  expect(limited?.status).toBe(429);
  expect(limited?.headers.get("retry-after")).toBe("15");
  expect(limited?.headers.get("access-control-allow-origin")).toBe("*");
  expect(await limited?.json()).toEqual({ error: "Too many requests. Try again in 15 s.", code: "rate-limited" });
  expect((await send("/binding-proof", "198.51.100.2"))?.status).toBe(400);
  now = 60_000;
  expect((await send("/forfeit", "198.51.100.1"))?.status).toBe(400);
});

test("a Forfeit that reverts on-chain after passing simulation stops the Keeper relaying for that Deposit and that Maintainer's wallet", async () => {
  const { post } = keeperHarness(anvil, keeperKey);
  const chain = createTestClient({ mode: "anvil", transport: http(anvil.url) });
  await anvil.deposit(REPO, "pr", 215);
  await anvil.deposit(REPO, "pr", 216);
  const request = await signedRequest(215, { sigDeadline: await secondsFromNow(60n) });
  const sent = await anvil.client.getTransactionCount({ address: anvil.keeper });

  await chain.setAutomine(false);
  let reverted: Response | null;
  try {
    const relaying = post("/forfeit", request);
    while ((await anvil.client.getTransactionCount({ address: anvil.keeper, blockTag: "pending" })) === sent) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    // The chain passes the signature's deadline before the Keeper's transaction is mined.
    await chain.setNextBlockTimestamp({ timestamp: BigInt(request.sigDeadline) + 1n });
    await chain.mine({ blocks: 1 });
    reverted = await relaying;
  } finally {
    await chain.setAutomine(true);
  }
  const again = await post("/forfeit", await signedRequest(215));
  const sameWallet = await post("/forfeit", await signedRequest(216));

  expect(reverted?.status).toBe(502);
  expect(await reverted?.json()).toEqual({
    error: "The Forfeit was sent but reverted on-chain, so no funds moved. Try again in 10 minutes.",
    code: "reverted",
    txHash: expect.stringMatching(/^0x[0-9a-f]{64}$/),
  });
  expect(again?.status).toBe(429);
  expect(await again?.json()).toMatchObject({ code: "paused" });
  expect(Number(again?.headers.get("retry-after"))).toBeGreaterThan(0);
  expect(sameWallet?.status).toBe(429);
  expect(await anvil.client.getTransactionCount({ address: anvil.keeper })).toBe(sent + 1);
  expect((await depositOf("pr", 215)).status).toBe(ACTIVE);
}, 60_000);
