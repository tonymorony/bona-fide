import { parse } from "yaml";

export const CONFIG_PATH = ".github/bona-fide.yml";
export const USDC_DECIMALS = 6;
export const DAY_SECONDS = 86_400;
const UNIT = 10n ** BigInt(USDC_DECIMALS);

export interface Config {
  amount: bigint;
  forfeitBps: number;
  timeoutSeconds: number;
  /** Bot logins the repo exempts on top of DEFAULT_EXEMPT_BOTS. */
  exemptBots: readonly string[];
  /** Whether triage reads the repo's items that hold a Deposit, when the host has a model to ask. */
  triage: boolean;
  /** Whether a good Bona Fide record can exempt a Contributor, when the host has a model to ask. */
  recordExemption: boolean;
  /** The score a Contributor's record needs for a Record Exemption. */
  recordThreshold: number;
  /** Whether the Keeper pays the repo's Bounties on its own, when the host has a Bounty wallet factory. */
  bounties: boolean;
}

export const DEFAULTS: Config = {
  amount: UNIT,
  forfeitBps: 5000,
  timeoutSeconds: 7 * DAY_SECONDS,
  exemptBots: [],
  triage: true,
  recordExemption: true,
  recordThreshold: 3,
  bounties: true,
};

/**
 * How far GitHub's clock and Arc's may disagree, in seconds. An item's `created_at` comes from
 * GitHub and a Deposit's time from its Arc block, so a Deposit counts for the item if its block
 * is at most this much older than the item.
 */
export const CLOCK_SKEW_SECONDS = 120;

/** Arc mainnet's block explorer, where a check links each Deposit's transaction by default. */
export const ARC_EXPLORER_URL = "https://explorer.arc.io";

/**
 * The most bytes the Node host reads of a webhook delivery's body. Past it, the host stops reading
 * and answers 413. GitHub's pull_request, issues, check_run and check_suite deliveries are far smaller.
 */
export const MAX_WEBHOOK_BODY_BYTES = 1024 * 1024;

/** The same limit for the JSON endpoints: POST /relay/deposit, /forfeit, /binding-proof and /bounty/payout. */
export const MAX_JSON_BODY_BYTES = 16 * 1024;

/** Maintenance bots every repo exempts. Any other bot, AI coding agents included, is treated like anyone else. */
export const DEFAULT_EXEMPT_BOTS: readonly string[] = ["dependabot[bot]", "renovate[bot]", "github-actions[bot]"];

/** The escrow's maxAmount at deploy (50 USDC); a larger amount could never be bound. */
const MAX_AMOUNT = 50n * UNIT;

export type ParsedConfig = { ok: true; config: Config } | { ok: false; problems: string[] };

// The failsafe schema keeps every value a string, so "0.0000001" isn't rounded into a float.
// Keys other than these (such as the Keeper's `maintainer`) are left to their readers.
export function parseConfig(text: string): ParsedConfig {
  let settings: unknown;
  try {
    settings = parse(text, { schema: "failsafe" });
  } catch {
    return { ok: false, problems: ["The file isn't valid YAML."] };
  }
  if (settings === null) return { ok: true, config: DEFAULTS };
  if (typeof settings !== "object" || Array.isArray(settings)) {
    return { ok: false, problems: ["The file must hold settings such as `amount: 1`."] };
  }
  const { amount, forfeit, timeout, exempt_bots, triage, record_exemption, record_threshold, bounties } =
    settings as Record<string, unknown>;
  const problems: string[] = [];
  const config: Config = {
    amount: isSet(amount) ? parseAmount(String(amount), problems) : DEFAULTS.amount,
    forfeitBps: isSet(forfeit) ? parseForfeit(String(forfeit), problems) : DEFAULTS.forfeitBps,
    timeoutSeconds: isSet(timeout) ? parseTimeout(String(timeout), problems) : DEFAULTS.timeoutSeconds,
    exemptBots: isSet(exempt_bots) ? parseLogins(exempt_bots, problems) : DEFAULTS.exemptBots,
    triage: isSet(triage) ? parseSwitch(triage, "triage", problems) : DEFAULTS.triage,
    recordExemption: isSet(record_exemption)
      ? parseSwitch(record_exemption, "record_exemption", problems)
      : DEFAULTS.recordExemption,
    recordThreshold: isSet(record_threshold) ? parseThreshold(record_threshold, problems) : DEFAULTS.recordThreshold,
    bounties: isSet(bounties) ? parseSwitch(bounties, "bounties", problems) : DEFAULTS.bounties,
  };
  return problems.length === 0 ? { ok: true, config } : { ok: false, problems };
}

function isSet(value: unknown): boolean {
  return value !== undefined && value !== null && value !== "";
}

/** A GitHub login: a user's, or a GitHub App's bot such as `pre-commit-ci[bot]`. */
const LOGIN = /^[\w-]+(\[bot\])?$/;

function parseLogins(value: unknown, problems: string[]): string[] {
  if (Array.isArray(value) && value.every((login) => typeof login === "string" && LOGIN.test(login))) return value;
  problems.push("`exempt_bots` must be a list of GitHub logins.");
  return [];
}

// The failsafe schema reads `off` and `false` alike, as strings.
function parseSwitch(value: unknown, key: string, problems: string[]): boolean {
  const text = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (["on", "true", "yes"].includes(text)) return true;
  if (["off", "false", "no"].includes(text)) return false;
  problems.push(`\`${key}\` must be on or off.`);
  return true;
}

function parseThreshold(value: unknown, problems: string[]): number {
  const text = typeof value === "string" ? value.trim() : "";
  const threshold = /^\d+$/.test(text) ? Number(text) : NaN;
  if (!(threshold >= 1 && threshold <= 100)) problems.push("`record_threshold` must be a whole number from 1 to 100.");
  return threshold;
}

function parseAmount(text: string, problems: string[]): bigint {
  const match = /^(\d+)(?:\.(\d+))?(?:\s*usdc)?$/i.exec(text.trim());
  if (match?.[2] && match[2].length > USDC_DECIMALS) {
    problems.push("`amount` can have at most 6 decimals.");
    return 0n;
  }
  const amount = match ? BigInt(match[1]!) * UNIT + BigInt((match[2] ?? "").padEnd(USDC_DECIMALS, "0")) : 0n;
  if (amount <= 0n || amount > MAX_AMOUNT) problems.push("`amount` must be more than 0 and at most 50 USDC.");
  return amount;
}

function parseForfeit(text: string, problems: string[]): number {
  const match = /^(\d+)(?:\.(\d{1,2}))?\s*%?$/.exec(text.trim());
  const bps = match ? Number(match[1]) * 100 + Number((match[2] ?? "").padEnd(2, "0")) : NaN;
  if (!(bps >= 0 && bps <= 5000)) problems.push("`forfeit` must be from 0% to 50%.");
  return bps;
}

function parseTimeout(text: string, problems: string[]): number {
  const match = /^(\d+)\s*(?:d|days?)?$/i.exec(text.trim());
  const days = match ? Number(match[1]) : NaN;
  if (!(days >= 1 && days <= 60)) problems.push("`timeout` must be a whole number of days from 1 to 60.");
  return days * DAY_SECONDS;
}
