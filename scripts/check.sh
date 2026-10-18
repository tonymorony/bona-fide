#!/usr/bin/env bash
# Runs every check CI runs, in one go, and says which failed: formatting, lint, types, the
# contracts' formatting and lint, the shell scripts, the guard scripts' tests, and every test suite.
#
#   npm run check                  everything
#   npm run check -- lint types    only the steps named
#
# Every step runs even after one fails, so one run lists everything to fix. It needs what the tests
# need (Node 24, Foundry, Chrome), shellcheck, shfmt and jq. It warns when forge isn't the Foundry CI
# pins (v1.8.5 today: foundryup -i v1.8.5).
set -uo pipefail

cd "$(dirname "$0")/.." || exit 1

steps=(
	"format|npm run format:check"
	"lint|npm run lint"
	"types|npm run typecheck"
	"sol-format|cd contracts && forge fmt --check"
	"sol-lint|cd contracts && forge lint --deny warnings"
	"shell|scripts/lint-shell.sh"
	"guards|scripts/test-guards.sh"
	"forge-test|cd contracts && forge test"
	"test-sdk|npm test -w sdk"
	"test-app|npm test -w app"
	"test-agent|npm test -w agent"
	"test-web|npm test -w web"
)

# Whether to run step $1: yes when no steps are named after it, or when it is one of them.
wanted() {
	local name=$1
	shift
	[ $# -eq 0 ] && return 0
	for only in "$@"; do [ "$only" = "$name" ] && return 0; done
	return 1
}

for only in "$@"; do
	known=no
	for step in "${steps[@]}"; do [ "${step%%|*}" = "$only" ] && known=yes; done
	if [ "$known" = no ]; then
		printf 'No step is called %s. The steps:' "$only" >&2
		for step in "${steps[@]}"; do printf ' %s' "${step%%|*}" >&2; done
		printf '\n' >&2
		exit 2
	fi
done

# CI pins one Foundry, in .github/pinned-tools.txt and the check workflow alike: forge fmt's output differs
# between releases, and forge lint --deny needs 1.4 or later. Another forge here can pass what CI fails.
foundry_warning=""
pinned_foundry=$(awk '$1 == "forge" { print $2; exit }' .github/pinned-tools.txt)
local_foundry=$(forge --version 2>/dev/null | sed -nE '1s/^forge Version: ([0-9]+\.[0-9]+\.[0-9]+).*/\1/p')
if [ "$local_foundry" != "$pinned_foundry" ]; then
	foundry_warning=$(printf 'warning: forge here is %s, but CI pins Foundry v%s, so forge fmt and forge lint may disagree with CI. AGENTS.md says how to install it.' \
		"${local_foundry:-missing}" "$pinned_foundry")
	printf '%s\n' "$foundry_warning" >&2
fi

summary=()
failed=0
for step in "${steps[@]}"; do
	name=${step%%|*}
	command=${step#*|}
	wanted "$name" "$@" || continue
	printf '\n==> %s: %s\n' "$name" "$command"
	start=$SECONDS
	if (eval "$command"); then status=ok; else
		status=FAIL
		failed=$((failed + 1))
	fi
	summary+=("$(printf '  %-4s  %-10s  %ss' "$status" "$name" $((SECONDS - start)))")
done

printf '\nCheck summary\n'
for line in "${summary[@]}"; do printf '%s\n' "$line"; done
[ -z "$foundry_warning" ] || printf '%s\n' "$foundry_warning" >&2
if [ "$failed" -gt 0 ]; then
	printf '%d step(s) failed.\n' "$failed"
	exit 1
fi
printf 'All %d steps passed.\n' "${#summary[@]}"
