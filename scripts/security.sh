#!/usr/bin/env bash
# The security check, one step at a time or all of them: the same commands CI's `security` job runs.
#
#   scripts/security.sh                     every step (npm run security)
#   scripts/security.sh --offline           every step that works without the network (npm run security -- --offline)
#   scripts/security.sh secrets contracts   just those steps
#
# Steps: workflows secrets scrub vulnerabilities dependency-policy contracts
#
# The scanners are the release binaries pinned in .github/pinned-tools.txt, downloaded once into $PINNED_BIN
# and checked against their SHA-256 before they run. --offline uses what is already there and skips the
# vulnerability scan, which needs the OSV database. docs/security/dependency-policy.md says what each step
# checks and what to do when one fails.
set -uo pipefail

root=$(git rev-parse --show-toplevel)
cd "$root" || exit 2

offline=0
steps=()
for arg in "$@"; do
	case "$arg" in
	--offline) offline=1 ;;
	workflows | secrets | scrub | vulnerabilities | dependency-policy | contracts) steps+=("$arg") ;;
	*)
		echo "unknown argument: $arg" >&2
		exit 2
		;;
	esac
done
[ "${#steps[@]}" -gt 0 ] || steps=(workflows secrets scrub vulnerabilities dependency-policy contracts)

if [ -n "${PINNED_BIN:-}" ]; then
	:
elif [ -n "${RUNNER_TEMP:-}" ]; then
	PINNED_BIN=$RUNNER_TEMP/pinned-bin
else
	PINNED_BIN=${TMPDIR:-/tmp}/bona-fide-pinned-bin
fi
export PINNED_BIN
export PATH="$PINNED_BIN:$PATH"

say() { printf '\n== %s\n' "$*"; }

# Install the pinned tools a step needs. Offline, nothing is downloaded, but what is already installed is
# hashed again before it runs, as online.
need() {
	if [ "$offline" = 1 ]; then
		.github/scripts/fetch-pinned.sh --offline "$@"
	else
		.github/scripts/fetch-pinned.sh "$@"
	fi
}

