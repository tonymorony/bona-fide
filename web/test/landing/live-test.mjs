// The landing page's live numbers: counts of Deposits, Refunds and Forfeits from the escrow's
// events, and the forfeit router's balance, read over plain JSON-RPC.

import assert from "node:assert/strict";
import { before, describe, test } from "node:test";
import { NETWORKS } from "../../landing/config.js";
import { LiveNumbersError, TOPICS, formatCount, formatUsdc, readLiveNumbers } from "../../landing/landing.js";
import { ISSUE, PR, buildContracts, freePort, startChain } from "./support/anvil.mjs";

const summary = ({ deposits, refunds, forfeits, routerBalance }) => ({ deposits, refunds, forfeits, routerBalance });

/** A Deposit refunded, one forfeited and one still active: 1 USDC each, with a 50% forfeit share. */
async function depositRefundForfeit(chain) {
  const repo = chain.repoId(1);
  await chain.bind(repo);
  await chain.refund(await chain.deposit(repo, PR, 1));
  await chain.forfeit(await chain.deposit(repo, PR, 2));
  await chain.deposit(repo, ISSUE, 3);
}

/** A fetch that answers JSON-RPC from `answer(method, params)`, which may return a Response itself. */
function fakeRpc(answer) {
  return async (_url, init) => {
    const { id, method, params } = JSON.parse(init.body);
    const result = await answer(method, params);
    if (result instanceof Response) return result;
    return Response.json({ jsonrpc: "2.0", id, result });
  };
}

const fakeNetwork = {
  ...NETWORKS.testnet,
  rpcUrl: "https://rpc.example",
  logsUrl: "https://logs.example",
  escrowFromBlock: 100,
};

describe("readLiveNumbers on a chain with the real escrow", () => {
  before(buildContracts);

  test("counts Deposits, Refunds and Forfeits from the escrow's events", async (t) => {
    const chain = await startChain();
    t.after(() => chain.stop());
    const network = chain.network();

    assert.deepEqual(summary(await readLiveNumbers(network)), {
      deposits: 0,
      refunds: 0,
      forfeits: 0,
      routerBalance: 0n,
    });

    await depositRefundForfeit(chain);
    const numbers = await readLiveNumbers(network);
    assert.deepEqual(summary(numbers), { deposits: 3, refunds: 1, forfeits: 1, routerBalance: 500_000n });
    assert.equal(numbers.routerBalance, await chain.usdcBalance(chain.router));
    assert.equal(numbers.block, BigInt(await chain.rpc("eth_blockNumber")));
  });

  test("reads the history in ranges the RPC accepts", async (t) => {
    const chain = await startChain();
    t.after(() => chain.stop());
    await depositRefundForfeit(chain);

    const spans = [];
    const guarded = (url, init) => {
      const { method, params } = JSON.parse(init.body);
      if (method === "eth_getLogs") spans.push(Number(params[0].toBlock) - Number(params[0].fromBlock) + 1);
      return fetch(url, init);
    };
    const numbers = await readLiveNumbers(chain.network({ logsRange: 3 }), { fetch: guarded });

    assert.deepEqual(summary(numbers), { deposits: 3, refunds: 1, forfeits: 1, routerBalance: 500_000n });
    assert.ok(spans.length > 1, `expected several ranges, got ${spans.length}`);
    assert.ok(
      spans.every((span) => span >= 1 && span <= 3),
      `ranges of ${spans.join(", ")} blocks`,
    );
  });

  test("refuses an RPC that serves another chain", async (t) => {
    const chain = await startChain();
    t.after(() => chain.stop());

    await assert.rejects(readLiveNumbers(chain.network({ chainId: 5042 }), { retryDelayMs: 1 }), (error) => {
      assert.ok(error instanceof LiveNumbersError);
      assert.equal(error.reason, "wrong-network");
      return true;
    });
  });
});

