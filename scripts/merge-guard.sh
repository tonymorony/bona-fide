#!/usr/bin/env bash
# Merges one pull request into develop, or with --release develop into main, and only when
# nothing is against it.
#
#   scripts/merge-guard.sh [--check] [--repo OWNER/NAME] <pull request number>
#   scripts/merge-guard.sh [--check] [--repo OWNER/NAME] --release <pull request number>
#
# It refuses when:
#   - the pull request is merged, closed or a draft
#   - its base isn't develop, or with --release isn't main
#   - its head is main or develop, or with --release isn't develop of the same repository
#   - GitHub's mergeable state isn't "clean"
#   - a required check isn't green on the head commit: "check" and "security", plus any
#     check a ruleset on the base requires. Only a check run from GitHub Actions counts; a
#     commit status, which anyone with write access can post, never does
#   - a trial merge of the head into the newest base, made here with git, conflicts
#   - the head moved while the script read it
# Then it merges with a merge commit at the commit it checked, and confirms main and
# develop still exist.
#
#   --check            report only: read everything, merge nothing
#   --repo OWNER/NAME  the GitHub repository (default: the one the remote "origin" names).
#                      The trial merge fetches from the git remote that names it, or else
#                      from https://github.com/OWNER/NAME.git
#   --release          the release pull request: develop into main. Only on Anton's word
#   BF_STATE_WAIT      seconds to wait while GitHub computes the mergeable state (default: 10)
#
# A repository GitHub keeps rulesets from (a private repository on the free plan answers
# HTTP 403 "Upgrade to GitHub Pro or make this repository public") gets a loud warning and
# only this script's own required checks.
#
# Exit codes: 0 ready or merged, 1 refused, 2 main or develop is missing,
# 3 couldn't check (nothing is proved), 64 wrong usage.
#
# Whether the merge is allowed at all is Anton's word, not this script's: see
# docs/working-rules.md. Never change this script to get past a refusal.
set -euo pipefail

readonly DEVELOP=develop
readonly RELEASE=main
readonly LONG_BRANCHES="main develop"
# The required checks. No option or variable replaces them; a ruleset can only add to them.
readonly REQUIRED_CHECKS="check security"
# The GitHub App whose check runs count: GitHub Actions.
readonly CHECK_APP=github-actions

