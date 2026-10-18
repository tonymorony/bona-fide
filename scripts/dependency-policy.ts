// The dependency policy check: docs/security/dependency-policy.md says what each rule is for.
//
//   node scripts/dependency-policy.ts            every rule, with the network lookups (CI runs this)
//   node scripts/dependency-policy.ts --offline  skips the npm owner lookups, `npm audit signatures`
//                                                and the submodule tag lookups, and says so
//   node scripts/dependency-policy.ts --write    refreshes the `resolved` inventory in dependency-policy.json
//                                                from package-lock.json, then checks as usual
//
// It reads package.json files, package-lock.json, .gitmodules and the git index. It installs nothing and
// needs no package beyond Node 24.
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

type Kind = "runtime" | "dev" | "tool";
type DirectEntry = { scope: string[]; kind: Kind; why: string; exit?: string; maintainers: string[] };
type SubmoduleEntry = {
  url: string;
  tag: string;
  commit: string;
  why: string;
  // The package OSV knows this release as, so its advisories are checked too; OSV-Scanner can't see a submodule.
  osv?: { ecosystem: string; name: string };
  // Advisories assessed as not reaching this repo: { "<id>": { reason, review_by } } (docs/security/suppressions.md).
  ignoreAdvisories?: Record<string, { reason: string; review_by: string }>;
};
type Policy = {
  about: string;
  direct: Record<string, DirectEntry>;
  installScripts: Record<string, string>;
  submodules: Record<string, SubmoduleEntry>;
  resolved: string[];
};
type Manifest = {
  name?: string;
  version?: string;
  workspaces?: string[];
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  bundleDependencies?: unknown;
  bundledDependencies?: unknown;
  overrides?: unknown;
};
type LockEntry = Manifest & {
  resolved?: string;
  integrity?: string;
  link?: boolean;
  hasInstallScript?: boolean;
};

const DEP_FIELDS = ["dependencies", "devDependencies", "optionalDependencies"] as const;
const EXACT = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
// An npm alias installs another registry package under the declared name: "npm:<package>@<version>".
const ALIAS = /^npm:((?:@[a-z0-9._-]+\/)?[a-z0-9._-]+)@(.+)$/;
const REGISTRY = "https://registry.npmjs.org/";
const KINDS: Kind[] = ["runtime", "dev", "tool"];

const args = new Set(process.argv.slice(2));
const offline = args.has("--offline");
const write = args.has("--write");
for (const arg of args) {
  if (arg !== "--offline" && arg !== "--write") {
    console.error(`unknown argument ${arg}; use --offline and/or --write`);
    process.exit(2);
  }
}

const root = execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim();
const policyPath = join(root, "dependency-policy.json");
const inCi = process.env.GITHUB_ACTIONS === "true";
const findings: string[] = [];
const warnings: string[] = [];
const notes: string[] = [];

function fail(rule: number, message: string): void {
  findings.push(`rule ${rule}: ${message}`);
}
function warn(message: string): void {
  warnings.push(message);
}
function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, "utf8")) as T;
}
function git(...gitArgs: string[]): string {
  return execFileSync("git", gitArgs, { cwd: root, encoding: "utf8" });
}
function sameSet(a: string[], b: string[]): boolean {
  const x = [...new Set(a)].sort();
  const y = [...new Set(b)].sort();
  return x.length === y.length && x.every((v, i) => v === y[i]);
}
// The package a lockfile path holds: its own name when it is installed under an alias, else the folder's.
function packageNameOf(lockPath: string, entry?: LockEntry): string {
  return entry?.name ?? lockPath.slice(lockPath.lastIndexOf("node_modules/") + "node_modules/".length);
}
// The registry package and version a declared dependency installs: itself, or what an npm alias names.
function target(name: string, spec: string): { name: string; version: string; alias: boolean } {
  const alias = ALIAS.exec(spec);
  return alias ? { name: alias[1], version: alias[2], alias: true } : { name, version: spec, alias: false };
}

