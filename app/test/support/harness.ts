import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../../src/app.ts";
import { createDecisionLog } from "../../src/decisions/log.ts";
import type { Binding, Decision, DecisionLog, Model } from "../../src/ports.ts";
import { createRecordExemptions } from "../../src/records/exemption.ts";
import { createRecordIndex } from "../../src/records/records.ts";
import { createTriage, type TriageDecision } from "../../src/triage/triage.ts";
import { createWebhookHandler } from "../../src/webhook.ts";
import { FakeChain } from "./fake-chain.ts";
import { FakeGitHub } from "./fake-github.ts";
import { REPO, SECRET, signed } from "./webhooks.ts";

export const DEPOSIT_PAGE = "https://bonafide.example/deposit";
export const SETUP_PAGE = "https://bonafide.example/setup";
export const SIGN_PAGE = "https://bonafide.example/sign";

/** A decision log file of its own for a Node host a test starts, so none writes into the checkout. */
export function scratchDecisionsPath(): string {
  return join(tmpdir(), `bona-fide-decisions-${randomUUID()}.jsonl`);
}

export interface HarnessOptions {
  /** The text of .github/bona-fide.yml; without it the repo has no config. */
  config?: string;
  /** The repo's active Binding: 1 USDC, 50% and 7 days unless given other terms. `null` leaves the repo unbound. */
  binding?: Partial<Binding> | null;
  /** When the Binding took effect: by default long before any PR or issue was opened. */
  startedAt?: Date;
  /** The App's clock: the time, or a clock a test can move. */
  now?: Date | (() => Date);
  /** The block explorer the App links Deposits to, if not Arc mainnet's. */
  explorerUrl?: string;
  /** The model triage asks; without it, triage is off. */
  triageModel?: Model;
  /** The model that weighs Contributors' records; without it, there are no Record Exemptions. */
  recordModel?: Model;
  /** The decision log, such as one kept in a file; by default one in memory that `logged` sees. */
  log?: DecisionLog;
}

export function harness(options: HarnessOptions = {}) {
  const { config, binding = {}, startedAt, explorerUrl, triageModel, recordModel } = options;
  const now = typeof options.now === "function" ? options.now : options.now && (() => options.now as Date);
  const github = new FakeGitHub();
  const chain = new FakeChain();
  github.addRepo(REPO);
  if (config !== undefined) github.setFile(REPO, ".github/bona-fide.yml", config);
  if (binding !== null) chain.bind(REPO, binding, startedAt);
  const decisions: TriageDecision[] = [];
  /** Every decision appended to the log, private repos' included. */
  const logged: Decision[] = [];
  const log = options.log ?? createDecisionLog({ write: (decision) => logged.push(decision) });
  const triage =
    triageModel &&
    createTriage({
      github,
      model: triageModel,
      signPageUrl: SIGN_PAGE,
      record: (decision) => decisions.push(decision),
      decisions: log,
    });
  // The record index reads the escrow from its first block, as the host reads it from ESCROW_FROM_BLOCK.
  const records = createRecordIndex({ chain, github, fromBlock: 0n });
  const recordExemptions =
    recordModel &&
    createRecordExemptions({ github, records, model: recordModel, decisions: log, ...(now ? { now } : {}) });
  const app = createApp({
    github,
    chain,
    depositPageUrl: DEPOSIT_PAGE,
    setupPageUrl: SETUP_PAGE,
    explorerUrl,
    triage,
    recordExemptions,
    ...(now ? { now } : {}),
  });
  const handle = createWebhookHandler({ secret: SECRET, app });
  const deliver = (event: string, body: unknown) => handle(signed(event, body));
  return { github, chain, app, handle, deliver, triage, decisions, log, logged, records, recordExemptions };
}
