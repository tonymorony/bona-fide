import { parseEventLogs, type Hex } from "viem";
import { escrowAbi, routerAbi } from "../abi.ts";
import { createBountyReader, hasBounties, type BountyRow, type BountyWalletState } from "../bounty.ts";
import type { RepoTerms, Terms } from "../chain.ts";
import { decisionWords } from "../decisions.ts";
import { readDecisions, type Decision, type DecisionsOutcome } from "../endpoints.ts";
import { delay, localTime, percent, shortAddress, shortDate, timeLeft, timeout, usdc, utcTime } from "../format.ts";
import { readRepoHistory, type DepositRow, type RepoHistory } from "../history.ts";
import { repoIdOf } from "../keys.ts";
import { bountiesPageUrl, explorerAddress, explorerTx, itemName, itemUrl, readRepoLink } from "../link.ts";
import { drawBountyRows } from "../ui/bounty-rows.ts";
import { newView, onAction, render } from "../ui/dom.ts";
import { sendContractCall } from "../wallet.ts";
import {
  chain,
  client,
  describeWallet,
  network,
  reader,
  readyWallet,
  revertReason,
  sameAddress,
  startSession,
  walletFailure,
} from "./common.ts";

const repo = readRepoLink(location.search);
const repoId = repo && repoIdOf(repo);
const bountyReader = hasBounties(network) ? createBountyReader(client, network) : null;
/** Rows shown before "Show all". */
const FIRST_ROWS = 10;

let terms: RepoTerms | null = null;
// What the page says until the escrow answers: its minimum Binding delay, which both deployed escrows use.
let delaySeconds = 3_600;
let routerBalance: bigint | null = null;
let chainNow = new Date();
let loadFailed = false;
let history: RepoHistory | null = null;
let historyProgress = 0;
let historyFailed = false;
let showAll = false;
let refundSent: { row: DepositRow; txHash: Hex } | null = null;
let flushed: { amount: bigint; txHash: Hex } | null = null;
let actionNote = "";
/** The repo's Bounty wallet, read from chain: undefined while it is read, null when there is none. */
let bountyWallet: { state: BountyWalletState; rows: BountyRow[] } | null | undefined;
let bountyFailed = false;
/** The App's decision log for the repo; null while it is read. */
let decisions: DecisionsOutcome | null = null;
const busy = new Set<string>();
const rowsBody = document.querySelector<HTMLTableSectionElement>("[data-rows]")!;
const rowTemplate = document.querySelector<HTMLTemplateElement>("template[data-row]")!;
const decisionList = document.querySelector<HTMLOListElement>("[data-decisions]")!;
const decisionTemplate = document.querySelector<HTMLTemplateElement>("template[data-decision]")!;
const bountyBody = document.querySelector<HTMLTableSectionElement>("[data-bounty-rows]")!;
const bountyTemplate = document.querySelector<HTMLTemplateElement>("template[data-bounty-row]")!;

const session = startSession(() => paint());

function termsText(t: Omit<Terms, "maintainer">): string {
  return `${usdc(t.amount)}, a ${timeout(t.timeoutSeconds)} Timeout and a ${percent(t.forfeitBps)} bad-faith share`;
}

function stateNow(): string {
  if (!repo) return "bad-link";
  if (loadFailed) return "chain-error";
  if (!terms) return "loading";
  if (terms.active) return "live";
  return terms.pending ? "starting" : "not-set-up";
}