const policy = readJson<Policy>(policyPath);
const rootManifest = readJson<Manifest>(join(root, "package.json"));
const lock = readJson<{ lockfileVersion: number; packages: Record<string, LockEntry> }>(
  join(root, "package-lock.json"),
);
const workspaces = rootManifest.workspaces ?? [];
const manifests = new Map<string, Manifest>([["", rootManifest]]);
for (const ws of workspaces) manifests.set(ws, readJson<Manifest>(join(root, ws, "package.json")));
const workspaceVersions = new Map<string, string>();
for (const ws of workspaces) {
  const m = manifests.get(ws)!;
  if (m.name) workspaceVersions.set(m.name, m.version ?? "");
}
const label = (ws: string): string => (ws === "" ? "the root" : ws);

// Rule 1: every dependency is an exact version from the npm registry, and the lockfile matches.
if (lock.lockfileVersion !== 3)
  fail(1, `package-lock.json is lockfileVersion ${lock.lockfileVersion}; npm 7+ writes 3`);
if (rootManifest.overrides !== undefined) {
  fail(1, "the root package.json has `overrides`: pin the dependency that needs it instead");
}
for (const [ws, manifest] of manifests) {
  const where = `${ws === "" ? "" : ws + "/"}package.json`;
  if (manifest.bundleDependencies !== undefined || manifest.bundledDependencies !== undefined) {
    fail(1, `${where} bundles dependencies, which the lockfile can't pin`);
  }
  const lockEntry = lock.packages[ws];
  if (!lockEntry) {
    fail(1, `package-lock.json has no entry for ${label(ws)}: run npm install and commit the lockfile`);
    continue;
  }
  for (const field of DEP_FIELDS) {
    const declared = manifest[field] ?? {};
    for (const [name, spec] of Object.entries(declared)) {
      if (workspaceVersions.has(name)) {
        if (spec !== workspaceVersions.get(name)) {
          fail(
            1,
            `${where} ${field}.${name} is "${spec}"; a workspace package is pinned to its own version, "${workspaceVersions.get(name)}"`,
          );
        }
        if (!lock.packages[`node_modules/${name}`]?.link) {
          fail(1, `${name} doesn't resolve to the workspace in package-lock.json: run npm install`);
        }
        continue;
      }
      // An alias to an exact registry version, such as "npm:@typescript/typescript6@6.0.2", is pinned too.
      const wanted = target(name, spec);
      if (!EXACT.test(wanted.version)) {
        fail(
          1,
          `${where} ${field}.${name} is "${spec}": write the exact version, such as "1.2.3" or "npm:<package>@1.2.3" (no ^, ~, ranges, tags, git, file or URL sources)`,
        );
        continue;
      }
      const resolved =
        lock.packages[`${ws === "" ? "" : ws + "/"}node_modules/${name}`] ?? lock.packages[`node_modules/${name}`];
      if (!resolved)
        fail(1, `${name} (${where}) is missing from package-lock.json: run npm install and commit the lockfile`);
      else if (resolved.version !== wanted.version || (resolved.name ?? name) !== wanted.name) {
        fail(
          1,
          `${name} is pinned to ${spec} in ${where} but package-lock.json resolves ${resolved.name ?? name}@${resolved.version}: run npm install and commit the lockfile`,
        );
      }
    }
    const locked = lockEntry[field] ?? {};
    if (
      !sameSet(Object.keys(declared), Object.keys(locked)) ||
      Object.entries(declared).some(([n, s]) => locked[n] !== s)
    ) {
      fail(
        1,
        `${where} ${field} differ from package-lock.json, so npm ci would fail: run npm install and commit the lockfile`,
      );
    }
  }
}
for (const [path, entry] of Object.entries(lock.packages)) {
  if (!path.includes("node_modules/") || entry.link) continue;
  if (!entry.resolved?.startsWith(REGISTRY)) {
    fail(1, `${path} resolves from ${entry.resolved ?? "nowhere"}; every package comes from ${REGISTRY}`);
  }
  if (!entry.integrity?.startsWith("sha512-")) fail(1, `${path} has no sha512 integrity hash in package-lock.json`);
}
// A direct dependency's optional dependencies, such as rolldown's native binding for each platform, stay in the
// lockfile. Some npm releases drop the ones that don't match the machine they run on; npm ci on Linux, in CI and
// in the Docker image, then installs no binding and the package fails to load.
const lockPaths = Object.keys(lock.packages);
for (const [ws, manifest] of manifests) {
  for (const field of DEP_FIELDS) {
    for (const name of Object.keys(manifest[field] ?? {})) {
      if (workspaceVersions.has(name)) continue;
      const entry =
        lock.packages[`${ws === "" ? "" : ws + "/"}node_modules/${name}`] ?? lock.packages[`node_modules/${name}`];
      for (const optional of Object.keys(entry?.optionalDependencies ?? {})) {
        if (!lockPaths.some((path) => path.endsWith(`node_modules/${optional}`))) {
          fail(
            1,
            `${name} lists the optional dependency ${optional}, which package-lock.json lacks, so npm ci won't install it on any platform: regenerate the lockfile with a current npm and check the diff`,
          );
        }
      }
    }
  }
}

