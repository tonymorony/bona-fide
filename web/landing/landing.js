// The landing page's live numbers, read by the browser over plain JSON-RPC with no server of its own:
// counts of Deposits, Refunds and Forfeits from the escrow's events, and the forfeit router's USDC.
// In a browser, it also fills the page from config.js.

import { CONFIG, NETWORKS } from "./config.js";

/** keccak256 of each escrow event's signature. */
export const TOPICS = {
  deposited: "0x9af249084d512362cb910e16112dcae7f42dea72d3361cb6ea4d7d9f809c3356",
  refunded: "0xea9704315e6a5ad043e9d2e05289229b8882413a3fcf74e3e60ed2c1806cd3a2",
  forfeited: "0x87d0709e4b97a6bb85b72608dfc8ffdc6e0c8d538223b210b04ed8c9e84582bd",
};
const BALANCE_OF = "0x70a08231";
// Blockscout answers eth_getLogs with at most 1,000 logs, the oldest first.
const LOG_PAGE = 1000;
const RATE_LIMITED = -32005;

/** Why the numbers couldn't be read: "unreachable", "wrong-network" or "bad-answer". */
export class LiveNumbersError extends Error {
  constructor(reason, message) {
    super(message);
    this.name = "LiveNumbersError";
    this.reason = reason;
  }
}

/**
 * Reads the network's live numbers at its latest block, or returns null while it has no escrow.
 * Rejects with a LiveNumbersError.
 */
export async function readLiveNumbers(
  network,
  { fetch = globalThis.fetch, attempts = 3, retryDelayMs = 400, timeoutMs = 15_000 } = {},
) {
  if (!network.escrow) return null;
  const options = { fetch, attempts, retryDelayMs, timeoutMs };
  const node = jsonRpc(network.rpcUrl, options);
  const logs = network.logsUrl === network.rpcUrl ? node : jsonRpc(network.logsUrl, options);

  const chainId = quantity(await node("eth_chainId"), "eth_chainId");
  if (chainId !== BigInt(network.chainId)) {
    throw new LiveNumbersError(
      "wrong-network",
      `${network.rpcUrl} serves chain ${chainId}, not ${network.name} (${network.chainId}).`,
    );
  }
  const block = quantity(await node("eth_blockNumber"), "eth_blockNumber");
  const [counts, routerBalance] = await Promise.all([
    countEvents(logs, network, block),
    network.router ? balanceOf(node, network.usdc, network.router, block) : null,
  ]);
  return { block, ...counts, routerBalance };
}

async function balanceOf(call, token, account, block) {
  const data = `${BALANCE_OF}${account.slice(2).toLowerCase().padStart(64, "0")}`;
  return quantity(await call("eth_call", [{ to: token, data }, hex(block)]), "balanceOf");
}

async function countEvents(call, network, toBlock) {
  const counts = { deposits: 0, refunds: 0, forfeits: 0 };
  const seen = new Set();
  const range = BigInt(network.logsRange || 0);
  for (let start = BigInt(network.escrowFromBlock); start <= toBlock;) {
    const end = range > 0n && start + range - 1n < toBlock ? start + range - 1n : toBlock;
    for (let from = start; ;) {
      const logs = await call("eth_getLogs", [
        {
          address: network.escrow,
          topics: [[TOPICS.deposited, TOPICS.refunded, TOPICS.forfeited]],
          fromBlock: hex(from),
          toBlock: hex(end),
        },
      ]);
      if (!Array.isArray(logs)) throw new LiveNumbersError("bad-answer", "eth_getLogs didn't answer with a list.");
      let fresh = 0;
      let last = from;
      for (const log of logs) {
        const blockNumber = quantity(log.blockNumber, "a log's block");
        const id = `${blockNumber}:${quantity(log.logIndex, "a log's index")}`;
        if (blockNumber > last) last = blockNumber;
        if (seen.has(id)) continue;
        seen.add(id);
        fresh++;
        const topic = String(log.topics?.[0]).toLowerCase();
        if (topic === TOPICS.deposited) counts.deposits++;
        else if (topic === TOPICS.refunded) counts.refunds++;
        else if (topic === TOPICS.forfeited) counts.forfeits++;
      }
      if (logs.length < LOG_PAGE) break;
      if (fresh === 0) throw new LiveNumbersError("bad-answer", `Over ${LOG_PAGE} escrow logs in block ${from}.`);
      from = last;
    }
    start = end + 1n;
  }
  return counts;
}

