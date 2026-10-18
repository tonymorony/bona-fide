# Dependency policy

Every package Bona Fide installs is code that runs next to the Keeper's key, the App's GitHub credentials and
the pages where people sign USDC authorizations. So each one is pinned, has a reason to be here, and was
looked at before it arrived; and the `security` check fails when any of that stops being true.

[`scripts/dependency-policy.ts`](../../scripts/dependency-policy.ts) checks the rules below against
[`dependency-policy.json`](../../dependency-policy.json). It needs Node 24 and nothing else.

## The rules

1. **Everything is pinned exactly.** Every dependency, dev dependency and optional dependency in every
   workspace's `package.json` is an exact version, such as `"2.56.9"`: no `^`, `~`, ranges, tags, or git, file
   or URL sources. An npm alias to an exact registry version, such as `"npm:@typescript/typescript6@6.0.2"`, is
   pinned too: the lockfile must resolve that package at that version under the declared name, and rules 2 to 4
   treat it as the package it installs. A workspace package (`@bona-fide/sdk`) is pinned to its own version
   and resolves to the workspace. `package-lock.json` is committed and agrees with every `package.json`, so `npm ci` installs it
   unchanged; every package in it comes from `registry.npmjs.org` with a `sha512` integrity hash. No
   `overrides`, no bundled dependencies. Every optional dependency of a direct dependency is in the lockfile:
   some npm releases (11.6 among them) drop the platform binaries that don't match the machine they run on,
   and `npm ci` on Linux would then install no rolldown binding at all.
2. **Every direct dependency is justified.** `direct` in `dependency-policy.json` lists each one with:
   - `scope`: the workspaces that declare it;
   - `kind`: `runtime` (ships with the App, the agent, the pages or the SDK), `dev` (tests, builds, types) or
     `tool` (a command the scripts run, such as `tsc` or `prettier`);
   - `why`: what it does for this repo, in a sentence;
   - `exit` (optional): what it would take to drop it.

   A `runtime` entry must be in some workspace's `dependencies`, and a source file there (not a test) must
   import it; a dead one is removed, not carried. A `dev` or `tool` entry must never be in `dependencies`.
3. **Every resolved package has been looked at.** `resolved` is the inventory of every package name in
   `package-lock.json`. A name that isn't in it fails until someone reviews the package and refreshes the
   inventory with `--write`; the diff shows the growth in review. A name that left the lockfile only warns.
4. **Each direct dependency's publishers are pinned.** `maintainers` lists the npm accounts that could publish
   the package when it was reviewed. The check asks the registry who can publish it now
   (`https://registry.npmjs.org/-/package/<name>/collaborators`, falling back to the `maintainers` of
   `https://registry.npmjs.org/<name>`) and fails on any difference. An exact pin says which bytes run today;
   this is what catches a package that changed hands before its next release is installed. A lookup that
   fails is a failure, not a pass.
5. **Signatures and provenance verify.** `npm audit signatures` checks the registry signature of every
   installed package, and the provenance attestation of those that publish one.
6. **Install scripts are acknowledged.** A package with an install script runs code at install time.
   `installScripts` lists each one with what it does and why that is acceptable; a new one fails. There are
   one today, fsevents (macOS only), and CI and the Docker image install with `--ignore-scripts` anyway.