describe("readLiveNumbers when the chain misbehaves", () => {
  test("sends the page's origin as the referrer, without cookies: Arc's explorer refuses a request with none", async () => {
    const sent = [];
    const fetch = fakeRpc((method) => (method === "eth_getLogs" ? [] : method === "eth_chainId" ? "0x4cef52" : "0x64"));
    await readLiveNumbers(fakeNetwork, {
      fetch: (url, init) => {
        sent.push(init);
        return fetch(url, init);
      },
    });

    assert.ok(sent.length >= 4);
    for (const init of sent) {
      assert.equal(init.referrerPolicy, "origin");
      assert.equal(init.credentials, "omit");
    }
  });

  test("says the chain can't be reached when nothing answers", async () => {
    const port = await freePort();
    const network = { ...fakeNetwork, rpcUrl: `http://127.0.0.1:${port}`, logsUrl: `http://127.0.0.1:${port}` };

    await assert.rejects(readLiveNumbers(network, { retryDelayMs: 1 }), (error) => {
      assert.ok(error instanceof LiveNumbersError);
      assert.equal(error.reason, "unreachable");
      return true;
    });
  });

  test("tries again while the RPC is busy", async () => {
    const failures = [
      () => new Response("Too Many Requests", { status: 429 }),
      () => Response.json({ jsonrpc: "2.0", id: 1, error: { code: -32005, message: "rate limit exceeded" } }),
    ];
    let calls = 0;
    const fetch = fakeRpc((method) => {
      calls++;
      if (failures.length > 0) return failures.shift()();
      if (method === "eth_chainId") return "0x4cef52";
      if (method === "eth_blockNumber") return "0x3e8";
      if (method === "eth_call") return `0x${(250_000).toString(16).padStart(64, "0")}`;
      if (method === "eth_getLogs") return [];
      throw new Error(`unexpected ${method}`);
    });

    const numbers = await readLiveNumbers(fakeNetwork, { fetch, retryDelayMs: 1 });
    assert.deepEqual(summary(numbers), { deposits: 0, refunds: 0, forfeits: 0, routerBalance: 250_000n });
    assert.equal(calls, 6);
  });

  test("gives up on an RPC that stays busy", async () => {
    const fetch = fakeRpc(() => new Response("Too Many Requests", { status: 429 }));

    await assert.rejects(readLiveNumbers(fakeNetwork, { fetch, retryDelayMs: 1 }), (error) => {
      assert.equal(error.reason, "unreachable");
      return true;
    });
  });

  test("pages through answers capped at 1,000 logs", async () => {
    const kinds = [TOPICS.deposited, TOPICS.deposited, TOPICS.refunded, TOPICS.forfeited];
    const logs = [];
    for (let block = 100; block < 200; block++) {
      for (let index = 0; index < 23 + (block % 7); index++) {
        logs.push({
          blockNumber: `0x${block.toString(16)}`,
          logIndex: `0x${index.toString(16)}`,
          topics: [kinds[(block + index) % kinds.length]],
        });
      }
    }
    const expected = {
      deposits: logs.filter((log) => log.topics[0] === TOPICS.deposited).length,
      refunds: logs.filter((log) => log.topics[0] === TOPICS.refunded).length,
      forfeits: logs.filter((log) => log.topics[0] === TOPICS.forfeited).length,
    };
    assert.ok(logs.length > 2500);

    let logCalls = 0;
    const fetch = fakeRpc((method, params) => {
      if (method === "eth_chainId") return "0x4cef52";
      if (method === "eth_blockNumber") return "0xc7";
      if (method === "eth_call") return `0x${"0".repeat(64)}`;
      if (method === "eth_getLogs") {
        logCalls++;
        const [{ address, topics, fromBlock, toBlock }] = params;
        assert.equal(address, fakeNetwork.escrow);
        assert.deepEqual(topics, [[TOPICS.deposited, TOPICS.refunded, TOPICS.forfeited]]);
        const inRange = logs.filter(
          (log) => Number(log.blockNumber) >= Number(fromBlock) && Number(log.blockNumber) <= Number(toBlock),
        );
        return inRange.slice(0, 1000);
      }
      throw new Error(`unexpected ${method}`);
    });

    const numbers = await readLiveNumbers(fakeNetwork, { fetch });
    assert.deepEqual(summary(numbers), { ...expected, routerBalance: 0n });
    assert.ok(logCalls >= 3, `expected at least 3 pages, got ${logCalls}`);
  });

  test("reads nothing while the network has no escrow", async () => {
    const fetch = () => assert.fail("no request expected");

    assert.equal(await readLiveNumbers({ ...NETWORKS.mainnet, escrow: "", router: "" }, { fetch }), null);
  });
});

describe("formatting", () => {
  test("shows USDC with at least two decimals", () => {
    assert.equal(formatUsdc(0n), "0.00");
    assert.equal(formatUsdc(500_000n), "0.50");
    assert.equal(formatUsdc(1_000_000n), "1.00");
    assert.equal(formatUsdc(1_234_567n), "1.234567");
    assert.equal(formatUsdc(12_345_000_000n), "12,345.00");
  });

  test("groups counts by thousands", () => {
    assert.equal(formatCount(0), "0");
    assert.equal(formatCount(12_345), "12,345");
  });
});
