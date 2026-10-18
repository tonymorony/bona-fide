import {
  depositAuthorization,
  escrowAbi,
  keyOf,
  kindCode,
  repoIdOf,
  usdcAbi,
  type SignedDepositTerms,
} from "@bona-fide/sdk";
import { parseEventLogs, type Hex } from "viem";
import type { DepositState, RepoTerms, Terms } from "../chain.ts";
import { depositRelayBody, relayDeposit } from "../endpoints.ts";
import { forfeitSplit, shortAddress, timeout, usdc, usdcAmount } from "../format.ts";
import { explorerAddress, explorerTx, itemName, itemUrl, readItemLink, repoPageUrl } from "../link.ts";
import { WINDOWS } from "../windows.ts";
import { focusState, newView, onAction, render } from "../ui/dom.ts";
import { isUndeployedSmartWalletSignature, isUserRejection, sendContractCall, signTypedData } from "../wallet.ts";
import {
  chain,
  client,
  describeWallet,
  network,
  randomBytes32,
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
const repoId = item && repoIdOf(item.repo);
const key = item && repoId && keyOf(repoId, item.kind, item.number);

/** A step of the payment that outlives a re-read of the chain. */
type Phase =
  | "idle"
  | "signing"
  | "submitted"
  | "unconfirmed"
  | "two-step-approve"
  | "two-step-deposit"
  | "expired"
  | "cant-sign"
  | "problem"
  | "confirmed"
  | "refunded";

interface Problem {
  title: string;
  body: string;
  detail?: string;
  txHash?: Hex | null;
  /** A button that runs `action`; `until` keeps it disabled for a countdown. */
  retry?: { label: string; action: string; until?: number };
  /** A link to the two transactions path under the button. */
  offerTwoStep?: boolean;
  /** The two transactions path is the way on. */
  twoStepOnly?: boolean;
}

let terms: RepoTerms | null = null;
let current: DepositState | null = null;
let chainNow = new Date();
let loadFailed = false;
let balance: bigint | null = null;
let phase: Phase = "idle";
let problem: Problem | null = null;
let signing: { validBefore: bigint; value: bigint } | null = null;
let attempt = 0;
let txHash: Hex | null = null;
let approveTx: Hex | null = null;
let approvedBefore = false;
let amountChanged = false;
let relayOn = true;
let stillChecking = true;
const notes = { ready: "", twoStep: "", network: "", refund: "" };
const busy = new Set<string>();
let shownState = "";

const session = startSession(() => {
  if (!session.account || !session.onNetwork) balance = null;
  if (["two-step-approve", "two-step-deposit", "expired", "cant-sign", "problem"].includes(phase)) phase = "idle";
  notes.network = "";
  paint();
  void loadBalance();
});

/** The terms the rules show: the active ones, or the ones about to start. */
function shownTerms(): Terms | null {
  return terms?.active ?? terms?.pending ?? null;
}

function stateNow(): string {
  if (!item) return "bad-link";
  if (loadFailed) return "chain-error";
  if (!terms || !current) return "loading";
  if (phase !== "idle") return phase;
  if (current.status === "active") return chainNow >= current.deadline ? "timed-out" : "already-active";
  if (!terms.active) return terms.pending ? "not-live" : "not-set-up";
  if (!session.account) return "not-connected";
  if (!session.onNetwork) return "wrong-network";
  if (balance !== null && balance < terms.active.amount) return "low-balance";
  return "ready";
}

function paint(): void {
  const state = stateNow();
  const view = newView(state);
  describeWallet(view, session, balance);
  if (item) {
    view.flags["repo-known"] = true;
    view.text.repo = item.repo;
    view.text.item = itemName(item.kind, item.number);
    view.text.Item = itemName(item.kind, item.number, { capital: true });
    view.hrefs["item-url"] = itemUrl(item);
    view.hrefs["repo-page"] = repoPageUrl(item.repo);
  }
  const shown = shownTerms();
  if (shown) {
    const split = forfeitSplit(shown.amount, shown.forfeitBps);
    view.text.amount = usdc(shown.amount);
    view.text["amount-number"] = usdcAmount(shown.amount);
    view.text.timeout = timeout(shown.timeoutSeconds);
    view.text.forfeited = usdc(split.forfeited);
    view.text["refunded-after-forfeit"] = usdc(split.refunded);
    view.flags.forfeits = shown.forfeitBps > 0;
  }
  if (terms?.pending) {
    view.times["starts-at"] = terms.pending.effectiveAt;
    view.times["new-terms-at"] = terms.pending.effectiveAt;
    view.flags["new-terms"] = terms.active !== null;
  }
  if (balance !== null && terms?.active && balance < terms.active.amount) {
    view.text.shortfall = usdc(terms.active.amount - balance);
  }
  if (current && current.status !== "none") {
    view.text["deposit-amount"] = usdc(current.amount);
    view.text["depositor-short"] = shortAddress(current.depositor);
    view.hrefs["depositor-url"] = explorerAddress(network, current.depositor);
    view.times.deadline = current.deadline;
    view.flags["paid-by-another"] = session.account !== null && !sameAddress(session.account, current.depositor);
  }
  if (signing) {
    view.text["escrow-short"] = shortAddress(network.escrow);
    view.text["value-units"] = signing.value.toString();
    view.text["valid-before-unix"] = signing.validBefore.toString();
    view.times["valid-before"] = new Date(Number(signing.validBefore) * 1000);
  }
  if (txHash) {
    view.flags.tx = true;
    view.hrefs["tx-url"] = explorerTx(network, txHash);
    view.text["tx-short"] = shortAddress(txHash);
  }
  if (approveTx) {
    view.flags["approve-tx"] = true;
    view.hrefs["approve-tx-url"] = explorerTx(network, approveTx);
    view.text["approve-tx-short"] = shortAddress(approveTx);
  }
  view.flags["approved-before"] = approvedBefore;
  view.flags["amount-changed"] = amountChanged;
  view.flags.relay = relayOn;
  view.flags["still-checking"] = stillChecking;
  view.flags["gave-up"] = !stillChecking;
  for (const [name, note] of [
    ["ready-note", notes.ready],
    ["two-step-note", notes.twoStep],
    ["network-note", notes.network],
    ["refund-note", notes.refund],
  ] as const) {
    view.text[name] = note;
    view.flags[name] = note !== "";
  }
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
    view.flags["offer-two-step"] = !!problem.offerTwoStep && !problem.twoStepOnly;
    view.flags["two-step-only"] = !!problem.twoStepOnly;
  }
  if (state === "ready" && balance === null) view.disabled.add("sign");
  for (const action of busy) view.busy.add(action);
  render(view);
  if (shownState && shownState !== state) focusState();
  shownState = state;
}