// Rule 2: every direct dependency is justified, in the workspaces that use it, as the kind it is.
type Use = { workspaces: Set<string>; runtimeIn: Set<string> };
const uses = new Map<string, Use>();
for (const [ws, manifest] of manifests) {
  for (const field of DEP_FIELDS) {
    for (const [declared, spec] of Object.entries(manifest[field] ?? {})) {
      if (workspaceVersions.has(declared)) continue;
      // An alias is justified as the package it installs: that is the code that runs, and whose publishers count.
      const name = target(declared, spec).name;
      const use = uses.get(name) ?? { workspaces: new Set<string>(), runtimeIn: new Set<string>() };
      use.workspaces.add(ws === "" ? "." : ws);
      if (field === "dependencies") use.runtimeIn.add(ws === "" ? "." : ws);
      uses.set(name, use);
    }
  }
}

const importCache = new Map<string, Set<string>>();
// The packages that a workspace's shipped source imports: everything git tracks except tests.
function importsOf(ws: string): Set<string> {
  const cached = importCache.get(ws);
  if (cached) return cached;
  const found = new Set<string>();
  const files = git("ls-files", "-z", "--", ws === "." ? "scripts" : ws)
    .split("\0")
    .filter((f) => /\.(m|c)?[jt]s$/.test(f))
    .filter((f) => !/(^|\/)test\//.test(f) && !/\.test\.[jt]s$/.test(f));
  const specifier = /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+|\brequire\s*\(\s*)["']([^"'./][^"']*)["']/g;
  for (const file of files) {
    const text = readFileSync(join(root, file), "utf8");
    for (const match of text.matchAll(specifier)) {
      const spec = match[1];
      if (spec.startsWith("node:")) continue;
      const parts = spec.split("/");
      found.add(spec.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0]);
    }
  }
  importCache.set(ws, found);
  return found;
}

