import type { Address, Hex } from "viem";
import { fetchBonaFideYml, readBonaFideYml, type FetchedFile, type FileTerms } from "../bona-fide-yml.ts";
import type { RepoTerms, Terms } from "../chain.ts";
import { askKeeperToBind, bindingProofBody } from "../endpoints.ts";
import { delay, percent, shortAddress, timeout, usdc } from "../format.ts";
import { repoIdOf } from "../keys.ts";
import { explorerTx, readRepoLink, repoPageUrl } from "../link.ts";
import { bindingProof, WINDOWS } from "../typed-data.ts";
import { focusState, newView, onAction, render } from "../ui/dom.ts";
import { isUndeployedSmartWalletSignature, isUserRejection, signTypedData } from "../wallet.ts";
import {
  describeWallet,
  network,
  randomBytes32,
  reader,
  readyWallet,
  sameAddress,
  pageFetch,
  secondsUntil,
  startSession,
  unixSeconds,
} from "./common.ts";

const repo = readRepoLink(location.search);

type Phase = "idle" | "signing" | "sending" | "done" | "problem";

interface Problem {
  title: string;
  body: string;
  detail?: string;
  retry?: { label: string; action: "sign" | "reload-file"; until?: number };
}

let file: FetchedFile | null = null;
let fileTerms: FileTerms | null = null;
let fileProblems: string[] = [];
let chainTerms: RepoTerms | null = null;
let delaySeconds = 86_400;
let loadFailed = false;
let phase: Phase = "idle";
let problem: Problem | null = null;
let attempt = 0;
let nonce: Hex = randomBytes32();
let signingDeadline: bigint | null = null;
let proposal: { txHash: Hex | null; effectiveAt: Date } | null = null;
let note = "";
let shownState = "";

const session = startSession(() => {
  note = "";
  if (phase === "problem") phase = "idle";
  paint();
});

function sameTerms(a: Terms, b: FileTerms): boolean {
  return (
    sameAddress(a.maintainer, b.maintainer) &&
    a.amount === b.amount &&
    a.forfeitBps === b.forfeitBps &&
    a.timeoutSeconds === b.timeoutSeconds
  );
}

function termsLine({ amount, forfeitBps, timeoutSeconds }: Omit<Terms, "maintainer">): string {
  const days = timeout(timeoutSeconds).replace(/ (day|hour)s?$/, "-$1");
  return `${usdc(amount)} Deposit · ${days} Timeout · ${percent(forfeitBps)} bad-faith share`;
}

function stateNow(): string {
  if (!repo) return "bad-link";
  if (loadFailed) return "chain-error";
  if (!file || !chainTerms) return "loading";
  if (phase !== "idle") return phase;
  if (file.kind === "missing") return "no-file";
  if (fileProblems.length > 0) return "file-problem";
  if (file.kind === "found" && !fileTerms?.maintainer) return "no-maintainer";
  if (fileTerms && chainTerms.active && !chainTerms.pending && sameTerms(chainTerms.active, fileTerms)) return "live";
  if (!session.account) return "not-connected";
  if (!session.onNetwork) return "wrong-network";
  if (fileTerms?.maintainer && !sameAddress(session.account, fileTerms.maintainer)) return "wrong-wallet";
  return "ready";
}

