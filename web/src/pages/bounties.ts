import {
  bountyFundAuthorization,
  keeperLimitFor,
  payeeProblem,
  payoutSignature,
  repoIdOf,
  usdcAbi,
  type BountyState,
  type BountyWalletState,
} from "@bona-fide/sdk";
import type { Address, Hex } from "viem";
import {
  bountyCalls,
  createBountyReader,
  DEFAULT_LIMITS,
  hasBounties,
  PERIOD_LENGTHS,
  type BountyLimits,
  type BountyRow,
} from "../bounty.ts";
import type { RepoTerms } from "../chain.ts";
import { payoutBody, relayPayout, type PayoutOutcome } from "../endpoints.ts";
import { parseUsdc, shortAddress, timeLeft, usdc, usdcAmount } from "../format.ts";
import { explorerAddress, explorerTx, itemUrl, readPayee, readPayoutLink, readRepoLink, repoPageUrl } from "../link.ts";
import { WINDOWS } from "../windows.ts";
import { drawBountyRows } from "../ui/bounty-rows.ts";
import { focusState, newView, onAction, render } from "../ui/dom.ts";
import { isUndeployedSmartWalletSignature, isUserRejection, sendContractCall, signTypedData } from "../wallet.ts";
import {
  chain,
  client,
  describeWallet,
  network,
  pageFetch,
  randomBytes32,
  reader,
  readyWallet,
  revertReason,
  sameAddress,
  startSession,
  unixSeconds,
  walletFailure,
} from "./common.ts";

const repo = readRepoLink(location.search);
const repoId = repo ? repoIdOf(repo) : null;
const payoutLink = readPayoutLink(location.search);
const payout = typeof payoutLink === "object" ? payoutLink : null;
/** Who the Payout goes to: from the link, or entered here when the App knew no wallet for the Contributor. */
let payee: Address | null = payout?.payee ?? null;
const factory = hasBounties(network) ? network.bountyFactory : null;
const bounties = hasBounties(network) ? createBountyReader(client, network) : null;

/** What a card says under its button: a transaction on its way, one that went through, or why nothing was sent. */
type Activity =
  { kind: "pending"; tx: Hex } | { kind: "done"; text: string; tx: Hex } | { kind: "note"; text: string; tx?: Hex };

/** Where the signed Payout is: being signed, sent to the Keeper, or back with the Maintainer after the Keeper didn't send it. */
type PayPhase = "idle" | "signing" | "relaying" | "relay-failed";

let terms: RepoTerms | null = null;
let loadFailed = false;
/** The repo's Bounty wallet: undefined until read, null when the Maintainer has none. */
let walletAddress: Address | null | undefined;
let wallet: BountyWalletState | null = null;
let rows: BountyRow[] | null = null;
let rowsProgress = 0;
let rowsFailed = false;
let linked: BountyState | null = null;
let balance: bigint | null = null;
let payPhase: PayPhase = "idle";
let signed: { deadline: bigint; signature: Hex; serial: bigint; payee: Address } | null = null;
let signingDeadline: bigint | null = null;
let relayProblem: { title: string; body: string; detail?: string } | null = null;
let attempt = 0;
let limitsFilled = false;
let note = "";
let shownState = "";
const activity: Record<string, Activity | undefined> = {};
const busy = new Set<string>();
const rowsBody = document.querySelector<HTMLTableSectionElement>("[data-bounty-rows]")!;
const rowTemplate = document.querySelector<HTMLTemplateElement>("template[data-bounty-row]")!;

const session = startSession(() => {
  note = "";
  if (!session.account || !session.onNetwork) balance = null;
  paint();
  void loadBalance();
});

const maintainer = (): Address | null => terms?.active?.maintainer ?? null;
const isMaintainer = () => sameAddress(session.account, maintainer());

function stateNow(): string {
  if (!repo) return "bad-link";
  if (!bounties) return "no-factory";
  if (loadFailed) return "chain-error";
  if (!terms) return "loading";
  if (!terms.active) return "not-set-up";
  if (walletAddress === undefined || (walletAddress && !wallet)) return "loading";
  if (!session.account) return walletAddress ? "view" : "no-wallet";
  if (!session.onNetwork) return "wrong-network";
  if (!isMaintainer()) return "wrong-wallet";
  return walletAddress ? "manage" : "create";
}

