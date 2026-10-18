import { escrowAbi, forfeitVerdict, keyOf, repoIdOf } from "@bona-fide/sdk";
import { parseEventLogs, type Hex } from "viem";
import type { DepositState } from "../chain.ts";
import { forfeitBody, sendVerdict } from "../endpoints.ts";
import { forfeitSplit, percent, shortAddress, timeLeft, usdc } from "../format.ts";
import { explorerTx, itemName, itemUrl, readItemLink, repoPageUrl } from "../link.ts";
import { WINDOWS } from "../windows.ts";
import { focusState, newView, onAction, render } from "../ui/dom.ts";
import { isUndeployedSmartWalletSignature, isUserRejection, sendContractCall, signTypedData } from "../wallet.ts";
import {
  chain,
  client,
  describeWallet,
  network,
  reader,
  readyWallet,
  revertReason,
  sameAddress,
  pageFetch,
  secondsUntil,
  startSession,
  unixSeconds,
  walletFailure,
} from "./common.ts";

const item = readItemLink(location.search);
const key = item && keyOf(repoIdOf(item.repo), item.kind, item.number);

type Phase = "idle" | "signing" | "sending" | "done" | "problem" | "refunded";

interface Problem {
  title: string;
  body: string;
  detail?: string;
  txHash?: Hex;
  retry?: { label: string; until?: number };
}

let deposit: DepositState | null = null;
let chainNow = new Date();
let loadFailed = false;
let phase: Phase = "idle";
let problem: Problem | null = null;
let attempt = 0;
let txHash: Hex | null = null;
let result: { forfeited: bigint; refunded: bigint } | null = null;
let note = "";
const busy = new Set<string>();
let shownState = "";
const confirmBox = document.querySelector<HTMLInputElement>("[data-confirm]")!;

const session = startSession(() => {
  note = "";
  if (phase === "problem") phase = "idle";
  paint();
});

function stateNow(): string {
  if (!item) return "bad-link";
  if (loadFailed) return "chain-error";
  if (!deposit) return "loading";
  if (phase !== "idle") return phase;
  if (deposit.status === "none") return "no-deposit";
  if (deposit.status !== "active") return "resolved";
  if (chainNow >= deposit.deadline) return "too-late";
  if (!session.account) return "not-connected";
  if (!session.onNetwork) return "wrong-network";
  if (!sameAddress(session.account, deposit.maintainer)) return "wrong-wallet";
  return "ready";
}

function paint(): void {
  const state = stateNow();
  const view = newView(state);
  describeWallet(view, session);
  if (item) {
    view.flags["item-known"] = true;
    view.text.repo = item.repo;
    view.text.item = itemName(item.kind, item.number);
    view.text.Item = itemName(item.kind, item.number, { capital: true });
    view.hrefs["item-url"] = itemUrl(item);
    view.hrefs["repo-page"] = repoPageUrl(item.repo);
  }
  if (deposit && deposit.status !== "none") {
    const split = result ?? forfeitSplit(deposit.amount, deposit.forfeitBps);
    view.text.amount = usdc(deposit.amount);
    view.text.depositor = deposit.depositor;
    view.text["depositor-short"] = shortAddress(deposit.depositor);
    view.text.serial = deposit.serial.toString();
    view.text.maintainer = deposit.maintainer;
    view.text["maintainer-short"] = shortAddress(deposit.maintainer);
    view.text.forfeited = usdc(split.forfeited);
    view.text.refunded = usdc(split.refunded);
    view.text.resolution = deposit.status;
    view.times.deadline = deposit.deadline;
    view.text["time-left"] = timeLeft(Math.max(0, (deposit.deadline.getTime() - chainNow.getTime()) / 1000));
    const shown = ["not-connected", "wrong-network", "wrong-wallet", "ready", "signing", "sending", "problem"];
    view.flags["deposit-shown"] = shown.includes(state) || state === "too-late";
    view.flags["split-shown"] = shown.includes(state);
    drawSplit(deposit.forfeitBps, split);
  }
  if (txHash) {
    view.hrefs["tx-url"] = explorerTx(network, txHash);
    view.text["tx-short"] = shortAddress(txHash);
  }
  view.text.note = note;
  view.flags.note = note !== "";
  if (problem) {
    view.text["problem-title"] = problem.title;
    view.text["problem-body"] = problem.body;
    view.text["problem-detail"] = problem.detail ?? "";
    view.flags["problem-detail"] = !!problem.detail;
    view.flags["problem-tx"] = !!problem.txHash;
    if (problem.txHash) view.hrefs["problem-tx-url"] = explorerTx(network, problem.txHash);
    view.flags.retry = !!problem.retry;
    if (problem.retry) {
      const wait = problem.retry.until ? secondsUntil(problem.retry.until) : 0;
      view.text["retry-label"] = wait > 0 ? `${problem.retry.label} in ${wait} s` : problem.retry.label;
      if (wait > 0) view.disabled.add("retry");
    }
  }
  if (!confirmBox.checked) view.disabled.add("sign");
  for (const action of busy) view.busy.add(action);
  render(view);
  if (shownState && shownState !== state) focusState();
  shownState = state;
}