async function load(): Promise<void> {
  if (!item || !repoId || !key) return paint();
  try {
    [terms, current, chainNow] = await Promise.all([reader.repoTerms(repoId), reader.depositOf(key), reader.now()]);
    loadFailed = false;
  } catch {
    loadFailed = true;
  }
  paint();
}

async function loadBalance(): Promise<void> {
  const account = session.account;
  if (!account) return;
  const read = await reader.usdcBalance(account).catch(() => null);
  if (session.account === account) {
    balance = read;
    paint();
  }
}

function showProblem(next: Problem): void {
  phase = "problem";
  problem = next;
  paint();
}

async function confirmed(hash: Hex): Promise<void> {
  txHash = hash;
  current = await reader.depositOf(key!).catch(() => current);
  phase = "confirmed";
  paint();
}

async function signAndDeposit(): Promise<void> {
  const active = terms?.active;
  if (!item || !active || !(await readyWallet(session, (note) => ((notes.ready = note), paint())))) return;
  const account = session.account!;
  const run = ++attempt;
  notes.ready = "";
  amountChanged = false;
  const deposit: SignedDepositTerms = {
    chainId: network.chainId,
    usdc: network.usdc,
    escrow: network.escrow,
    repo: item.repo,
    kind: item.kind,
    number: item.number,
    from: account,
    value: active.amount,
    salt: randomBytes32(),
    validBefore: unixSeconds(await reader.now().catch(() => new Date())) + BigInt(WINDOWS.deposit),
  };
  signing = { validBefore: deposit.validBefore, value: deposit.value };
  phase = "signing";
  paint();
  let signature: Hex;
  try {
    signature = await signTypedData(session.wallet!.provider, account, depositAuthorization(deposit));
  } catch (error) {
    if (run !== attempt) return;
    phase = "idle";
    notes.ready = isUserRejection(error)
      ? "You cancelled the signature. Nothing was sent."
      : "Your wallet couldn't sign. Try again, or pay with two transactions instead.";
    return paint();
  }
  if (run !== attempt) return;
  if (isUndeployedSmartWalletSignature(signature)) {
    phase = "cant-sign";
    return paint();
  }
  phase = "submitted";
  paint();
  await settleRelay(await relayDeposit(depositRelayBody(deposit, signature), pageFetch));
}