function paint(): void {
  const state = stateNow();
  const view = newView(state);
  describeWallet(view, session, balance);
  view.flags["repo-known"] = repo !== null;
  if (repo) {
    view.text.repo = repo;
    view.hrefs["repo-url"] = `https://github.com/${repo}`;
    view.hrefs["repo-page"] = repoPageUrl(repo);
    view.hrefs["setup-page"] = `setup.html?${new URLSearchParams({ repo })}`;
  }
  const bound = maintainer();
  if (bound) view.text["maintainer-short"] = shortAddress(bound);
  view.flags["payout-link-broken"] = payoutLink === "invalid" && !["bad-link", "no-factory"].includes(state);
  view.text.note = note;
  view.flags.note = note !== "";

  const shown = !["loading", "bad-link", "no-factory", "chain-error", "not-set-up"].includes(state);
  if (wallet && shown) {
    view.flags["wallet-known"] = true;
    view.text["wallet-short"] = shortAddress(wallet.address);
    view.hrefs["wallet-url"] = explorerAddress(network, wallet.address);
    view.text.available = usdc(wallet.available);
    view.text.reserved = usdc(wallet.reserved);
    view.flags["keeper-on"] = wallet.keeperEnabled;
    view.flags["keeper-off"] = !wallet.keeperEnabled;
    view.text["per-payout-limit"] = usdc(wallet.perPayoutLimit);
    view.text["period-limit"] = `${usdc(wallet.periodLimit)} every ${timeLeft(wallet.periodLength)}`;
    view.text["period-left"] = `Bona Fide may still pay ${usdc(wallet.keeperAllowance)} in this period.`;
    view.flags["bounties-loading"] = rows === null && !rowsFailed;
    view.flags["bounties-failed"] = rowsFailed;
    view.text["bounties-progress"] = `${Math.floor(rowsProgress * 100)}%`;
    view.flags["has-bounties"] = !!rows && rows.length > 0;
    view.flags["no-bounties"] = !!rows && rows.length === 0;
    if (rows) {
      drawBountyRows(rowsBody, rowTemplate, rows, {
        repo: repo!,
        explorerUrl: network.explorerUrl,
        ...(state === "manage" ? { cancel: { busy } } : {}),
      });
    }
  }
  paintPayout(view, state);
  if (state === "create" && !limitsFilled) fillLimits(DEFAULT_LIMITS);
  for (const action of busy) view.busy.add(action);
  // One transaction at a time: the others wait for it.
  if (busy.size > 0) {
    for (const action of ["create", "set-limits", "post", "fund-sign", "fund-two-step", "withdraw"]) {
      view.disabled.add(action);
    }
    for (const action of ["keeper-on", "keeper-off", "pay-owner", "pay-sign", "pay-signed", "cancel-row"]) {
      view.disabled.add(action);
    }
  }
  render(view);
  for (const card of ["limits", "post", "bounties", "fund", "keeper", "withdraw", "pay"]) drawActivity(card);
  if (shownState && shownState !== state) focusState();
  shownState = state;
}