function drawSplit(forfeitBps: number, split: { forfeited: bigint; refunded: bigint }): void {
  const fund = document.querySelector<HTMLElement>('[data-split="fund"]')!;
  const back = document.querySelector<HTMLElement>('[data-split="depositor"]')!;
  fund.style.width = percent(forfeitBps);
  back.style.width = percent(10_000 - forfeitBps);
  document
    .querySelector("[data-split-label]")!
    .setAttribute(
      "aria-label",
      `${usdc(split.forfeited)} ${network.forfeits.purpose}, and ${usdc(split.refunded)} is refunded`,
    );
}

async function load(): Promise<void> {
  if (!key) return paint();
  try {
    [deposit, chainNow] = await Promise.all([reader.depositOf(key), reader.now()]);
    loadFailed = false;
  } catch {
    loadFailed = true;
  }
  paint();
}

function showProblem(next: Problem): void {
  phase = "problem";
  problem = next;
  paint();
}

async function sign(): Promise<void> {
  if (!item || !key || !deposit || !confirmBox.checked) return;
  if (!(await readyWallet(session, (text) => ((note = text), paint())))) return;
  if (!sameAddress(session.account, deposit.maintainer)) return paint();
  const account = session.account!;
  const run = ++attempt;
  note = "";
  const sigDeadline = unixSeconds(await reader.now().catch(() => new Date())) + BigInt(WINDOWS.verdict);
  phase = "signing";
  paint();
  let signature: Hex;
  try {
    signature = await signTypedData(
      session.wallet!.provider,
      account,
      forfeitVerdict({ chainId: network.chainId, escrow: network.escrow, key, serial: deposit.serial, sigDeadline }),
    );
  } catch (error) {
    if (run !== attempt) return;
    phase = "idle";
    note = isUserRejection(error)
      ? "You cancelled the signature. Nothing was sent."
      : "Your wallet couldn't sign. Try again.";
    return paint();
  }
  if (run !== attempt) return;
  if (isUndeployedSmartWalletSignature(signature)) {
    return showProblem({
      title: "This wallet can't sign the verdict yet",
      body: `It's a smart wallet that hasn't made a transaction on ${network.name}, and the escrow can only check signatures from wallets that have. Make any transaction from it on ${network.name}, then sign again.`,
      retry: { label: "Sign again" },
    });
  }
  phase = "sending";
  paint();
  const outcome = await sendVerdict(
    forfeitBody({ repo: item.repo, kind: item.kind, number: item.number, sigDeadline, signature }),
    pageFetch,
  );
  switch (outcome.kind) {
    case "forfeited": {
      txHash = outcome.txHash;
      const receipt = await client.getTransactionReceipt({ hash: outcome.txHash }).catch(() => null);
      const [event] = receipt ? parseEventLogs({ abi: escrowAbi, logs: receipt.logs, eventName: "Forfeited" }) : [];
      if (event) result = { forfeited: event.args.forfeited, refunded: event.args.refunded };
      phase = "done";
      return paint();
    }
    case "refused":
      if (outcome.status === 400) {
        return showProblem({
          title: "Bona Fide didn't send the verdict",
          body: "Nothing was forfeited.",
          detail: outcome.message,
          retry: { label: "Sign again" },
        });
      }
      phase = "idle";
      await load();
      if (stateNow() === "ready") {
        showProblem({
          title: "Bona Fide didn't send the verdict",
          body: "Nothing was forfeited.",
          detail: outcome.message,
        });
      }
      return;
    case "wait":
      return showProblem({
        title: "Verdict not sent yet",
        body: outcome.paused
          ? "Bona Fide paused verdicts for this Deposit after one failed on-chain. Nothing was forfeited."
          : "Bona Fide is getting too many requests from your connection right now. Nothing was forfeited.",
        retry: { label: "Sign again", until: Date.now() + outcome.seconds * 1000 },
      });
    case "reverted":
      return showProblem({
        title: "The verdict failed on-chain",
        body: "The transaction reverted, so nothing was forfeited. Try again in 10 minutes.",
        txHash: outcome.txHash,
        retry: { label: "Sign again", until: Date.now() + 10 * 60_000 },
      });
    case "too-large":
      return showProblem({
        title: "The signature is too large to send",
        body: "Your wallet's signature is larger than Bona Fide accepts. Nothing was forfeited.",
      });
    case "unavailable":
      return showProblem({
        title: "Verdict not sent",
        body: `Bona Fide couldn't be reached, or couldn't reach ${network.name}. Nothing was forfeited. Try again in a minute.`,
        retry: { label: "Sign again" },
      });
  }
}