function paint(): void {
  const state = stateNow();
  const view = newView(state);
  describeWallet(view, session);
  view.text.delay = delay(delaySeconds);
  view.text["escrow-short"] = shortAddress(network.escrow);
  view.text["example-wallet"] = session.account ?? "0xYourWalletAddress";
  if (repo) {
    view.flags["repo-known"] = true;
    view.text.repo = repo;
    view.text["binding-repo"] = `github:${repo.toLowerCase()}`;
    view.hrefs["repo-url"] = `https://github.com/${repo}`;
    view.hrefs["repo-page"] = repoPageUrl(repo);
  }
  const fileKnown = fileTerms !== null && fileTerms.maintainer !== null;
  view.flags["file-known"] = fileKnown;
  view.flags["file-unknown"] = file?.kind === "unreadable";
  view.flags["terms-known"] = fileKnown;
  if (fileTerms?.maintainer) {
    view.text["file-maintainer-short"] = shortAddress(fileTerms.maintainer);
    view.text["file-amount"] = usdc(fileTerms.amount);
    view.text["file-timeout"] = timeout(fileTerms.timeoutSeconds);
    view.text["file-share"] = percent(fileTerms.forfeitBps);
  }
  view.text["signing-wallet"] = fileTerms?.maintainer ?? session.account ?? "The wallet you connect";
  view.text.nonce = shortAddress(nonce);
  view.flags["deadline-known"] = signingDeadline !== null;
  view.flags["deadline-later"] = signingDeadline === null;
  if (signingDeadline !== null) {
    view.text["deadline-unix"] = signingDeadline.toString();
    view.times.deadline = new Date(Number(signingDeadline) * 1000);
  }
  const signFlow = ["not-connected", "wrong-network", "wrong-wallet", "ready", "signing", "sending", "problem"];
  view.flags.explain = signFlow.includes(state);
  view.flags["first-binding"] = !chainTerms?.active;
  view.flags["changing-terms"] = !!chainTerms?.active;
  const fileNeeded = ["no-file", "file-problem", "no-maintainer"].includes(state);
  view.flags["file-ok"] = !fileNeeded;
  view.flags["file-needed"] = fileNeeded;
  view.flags["step-sign"] = !fileNeeded && state !== "done" && state !== "live";
  view.flags["step-signed"] = state === "done" || state === "live";
  view.flags["step-waiting"] = !fileNeeded && state !== "done" && state !== "live";
  view.flags["step-live-soon"] = state === "done";
  view.flags["step-live"] = state === "live";
  const bound = state === "live" ? chainTerms?.active : chainTerms?.pending;
  if (bound) {
    view.text["bound-maintainer"] = bound.maintainer;
    view.text["bound-terms"] = termsLine(bound);
  }
  if (proposal) {
    view.times["effective-at"] = proposal.effectiveAt;
    view.flags["just-proposed"] = proposal.txHash !== null;
    view.flags["already-proposed"] = proposal.txHash === null;
    view.flags["proposal-tx"] = proposal.txHash !== null;
    if (proposal.txHash) {
      view.hrefs["tx-url"] = explorerTx(network, proposal.txHash);
      view.text["tx-short"] = shortAddress(proposal.txHash);
    }
  }
  view.text.note = note;
  view.flags.note = note !== "";
  if (problem) {
    view.text["problem-title"] = problem.title;
    view.text["problem-body"] = problem.body;
    view.text["problem-detail"] = problem.detail ?? "";
    view.flags["problem-detail"] = !!problem.detail;
    view.flags.retry = !!problem.retry;
    if (problem.retry) {
      const wait = problem.retry.until ? secondsUntil(problem.retry.until) : 0;
      view.text["retry-label"] = wait > 0 ? `${problem.retry.label} in ${wait} s` : problem.retry.label;
      if (wait > 0) view.disabled.add("retry");
    }
  }
  const list = document.querySelector("[data-problems]")!;
  list.replaceChildren(
    ...fileProblems.map((text) => {
      const li = document.createElement("li");
      li.textContent = text;
      return li;
    }),
  );
  render(view);
  if (shownState && shownState !== state) focusState();
  shownState = state;
}

async function loadFile(): Promise<void> {
  if (!repo) return;
  file = await fetchBonaFideYml(repo, pageFetch);
  fileTerms = null;
  fileProblems = [];
  if (file.kind === "found") {
    const read = readBonaFideYml(file.text);
    if (read.ok) fileTerms = read.terms;
    else fileProblems = read.problems;
  }
}

async function loadChain(): Promise<void> {
  if (!repo) return;
  try {
    [chainTerms, delaySeconds] = await Promise.all([reader.repoTerms(repoIdOf(repo)), reader.bindingDelaySeconds()]);
    loadFailed = false;
  } catch {
    loadFailed = true;
  }
}

async function load(): Promise<void> {
  if (!repo) return paint();
  await Promise.all([loadFile(), loadChain()]);
  const pending = chainTerms?.pending;
  if (phase === "idle" && pending && fileTerms && sameTerms(pending, fileTerms)) {
    proposal = { txHash: null, effectiveAt: pending.effectiveAt };
    phase = "done";
  }
  paint();
}

function showProblem(next: Problem): void {
  phase = "problem";
  problem = next;
  paint();
}