async function settleRelay(outcome: Awaited<ReturnType<typeof relayDeposit>>): Promise<void> {
  const noUsdcLeft = "Nothing was paid, and no USDC left your wallet.";
  switch (outcome.kind) {
    case "deposited":
      return confirmed(outcome.txHash);
    case "amount-changed":
      await load();
      amountChanged = true;
      phase = "idle";
      await loadBalance();
      return paint();
    case "already-paid":
      phase = "idle";
      return load();
    case "conflict":
      await load();
      if (current?.status === "active" || !terms?.active) {
        phase = "idle";
        return paint();
      }
      return showProblem({
        title: `A Deposit for ${itemName(item!.kind, item!.number)} is on its way`,
        body: `Someone's Deposit for it is being sent right now. ${noUsdcLeft} Wait a moment, then check again.`,
        retry: { label: "Check again", action: "reload-state" },
      });
    case "expired":
      phase = "expired";
      return paint();
    case "low-balance":
      phase = "idle";
      await loadBalance();
      return paint();
    case "bad-signature":
      return showProblem({
        title: "USDC didn't accept this signature",
        body: `This happens with smart wallets that haven't made a transaction on ${network.name} yet. ${noUsdcLeft}`,
        detail: outcome.message,
        twoStepOnly: true,
      });
    case "would-fail":
      return showProblem({
        title: "The Deposit would fail",
        body: `Bona Fide checked it before sending. ${noUsdcLeft}`,
        detail: outcome.message,
        retry: { label: "Sign again", action: "sign" },
        offerTwoStep: true,
      });
    case "wait":
      return showProblem({
        title: "Deposit not sent yet",
        body: outcome.paused
          ? `Bona Fide paused Deposits for ${itemName(item!.kind, item!.number)}, or from this wallet, after one failed on-chain. ${noUsdcLeft}`
          : `Bona Fide is getting too many requests from your connection right now. ${noUsdcLeft}`,
        retry: { label: "Try again", action: "sign", until: Date.now() + outcome.seconds * 1000 },
        offerTwoStep: true,
      });
    case "reverted":
      return showProblem({
        title: "The Deposit failed on-chain",
        body: `The transaction reverted, so no Deposit was made and no USDC left your wallet. You can try again in 10 minutes, or pay with two transactions now.`,
        txHash: outcome.txHash,
        twoStepOnly: true,
      });
    case "unconfirmed":
      txHash = outcome.txHash;
      phase = "unconfirmed";
      stillChecking = true;
      paint();
      return watchUnconfirmed(outcome.txHash);
    case "no-relay":
      relayOn = false;
      return showProblem({
        title: "One-signature Deposits are off here",
        body: `This Bona Fide server doesn't send signed Deposits. ${noUsdcLeft} Pay with two transactions from your wallet instead.`,
        twoStepOnly: true,
      });
    case "too-large":
      return showProblem({
        title: "The signature is too large to send",
        body: `Your wallet's signature is larger than Bona Fide accepts. ${noUsdcLeft}`,
        twoStepOnly: true,
      });
    case "invalid":
      return showProblem({
        title: "Deposit not sent",
        body: `Bona Fide couldn't read the request. ${noUsdcLeft} Reload the page and try again.`,
        detail: outcome.message,
        retry: { label: "Reload the page", action: "reload" },
      });
    case "unavailable":
      return showProblem({
        title: "Deposit not sent",
        body: `Bona Fide couldn't be reached, or couldn't reach ${network.name}. ${noUsdcLeft} Try again in a minute.`,
        retry: { label: "Try again", action: "sign" },
        offerTwoStep: true,
      });
  }
}