async function refund(): Promise<void> {
  if (!key || !deposit || busy.has("refund")) return;
  if (!(await readyWallet(session, (text) => ((note = text), paint())))) return;
  const account = session.account!;
  const call = { address: network.escrow, abi: escrowAbi, functionName: "refund", args: [key] } as const;
  busy.add("refund");
  note = "";
  paint();
  try {
    await client.simulateContract({ ...call, account });
  } catch (error) {
    busy.delete("refund");
    const reason = revertReason(error);
    await load();
    note =
      reason === "DepositNotActive"
        ? ""
        : `The Refund would fail (${reason ?? "no reason given"}), so nothing was sent.`;
    return paint();
  }
  try {
    const hash = await sendContractCall(session.wallet!.provider, account, chain, call);
    const receipt = await client.waitForTransactionReceipt({ hash, pollingInterval: 1000 });
    busy.delete("refund");
    if (receipt.status !== "success") {
      note = "The Refund reverted on-chain. Try again.";
      return paint();
    }
    txHash = hash;
    phase = "refunded";
    paint();
  } catch (error) {
    busy.delete("refund");
    note = walletFailure(error, "Refund");
    paint();
  }
}

onAction((action) => {
  if (action === "reload") return location.reload();
  if (action === "connect") return void session.connect();
  if (action === "switch-network") return void readyWallet(session, (text) => ((note = text), paint()));
  if (action === "sign" || action === "retry") {
    problem = null;
    phase = "idle";
    return void sign();
  }
  if (action === "cancel-signing") {
    attempt++;
    phase = "idle";
    note = "Nothing was signed. If your wallet still shows the request, reject it there.";
    return paint();
  }
  if (action === "refund") return void refund();
});

confirmBox.addEventListener("change", () => paint());
if (item)
  document.title = `Sign a bad-faith verdict for ${itemName(item.kind, item.number)} in ${item.repo} · Bona Fide`;
setInterval(() => {
  if (phase === "problem" && problem?.retry?.until) paint();
}, 1000);
paint();
void load();