7. **The contracts' submodules sit on release tags.** `submodules` records, for each git submodule under
   `contracts/lib`, its upstream URL, the release tag and that tag's commit. The check fails when the
   submodule's commit isn't the recorded one, and, online, when the upstream tag no longer points at it. For
   OpenZeppelin it also asks [OSV](https://osv.dev) about `@openzeppelin/contracts` at that version, since
   OSV-Scanner can't see a submodule. The contracts on Arc were built from these tags: moving a tag changes
   only the next deployment.

`--offline` skips the network: rule 4, rule 5 and the online half of rule 7. It says so in its output. CI
always runs online.

## The `security` check

[`.github/workflows/security.yml`](../../.github/workflows/security.yml) runs on every pull request, on pushes
to `main` and `develop`, every Monday, and on demand. It is one job, `security`, a required status check like
`check`. On the public repository a ruleset on `main` and `develop` requires both. The private working
repository can't hold a ruleset on its GitHub plan, so there the orchestrator merges only through
[`scripts/merge-guard.sh`](../../scripts/merge-guard.sh), which refuses unless both are green GitHub Actions
runs on the head commit. Each step runs [`scripts/security.sh`](../../scripts/security.sh) and is `continue-on-error`, so a
failing step doesn't hide the others; the last step fails the job and writes a table of results to the run's
summary.

| Step | Tool (pinned version) | What it catches |
|---|---|---|
| `workflows` | zizmor 1.30.1, actionlint 1.7.12 with shellcheck 0.11.0, `lint-unpinned-installs.sh`, `lint-suppressions.ts` | Workflow injection, over-broad permissions, persisted credentials, actions not pinned to a commit SHA, known-vulnerable or impostor actions; workflow and shell mistakes; `npm install`, `npx`, unhashed `pip install` or `curl \| sh` in CI and deploy scripts; a Foundry in `check.yml` other than the pinned forge; suppressions without a reason or a date |
| `secrets` | gitleaks 8.30.1 | Credentials in the pull request's commits, or in the whole history on `main`, `develop` and the weekly run |
| `scrub` | `scrub.sh` | Words from the `SCRUB_WORDS` secret in the tree, its paths, or the new commit messages. It prints the file and line, never the word, and names a file whose path holds a word by its position in `git ls-files`. A commit range git can't list fails. With no words it checks nothing and reports "skipped", with a warning, never "pass" |
| `vulnerabilities` | OSV-Scanner 2.6.0 | Known advisories in every lockfile, found recursively: `package-lock.json` and `contracts/slither/requirements.txt` today, and any added later. No lockfile at all is a failure too |
| `dependency-policy` | `scripts/dependency-policy.ts` on Node 24.21.0 | Rules 1 to 7 above, after `npm ci --ignore-scripts` |
| `contracts` | Slither 0.11.6 on Python 3.13.16, forge 1.8.5, solc 0.8.30 | Any Slither finding in `contracts/src` that [`contracts/slither.db.json`](../../contracts/slither.db.json) doesn't triage |

The scanners are release binaries listed in [`.github/pinned-tools.txt`](../../.github/pinned-tools.txt) with
their version and SHA-256, for Linux x64 (CI) and macOS arm64 (an Intel shell under Rosetta on Apple silicon
gets the arm64 binaries; an Intel Mac has no rows). [`fetch-pinned.sh`](../../.github/scripts/fetch-pinned.sh)
downloads them and checks the hash before anything runs them, and hashes a cached copy again before it trusts
it. The hashes come from each release's own checksum file where it publishes one, and otherwise from
GitHub's digest of the release asset. Slither is installed with
`pip install --require-hashes --no-deps --only-binary :all:` from
[`contracts/slither/requirements.txt`](../../contracts/slither/requirements.txt), and the contracts are built
with the pinned solc and no downloads (`FOUNDRY_OFFLINE`). Every action in the workflow is pinned to a full
commit SHA, with its version in a comment.

## Run it locally

```shell
npm run security                      # every step: the same commands CI runs
npm run security -- --offline         # without the network: skips the OSV scan and the online policy checks
scripts/security.sh contracts secrets # just some steps
```

The first run downloads the pinned tools into `$TMPDIR/bona-fide-pinned-bin` (set `PINNED_BIN` to choose) and
installs Slither in a virtualenv there. `--offline` downloads nothing and uses what is already there, once it
hashes the same as when it was installed. The `contracts` step uses
`python3`, or `PYTHON` if set; it should be Python 3.13 for your platform, since only prebuilt wheels are
accepted. The `scrub` step reads `SCRUB_WORDS`, or a file named by `SCRUB_WORDS_FILE`, and checks the commits
that no remote has yet; with no words it warns and reports "skipped".

## Add a dependency

1. Ask whether Node, the SDK or twenty lines of our own would do. A package is the last resort; prefer one
   that is maintained, permissively licensed and brings few dependencies, and never one that fetches code or
   assets at run time.
2. Add it at an exact version in the workspace that needs it, for example `npm install --save-exact zod@4.6.5
   --workspace app`, and commit `package-lock.json` with it.
3. Add its `direct` entry: `scope`, `kind`, `why`, and `exit` if there is an honest one. Copy `maintainers`
   from `curl -s https://registry.npmjs.org/-/package/<name>/collaborators`, and look at who they are; typing
   them is the review.
4. Run `node scripts/dependency-policy.ts --write`, read the `new:` names it prints (who publishes each, its
   licence, what it pulls in, whether it has an install script), and commit the inventory diff.
5. Run `npm run security`.

## Bump one

Dependabot proposes npm, Actions, submodule and Slither updates (see
[`.github/dependabot.yml`](../../.github/dependabot.yml)): weekly for npm and Actions, monthly for the rest,
grouped, once a release is 7 days old, keeping exact pins exact. A bump by hand is `npm install --save-exact
<name>@<version> --workspace <workspace>`. Either way the policy check runs on it:

- a new transitive package fails rule 3: review it and run `--write`;
- a package whose publishers changed fails rule 4: find out why (a new team member, a transfer, a hijacked
  account) before you update `maintainers`;
- a submodule bump fails rule 7 unless it lands on a release tag. Dependabot proposes the branch head, so move
  the submodule to the newest release tag instead (`git -C contracts/lib/<name> checkout <tag>`), and record
  the tag and commit.

A scanner is bumped by hand in `.github/pinned-tools.txt`, both platforms, with the hash from the release's
checksum file. Slither is bumped in `contracts/slither/requirements.in`, then recompiled with the `uv pip
compile` line at the top of that file. Node and Python are pinned in the workflow.

## Remove one

Remove it from `package.json`, run `npm install`, delete its `direct` entry, run `--write`. Always welcome.

## Triage a Slither finding

The contracts are deployed and immutable, so a finding in `contracts/src` can't be fixed on Arc. Every
finding in today's code has been read once and recorded in `contracts/slither.db.json` with a reason and a
`review_by` date (the list is in [suppressions.md](suppressions.md)). A new finding fails the step. To clear
it, either change the code for the next deployment, or add its entry: run the step to see it, copy its `id`,
`check`, `impact`, `confidence` and `description` from `slither contracts --json -`, and write why it can't
cost anyone funds. Slither's ids include line numbers, so editing a contract can turn an old finding into a
new one; read it again rather than copying the old reason.

## Deliberate deviations

- **The root's `typescript` is TypeScript 6, under an alias.** ESLint's typed rules come from typescript-eslint,
  which needs TypeScript's JavaScript API, and TypeScript 7 (the compiler every workspace type-checks with)
  doesn't have it yet. So the root declares `"typescript": "npm:@typescript/typescript6@6.0.2"`, as Microsoft's
  7.0 notes advise, for ESLint only, and each workspace keeps `typescript` 7.0.2 for `tsc`. Its entry in
  `direct` is `@typescript/typescript6`, with that package's publishers. Drop the alias once typescript-eslint
  reads TypeScript 7.

- **`peerDependencies` may be a range.** The SDK declares `viem` as `^2.56.9` so that apps using it choose
  their own viem. Nothing is installed from a peer range here: the SDK's dev dependency and the lockfile pin
  the viem the repo runs.
- **Publishers are checked for direct dependencies only.** The direct set chooses the transitive set; new
  transitive names are caught by rule 3 and their advisories by OSV-Scanner. One request per resolved package
  would be 131 requests per run for names nobody picked.
- **The collaborators endpoint, not the packument.** Both give the accounts that can publish. The packument
  for `typescript` or `@types/node` is tens of megabytes; the endpoint is a few hundred bytes. The check
  falls back to the packument if the endpoint stops answering.
- **OSV-Scanner skips `contracts/lib`.** Those lockfiles are OpenZeppelin's and forge-std's own development
  tooling, which this repo never installs. The submodules are covered by rule 7 instead.
- **Slither's triage file is the only way to quiet it.** Inline `slither-disable` comments would mean editing
  `contracts/src`, and switching a detector off in `contracts/slither.config.json` would hide every future
  finding of that kind; the suppression lint refuses both.
- **No code scanning upload.** The job keeps `contents: read` and nothing else. Findings fail the job and
  appear in its log and summary instead of the Security tab.
- **Not yet pinned: the Docker base image.** [`deploy/Dockerfile`](../../deploy/Dockerfile) starts `FROM
  node:24-alpine`, a tag that moves. Pinning it by digest, with a `docker` entry in Dependabot, would close
  that gap; it changes what the next deploy builds, so it is left to a separate change.