/** A relayed Deposit that was sent but not confirmed: wait for it rather than sign again. */
async function watchUnconfirmed(hash: Hex): Promise<void> {
  const receipt = await client
    .waitForTransactionReceipt({ hash, pollingInterval: 2000, timeout: 120_000 })
    .catch(() => null);
  if (phase !== "unconfirmed" || txHash !== hash) return;
  if (receipt?.status === "success") return confirmed(hash);
  if (receipt) {
    return showProblem({
      title: "The Deposit failed on-chain",
      body: "The transaction reverted, so no Deposit was made and no USDC left your wallet.",
      txHash: hash,
      twoStepOnly: true,
    });
  }
  stillChecking = false;
  paint();
}

async function checkDeposit(): Promise<void> {
  if (!txHash) return;
  const receipt = await client.getTransactionReceipt({ hash: txHash }).catch(() => null);
  if (receipt?.status === "success") return confirmed(txHash);
  stillChecking = true;
  paint();
  return watchUnconfirmed(txHash);
}

async function startTwoStep(): Promise<void> {
  if (!terms?.active) return;
  problem = null;
  approveTx = null;
  approvedBefore = false;
  notes.twoStep = "";
  if (!(await readyWallet(session, (note) => ((notes.ready = note), paint())))) return;
  phase = "two-step-approve";
  paint();
  const allowance = await reader.allowance(session.account!).catch(() => 0n);
  if (phase === "two-step-approve" && allowance >= terms.active.amount) {
    approvedBefore = true;
    phase = "two-step-deposit";
    paint();
  }
}

async function sendStep(action: "approve" | "deposit"): Promise<void> {
  const active = terms?.active;
  if (!item || !active || busy.size > 0) return;
  if (!(await readyWallet(session, (note) => ((notes.twoStep = note), paint())))) return;
  const account = session.account!;
  const call =
    action === "approve"
      ? ({
          address: network.usdc,
          abi: usdcAbi,
          functionName: "approve",
          args: [network.escrow, active.amount],
        } as const)
      : ({
          address: network.escrow,
          abi: escrowAbi,
          functionName: "deposit",
          args: [repoId!, kindCode(item.kind), BigInt(item.number)],
        } as const);
  busy.add(action);
  notes.twoStep = "";
  paint();
  try {
    await client.simulateContract({ ...call, account } as Parameters<typeof client.simulateContract>[0]);
  } catch (error) {
    busy.delete(action);
    return stepRefused(action, revertReason(error));
  }
  try {
    const hash = await sendContractCall(session.wallet!.provider, account, chain, call as any);
    const receipt = await client.waitForTransactionReceipt({ hash, pollingInterval: 1000 });
    busy.delete(action);
    if (receipt.status !== "success") {
      notes.twoStep = `The ${action === "approve" ? "approval" : "Deposit"} reverted on-chain. Try again.`;
      return paint();
    }
    if (action === "approve") {
      approveTx = hash;
      phase = "two-step-deposit";
      return paint();
    }
    const [made] = parseEventLogs({ abi: escrowAbi, logs: receipt.logs, eventName: "Deposited" });
    return confirmed(made?.transactionHash ?? hash);
  } catch (error) {
    busy.delete(action);
    notes.twoStep = walletFailure(error, action === "approve" ? "approval" : "Deposit");
    paint();
  }
}