for (const [name, use] of [...uses].sort(([a], [b]) => a.localeCompare(b))) {
  const entry = policy.direct[name];
  if (!entry) {
    fail(
      2,
      `${name} is a direct dependency of ${[...use.workspaces].join(", ")} but has no entry in dependency-policy.json "direct": add scope, kind, why, maintainers (docs/security/dependency-policy.md)`,
    );
    continue;
  }
  if (!Array.isArray(entry.scope) || !sameSet(entry.scope, [...use.workspaces])) {
    fail(
      2,
      `${name}: scope is ${JSON.stringify(entry.scope)} but the workspaces that declare it are ${JSON.stringify([...use.workspaces].sort())}`,
    );
  }
  if (!KINDS.includes(entry.kind)) fail(2, `${name}: kind must be one of ${KINDS.join(", ")}`);
  if (typeof entry.why !== "string" || entry.why.trim().length < 30 || /\b(todo|tbd)\b/i.test(entry.why)) {
    fail(2, `${name}: "why" must say what the package does for this repo, in a sentence`);
  }
  if (entry.exit !== undefined && (typeof entry.exit !== "string" || entry.exit.trim().length < 10)) {
    fail(2, `${name}: "exit", when present, says what it would take to drop the package`);
  }
  if (!Array.isArray(entry.maintainers) || entry.maintainers.length === 0) {
    fail(4, `${name}: "maintainers" must list the npm accounts it was reviewed under`);
  }
  if (entry.kind === "runtime") {
    if (use.runtimeIn.size === 0) {
      fail(2, `${name} is kind "runtime" but no workspace lists it in "dependencies"; make it dev or tool, or move it`);
    } else if (![...use.runtimeIn].some((ws) => importsOf(ws).has(name))) {
      fail(
        2,
        `${name} is a runtime dependency of ${[...use.runtimeIn].join(", ")} but no source file there imports it: remove it`,
      );
    }
  } else if (use.runtimeIn.size > 0) {
    fail(
      2,
      `${name} is kind "${entry.kind}" but ${[...use.runtimeIn].join(", ")} lists it in "dependencies", which ships it`,
    );
  }
}
for (const name of Object.keys(policy.direct)) {
  if (!uses.has(name))
    fail(2, `dependency-policy.json lists ${name}, which no package.json declares: remove its entry`);
}

// Rule 3: every package in the lockfile has been looked at.
const resolvedNames = [
  ...new Set(
    Object.entries(lock.packages)
      .filter(([path, entry]) => path.includes("node_modules/") && !entry.link)
      .map(([path, entry]) => packageNameOf(path, entry)),
  ),
].sort();
const known = new Set(policy.resolved);
const added = resolvedNames.filter((n) => !known.has(n));
const removed = policy.resolved.filter((n) => !resolvedNames.includes(n));
if (write) {
  policy.resolved = resolvedNames;
  writeFileSync(policyPath, JSON.stringify(policy, null, 2) + "\n");
  notes.push(`--write: the inventory now holds ${resolvedNames.length} names`);
  for (const n of added) notes.push(`new: ${n}  (review it: who publishes it, its licence, what it pulls in)`);
  for (const n of removed) notes.push(`gone: ${n}`);
} else {
  for (const n of added) {
    fail(
      3,
      `${n} is in package-lock.json but not in the reviewed inventory: review it, then run node scripts/dependency-policy.ts --write and commit the diff`,
    );
  }
  for (const n of removed)
    warn(`${n} is in the inventory but no longer in package-lock.json: run node scripts/dependency-policy.ts --write`);
}

// Rule 6: install scripts run code at install time, so each one is acknowledged.
const withScripts = new Set(
  Object.entries(lock.packages)
    .filter(([path, entry]) => path.includes("node_modules/") && !entry.link && entry.hasInstallScript)
    .map(([path, entry]) => packageNameOf(path, entry)),
);
for (const name of withScripts) {
  const reason = policy.installScripts?.[name];
  if (typeof reason !== "string" || reason.trim().length < 30) {
    fail(
      6,
      `${name} has an install script: read it, then add it to "installScripts" with what it does and why that's acceptable`,
    );
  }
}
for (const name of Object.keys(policy.installScripts ?? {})) {
  if (!withScripts.has(name))
    warn(`installScripts lists ${name}, which no longer has an install script: remove the entry`);
}