say() { printf '%s\n' "$*"; }
err() { printf '%s\n' "$*" >&2; }
usage() {
	err "merge-guard: $*"
	err "usage: scripts/merge-guard.sh [--check] [--repo OWNER/NAME] [--release] <pull request number>"
	exit 64
}
# phase says how far the script got, so a stop never claims more or less than happened.
phase=before
cannot() {
	err "CANNOT CHECK: $*"
	case "$phase" in
	before) err "Nothing was merged." ;;
	sent) err "The merge request WAS SENT and its result is unknown. Read the pull request before anything else." ;;
	merged) err "The pull request IS MERGED." ;;
	esac
	exit 3
}
# owner/name from a git remote URL: https://github.com/o/n.git, git@github.com:o/n, a path.
repo_of() { printf '%s\n' "$1" | sed -E 's#/+$##; s#\.git$##; s#^.*[:/]([^/:]+/[^/:]+)$#\1#'; }
valid_repo() {
	case "$1" in
	*/*/* | /* | */ | *[!A-Za-z0-9._/-]*) return 1 ;;
	*/*) return 0 ;;
	*) return 1 ;;
	esac
}

check_only=0
release=0
repo=""
pr=""
while [ $# -gt 0 ]; do
	case "$1" in
	--check) check_only=1 ;;
	--release) release=1 ;;
	--repo)
		[ $# -ge 2 ] || usage "--repo needs OWNER/NAME"
		repo=$2
		shift
		;;
	--repo=*) repo=${1#--repo=} ;;
	-h | --help)
		awk 'NR > 1 && !/^#/ { exit } NR > 1 { sub(/^# ?/, ""); print }' "$0"
		exit 0
		;;
	-*) usage "unknown option: $1" ;;
	*)
		[ -z "$pr" ] || usage "more than one pull request number"
		pr=$1
		;;
	esac
	shift
done
case "$pr" in
"" | *[!0-9]*) usage "the pull request number must be digits only" ;;
esac

if [ "$release" = 1 ]; then
	base=$RELEASE
	want_head=$DEVELOP
else
	base=$DEVELOP
	want_head=""
fi

state_wait=${BF_STATE_WAIT:-10}
case "$state_wait" in "" | *[!0-9]*) usage "BF_STATE_WAIT must be whole seconds" ;; esac

command -v gh >/dev/null 2>&1 || cannot "gh is not on the PATH."
command -v git >/dev/null 2>&1 || cannot "git is not on the PATH."

if [ -z "$repo" ]; then
	url=$(git remote get-url origin 2>/dev/null) || usage "no git remote \"origin\" here: pass --repo OWNER/NAME"
	repo=$(repo_of "$url")
fi
valid_repo "$repo" || usage "the repository must be owner/name, not \"$repo\""

# Fetch from the remote that names this repository, so a fork or a second remote is never
# mistaken for it; with none, from GitHub itself.
fetch_from=""
for r in $(git remote); do
	if [ "$(repo_of "$(git remote get-url "$r")")" = "$repo" ]; then
		fetch_from=$r
		break
	fi
done
[ -n "$fetch_from" ] || fetch_from="https://github.com/$repo.git"

errfile=$(mktemp "${TMPDIR:-/tmp}/merge-guard.XXXXXX")
trial_base=refs/merge-guard/$pr/base
trial_head=refs/merge-guard/$pr/head
cleanup() {
	rm -f "$errfile"
	git update-ref -d "$trial_base" 2>/dev/null || true
	git update-ref -d "$trial_head" 2>/dev/null || true
}
trap cleanup EXIT

api() { gh api "$@" 2>"$errfile"; }
github_said() { tr '\n' ' ' <"$errfile"; }

read_pr() {
	local line
	line=$(api "repos/$repo/pulls/$pr" --jq '[.state, (.merged | tostring), (.draft | tostring), .base.ref, .head.ref, .head.sha, (.mergeable_state // "unknown"), (.head.repo.full_name // "-"), (.title // "-")] | @tsv') ||
		cannot "GitHub didn't return pull request $pr of $repo: $(github_said)"
	IFS=$'\t' read -r pr_state pr_merged pr_draft pr_base pr_head pr_sha pr_mstate pr_head_repo pr_title <<<"$line"
	[ -n "${pr_sha:-}" ] || cannot "GitHub's answer for pull request $pr has an unknown shape."
}

refusals=0
refuse() {
	err "REFUSE: $*"
	refusals=$((refusals + 1))
}

say "repository: $repo"
[ "$release" = 0 ] || say "mode: release ($DEVELOP into $RELEASE)"
read_pr
say "pull request $pr: $pr_title"

if [ "$pr_merged" = true ]; then
	err "REFUSE: pull request $pr is already merged. Don't push to its branch; start a new branch from $DEVELOP."
	exit 1
fi
if [ "$pr_state" != open ]; then
	err "REFUSE: pull request $pr is $pr_state."
	exit 1
fi

waited=0
while [ "$pr_mstate" = unknown ] && [ "$waited" -lt "$state_wait" ]; do
	sleep 2
	waited=$((waited + 2))
	read_pr
done
say "base: $pr_base   head: $pr_head ($pr_sha)   mergeable state: $pr_mstate"

if [ "$release" = 1 ]; then
	if [ "$pr_base" != "$RELEASE" ]; then
		refuse "the base is \"$pr_base\", not $RELEASE. --release merges only $DEVELOP into $RELEASE."
	fi
	if [ "$pr_head" != "$want_head" ] || [ "$pr_head_repo" != "$repo" ]; then
		refuse "the head is \"$pr_head\" of $pr_head_repo, not $DEVELOP of $repo. A release is $DEVELOP into $RELEASE, nothing else."
	fi
else
	if [ "$pr_base" = "$RELEASE" ]; then
		refuse "the base is $RELEASE. A merge into $RELEASE is a release: only with Anton's word, and only with --release."
	elif [ "$pr_base" != "$DEVELOP" ]; then
		refuse "the base is \"$pr_base\", not $DEVELOP. Every pull request targets $DEVELOP; set the base back to $DEVELOP."
	fi
	for b in $LONG_BRANCHES; do
		if [ "$pr_head" = "$b" ] && [ "$pr_head_repo" = "$repo" ]; then
			refuse "the head is $b, a long branch. A release goes through --release, on Anton's word."
		fi
	done
fi
if [ "$pr_draft" = true ]; then
	refuse "the pull request is a draft. Mark it ready first, if it is."
fi
case "$pr_mstate" in
clean) ;;
dirty) refuse "the mergeable state is \"dirty\": the head conflicts with $pr_base. Merge $pr_base into the head and push." ;;
behind) refuse "the mergeable state is \"behind\": merge $pr_base into the head and wait for the checks." ;;
blocked) refuse "the mergeable state is \"blocked\": a required check or review is missing." ;;
unstable) refuse "the mergeable state is \"unstable\": a check failed or is still running." ;;
*) refuse "the mergeable state is \"$pr_mstate\", not \"clean\"." ;;
esac

# The checks a ruleset on the base requires count too, so the list here can't fall behind GitHub's.
# A private repository on GitHub's free plan can't hold a ruleset, and GitHub says so with this 403.
if ruleset_checks=$(api "repos/$repo/rules/branches/$base" --jq '.[] | select(.type == "required_status_checks") | .parameters.required_status_checks[].context'); then
	:
elif grep -q 'HTTP 403' "$errfile" && grep -q 'Upgrade to GitHub Pro or make this repository public' "$errfile"; then
	ruleset_checks=""
	err "WARNING: GitHub keeps rulesets from $repo on its current plan, so $base HAS NO RULESET."
	err "WARNING: nothing on GitHub stops a direct push, a force push or a deletion of $base there."
	err "WARNING: only this script's own required checks stand: $REQUIRED_CHECKS."
else
	cannot "GitHub didn't return the rules of $base: $(github_said)"
fi
checks=$(printf '%s\n%s\n' "$REQUIRED_CHECKS" "$ruleset_checks" | tr -s ' ' '\n' | sed '/^$/d' | sort -u)

runs=$(api --paginate "repos/$repo/commits/$pr_sha/check-runs?per_page=100" --jq '.check_runs[] | [(.id | tostring), .status, (.conclusion // "-"), .name, (.app.slug // "-")] | @tsv') ||
	cannot "GitHub didn't return the check runs of $pr_sha: $(github_said)"

# "status conclusion" of the newest GitHub Actions run with this name, or "missing".
check_state() {
	printf '%s\n' "$runs" | NAME=$1 APP=$CHECK_APP awk -F '\t' '
		BEGIN { name = ENVIRON["NAME"]; app = ENVIRON["APP"]; newest = -1 }
		$4 == name && $5 == app && ($1 + 0) > newest { newest = $1 + 0; status = $2; conclusion = $3 }
		END { if (newest < 0) print "missing"; else print status " " conclusion }'
}
while IFS= read -r name; do
	state=$(check_state "$name")
	case "$state" in
	"completed success") say "check \"$name\": success" ;;
	missing) refuse "the required check \"$name\" has no GitHub Actions run on $pr_sha." ;;
	completed*) refuse "the required check \"$name\" ended \"${state#completed }\" on $pr_sha. Read why before anything else." ;;
	*) refuse "the required check \"$name\" isn't finished (${state%% *}) on $pr_sha." ;;
	esac
done <<<"$checks"

# The trial merge: the head as GitHub has it, merged into the newest base, in git's object
# store only. No working tree, index or branch here changes.
merge_tree_help=$(git merge-tree -h 2>&1 || true)
case "$merge_tree_help" in
*--write-tree*) ;;
*) cannot "this git has no \"merge-tree --write-tree\" (git 2.38 or later)." ;;
esac
git fetch --quiet --no-tags "$fetch_from" "+refs/heads/$base:$trial_base" "+refs/pull/$pr/head:$trial_head" 2>"$errfile" ||
	cannot "git couldn't fetch $base and pull request $pr from $fetch_from: $(github_said)"
fetched_head=$(git rev-parse "$trial_head")
if [ "$fetched_head" != "$pr_sha" ]; then
	refuse "the head moved while this script read it: GitHub said $pr_sha, git fetched $fetched_head. Run it again."
else
	trial_rc=0
	trial=$(git merge-tree --write-tree --name-only --no-messages "$trial_base" "$trial_head" 2>"$errfile") || trial_rc=$?
	case "$trial_rc" in
	0) say "trial merge with $base ($(git rev-parse --short "$trial_base")): clean" ;;
	1) refuse "the trial merge with $base conflicts in: $(printf '%s\n' "$trial" | sed 1d | tr '\n' ' ')" ;;
	*) cannot "git couldn't make the trial merge: $(github_said)" ;;
	esac
fi

tips=""
for b in $LONG_BRANCHES; do
	tip=$(api "repos/$repo/git/ref/heads/$b" --jq .object.sha) || {
		grep -q 'HTTP 404' "$errfile" || cannot "GitHub didn't answer for $b: $(github_said)"
		err "STOP: the long branch $b is missing on GitHub. Nothing was merged. Tell Anton."
		exit 2
	}
	tips="$tips$b $tip
"
done

if [ "$refusals" -gt 0 ]; then
	err "pull request $pr is not ready: $refusals reason(s) above. Nothing was merged."
	exit 1
fi

if [ "$check_only" = 1 ]; then
	say "READY: pull request $pr can merge into $base at $pr_sha. Nothing was merged (--check)."
	exit 0
fi

checked_sha=$pr_sha
read_pr
if [ "$pr_state" != open ] || [ "$pr_base" != "$base" ] || [ "$pr_sha" != "$checked_sha" ] || [ "$pr_draft" = true ]; then
	err "REFUSE: pull request $pr changed while the script read it. Nothing was merged. Run it again."
	exit 1
fi

phase=sent
if merge=$(api -X PUT "repos/$repo/pulls/$pr/merge" -f merge_method=merge -f "sha=$checked_sha" --jq '[(.merged | tostring), (.sha // "-")] | @tsv'); then
	IFS=$'\t' read -r merged merge_sha <<<"$merge"
	[ "$merged" = true ] || cannot "GitHub answered without a merge."
else
	refused_with=$(github_said)
	read_pr
	if [ "$pr_merged" != true ]; then
		err "REFUSE: GitHub didn't merge pull request $pr: $refused_with"
		err "Nothing was merged. Don't try the merge another way. Tell Anton what GitHub said."
		exit 1
	fi
	merge_sha=$(api "repos/$repo/pulls/$pr" --jq .merge_commit_sha) || merge_sha=unknown
fi
phase=merged
say "MERGED: pull request $pr into $base. Merge commit: $merge_sha"

for b in $LONG_BRANCHES; do
	if ! api "repos/$repo/git/ref/heads/$b" --jq .object.sha >/dev/null; then
		grep -q 'HTTP 404' "$errfile" || cannot "GitHub didn't answer for $b after merge commit $merge_sha: $(github_said) Read main and develop before anything else."
		before=$(printf '%s' "$tips" | B=$b awk '$1 == ENVIRON["B"] { print $2 }')
		err "STOP: the long branch $b is gone after the merge. Anton restores it with:"
		err "  gh api -X POST repos/$repo/git/refs -f ref=refs/heads/$b -f sha=$before"
		exit 2
	fi
done
say "main and develop: both still on GitHub"