function paint(): void {
  const state = stateNow();
  const view = newView(state);
  describeWallet(view, session);
  view.text["recipient-short"] = shortAddress(network.forfeits.address);
  view.text.delay = delay(delaySeconds);
  view.flags["repo-known"] = repo !== null;
  view.flags["repo-unknown"] = repo === null;
  if (repo) {
    view.text.repo = repo;
    view.hrefs["repo-url"] = `https://github.com/${repo}`;
  }
  const shown = terms?.active ?? terms?.pending ?? null;
  if (shown) {
    view.text.amount = usdc(shown.amount);
    view.text.timeout = timeout(shown.timeoutSeconds);
    view.text.share = percent(shown.forfeitBps);
    view.text["maintainer-short"] = shortAddress(shown.maintainer);
    view.hrefs["maintainer-url"] = explorerAddress(network, shown.maintainer);
  }
  view.flags["terms-active"] = !!terms?.active;
  view.flags["terms-starting"] = !terms?.active && !!terms?.pending;
  if (terms?.pending) {
    view.times["starts-at"] = terms.pending.effectiveAt;
    view.times["new-terms-at"] = terms.pending.effectiveAt;
    view.flags["starts-at"] = !terms.active;
    view.flags["new-terms"] = !!terms.active;
    view.text["new-terms"] = termsText(terms.pending);
  }
  if (history?.liveSince) {
    view.times["live-since"] = history.liveSince;
    view.flags["live-since"] = !!terms?.active;
  }
  view.flags["history-loading"] = !history && !historyFailed && state !== "not-set-up";
  view.flags["history-failed"] = historyFailed;
  view.text["history-progress"] = `${Math.floor(historyProgress * 100)}%`;
  if (history) {
    const deposits = history.deposits;
    const count = (status: DepositRow["status"]) => deposits.filter((d) => d.status === status).length;
    const forfeited = count("forfeited");
    const decided = count("refunded") + forfeited;
    const forfeitedShares = deposits.reduce((sum, d) => sum + (d.forfeit?.forfeited ?? 0n), 0n);
    view.flags["history-ready"] = true;
    view.flags["has-deposits"] = deposits.length > 0;
    view.flags["no-deposits"] = deposits.length === 0;
    view.flags.more = !showAll && deposits.length > FIRST_ROWS;
    view.flags.decided = decided > 0;
    view.text["count-all"] = String(deposits.length);
    view.text["count-active"] = String(count("active"));
    view.text["count-refunded"] = String(count("refunded"));
    view.text["count-forfeited"] = String(forfeited);
    view.text["forfeit-rate"] = decided > 0 ? `${((forfeited / decided) * 100).toFixed(1).replace(/\.0$/, "")}%` : "";
    view.text["forfeit-rate-detail"] =
      forfeited === 0
        ? "Forfeit rate: no Deposit here has been forfeited."
        : `Forfeit rate: ${forfeited} of ${decided} decided ${decided === 1 ? "Deposit" : "Deposits"} ${
            forfeited === 1 ? "was" : "were"
          } forfeited. ${forfeited === 1 ? "Its" : "Their"} ${usdc(forfeitedShares)} ${
            forfeited === 1 ? "share goes" : "in shares go"
          } to ${network.forfeits.recipient}.`;
    view.text["flushed-total"] = usdc(history.flushes.total);
    view.text["flush-count"] =
      history.flushes.count === 0
        ? "Nothing sent yet"
        : `In ${history.flushes.count} ${history.flushes.count === 1 ? "send" : "sends"}`;
    drawRows(deposits);
  }
  if (routerBalance !== null) {
    view.text["router-balance"] = usdc(routerBalance);
    view.flags["can-flush"] = routerBalance > 0n;
    view.flags["nothing-to-flush"] = routerBalance === 0n;
  }
  if (refundSent) {
    view.flags["refund-sent"] = true;
    view.text["refund-amount"] = usdc(refundSent.row.amount);
    view.text["refund-to"] = shortAddress(refundSent.row.depositor);
    view.text["refund-item"] = itemName(refundSent.row.kind, refundSent.row.number);
    view.hrefs["refund-tx-url"] = explorerTx(network, refundSent.txHash);
  }
  if (flushed) {
    view.flags.flushed = true;
    view.text["flushed-amount"] = usdc(flushed.amount);
    view.hrefs["flush-tx-url"] = explorerTx(network, flushed.txHash);
  }
  // A log that can't be read says so: its counts are never shown as zeros.
  view.flags["decisions-loading"] = repo !== null && decisions === null;
  view.flags["decisions-failed"] = decisions?.kind === "unavailable";
  if (decisions?.kind === "ok") {
    view.flags["decisions-ready"] = true;
    view.flags["has-decisions"] = decisions.decisions.length > 0;
    view.flags["no-decisions"] = decisions.decisions.length === 0;
    view.text["decided-count"] = String(decisions.counts.decided);
    view.text["escalated-count"] = String(decisions.counts.escalated);
  }
  paintBounties(view, state);
  view.text["action-note"] = actionNote;
  view.flags["action-note"] = actionNote !== "";
  for (const action of busy) view.busy.add(action);
  render(view);
}