function paintPayout(view: ReturnType<typeof newView>, state: string): void {
  if (!payout || !wallet || !linked || !["view", "wrong-wallet", "wrong-network", "manage"].includes(state)) return;
  view.flags["payout-shown"] = true;
  view.text["payout-issue"] = `issue #${payout.issue}`;
  view.text["payout-issue-number"] = String(payout.issue);
  view.hrefs["payout-issue-url"] = itemUrl({ repo: repo!, kind: "issue", number: payout.issue });
  const open = linked.status === "open";
  view.flags["payee-known"] = payee !== null;
  view.flags["payee-from-link"] = payee !== null && payout.payee !== null;
  view.flags["payee-entered"] = payee !== null && payout.payee === null && open && state === "manage";
  view.flags["payee-needed"] = payee === null && open && state === "manage";
  view.flags["payee-unknown"] = payee === null && !(open && state === "manage");
  if (payee) {
    view.text["payout-payee"] = payee;
    view.hrefs["payout-payee-url"] = explorerAddress(network, payee);
  }
  view.flags["payout-open"] = open;
  if (linked.status !== "none") {
    view.text["payout-amount"] = usdc(linked.amount);
    view.text["payout-units"] = linked.amount.toString();
    view.text["payout-serial"] = linked.serial.toString();
  } else {
    view.text["payout-amount"] = "No Bounty";
  }
  if (open) {
    const limit = keeperLimitFor(linked.amount, wallet);
    view.text["payout-why"] =
      limit === "off"
        ? "Keeper payouts are off."
        : limit === "per-payout"
          ? `It's above the per-payout limit, ${usdc(wallet.perPayoutLimit)}.`
          : limit === "period"
            ? `It's above what Bona Fide may still pay this period, ${usdc(wallet.keeperAllowance)}.`
            : "It's within your limits. The note on the PR says why the Keeper didn't pay it.";
  }
  const paidRow = rows?.find((row) => row.issue === payout.issue && row.status === "paid");
  view.flags["payout-paid"] = linked.status === "paid";
  if (linked.status === "paid") {
    const to = linked.payee ? shortAddress(linked.payee) : "its payee";
    view.text["payout-paid-text"] = `The Bounty on issue #${payout.issue} went to ${to}.`;
    view.flags["payout-paid-tx"] = !!paidRow?.closedTx;
    if (paidRow?.closedTx) view.hrefs["payout-paid-tx"] = explorerTx(network, paidRow.closedTx);
  }
  view.flags["payout-closed"] = linked.status === "none" || linked.status === "cancelled";
  view.text["payout-closed-text"] =
    linked.status === "cancelled"
      ? `The Bounty on issue #${payout.issue} was cancelled, so there's nothing to pay.`
      : `Issue #${payout.issue} has no Bounty in this wallet, so there's nothing to pay.`;
  const refused = open && payee !== null && payeeProblem(payee, wallet.address, wallet.keeper) !== null;
  view.flags["payout-refused-payee"] = refused;
  const actions = open && payee !== null && !refused && state === "manage";
  view.flags["payout-actions"] = actions;
  view.flags["payout-connect"] = open && state !== "manage";
  view.flags["pay-sign-offer"] = payPhase === "idle";
  view.flags["pay-signing"] = payPhase === "signing";
  view.flags["pay-relaying"] = payPhase === "relaying";
  view.flags["pay-relay-failed"] = payPhase === "relay-failed";
  view.flags["pay-sign-shown"] = actions;
  const deadline = signed?.deadline ?? signingDeadline;
  view.flags["payout-deadline-known"] = deadline !== null;
  view.flags["payout-deadline-later"] = deadline === null;
  if (deadline !== null) {
    view.text["payout-deadline-unix"] = deadline.toString();
    view.times["payout-deadline"] = new Date(Number(deadline) * 1000);
  }
  if (relayProblem) {
    view.text["relay-title"] = relayProblem.title;
    view.text["relay-body"] = relayProblem.body;
    view.text["relay-detail"] = relayProblem.detail ?? "";
    view.flags["relay-detail"] = !!relayProblem.detail;
  }
  if (payPhase === "signing" || payPhase === "relaying") view.disabled.add("pay-owner");
}

const ICONS = { done: "#i-check-circle", note: "#i-alert" } as const;

/** Fills a card's `data-status` slot from its activity. Text goes in as text only. */
function drawActivity(card: string): void {
  const slot = document.querySelector<HTMLElement>(`[data-status="${card}"]`);
  if (!slot) return;
  const now = activity[card];
  const link = (tx: Hex) => {
    const a = document.createElement("a");
    a.href = explorerTx(network, tx);
    a.target = "_blank";
    a.rel = "noopener";
    a.textContent = "View the transaction";
    return a;
  };
  if (!now) return slot.replaceChildren();
  if (now.kind === "pending") {
    const line = document.createElement("p");
    line.className = "progress-line mt-14";
    line.setAttribute("role", "status");
    const spinner = document.createElement("span");
    spinner.className = "spinner";
    spinner.setAttribute("aria-hidden", "true");
    const text = document.createElement("span");
    text.append(`Sent. Waiting for ${network.name} to confirm it. `, link(now.tx));
    line.append(spinner, text);
    return slot.replaceChildren(line);
  }
  const alert = document.createElement("div");
  alert.className = `alert ${now.kind === "done" ? "ok" : "warn"} mt-14`;
  alert.setAttribute("role", now.kind === "done" ? "status" : "alert");
  const icon = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  icon.setAttribute("class", "icon md");
  const use = document.createElementNS("http://www.w3.org/2000/svg", "use");
  use.setAttribute("href", ICONS[now.kind]);
  icon.append(use);
  const body = document.createElement("div");
  const text = document.createElement("p");
  text.append(now.text);
  if (now.tx) text.append(" ", link(now.tx));
  body.append(text);
  alert.append(icon, body);
  slot.replaceChildren(alert);
}