function jsonRpc(url, { fetch, attempts, retryDelayMs, timeoutMs }) {
  let id = 0;
  return async function call(method, params = []) {
    let problem = "";
    for (let attempt = 1; attempt <= attempts; attempt++) {
      if (attempt > 1) await new Promise((resolve) => setTimeout(resolve, retryDelayMs * 2 ** (attempt - 2)));
      let response;
      try {
        response = await fetch(url, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params }),
          credentials: "omit",
          referrerPolicy: "no-referrer",
          cache: "no-store",
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch (error) {
        problem = `${url} didn't answer ${method}: ${error.message}`;
        continue;
      }
      if (response.status === 429 || response.status >= 500) {
        problem = `${url} answered ${method} with HTTP ${response.status}.`;
        continue;
      }
      let answer;
      try {
        answer = await response.json();
      } catch {
        throw new LiveNumbersError("bad-answer", `${url} answered ${method} with HTTP ${response.status}, not JSON.`);
      }
      if (answer?.error) {
        if (answer.error.code === RATE_LIMITED) {
          problem = `${url} is busy: ${answer.error.message}`;
          continue;
        }
        throw new LiveNumbersError("bad-answer", `${url} refused ${method}: ${answer.error.message}`);
      }
      if (!answer || !("result" in answer))
        throw new LiveNumbersError("bad-answer", `${url} sent no result for ${method}.`);
      return answer.result;
    }
    throw new LiveNumbersError("unreachable", problem);
  };
}

function quantity(value, what) {
  if (typeof value !== "string" || !/^0x[0-9a-f]+$/i.test(value)) {
    throw new LiveNumbersError("bad-answer", `Expected a hex number for ${what}, got ${JSON.stringify(value)}.`);
  }
  return BigInt(value);
}

const hex = (value) => `0x${value.toString(16)}`;

const COUNT = new Intl.NumberFormat("en-US");

export function formatCount(count) {
  return COUNT.format(count);
}

/** USDC's 6-decimal base units as an amount with at least two decimals, such as "0.50". */
export function formatUsdc(units) {
  const fraction = (units % 1_000_000n).toString().padStart(6, "0").replace(/0+$/, "").padEnd(2, "0");
  return `${COUNT.format(units / 1_000_000n)}.${fraction}`;
}

export function shortAddress(address) {
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

if (typeof document !== "undefined") startPage(document, CONFIG, NETWORKS[CONFIG.network]);

function startPage(doc, config, network) {
  showInstall(doc, config);
  showNetwork(doc, network);
  const live = doc.querySelector("[data-live]");
  if (!live) return;
  live.querySelector("[data-retry]")?.addEventListener("click", () => showLiveNumbers(live, network));
  void showLiveNumbers(live, network);
}

function showInstall(doc, { installUrl, installOpen }) {
  if (!installOpen) return;
  for (const button of doc.querySelectorAll("[data-install]")) {
    button.href = installUrl;
    button.removeAttribute("aria-disabled");
    button.textContent = "Install on GitHub";
  }
}

function showNetwork(doc, network) {
  for (const name of doc.querySelectorAll("[data-network-name]")) name.textContent = network.name;
  const tag = doc.querySelector("[data-network-tag]");
  if (tag) {
    tag.textContent = network.test ? `${network.name} · test network` : network.name;
    tag.classList.toggle("warn", network.test);
    if (network.test) tag.title = "Test USDC only: it has no value";
  }
  for (const note of doc.querySelectorAll("[data-test-only]")) note.hidden = !network.test || !network.escrow;
  for (const note of doc.querySelectorAll("[data-main-only]")) note.hidden = network.test || !network.escrow;
  if (network.escrow) {
    for (const link of doc.querySelectorAll("[data-escrow-link]")) {
      link.href = `${network.explorerUrl}/address/${network.escrow}`;
      link.hidden = false;
    }
  }
  for (const link of doc.querySelectorAll("[data-address]")) {
    const address = network[link.dataset.address];
    if (!address) continue;
    link.href = `${network.explorerUrl}/address/${address}`;
    link.textContent = shortAddress(address);
    link.title = address;
  }
}

async function showLiveNumbers(section, network) {
  const status = section.querySelector("[data-live-status]");
  const values = Object.fromEntries([...section.querySelectorAll("[data-value]")].map((el) => [el.dataset.value, el]));
  const show = (state) => {
    section.dataset.state = state;
    for (const part of section.querySelectorAll("[data-when]"))
      part.hidden = !part.dataset.when.split(" ").includes(state);
  };
  for (const value of Object.values(values)) value.textContent = "—";
  if (!network.escrow) {
    status.textContent = "";
    show("soon");
    return;
  }

  show("loading");
  status.textContent = `Reading ${network.name}…`;
  try {
    const numbers = await readLiveNumbers(network);
    values.deposits.textContent = formatCount(numbers.deposits);
    values.refunds.textContent = formatCount(numbers.refunds);
    values.forfeits.textContent = formatCount(numbers.forfeits);
    if (numbers.routerBalance !== null) values.routerBalance.textContent = formatUsdc(numbers.routerBalance);
    const line = section.ownerDocument.createElement("span");
    const block = section.ownerDocument.createElement("a");
    block.href = `${network.explorerUrl}/block/${numbers.block}`;
    block.textContent = formatCount(numbers.block);
    line.append("As of block ", block);
    status.replaceChildren(line);
    delete section.dataset.reason;
    show("live");
  } catch (error) {
    status.textContent = "";
    section.dataset.reason = error instanceof LiveNumbersError ? error.reason : "unreachable";
    show("unreachable");
  }
}