// Read from the Bounty wallet on chain, never from the App. A network without the factory shows nothing.
function paintBounties(view: ReturnType<typeof newView>, state: string): void {
  if (!bountyReader || state !== "live" || !repo) return;
  view.flags["bounties-section"] = true;
  view.flags["maintainer-connected"] = sameAddress(session.account, terms?.active?.maintainer);
  view.hrefs["bounties-page"] = bountiesPageUrl(repo);
  view.flags["bounty-loading"] = bountyWallet === undefined && !bountyFailed;
  view.flags["bounty-failed"] = bountyFailed;
  view.flags["no-bounty-wallet"] = bountyWallet === null;
  if (!bountyWallet) return;
  const { state: wallet, rows } = bountyWallet;
  view.flags["bounty-wallet"] = true;
  view.text["bounty-available"] = usdc(wallet.available);
  view.text["bounty-reserved"] = usdc(wallet.reserved);
  view.flags["bounty-keeper-on"] = wallet.keeperEnabled;
  view.flags["bounty-keeper-off"] = !wallet.keeperEnabled;
  view.text["bounty-limits"] =
    `Up to ${usdc(wallet.perPayoutLimit)} a Bounty, and ${usdc(wallet.periodLimit)} every ${timeLeft(wallet.periodLength)}`;
  view.text["bounty-period-left"] =
    `${usdc(wallet.keeperAllowance)} left in this period. Above that, the Maintainer pays.`;
  view.text["bounty-wallet-short"] = shortAddress(wallet.address);
  view.hrefs["bounty-wallet-url"] = explorerAddress(network, wallet.address);
  const shown = rows.filter((row) => row.status !== "cancelled");
  view.flags["has-bounty-rows"] = shown.length > 0;
  view.flags["no-bounty-rows"] = shown.length === 0;
  drawBountyRows(bountyBody, bountyTemplate, shown, { repo, explorerUrl: network.explorerUrl });
}

function drawRows(deposits: DepositRow[]): void {
  const rows = (showAll ? deposits : deposits.slice(0, FIRST_ROWS)).map((d) => {
    const row = rowTemplate.content.firstElementChild!.cloneNode(true) as HTMLTableRowElement;
    const cell = (name: string) => row.querySelector<HTMLElement>(`[data-cell="${name}"]`)!;
    const item = cell("item") as HTMLAnchorElement;
    item.textContent = itemName(d.kind, d.number, { capital: true });
    item.href = itemUrl({ repo: repo!, kind: d.kind, number: d.number });
    const depositor = cell("depositor") as HTMLAnchorElement;
    depositor.textContent = shortAddress(d.depositor);
    depositor.href = explorerAddress(network, d.depositor);
    cell("amount").textContent = usdc(d.amount);
    const made = cell("made") as HTMLTimeElement;
    made.dateTime = d.madeAt.toISOString();
    made.textContent = shortDate(d.madeAt);
    made.title = utcTime(d.madeAt);
    const tag = cell("tag");
    const detail = cell("detail");
    const button = row.querySelector<HTMLButtonElement>('[data-action="refund-row"]')!;
    if (d.status === "active" && chainNow < d.deadline) {
      tag.textContent = "Active";
      tag.classList.add("accent");
      detail.textContent = `Timeout ends ${shortDate(d.deadline)}`;
      detail.title = utcTime(d.deadline);
    } else if (d.status === "active") {
      tag.textContent = "Timeout passed";
      tag.classList.add("warn");
      button.hidden = false;
      button.textContent = `Refund ${usdc(d.amount)}`;
      button.dataset.key = d.key;
      button.setAttribute("aria-label", `Refund ${usdc(d.amount)} for ${itemName(d.kind, d.number)}`);
      if (busy.has(`refund:${d.key}`)) {
        button.disabled = true;
        button.textContent = "Waiting for your wallet";
      }
    } else if (d.status === "refunded") {
      tag.textContent = "Refunded";
      if (d.refund?.afterTimeout) detail.textContent = "after the Timeout";
    } else {
      tag.textContent = "Forfeited";
      tag.classList.add("danger");
      detail.textContent = `${usdc(d.forfeit?.forfeited ?? 0n)} to ${network.forfeits.recipient}`;
    }
    return row;
  });
  rowsBody.replaceChildren(...rows);
}