function field(name: string): HTMLInputElement | HTMLSelectElement {
  return document.querySelector<HTMLInputElement | HTMLSelectElement>(`[data-field="${name}"]`)!;
}

function fillLimits(limits: BountyLimits): void {
  limitsFilled = true;
  field("per-payout").value = usdcAmount(limits.perPayoutLimit).replaceAll(",", "");
  field("period-limit").value = usdcAmount(limits.periodLimit).replaceAll(",", "");
  const select = field("period-length") as HTMLSelectElement;
  const value = String(limits.periodLength);
  if (![...select.options].some((option) => option.value === value)) {
    select.add(new Option(timeLeft(limits.periodLength), value));
  }
  select.value = value;
}

async function load(): Promise<void> {
  if (!repoId || !bounties) return paint();
  try {
    terms = await reader.repoTerms(repoId);
    walletAddress = await bounties.repoWallet(repoId, terms);
    if (walletAddress) await loadWallet();
    loadFailed = false;
  } catch {
    loadFailed = true;
  }
  paint();
  if (walletAddress) await loadRows();
}

/** The cards whose refusals can quote the wallet's figures or the linked Bounty's. */
const QUOTING = ["post", "withdraw", "fund", "pay"] as const;

function figures(state: BountyWalletState | null, link: BountyState | null): string {
  if (!state) return "";
  const { address: _, owner: __, keeper: ___, ...amounts } = state;
  return JSON.stringify({ ...amounts, link }, (_key, value: unknown) =>
    typeof value === "bigint" ? value.toString() : value,
  );
}

/** Reads the wallet's state and the linked Bounty again, as after a transaction. */
async function loadWallet(): Promise<void> {
  if (!walletAddress || !bounties) return;
  const [state, link] = await Promise.all([
    bounties.state(walletAddress),
    payout ? bounties.bountyOf(walletAddress, payout.issue) : Promise.resolve(null),
  ]);
  const changed = figures(wallet, linked) !== figures(state, link);
  wallet = state;
  linked = link;
  // A refusal may quote the old figures, such as what was available: it goes once they change.
  if (changed) {
    for (const card of QUOTING) {
      const now = activity[card];
      if (now?.kind === "note" && !now.tx) activity[card] = undefined;
    }
  }
  if (!limitsFilled) fillLimits(state);
}

async function loadRows(): Promise<void> {
  if (!walletAddress || !bounties) return;
  rowsFailed = false;
  rowsProgress = 0;
  paint();
  try {
    rows = await bounties.bounties(walletAddress, {
      onProgress: (done, total) => {
        rowsProgress = done / total;
        paint();
      },
    });
  } catch {
    rowsFailed = true;
  }
  paint();
}

async function loadBalance(): Promise<void> {
  const account = session.account;
  if (!account || !session.onNetwork) return;
  const read = await reader.usdcBalance(account).catch(() => null);
  if (session.account === account) {
    balance = read;
    paint();
  }
}

/** After a transaction: the wallet and the Bounty the link names, read again. */
async function refreshWallet(): Promise<void> {
  try {
    if (!walletAddress && repoId && bounties && terms) walletAddress = await bounties.repoWallet(repoId, terms);
    await loadWallet();
  } catch {
    // The figures on the page stay as they were; the next read corrects them.
  }
}

/** After a transaction: the wallet, its Bounties and the Maintainer's balance, read again. */
async function refresh(): Promise<void> {
  await refreshWallet();
  void loadBalance();
  await loadRows();
}

const REFUSALS: Record<string, string> = {
  InsufficientFunds: "The Bounty wallet doesn't have that much unreserved USDC.",
  BountyAlreadyPosted: "That issue already has an open Bounty. Cancel it first to post a new amount.",
  BountyAlreadyPaid: "That issue's Bounty was already paid. An issue is paid at most once.",
  BountyNotOpen: "That Bounty isn't open anymore.",
  InvalidRecipient: "The Bounty wallet can't pay that address: it's the Keeper's, the wallet's own, or zero.",
  InvalidPeriodLength: "A period must be from 1 hour to 365 days.",
  InvalidAmount: "Enter an amount above 0.",
  NotOwner: "Only the Bounty wallet's owner can do that.",
  WalletExists: "You already have a Bounty wallet for this repo. Reload the page to see it.",
  InvalidSignature: "The Bounty wallet didn't accept the signature.",
  SignatureExpired: "The signature has expired. Sign again.",
};