async function sign(): Promise<void> {
  if (!repo) return;
  if (!(await readyWallet(session, (text) => ((note = text), paint())))) return;
  const account = session.account!;
  if (fileTerms?.maintainer && !sameAddress(account, fileTerms.maintainer)) return paint();
  const run = ++attempt;
  note = "";
  const maintainer: Address = fileTerms?.maintainer ?? account;
  const deadline = unixSeconds(await reader.now().catch(() => new Date())) + BigInt(WINDOWS.bindingProof);
  signingDeadline = deadline;
  phase = "signing";
  paint();
  let signature: Hex;
  try {
    signature = await signTypedData(
      session.wallet!.provider,
      account,
      bindingProof({ chainId: network.chainId, escrow: network.escrow, repo, maintainer, nonce, deadline }),
    );
  } catch (error) {
    if (run !== attempt) return;
    phase = "idle";
    signingDeadline = null;
    note = isUserRejection(error)
      ? "You cancelled the signature. Nothing was sent."
      : "Your wallet couldn't sign. Try again.";
    return paint();
  }
  if (run !== attempt) return;
  if (isUndeployedSmartWalletSignature(signature)) {
    return showProblem({
      title: "This wallet can't sign the proof yet",
      body: `It's a smart wallet that hasn't made a transaction on ${network.name}, and Bona Fide can only check signatures from wallets that have. Make any transaction from it on ${network.name}, then sign again.`,
      retry: { label: "Sign again", action: "sign" },
    });
  }
  phase = "sending";
  paint();
  const outcome = await askKeeperToBind(bindingProofBody({ repo, maintainer, nonce, deadline }, signature), pageFetch);
  nonce = randomBytes32();
  signingDeadline = null;
  switch (outcome.kind) {
    case "proposed":
    case "pending":
      await loadChain();
      proposal = {
        txHash: outcome.kind === "proposed" ? outcome.txHash : null,
        effectiveAt: new Date(outcome.effectiveAt * 1000),
      };
      phase = "done";
      return paint();
    case "active":
      phase = "idle";
      return load();
    case "refused":
      if (outcome.status === 404) {
        return showProblem({
          title: "Install the Bona Fide App first",
          body: `Bona Fide isn't installed on ${repo}. Install the App on the repo, then sign again.`,
          detail: outcome.message,
          retry: { label: "Sign again", action: "sign" },
        });
      }
      if (outcome.status === 409) {
        return showProblem({
          title: "Bona Fide didn't propose the Binding",
          body: "Fix bona-fide.yml on the default branch, then check again.",
          detail: outcome.message,
          retry: { label: "Check again", action: "reload-file" },
        });
      }
      return showProblem({
        title: "Bona Fide didn't accept the proof",
        body: "Nothing was proposed.",
        detail: outcome.message,
        retry: { label: "Sign again", action: "sign" },
      });
    case "wait":
      return showProblem({
        title: "Proof not sent yet",
        body: "Bona Fide is getting too many requests from your connection right now. Nothing was proposed.",
        retry: { label: "Sign again", action: "sign", until: Date.now() + outcome.seconds * 1000 },
      });
    case "too-large":
      return showProblem({
        title: "The signature is too large to send",
        body: "Your wallet's signature is larger than Bona Fide accepts. Nothing was proposed.",
      });
    case "unavailable":
      return showProblem({
        title: "Proof not sent",
        body: `Bona Fide couldn't be reached, or couldn't reach ${network.name}. Nothing was proposed. Try again in a minute.`,
        retry: { label: "Sign again", action: "sign" },
      });
  }
}

async function reloadFile(): Promise<void> {
  phase = "idle";
  problem = null;
  file = null;
  paint();
  await load();
}

onAction((action) => {
  const next = action === "retry" ? (problem?.retry?.action ?? "sign") : action;
  if (next === "reload") return location.reload();
  if (next === "reload-file") return void reloadFile();
  if (next === "connect") return void session.connect();
  if (next === "switch-network") return void readyWallet(session, (text) => ((note = text), paint()));
  if (next === "sign") {
    problem = null;
    phase = "idle";
    return void sign();
  }
  if (next === "cancel-signing") {
    attempt++;
    phase = "idle";
    signingDeadline = null;
    note = "Nothing was signed. If your wallet still shows the request, reject it there.";
    return paint();
  }
});

if (repo) document.title = `Set up Bona Fide in ${repo} · Bona Fide`;
setInterval(() => {
  if (phase === "problem" && problem?.retry?.until) paint();
}, 1000);
paint();
void load();