// The log's text comes from the App and, through the model, from Contributors: it goes into the
// page as text only.
function drawDecisions(list: Decision[]): void {
  const items = list.map((d) => {
    const li = decisionTemplate.content.firstElementChild!.cloneNode(true) as HTMLLIElement;
    const cell = (name: string) => li.querySelector<HTMLElement>(`[data-cell="${name}"]`)!;
    const words = decisionWords(d);
    const item = cell("item") as HTMLAnchorElement;
    item.textContent = itemName(d.item.kind, d.item.number, { capital: true });
    item.href = itemUrl({ repo: repo!, kind: d.item.kind, number: d.item.number });
    const kind = cell("kind");
    kind.textContent = words.kind;
    if (words.pr !== null) {
      const pr = document.createElement("a");
      pr.textContent = itemName("pr", words.pr);
      pr.href = itemUrl({ repo: repo!, kind: "pr", number: words.pr });
      kind.append(" for ", pr);
    }
    const outcome = cell("outcome");
    outcome.textContent = words.outcome;
    outcome.classList.add(d.outcome === "decided" ? "accent" : "neutral");
    const at = cell("at") as HTMLTimeElement;
    at.dateTime = d.at.toISOString();
    at.textContent = localTime(d.at);
    at.title = utcTime(d.at);
    const suggestion = cell("suggestion");
    suggestion.textContent = words.suggestion ?? "";
    suggestion.hidden = words.suggestion === null;
    const reasons = cell("reasons");
    reasons.replaceChildren(
      ...(d.suggestion?.reasons ?? []).map((reason) => {
        const line = document.createElement("li");
        line.textContent = reason;
        return line;
      }),
    );
    reasons.hidden = reasons.childElementCount === 0;
    const witnesses = cell("witnesses");
    witnesses.replaceChildren(
      ...d.witnesses.map((witness) => {
        const row = document.createElement("div");
        const name = document.createElement("dt");
        const value = document.createElement("dd");
        name.textContent = witness.name;
        value.textContent = witness.value;
        row.append(name, value);
        return row;
      }),
    );
    witnesses.hidden = d.witnesses.length === 0;
    cell("done").textContent = words.done;
    const tx = cell("tx") as HTMLAnchorElement;
    if (d.txHash) tx.href = explorerTx(network, d.txHash);
    else tx.remove();
    for (const name of ["read", "cost"] as const) {
      cell(name).textContent = words[name] ?? "";
      cell(name).hidden = words[name] === null;
    }
    return li;
  });
  decisionList.replaceChildren(...items);
}

async function loadDecisions(): Promise<void> {
  if (!repo) return;
  decisions = null;
  paint();
  decisions = await readDecisions(repo, (input, init) => fetch(input, init));
  if (decisions.kind === "ok") drawDecisions(decisions.decisions);
  paint();
}

async function load(): Promise<void> {
  if (!repoId) return paint();
  try {
    [terms, delaySeconds, routerBalance, chainNow] = await Promise.all([
      reader.repoTerms(repoId),
      reader.bindingDelaySeconds(),
      reader.routerBalance(),
      reader.now(),
    ]);
    loadFailed = false;
  } catch {
    loadFailed = true;
  }
  paint();
  if (!loadFailed && terms?.active) void loadBounties();
  if (!loadFailed && terms && (terms.active || terms.pending)) await loadHistory();
}