async function stepRefused(action: "approve" | "deposit", reason: string | null): Promise<void> {
  await load();
  if (current?.status === "active" || !terms?.active) {
    phase = "idle";
    return paint();
  }
  if (action === "deposit" && /allowance/i.test(reason ?? "")) {
    amountChanged = true;
    phase = "two-step-approve";
    approveTx = null;
    notes.twoStep = `The escrow may take less than ${usdc(terms.active.amount)} from this wallet. Approve it again.`;
    return paint();
  }
  if (/balance/i.test(reason ?? "")) {
    phase = "idle";
    await loadBalance();
    return paint();
  }
  notes.twoStep = `This ${action === "approve" ? "approval" : "Deposit"} would fail (${reason ?? "no reason given"}), so nothing was sent.`;
  paint();
}

async function refund(): Promise<void> {
  if (!current || busy.has("refund")) return;
  if (!(await readyWallet(session, (note) => ((notes.refund = note), paint())))) return;
  const account = session.account!;
  const call = { address: network.escrow, abi: escrowAbi, functionName: "refund", args: [key!] } as const;
  busy.add("refund");
  notes.refund = "";
  paint();
  try {
    await client.simulateContract({ ...call, account });
  } catch (error) {
    busy.delete("refund");
    const reason = revertReason(error);
    await load();
    notes.refund =
      reason === "DepositNotActive"
        ? "This Deposit was already refunded."
        : `The Refund would fail (${reason ?? "no reason given"}), so nothing was sent.`;
    return paint();
  }
  try {
    const hash = await sendContractCall(session.wallet!.provider, account, chain, call);
    const receipt = await client.waitForTransactionReceipt({ hash, pollingInterval: 1000 });
    busy.delete("refund");
    if (receipt.status !== "success") {
      notes.refund = "The Refund reverted on-chain. Try again.";
      return paint();
    }
    txHash = hash;
    phase = "refunded";
    paint();
  } catch (error) {
    busy.delete("refund");
    notes.refund = walletFailure(error, "Refund");
    paint();
  }
}

function act(action: string): void {
  if (action === "reload") return location.reload();
  if (action === "reload-state") {
    phase = "idle";
    problem = null;
    return void load();
  }
  if (action === "connect") return void session.connect();
  if (action === "switch-network") return void readyWallet(session, (note) => ((notes.network = note), paint()));
  if (action === "check-balance") return void loadBalance();
  if (action === "sign") {
    problem = null;
    return void signAndDeposit();
  }
  if (action === "cancel-signing") {
    attempt++;
    phase = "idle";
    notes.ready = "Nothing was signed. If your wallet still shows the request, reject it there.";
    return paint();
  }
  if (action === "two-step") return void startTwoStep();
  if (action === "one-signature") {
    phase = "idle";
    return paint();
  }
  if (action === "approve" || action === "deposit") return void sendStep(action);
  if (action === "check-deposit") return void checkDeposit();
  if (action === "refund") return void refund();
}

onAction((action) => act(action === "retry" ? (problem?.retry?.action ?? "sign") : action));

if (item) {
  for (const el of document.querySelectorAll<HTMLElement>("[data-kind]")) {
    if (el.dataset.kind !== item.kind) el.remove();
  }
  document.title = `Deposit for ${itemName(item.kind, item.number)} in ${item.repo} · Bona Fide`;
}
setInterval(() => {
  if (phase === "problem" && problem?.retry?.until) paint();
}, 1000);
paint();
void load();
