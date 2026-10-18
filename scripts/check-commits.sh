#!/usr/bin/env bash
# Fails when a commit subject or a pull request title isn't a Conventional Commit:
#
#   <type>(<scope>)!: <description>      type: feat fix chore docs refactor test ci build perf revert
#                                        (<scope>) and ! are optional; a scope is a-z, 0-9 and -
#
#   scripts/check-commits.sh <base> <head>     every commit in base..head except merge commits
#   scripts/check-commits.sh --title <title>   one pull request title
#
# It needs only bash and git, so CI and a laptop run the same check.
set -euo pipefail

pattern='^(feat|fix|chore|docs|refactor|test|ci|build|perf|revert)(\([a-z0-9-]+\))?!?: .+'

usage() {
	printf 'usage: %s <base> <head>\n       %s --title <title>\n' "$0" "$0" >&2
	exit 2
}

conventional() { [[ $1 =~ $pattern ]]; }

hint() {
	printf '\nUse <type>(<scope>): <description>, with type one of feat, fix, chore, docs, refactor,\n' >&2
	printf 'test, ci, build, perf or revert, for example "fix(app): refund a Deposit on merge".\n' >&2
}

if [ "${1:-}" = "--title" ]; then
	[ $# -eq 2 ] || usage
	if conventional "$2"; then
		printf 'Title is a Conventional Commit: %s\n' "$2"
		exit 0
	fi
	printf 'Title is not a Conventional Commit: %s\n' "$2" >&2
	hint
	exit 1
fi

[ $# -eq 2 ] || usage
base=$1
head=$2

# Read the log first, so a range git can't resolve fails the check instead of passing it empty.
log=$(git log --no-merges --format='%H %s' "$base..$head")
checked=0
bad=0
while IFS= read -r line; do
	[ -n "$line" ] || continue
	sha=${line%% *}
	subject=${line#* }
	checked=$((checked + 1))
	if ! conventional "$subject"; then
		printf '%s  %s\n' "${sha:0:12}" "$subject" >&2
		bad=$((bad + 1))
	fi
done <<<"$log"

if [ "$bad" -gt 0 ]; then
	printf '\n%d of %d commits in %s..%s are not Conventional Commits.\n' "$bad" "$checked" "$base" "$head" >&2
	hint
	exit 1
fi
printf 'All %d commits in %s..%s are Conventional Commits.\n' "$checked" "$base" "$head"