step_workflows() {
	need zizmor actionlint shellcheck || return 1
	local status=0
	# zizmor's online audits (impostor commits, known-vulnerable actions) need a token: CI passes the job's
	# read-only GITHUB_TOKEN as GH_TOKEN. Without one, zizmor runs its offline audits.
	if [ "$offline" = 1 ] || [ -z "${GH_TOKEN:-}" ]; then
		zizmor --config .github/zizmor.yml --no-progress --offline .github/ || status=1
	else
		zizmor --config .github/zizmor.yml --no-progress .github/ || status=1
	fi
	# actionlint runs shellcheck over every run: block, but silently skips that if shellcheck is missing.
	if ! command -v shellcheck >/dev/null; then
		echo "shellcheck isn't on PATH, so actionlint would skip the shell in run: blocks"
		return 1
	fi
	actionlint -pyflakes= || status=1
	shellcheck .github/scripts/*.sh scripts/*.sh || status=1
	.github/scripts/lint-unpinned-installs.sh || status=1
	node scripts/lint-suppressions.ts || status=1
	return "$status"
}

step_secrets() {
	need gitleaks || return 1
	# GITLEAKS_LOG_OPTS narrows the history, for example to a pull request's commits. CI checks out only the
	# pull request's commits, so it scans the whole clone; on main, develop and the weekly run, the whole history.
	local opts=()
	[ -z "${GITLEAKS_LOG_OPTS:-}" ] || opts=(--log-opts "$GITLEAKS_LOG_OPTS")
	gitleaks git --config .gitleaks.toml --redact --no-banner --exit-code 1 -v ${opts[@]+"${opts[@]}"} .
}

step_scrub() {
	.github/scripts/scrub.sh
}

step_vulnerabilities() {
	if [ "$offline" = 1 ]; then
		echo "skipped: OSV-Scanner needs the network to read the vulnerability database"
		return 3
	fi
	need osv-scanner || return 1
	# Recursive, so a lockfile added anywhere is scanned. contracts/lib holds the contracts' git submodules:
	# their lockfiles are OpenZeppelin's and forge-std's own development tooling, which this repo never installs.
	# The submodules themselves are pinned to release tags by the dependency policy (rule 7).
	# Exit 1 means vulnerabilities, 128 means no lockfile was found: both fail.
	local code=0 args=(scan source --recursive --experimental-exclude 'r:contracts/lib' .)
	if [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then
		osv-scanner "${args[@]}" --format markdown --output-file "${RUNNER_TEMP:-/tmp}/osv.md" >/dev/null 2>&1
		{
			echo '### OSV-Scanner'
			echo
			cat "${RUNNER_TEMP:-/tmp}/osv.md" 2>/dev/null || echo "No report."
		} >>"$GITHUB_STEP_SUMMARY"
	fi
	osv-scanner "${args[@]}" --format table || code=$?
	return "$code"
}

step_dependency_policy() {
	if [ "$offline" = 1 ]; then
		node scripts/dependency-policy.ts --offline
	else
		node scripts/dependency-policy.ts
	fi
}

step_contracts() {
	need forge solc || return 1
	local python=${PYTHON:-python3} req=contracts/slither/requirements.txt hash venv work
	if ! "$python" -c 'import sys; sys.exit(0 if sys.version_info[:2] == (3, 13) else 1)' 2>/dev/null; then
		echo "warning: $python is not Python 3.13, the version CI runs Slither with; set PYTHON to a 3.13 interpreter"
	fi
	hash=$(git hash-object "$req")
	venv="$PINNED_BIN/slither-venv-${hash:0:12}"
	if [ ! -x "$venv/bin/slither" ]; then
		if [ "$offline" = 1 ]; then
			echo "Slither isn't installed in $venv yet: run once without --offline"
			return 1
		fi
		rm -rf "$venv"
		"$python" -m venv "$venv" || return 1
		"$venv/bin/python" -m pip install --quiet --disable-pip-version-check \
			--require-hashes --no-deps --only-binary :all: -r "$req" || return 1
	fi
	if [ ! -f contracts/lib/openzeppelin-contracts/package.json ]; then
		[ "$offline" = 0 ] || {
			echo "contracts/lib/openzeppelin-contracts isn't checked out"
			return 1
		}
		git submodule update --init --depth 1 contracts/lib/openzeppelin-contracts || return 1
	fi
	# Build into a scratch directory, with the pinned solc and no downloads, so a local contracts/out is left
	# alone. Slither fails on any finding that contracts/slither.db.json doesn't triage.
	work=$(mktemp -d)
	FOUNDRY_SOLC="$PINNED_BIN/solc" FOUNDRY_OFFLINE=true FOUNDRY_OUT="$work/out" FOUNDRY_CACHE_PATH="$work/cache" \
		"$venv/bin/slither" contracts --config-file contracts/slither.config.json
	local code=$?
	rm -rf "$work"
	return "$code"
}

results=()
failed=0
for step in "${steps[@]}"; do
	say "$step"
	case "$step" in
	workflows) step_workflows ;;
	secrets) step_secrets ;;
	scrub) step_scrub ;;
	vulnerabilities) step_vulnerabilities ;;
	dependency-policy) step_dependency_policy ;;
	contracts) step_contracts ;;
	esac
	code=$?
	case "$code" in
	0) results+=("$step|pass") ;;
	3) results+=("$step|skipped") ;;
	*)
		results+=("$step|FAIL ($code)")
		failed=1
		;;
	esac
done

say "security"
printf '| %-18s | %-10s |\n' step result '------------------' '----------'
for row in "${results[@]}"; do
	printf '| %-18s | %-10s |\n' "${row%%|*}" "${row#*|}"
done
# In Actions, each step's result is a step output (scrub=skipped), so the workflow's verdict can tell a skip
# from a pass: both end the step green.
if [ -n "${GITHUB_OUTPUT:-}" ]; then
	for row in "${results[@]}"; do
		result=${row#*|}
		printf '%s=%s\n' "${row%%|*}" "${result%% *}" >>"$GITHUB_OUTPUT"
	done
fi
exit "$failed"
