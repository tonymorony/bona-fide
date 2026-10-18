// Every place that tells a scanner or a linter to stay quiet says why, and when someone looks at it again.
// docs/security/suppressions.md has the rules; this enforces them.
//
//   node scripts/lint-suppressions.ts
//
// A missing reason or date fails. A date further out than the horizon fails. A date that has passed warns on
// every run but doesn't block: the point is a second look, not a red build on an unrelated change.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const root = execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim();
const inCi = process.env.GITHUB_ACTIONS === "true";
const today = new Date().toISOString().slice(0, 10);
const REVIEW_BY = /review-by\s*[:=]\s*"?(\d{4}-\d{2}-\d{2})/;
const YEAR_DAYS = 366;
const OSV_DAYS = 90;
const WEAK_REASONS = /^(false positive|test data|noisy( rule)?|legacy|for now|not a secret|n\/a|todo|ignore)\.?$/i;

let failures = 0;
let checked = 0;
function fail(where: string, message: string): void {
  failures++;
  console.log(inCi ? `::error::${where}: ${message}` : `FAIL ${where}: ${message}`);
}
function warn(where: string, message: string): void {
  console.log(inCi ? `::warning::${where}: ${message}` : `warning ${where}: ${message}`);
}
function daysFromToday(date: string): number {
  return Math.round((Date.parse(`${date}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / 86_400_000);
}
// A review date: present, a real date, within the horizon. Passed dates warn.
function checkDate(where: string, date: string | undefined, horizonDays: number, field = "review-by"): void {
  if (!date) {
    fail(where, `no ${field} date: add "${field}: YYYY-MM-DD", at most ${horizonDays} days out`);
    return;
  }
  if (Number.isNaN(Date.parse(`${date}T00:00:00Z`))) {
    fail(where, `${field} ${date} isn't a date`);
    return;
  }
  const days = daysFromToday(date);
  if (days > horizonDays) fail(where, `${field} ${date} is ${days} days out; the most is ${horizonDays}`);
  else if (days < 0)
    warn(where, `${field} ${date} has passed: look at this suppression again, then fix it or move the date`);
}
function checkReason(where: string, reason: string | undefined): void {
  const text = (reason ?? "").replace(REVIEW_BY, "").trim();
  if (text.length < 30 || WEAK_REASONS.test(text)) {
    fail(where, "the reason must name what is being let through and why it is safe here, in a sentence");
  }
}

const files = execFileSync("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard"], {
  cwd: root,
  encoding: "utf8",
})
  .split("\0")
  .filter((f) => f && existsSync(join(root, f)) && statSync(join(root, f)).isFile());

// 1. Fingerprint and blanket ignore files have nowhere to put a reason.
for (const f of files) {
  if (/(^|\/)\.gitleaksignore$/.test(f))
    fail(f, "a fingerprint list can't carry a reason: use an [[allowlists]] entry in .gitleaks.toml");
  if (/(^|\/)\.semgrepignore$/.test(f) || /(^|\/)\.trivyignore$/.test(f))
    fail(f, "an ignore file can't carry a reason or a date");
}

// 2. Inline suppressions in code, workflows and config.
const INLINE =
  /eslint-disable|@ts-ignore|@ts-expect-error|@ts-nocheck|prettier-ignore|biome-ignore|shellcheck\s+disable=|slither-disable|solhint-disable|forge-lint:\s*disable|forgefmt:\s*disable|zizmor:\s*ignore|gitleaks:allow|nosemgrep|NOSONAR|osv-scanner:\s*ignore/;
const SELF = "scripts/lint-suppressions.ts";
for (const f of files) {
  if (f === SELF || /\.md$/.test(f) || f === "package-lock.json" || /(^|\/)(dist|node_modules)\//.test(f)) continue;
  const raw = readFileSync(join(root, f));
  if (raw.includes(0)) continue;
  const lines = raw.toString("utf8").split("\n");
  lines.forEach((line, i) => {
    if (!INLINE.test(line)) return;
    checked++;
    const where = `${f}:${i + 1}`;
    // A block comment that opens here and closes lines later carries its reason and date as a whole.
    let block = line;
    const opens = line.lastIndexOf("/*");
    if (opens >= 0 && !line.includes("*/", opens)) {
      for (let j = i + 1; j < lines.length; j++) {
        block += ` ${lines[j].trim()}`;
        if (lines[j].includes("*/")) break;
      }
    }
    const carrier = [block, lines[i - 1] ?? ""].find((l) => REVIEW_BY.test(l));
    checkDate(where, carrier ? REVIEW_BY.exec(carrier)?.[1] : undefined, YEAR_DAYS);
    if (carrier) checkReason(where, carrier.replace(INLINE, "").replace(/^[\s/#*-]+|[\s*/]+$/g, ""));
  });
}

// 3. gitleaks: each [[allowlists]] entry's description says what the match is, why it isn't a secret, and
//    carries review-by (gitleaks has no expiry field).
type Block = { header: string; line: number; body: string[] };
function tomlBlocks(text: string): Block[] {
  const blocks: Block[] = [];
  text.split("\n").forEach((line, i) => {
    if (/^\s*\[/.test(line)) blocks.push({ header: line.trim(), line: i + 1, body: [] });
    else blocks.at(-1)?.body.push(line);
  });
  return blocks;
}
function tomlString(body: string[], key: string): string | undefined {
  const line = body.find((l) => new RegExp(`^\\s*${key}\\s*=`).test(l));
  return line?.replace(new RegExp(`^\\s*${key}\\s*=\\s*`), "").replace(/^(['"]{1,3})([\s\S]*)\1\s*$/, "$2");
}
if (existsSync(join(root, ".gitleaks.toml"))) {
  for (const block of tomlBlocks(readFileSync(join(root, ".gitleaks.toml"), "utf8"))) {
    if (!/^\[\[(\w+\.)?allowlists\]\]$/.test(block.header)) continue;
    checked++;
    const where = `.gitleaks.toml:${block.line}`;
    const description = tomlString(block.body, "description");
    checkReason(where, description);
    checkDate(where, description ? REVIEW_BY.exec(description)?.[1] : undefined, YEAR_DAYS);
  }
}

// 4. OSV-Scanner: each ignored advisory names the exposure and expires within 90 days.
for (const f of files.filter((f) => /(^|\/)osv-scanner\.toml$/.test(f))) {
  for (const block of tomlBlocks(readFileSync(join(root, f), "utf8"))) {
    if (block.header !== "[[IgnoredVulns]]" && block.header !== "[[PackageOverrides]]") continue;
    checked++;
    const where = `${f}:${block.line}`;
    if (block.header === "[[IgnoredVulns]]" && !tomlString(block.body, "id"))
      fail(where, "IgnoredVulns needs the advisory id");
    checkReason(where, tomlString(block.body, "reason"));
    const until = tomlString(block.body, "ignoreUntil") ?? tomlString(block.body, "effectiveUntil");
    checkDate(where, until?.match(/\d{4}-\d{2}-\d{2}/)?.[0], OSV_DAYS, "ignoreUntil");
  }
}

// 5. zizmor: an `ignore:` in its config carries a review-by comment.
if (existsSync(join(root, ".github/zizmor.yml"))) {
  const lines = readFileSync(join(root, ".github/zizmor.yml"), "utf8").split("\n");
  lines.forEach((line, i) => {
    if (!/^\s*ignore\s*:/.test(line)) return;
    checked++;
    let j = i + 1;
    while (j < lines.length && /^\s*-/.test(lines[j])) {
      const carrier = [lines[j], lines[j - 1]].find((l) => REVIEW_BY.test(l));
      checkDate(`.github/zizmor.yml:${j + 1}`, carrier ? REVIEW_BY.exec(carrier)?.[1] : undefined, YEAR_DAYS);
      if (carrier) checkReason(`.github/zizmor.yml:${j + 1}`, carrier.replace(/^[\s#-]+/, ""));
      j++;
    }
  });
}

// 6. Slither: each triaged finding in contracts/slither.db.json has a reason and a review date, and the config
//    switches no detector off wholesale.
const triagePath = join(root, "contracts/slither.db.json");
if (existsSync(triagePath)) {
  const entries = JSON.parse(readFileSync(triagePath, "utf8")) as Array<Record<string, unknown>>;
  entries.forEach((entry, i) => {
    checked++;
    const where = `contracts/slither.db.json[${i}] ${String(entry.check ?? "")}`;
    if (typeof entry.id !== "string" || !/^[0-9a-f]{64}$/.test(entry.id))
      fail(where, "needs the finding's id from slither --json");
    if (typeof entry.check !== "string") fail(where, "needs the detector name in `check`");
    checkReason(where, typeof entry.reason === "string" ? entry.reason : undefined);
    checkDate(where, typeof entry.review_by === "string" ? entry.review_by : undefined, YEAR_DAYS, "review_by");
  });
}
// 7. Advisories set aside for a submodule's release in dependency-policy.json, which OSV-Scanner can't see.
const policyPath = join(root, "dependency-policy.json");
if (existsSync(policyPath)) {
  const policy = JSON.parse(readFileSync(policyPath, "utf8")) as {
    submodules?: Record<string, { ignoreAdvisories?: Record<string, { reason?: string; review_by?: string }> }>;
  };
  for (const [path, entry] of Object.entries(policy.submodules ?? {})) {
    for (const [id, ignored] of Object.entries(entry.ignoreAdvisories ?? {})) {
      checked++;
      const where = `dependency-policy.json submodules.${path}.ignoreAdvisories.${id}`;
      checkReason(where, ignored.reason);
      checkDate(where, ignored.review_by, OSV_DAYS, "review_by");
    }
  }
}

const slitherConfig = join(root, "contracts/slither.config.json");
if (existsSync(slitherConfig)) {
  const config = JSON.parse(readFileSync(slitherConfig, "utf8")) as Record<string, unknown>;
  for (const key of [
    "detectors_to_exclude",
    "exclude_informational",
    "exclude_low",
    "exclude_medium",
    "exclude_high",
    "exclude_optimization",
  ]) {
    if (config[key])
      fail(
        `contracts/slither.config.json ${key}`,
        "switches findings off wholesale: triage each finding in contracts/slither.db.json instead",
      );
  }
}

if (failures > 0) {
  console.log(`${failures} suppression problem(s); see docs/security/suppressions.md`);
  process.exit(1);
}
console.log(`suppressions: ${checked} checked, each with a reason and a review date`);