// Rule 7: the contracts' git submodules sit on tagged releases of their upstream.
const gitmodules = new Map<string, string>();
if (existsSync(join(root, ".gitmodules"))) {
  const lines = git("config", "-f", ".gitmodules", "--get-regexp", "^submodule\\..*\\.(path|url)$").trim().split("\n");
  const byName = new Map<string, { path?: string; url?: string }>();
  for (const line of lines) {
    const [key, value] = line.split(" ");
    const m = /^submodule\.(.*)\.(path|url)$/.exec(key);
    if (!m) continue;
    const item = byName.get(m[1]) ?? {};
    item[m[2] as "path" | "url"] = value;
    byName.set(m[1], item);
  }
  for (const { path, url } of byName.values()) if (path && url) gitmodules.set(path, url);
}
const gitlinks = new Map<string, string>();
for (const line of git("ls-files", "--stage").split("\n")) {
  const m = /^160000 ([0-9a-f]{40}) \d\t(.*)$/.exec(line);
  if (m) gitlinks.set(m[2], m[1]);
}
const submoduleChecks: Array<{ path: string; entry: SubmoduleEntry }> = [];
for (const [path, commit] of gitlinks) {
  const entry = policy.submodules?.[path];
  if (!entry) {
    fail(
      7,
      `submodule ${path} is not in dependency-policy.json "submodules": add its url, the release tag it sits on, its commit and why`,
    );
    continue;
  }
  if (gitmodules.get(path) !== entry.url)
    fail(7, `${path}: .gitmodules says ${gitmodules.get(path)}, the policy says ${entry.url}`);
  if (entry.commit !== commit) {
    fail(
      7,
      `${path} is at ${commit} but the policy pins ${entry.commit} (${entry.tag}): check out a release tag and record it`,
    );
  }
  if (!/^v?\d+\.\d+\.\d+$/.test(entry.tag ?? "")) fail(7, `${path}: "tag" must be the release tag, such as v1.2.3`);
  if (typeof entry.why !== "string" || entry.why.trim().length < 30)
    fail(7, `${path}: "why" must say what the contracts use it for`);
  submoduleChecks.push({ path, entry });
}
for (const path of Object.keys(policy.submodules ?? {})) {
  if (!gitlinks.has(path)) fail(7, `dependency-policy.json lists submodule ${path}, which the repo no longer has`);
}

// The checks that need the network.
async function fetchWithRetry(url: string, timeoutMs: number, init: RequestInit = {}): Promise<Response> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
    } catch (error) {
      if (attempt === 3) throw error;
      await new Promise((resolve) => setTimeout(resolve, attempt * 2000));
    }
  }
}
async function owners(name: string): Promise<string[]> {
  // The collaborators endpoint names every account that can publish the package, in a few hundred bytes. The
  // packument's `maintainers` says the same, but for typescript or @types/node it is tens of megabytes.
  const encoded = name.replace("/", "%2F");
  const response = await fetchWithRetry(`${REGISTRY}-/package/${encoded}/collaborators`, 30_000);
  if (response.ok) return Object.keys((await response.json()) as Record<string, string>);
  const packument = await fetchWithRetry(`${REGISTRY}${encoded}`, 120_000);
  if (!packument.ok) throw new Error(`the registry answered ${response.status}, then ${packument.status}`);
  const body = (await packument.json()) as { maintainers?: Array<{ name: string }> };
  return (body.maintainers ?? []).map((m) => m.name);
}