function refusal(reason: string | null): string {
  if (reason && /balance/i.test(reason)) return "Your wallet doesn't hold that much USDC. Nothing was sent.";
  if (reason && /allowance/i.test(reason)) return "The Bounty wallet may take less than that. Approve it again.";
  const known = reason ? REFUSALS[reason] : undefined;
  return known ? `${known} Nothing was sent.` : `It would fail (${reason ?? "no reason given"}), so nothing was sent.`;
}

type Call = Parameters<typeof sendContractCall>[3];

/**
 * Checks, sends and confirms one transaction from the Maintainer's wallet, and says on `card` what came of
 * it. `onDone` runs as the card says it's done, before the Bounties are read again, so it never undoes
 * what the Maintainer types meanwhile.
 */
async function transact(
  card: string,
  action: string,
  call: Call,
  done: string,
  onDone?: () => void,
): Promise<Hex | null> {
  if (busy.size > 0) return null;
  activity[card] = undefined;
  paint();
  if (!(await readyWallet(session, (text) => ((activity[card] = { kind: "note", text }), paint())))) return null;
  if (!isMaintainer()) {
    paint();
    return null;
  }
  const account = session.account!;
  busy.add(action);
  paint();
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-argument -- viem's generic call type doesn't follow a union of calls; review-by: 2027-04-18
    await client.simulateContract({ ...(call as any), account });
  } catch (error) {
    busy.delete(action);
    activity[card] = { kind: "note", text: refusal(revertReason(error)) };
    paint();
    return null;
  }
  let hash: Hex;
  try {
    hash = await sendContractCall(session.wallet!.provider, account, chain, call);
  } catch (error) {
    busy.delete(action);
    activity[card] = { kind: "note", text: walletFailure(error, "transaction") };
    paint();
    return null;
  }
  activity[card] = { kind: "pending", tx: hash };
  paint();
  const receipt = await client.waitForTransactionReceipt({ hash, pollingInterval: 1000 }).catch(() => null);
  // The figures are read again before the card says it's done and the buttons work again, so nothing
  // is checked or shown against the wallet as it was before this transaction.
  await refreshWallet();
  busy.delete(action);
  if (!receipt) {
    activity[card] = {
      kind: "note",
      text: `Not confirmed yet. Look at the transaction before you send it again.`,
      tx: hash,
    };
  } else if (receipt.status !== "success") {
    activity[card] = { kind: "note", text: "The transaction reverted on-chain, so nothing changed.", tx: hash };
  } else {
    activity[card] = { kind: "done", text: done, tx: hash };
    onDone?.();
  }
  paint();
  void loadBalance();
  await loadRows();
  return receipt?.status === "success" ? hash : null;
}

function readLimits(): BountyLimits | string {
  const perPayoutLimit = parseUsdc(field("per-payout").value);
  const periodLimit = parseUsdc(field("period-limit").value);
  const periodLength = Number(field("period-length").value);
  if (perPayoutLimit === null) return "Enter the per-payout limit in USDC, such as 50.";
  if (periodLimit === null) return "Enter the per-period limit in USDC, such as 200.";
  if (!(periodLength >= PERIOD_LENGTHS.min && periodLength <= PERIOD_LENGTHS.max)) {
    return "A period must be from 1 hour to 365 days.";
  }
  if (perPayoutLimit > periodLimit) {
    return "The per-payout limit is above the per-period limit, so Bona Fide could never pay a Bounty that size. Raise the per-period limit, or lower the other.";
  }
  return { perPayoutLimit, periodLimit, periodLength };
}

async function saveLimits(): Promise<void> {
  const state = stateNow();
  if (state !== "create" && state !== "manage") return;
  const limits = readLimits();
  if (typeof limits === "string") return void ((activity.limits = { kind: "note", text: limits }), paint());
  if (state === "create") {
    await transact(
      "limits",
      "create",
      bountyCalls.create(factory!, repoId!, limits),
      "Your Bounty wallet is ready. Fund it, then post Bounties.",
    );
    return;
  }
  await transact(
    "limits",
    "set-limits",
    bountyCalls.setLimits(walletAddress!, limits),
    "Limits saved. They apply from now.",
    () => {
      fillLimits(limits);
    },
  );
}