/** The Binding Maintainer's Bounty wallet, its figures and its Bounties. */
async function loadBounties(): Promise<void> {
  if (!bountyReader || !repoId || !terms) return;
  bountyFailed = false;
  bountyWallet = undefined;
  paint();
  try {
    const address = await bountyReader.repoWallet(repoId, terms);
    if (!address) bountyWallet = null;
    else {
      const [state, rows] = await Promise.all([bountyReader.state(address), bountyReader.bounties(address)]);
      bountyWallet = { state, rows };
    }
  } catch {
    bountyFailed = true;
  }
  paint();
}

async function loadHistory(): Promise<void> {
  if (!repoId) return;
  historyFailed = false;
  historyProgress = 0;
  paint();
  try {
    history = await readRepoHistory({
      client,
      network,
      repoId,
      onProgress: (done, total) => {
        historyProgress = done / total;
        paint();
      },
    });
  } catch {
    historyFailed = true;
  }
  paint();
}

async function refundRow(key: Hex): Promise<void> {
  const row = history?.deposits.find((d) => d.key === key && d.status === "active");
  if (!row || busy.has(`refund:${key}`)) return;
  actionNote = "";
  if (!(await readyWallet(session, (note) => ((actionNote = note), paint())))) return;
  const account = session.account!;
  const call = { address: network.escrow, abi: escrowAbi, functionName: "refund", args: [key] } as const;
  busy.add(`refund:${key}`);
  paint();
  try {
    await client.simulateContract({ ...call, account });
    const hash = await sendContractCall(session.wallet!.provider, account, chain, call);
    const receipt = await client.waitForTransactionReceipt({ hash, pollingInterval: 1000 });
    if (receipt.status !== "success") throw new Error("reverted");
    row.status = "refunded";
    row.refund = { at: chainNow, afterTimeout: true, txHash: hash };
    refundSent = { row, txHash: hash };
  } catch (error) {
    const reason = revertReason(error);
    actionNote =
      reason === "DepositNotActive"
        ? `The Deposit for ${itemName(row.kind, row.number)} was already refunded.`
        : reason
          ? `The Refund would fail (${reason}), so nothing was sent.`
          : walletFailure(error, "Refund");
    if (reason === "DepositNotActive") void loadHistory();
  } finally {
    busy.delete(`refund:${key}`);
    paint();
  }
}

async function flush(): Promise<void> {
  if (busy.has("flush")) return;
  actionNote = "";
  if (!(await readyWallet(session, (note) => ((actionNote = note), paint())))) return;
  const account = session.account!;
  const call = { address: network.router, abi: routerAbi, functionName: "flush", args: [] } as const;
  busy.add("flush");
  paint();
  try {
    await client.simulateContract({ ...call, account });
    const hash = await sendContractCall(session.wallet!.provider, account, chain, call);
    const receipt = await client.waitForTransactionReceipt({ hash, pollingInterval: 1000 });
    if (receipt.status !== "success") throw new Error("reverted");
    const [event] = parseEventLogs({ abi: routerAbi, logs: receipt.logs, eventName: "Flushed" });
    flushed = { amount: event?.args.amount ?? routerBalance ?? 0n, txHash: hash };
    if (history) history.flushes = { total: history.flushes.total + flushed.amount, count: history.flushes.count + 1 };
  } catch (error) {
    const reason = revertReason(error);
    actionNote =
      reason === "NothingToFlush"
        ? "There's nothing to send: someone just sent it."
        : reason
          ? `Sending would fail (${reason}), so nothing was sent.`
          : walletFailure(error, "transaction");
  } finally {
    busy.delete("flush");
    routerBalance = await reader.routerBalance().catch(() => routerBalance);
    paint();
  }
}

onAction((action, element) => {
  if (action === "reload") return location.reload();
  if (action === "reload-history") return void loadHistory();
  if (action === "reload-decisions") return void loadDecisions();
  if (action === "reload-bounties") return void loadBounties();
  if (action === "show-all") {
    showAll = true;
    return paint();
  }
  if (action === "flush") return void flush();
  if (action === "refund-row" && element.dataset.key) return void refundRow(element.dataset.key as Hex);
});

if (repo) document.title = `${repo} · Bona Fide Deposits`;
paint();
void load();
void loadDecisions();
