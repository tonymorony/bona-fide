#!/usr/bin/env bash
# Protects main and develop on GitHub with one repository ruleset: no deletion, no force
# push, and the status checks "check" and "security" required, with nobody able to bypass it.
#
#   scripts/protect-branches.sh [--dry-run]
#
# It creates the ruleset, or replaces the rules of the ruleset with the same name, then reads
# the rules GitHub applies to each branch back and fails if one is missing.
#
#   --dry-run      print the request and send nothing; it reads nothing either
#   BF_REPO        owner/name on GitHub (default: read from the remote "origin")
#
# A change to a guard is Anton's: he runs it without --dry-run. An agent runs --dry-run only.
#
# Exit codes: 0 protected (or a dry run), 1 not protected, 3 couldn't check, 64 wrong usage.
set -euo pipefail

readonly BRANCHES="main develop"
readonly CHECKS="check security"
readonly NAME="Protect main and develop"

say() { printf '%s\n' "$*"; }
err() { printf '%s\n' "$*" >&2; }
usage() {
	err "protect-branches: $*"
	err "usage: scripts/protect-branches.sh [--dry-run]"
	exit 64
}
cannot() {
	err "CANNOT CHECK: $*"
	exit 3
}

dry_run=0
for arg in "$@"; do
	case "$arg" in
	--dry-run) dry_run=1 ;;
	-h | --help)
		awk 'NR > 1 && !/^#/ { exit } NR > 1 { sub(/^# ?/, ""); print }' "$0"
		exit 0
		;;
	*) usage "unknown argument: $arg" ;;
	esac
done

if [ -n "${BF_REPO:-}" ]; then
	repo=$BF_REPO
else
	url=$(git remote get-url origin 2>/dev/null) || cannot "no git remote \"origin\" here. Set BF_REPO=owner/name."
	repo=$(printf '%s\n' "$url" | sed -E 's#/+$##; s#\.git$##; s#^.*[:/]([^/:]+/[^/:]+)$#\1#')
fi
case "$repo" in
*/*/* | /* | */ | *[!A-Za-z0-9._/-]*) usage "the repository must be owner/name, not \"$repo\"" ;;
*/*) ;;
*) usage "the repository must be owner/name, not \"$repo\"" ;;
esac

includes=""
for b in $BRANCHES; do includes="$includes${includes:+, }\"refs/heads/$b\""; done
contexts=""
for c in $CHECKS; do contexts="$contexts${contexts:+, }{ \"context\": \"$c\" }"; done
payload=$(
	cat <<EOF
{
  "name": "$NAME",
  "target": "branch",
  "enforcement": "active",
  "bypass_actors": [],
  "conditions": { "ref_name": { "include": [$includes], "exclude": [] } },
  "rules": [
    { "type": "deletion" },
    { "type": "non_fast_forward" },
    {
      "type": "required_status_checks",
      "parameters": {
        "strict_required_status_checks_policy": false,
        "do_not_enforce_on_create": false,
        "required_status_checks": [$contexts]
      }
    }
  ]
}
EOF
)

say "repository: $repo"
if [ "$dry_run" = 1 ]; then
	say "dry run: nothing is read and nothing is sent."
	say "would read: GET repos/$repo/rulesets?includes_parents=false  (is there a ruleset named \"$NAME\"?)"
	say "would send: POST repos/$repo/rulesets  (if there isn't), or PUT repos/$repo/rulesets/<its id>  (if there is)"
	say "$payload"
	for b in $BRANCHES; do
		say "would read: GET repos/$repo/rules/branches/$b  (deletion, non_fast_forward, required_status_checks: $CHECKS)"
	done
	exit 0
fi

command -v gh >/dev/null 2>&1 || cannot "gh is not on the PATH."
errfile=$(mktemp "${TMPDIR:-/tmp}/protect-branches.XXXXXX")
trap 'rm -f "$errfile"' EXIT
api() { gh api "$@" 2>"$errfile"; }
github_said() { tr '\n' ' ' <"$errfile"; }

existing=$(api "repos/$repo/rulesets?includes_parents=false" --jq '.[] | [(.id | tostring), .name] | @tsv') ||
	cannot "GitHub didn't return the rulesets of $repo: $(github_said)"
id=$(printf '%s\n' "$existing" | N=$NAME awk -F '\t' '$2 == ENVIRON["N"] { print $1; exit }')

if [ -n "$id" ]; then
	say "update: PUT repos/$repo/rulesets/$id"
	printf '%s\n' "$payload" | api -X PUT "repos/$repo/rulesets/$id" --input - --jq .id >/dev/null || {
		err "NOT PROTECTED: GitHub didn't update ruleset $id: $(github_said)"
		exit 1
	}
else
	say "create: POST repos/$repo/rulesets"
	id=$(printf '%s\n' "$payload" | api -X POST "repos/$repo/rulesets" --input - --jq .id) || {
		err "NOT PROTECTED: GitHub didn't create the ruleset: $(github_said)"
		exit 1
	}
fi
say "ruleset $id \"$NAME\": sent"

wants="deletion non_fast_forward"
for c in $CHECKS; do wants="$wants check:$c"; done
missing=0
for b in $BRANCHES; do
	rules=$(api "repos/$repo/rules/branches/$b" --jq '.[] | if .type == "required_status_checks" then (.parameters.required_status_checks[] | "check:" + .context) else .type end') ||
		cannot "GitHub didn't return the rules of $b: $(github_said)"
	for want in $wants; do
		if printf '%s\n' "$rules" | grep -qx -- "$want"; then
			say "$b: $want"
		else
			err "NOT PROTECTED: $b has no rule \"$want\"."
			missing=$((missing + 1))
		fi
	done
done
[ "$missing" = 0 ] || exit 1
say "PROTECTED: main and develop."