async function post(): Promise<void> {
  if (!walletAddress) return;
  const issueText = field("post-issue").value.trim().replace(/^#/, "");
  const issue = /^[1-9]\d{0,15}$/.test(issueText) ? Number(issueText) : NaN;
  const amount = parseUsdc(field("post-amount").value);
  const problem = !Number.isSafeInteger(issue)
    ? "Enter the issue's number, such as 12."
    : amount === null || amount === 0n
      ? "Enter the Bounty's amount in USDC, such as 25."
      : wallet && amount > wallet.available
        ? `That's more than the ${usdc(wallet.available)} available. Fund the wallet first.`
        : null;
  if (problem) return void ((activity.post = { kind: "note", text: problem }), paint());
  await transact(
    "post",
    "post",
    bountyCalls.post(walletAddress, issue, amount!),
    `Posted ${usdc(amount!)} on issue #${issue}.`,
    () => {
      field("post-issue").value = "";
      field("post-amount").value = "";
    },
  );
}

async function cancel(issue: number): Promise<void> {
  if (!walletAddress) return;
  const action = `cancel:${issue}`;
  await transact(
    "bounties",
    action,
    bountyCalls.cancel(walletAddress, issue),
    `Cancelled the Bounty on issue #${issue}. Its USDC is available again.`,
  );
}

function readAmount(name: string, what: string): bigint | null {
  const amount = parseUsdc(field(name).value);
  if (amount === null || amount === 0n) {
    activity[what] = { kind: "note", text: "Enter an amount in USDC, such as 100." };
    paint();
    return null;
  }
  return amount;
}

async function fundWithSignature(): Promise<void> {
  if (!walletAddress || busy.size > 0) return;
  const amount = readAmount("fund-amount", "fund");
  if (amount === null) return;
  activity.fund = undefined;
  paint();
  if (!(await readyWallet(session, (text) => ((activity.fund = { kind: "note", text }), paint())))) return;
  if (!isMaintainer()) return paint();
  const account = session.account!;
  const authorization = {
    from: account,
    value: amount,
    nonce: randomBytes32(),
    validBefore: unixSeconds(await reader.now().catch(() => new Date())) + BigInt(WINDOWS.bountyFund),
  };
  busy.add("fund-sign");
  paint();
  let signature: Hex;
  try {
    signature = await signTypedData(
      session.wallet!.provider,
      account,
      bountyFundAuthorization({
        chainId: network.chainId,
        usdc: network.usdc,
        wallet: walletAddress,
        ...authorization,
      }),
    );
  } catch (error) {
    busy.delete("fund-sign");
    activity.fund = {
      kind: "note",
      text: isUserRejection(error)
        ? "You cancelled the signature. Nothing was sent."
        : "Your wallet couldn't sign. Try again, or fund with two transactions instead.",
    };
    return paint();
  }
  busy.delete("fund-sign");
  if (isUndeployedSmartWalletSignature(signature)) {
    activity.fund = {
      kind: "note",
      text: `This smart wallet hasn't made a transaction on ${network.name} yet, so USDC can't check its signature. Fund with two transactions instead.`,
    };
    return paint();
  }
  await transact(
    "fund",
    "fund-sign",
    bountyCalls.fundWithAuthorization(walletAddress, authorization, signature),
    `Funded ${usdc(amount)}.`,
    () => {
      field("fund-amount").value = "";
    },
  );
}

async function fundTwoStep(): Promise<void> {
  if (!walletAddress || busy.size > 0) return;
  const amount = readAmount("fund-amount", "fund");
  if (amount === null) return;
  if (!(await readyWallet(session, (text) => ((activity.fund = { kind: "note", text }), paint())))) return;
  if (!isMaintainer()) return paint();
  const allowance = await client
    .readContract({
      address: network.usdc,
      abi: usdcAbi,
      functionName: "allowance",
      args: [session.account!, walletAddress],
    })
    .catch(() => 0n);
  if (allowance < amount) {
    const approved = await transact(
      "fund",
      "fund-two-step",
      bountyCalls.approve(network.usdc, walletAddress, amount),
      `Approved ${usdc(amount)}. Now confirm the second transaction.`,
    );
    if (!approved) return;
  }
  await transact("fund", "fund-two-step", bountyCalls.fund(walletAddress, amount), `Funded ${usdc(amount)}.`, () => {
    field("fund-amount").value = "";
  });
}

async function withdraw(): Promise<void> {
  if (!walletAddress || !session.account) return void readyWallet(session, () => paint());
  const amount = readAmount("withdraw-amount", "withdraw");
  if (amount === null) return;
  if (wallet && amount > wallet.available) {
    activity.withdraw = {
      kind: "note",
      text: `Only ${usdc(wallet.available)} is available. Cancel a Bounty first to free its USDC.`,
    };
    return paint();
  }
  await transact(
    "withdraw",
    "withdraw",
    bountyCalls.withdraw(walletAddress, session.account, amount),
    `Withdrew ${usdc(amount)} to ${shortAddress(session.account)}.`,
    () => {
      field("withdraw-amount").value = "";
    },
  );
}

async function switchKeeper(enabled: boolean): Promise<void> {
  if (!walletAddress) return;
  await transact(
    "keeper",
    enabled ? "keeper-on" : "keeper-off",
    bountyCalls.setKeeperEnabled(walletAddress, enabled),
    enabled
      ? "Keeper payouts are on. Bona Fide pays posted Bounties within your limits again."
      : "Keeper payouts are off. Every Payout now waits for you.",
  );
}

async function payDirectly(): Promise<void> {
  if (!walletAddress || !payout || !payee || linked?.status !== "open") return;
  await transact(
    "pay",
    "pay-owner",
    bountyCalls.ownerPay(walletAddress, payout.issue, payee),
    `Paid ${usdc(linked.amount)} to ${shortAddress(payee)}.`,
  );
}

async function signPayout(): Promise<void> {
  if (!walletAddress || !payout || !payee || !linked || linked.status !== "open" || busy.size > 0) return;
  const to = payee;
  activity.pay = undefined;
  paint();
  if (!(await readyWallet(session, (text) => ((activity.pay = { kind: "note", text }), paint())))) return;
  if (!isMaintainer()) return paint();
  const account = session.account!;
  const run = ++attempt;
  const bounty = linked;
  const deadline = unixSeconds(await reader.now().catch(() => new Date())) + BigInt(WINDOWS.payout);
  signingDeadline = deadline;
  payPhase = "signing";
  relayProblem = null;
  paint();
  let signature: Hex;
  try {
    signature = await signTypedData(
      session.wallet!.provider,
      account,
      payoutSignature({
        chainId: network.chainId,
        wallet: walletAddress,
        issueNumber: payout.issue,
        serial: bounty.serial,
        payee: to,
        amount: bounty.amount,
        deadline,
      }),
    );
  } catch (error) {
    if (run !== attempt) return;
    payPhase = "idle";
    signingDeadline = null;
    activity.pay = {
      kind: "note",
      text: isUserRejection(error)
        ? "You cancelled the signature. Nothing was sent."
        : "Your wallet couldn't sign. Try again.",
    };
    return paint();
  }
  if (run !== attempt) return;
  if (isUndeployedSmartWalletSignature(signature)) {
    payPhase = "idle";
    signingDeadline = null;
    activity.pay = {
      kind: "note",
      text: `This smart wallet hasn't made a transaction on ${network.name} yet, so the Bounty wallet can't check its signature. Pay now instead.`,
    };
    return paint();
  }
  signed = { deadline, signature, serial: bounty.serial, payee: to };
  payPhase = "relaying";
  paint();
  const outcome = await relayPayout(
    payoutBody({ repo: repo!, issue: payout.issue, payee: to, deadline }, signature),
    pageFetch,
  );
  await settleRelay(outcome, bounty.amount, to);
}

async function settleRelay(outcome: PayoutOutcome, amount: bigint, to: Address): Promise<void> {
  if (outcome.kind === "paid" || outcome.kind === "unconfirmed") {
    payPhase = "idle";
    activity.pay = { kind: "pending", tx: outcome.txHash };
    paint();
    const receipt = await client
      .waitForTransactionReceipt({ hash: outcome.txHash, pollingInterval: 1000, timeout: 120_000 })
      .catch(() => null);
    await refreshWallet();
    if (receipt?.status === "success") {
      activity.pay = {
        kind: "done",
        text: `Paid ${usdc(amount)} to ${shortAddress(to)}.`,
        tx: outcome.txHash,
      };
      signed = null;
      signingDeadline = null;
    } else if (receipt) {
      activity.pay = { kind: "note", text: "The transaction reverted, so nothing was paid.", tx: outcome.txHash };
      relayFailed("The Payout failed on-chain", "Your signature still works: send it from your wallet instead.");
    } else {
      activity.pay = {
        kind: "note",
        text: "Not confirmed yet. Look at the transaction before you pay again.",
        tx: outcome.txHash,
      };
    }
    paint();
    void loadBalance();
    return loadRows();
  }
  const nothing = "Nothing was paid. Your signature still works: send it from your wallet instead.";
  switch (outcome.kind) {
    case "refused":
      if (outcome.status === 409) {
        payPhase = "idle";
        signed = null;
        await refresh();
        activity.pay = {
          kind: "note",
          text: `Bona Fide didn't send it: ${outcome.message || "the Bounty isn't open"}.`,
        };
        return paint();
      }
      return relayFailed("Bona Fide didn't send the Payout", nothing, outcome.message);
    case "wait":
      return relayFailed("Payout not sent yet", `Bona Fide is getting too many requests right now. ${nothing}`);
    case "reverted":
      activity.pay = { kind: "note", text: "The transaction reverted.", tx: outcome.txHash };
      return relayFailed(
        "The Payout failed on-chain",
        `The transaction reverted, so nothing was paid. ${nothing}`,
        outcome.message,
      );
    case "too-large":
      return relayFailed(
        "The signature is too large to send",
        `Bona Fide doesn't accept a signature that large. ${nothing}`,
      );
    case "unavailable":
      return relayFailed(
        "Payout not sent",
        `Bona Fide couldn't be reached, or couldn't reach ${network.name}. ${nothing}`,
      );
  }
}

function relayFailed(title: string, body: string, detail?: string): void {
  payPhase = "relay-failed";
  relayProblem = { title, body, ...(detail ? { detail } : {}) };
  paint();
}

async function sendSigned(): Promise<void> {
  if (!walletAddress || !payout || !signed || !linked) return;
  if (linked.serial !== signed.serial || linked.status !== "open") {
    payPhase = "idle";
    signed = null;
    return paint();
  }
  // Anyone can send a signed Payout: the signature, not the sender, is the Maintainer's say-so.
  await transact(
    "pay",
    "pay-signed",
    bountyCalls.payWithSignature(walletAddress, payout.issue, signed.payee, signed.deadline, signed.signature),
    `Paid ${usdc(linked.amount)} to ${shortAddress(signed.payee)}.`,
    () => {
      payPhase = "idle";
      signed = null;
      signingDeadline = null;
      paint();
    },
  );
}

function usePayee(): void {
  const entered = readPayee(field("payee").value);
  if (!entered) {
    activity.pay = {
      kind: "note",
      text: "That isn't a wallet address. Paste the full address, 0x and 40 characters, as the Contributor gave it.",
    };
    return paint();
  }
  if (wallet && payeeProblem(entered, wallet.address, wallet.keeper) !== null) {
    activity.pay = {
      kind: "note",
      text: "The Bounty wallet can't pay that address: it's the Keeper's, the wallet's own, or zero.",
    };
    return paint();
  }
  activity.pay = undefined;
  payee = entered;
  paint();
}

onAction((action, element) => {
  if (action === "reload") return location.reload();
  if (action === "reload-bounties") return void loadRows();
  if (action === "connect") return void session.connect();
  if (action === "switch-network") return void readyWallet(session, (text) => ((note = text), paint()));
  if (action === "create" || action === "set-limits") return void saveLimits();
  if (action === "post") return void post();
  if (action === "cancel-row" && element.dataset.issue) return void cancel(Number(element.dataset.issue));
  if (action === "fund-sign") return void fundWithSignature();
  if (action === "fund-two-step") return void fundTwoStep();
  if (action === "withdraw") return void withdraw();
  if (action === "keeper-off" || action === "keeper-on") return void switchKeeper(action === "keeper-on");
  if (action === "pay-owner") return void payDirectly();
  if (action === "pay-sign") return void signPayout();
  if (action === "pay-signed") return void sendSigned();
  if (action === "use-payee") return usePayee();
  if (action === "change-payee" && busy.size === 0 && payPhase !== "signing" && payPhase !== "relaying") {
    payee = null;
    payPhase = "idle";
    signed = null;
    signingDeadline = null;
    return paint();
  }
});

// Enter in a field submits its form: the page handles it as the form's button.
for (const form of document.querySelectorAll<HTMLFormElement>("[data-form]")) {
  form.addEventListener("submit", (event) => event.preventDefault());
}

if (repo) document.title = `Bounties in ${repo} · Bona Fide`;
paint();
void load();