if (offline) {
  notes.push(
    "--offline: skipped rule 4 (npm owners), rule 5 (npm audit signatures) and the submodule tag lookups of rule 7",
  );
} else {
  // Rule 4: a package that changes hands fails here.
  await Promise.all(
    Object.entries(policy.direct).map(async ([name, entry]) => {
      try {
        const now = await owners(name);
        if (!sameSet(now, entry.maintainers ?? [])) {
          const gained = now.filter((n) => !entry.maintainers.includes(n));
          const lost = (entry.maintainers ?? []).filter((n) => !now.includes(n));
          fail(
            4,
            `${name} can now be published by a different set of npm accounts (added: ${gained.join(", ") || "none"}; removed: ${lost.join(", ") || "none"}). Find out why before you update "maintainers"`,
          );
        }
      } catch (error) {
        fail(4, `couldn't look up who publishes ${name}: ${(error as Error).message}. A failed lookup is not a pass`);
      }
    }),
  );

  // Rule 5: registry signatures and provenance attestations of everything installed.
  if (!existsSync(join(root, "node_modules"))) {
    fail(5, "node_modules is missing, so npm audit signatures has nothing to check: run npm ci --ignore-scripts first");
  } else {
    const audit = spawnSync("npm", ["audit", "signatures"], { cwd: root, encoding: "utf8" });
    const output = `${audit.stdout}${audit.stderr}`.trim();
    if (audit.status !== 0) fail(5, `npm audit signatures failed:\n${output}`);
    else notes.push(`npm audit signatures: ${output.split("\n").filter(Boolean).join("; ")}`);
  }

  // Rule 7, online: the recorded tag still points at the recorded commit upstream.
  for (const { path, entry } of submoduleChecks) {
    try {
      const refs = execFileSync(
        "git",
        ["ls-remote", "--tags", entry.url, `refs/tags/${entry.tag}`, `refs/tags/${entry.tag}^{}`],
        {
          encoding: "utf8",
          timeout: 60_000,
        },
      );
      const lines = refs.trim().split("\n").filter(Boolean);
      const peeled = lines.find((l) => l.endsWith("^{}")) ?? lines[0];
      const upstream = peeled?.split("\t")[0];
      if (!upstream) fail(7, `${path}: ${entry.url} has no tag ${entry.tag}`);
      else if (upstream !== entry.commit) {
        fail(
          7,
          `${path}: upstream tag ${entry.tag} points at ${upstream}, not the pinned ${entry.commit}. A moved tag needs a person to look`,
        );
      }
    } catch (error) {
      fail(
        7,
        `couldn't list ${entry.url}'s tags: ${(error as Error).message.split("\n")[0]}. A failed lookup is not a pass`,
      );
    }
    if (!entry.osv) continue;
    try {
      const response = await fetchWithRetry("https://api.osv.dev/v1/query", 30_000, {
        method: "POST",
        body: JSON.stringify({ package: entry.osv, version: entry.tag.replace(/^v/, "") }),
      });
      if (!response.ok) throw new Error(`api.osv.dev answered ${response.status}`);
      const { vulns = [] } = (await response.json()) as { vulns?: Array<{ id: string; summary?: string }> };
      for (const vuln of vulns) {
        if (entry.ignoreAdvisories?.[vuln.id]) continue;
        fail(
          7,
          `${path} (${entry.osv.name} ${entry.tag}) is affected by ${vuln.id}: ${vuln.summary ?? ""}. Assess it against the deployed contracts`,
        );
      }
    } catch (error) {
      fail(
        7,
        `couldn't query OSV for ${entry.osv.name} ${entry.tag}: ${(error as Error).message}. A failed lookup is not a pass`,
      );
    }
  }
}

// Report.
const directCount = Object.keys(policy.direct).length;
console.log(
  `dependency policy: ${directCount} direct dependencies, ${resolvedNames.length} resolved packages, ${withScripts.size} with install scripts, ${gitlinks.size} submodules`,
);
for (const note of notes) console.log(note);
for (const w of warnings) console.log(inCi ? `::warning::${w}` : `warning: ${w}`);
if (findings.length > 0) {
  for (const f of findings) console.log(inCi ? `::error::${f.replaceAll("\n", "%0A")}` : `FAIL ${f}`);
  console.log(`${findings.length} finding(s); docs/security/dependency-policy.md says how to resolve each rule`);
  process.exit(1);
}
console.log("dependency policy: ok");
