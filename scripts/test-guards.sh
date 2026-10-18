#!/usr/bin/env bash
# Tests scripts/merge-guard.sh and scripts/protect-branches.sh without GitHub: a stub "gh"
# answers from fixture files and logs every call, and a throwaway local git repo stands in for
# the remote, so the trial merge is a real one.
#
#   scripts/test-guards.sh [folder with the two scripts]
#
# Point it at a changed copy of the scripts to see a case go red. Needs bash, git 2.38 or later
# and jq. Exits 1 if any case fails.
set -euo pipefail

here=$(cd "${1:-$(dirname "$0")}" && pwd)
command -v jq >/dev/null 2>&1 || {
	echo "test-guards: needs jq" >&2
	exit 3
}

tmp=$(mktemp -d "${TMPDIR:-/tmp}/test-guards.XXXXXX")
trap 'rm -rf "$tmp"' EXIT

# The stub: "gh api [-X METHOD] <endpoint> [--jq expr] [--input -] [-f k=v]...". The fixture for
# a call is $GH_FIXTURES/<METHOD>_<endpoint with / ? & = as _>. A missing fixture is a 404; a
# fixture ending in .fail is printed to stderr as the error.
mkdir -p "$tmp/bin"
cat >"$tmp/bin/gh" <<'STUB'
#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$*" >>"$GH_LOG"
[ "${1:-}" = api ] || { echo "stub gh: only 'gh api' is stubbed" >&2; exit 1; }
shift
method=GET endpoint="" jq_expr=""
while [ $# -gt 0 ]; do
	case "$1" in
	-X) method=$2; shift 2 ;;
	--jq) jq_expr=$2; shift 2 ;;
	-f | -F | --input) shift 2 ;;
	--paginate) shift ;;
	*) endpoint=$1; shift ;;
	esac
done
[ "$method" = GET ] || cat >/dev/null
name="$method"_$(printf '%s' "$endpoint" | tr '/?&=' '____')
file="$GH_FIXTURES/$name"
if [ -f "$file.fail" ]; then cat "$file.fail" >&2; exit 1; fi
if [ ! -f "$file" ]; then echo "gh: Not Found (HTTP 404)" >&2; exit 1; fi
if [ -n "$jq_expr" ]; then jq -r "$jq_expr" "$file"; else cat "$file"; fi
STUB
chmod +x "$tmp/bin/gh"

# A remote with develop, a clean pull request 7, a conflicting pull request 8 and the release
# pull request 9 (develop into main). Its path ends in test/repo, so merge-guard.sh reads that
# repository from the remote "origin", as it reads owner/name from a GitHub URL. A second remote,
# "public", names test/public, for --repo.
git init --quiet --bare "$tmp/remotes/test/repo.git"
git init --quiet -b develop "$tmp/clone"
g() { git -C "$tmp/clone" -c user.name=test -c user.email=test@example.com "$@"; }
printf 'one\ntwo\n' >"$tmp/clone/a.txt"
g add a.txt && g commit --quiet -m base
g remote add origin "$tmp/remotes/test/repo.git"
g checkout --quiet -b clean
printf 'new\n' >"$tmp/clone/b.txt"
g add b.txt && g commit --quiet -m clean
sha7=$(g rev-parse HEAD)
g checkout --quiet develop
g checkout --quiet -b conflict
printf 'one\nTWO from the pull request\n' >"$tmp/clone/a.txt"
g commit --quiet -am conflict
sha8=$(g rev-parse HEAD)
g checkout --quiet develop
printf 'one\nTWO from develop\n' >"$tmp/clone/a.txt"
g commit --quiet -am develop-moved
g branch --quiet main develop~1
devsha=$(g rev-parse develop)
mainsha=$(g rev-parse main)
g push --quiet origin develop main "$sha7:refs/pull/7/head" "$sha8:refs/pull/8/head" "$devsha:refs/pull/9/head"
git init --quiet --bare "$tmp/remotes/test/public.git"
g remote add public "$tmp/remotes/test/public.git"
g push --quiet public develop main "$sha7:refs/pull/7/head"

repo=test/repo
fx() { printf '%s\n' "$2" >"$fixtures/$1"; }
pr() { # number base head sha draft mergeable_state [state merged]
	fx "GET_repos_${repo/\//_}_pulls_$1" "{\"state\":\"${7:-open}\",\"merged\":${8:-false},\"draft\":$5,\"base\":{\"ref\":\"$2\"},\"head\":{\"ref\":\"$3\",\"sha\":\"$4\",\"repo\":{\"full_name\":\"$repo\"}},\"mergeable_state\":\"$6\",\"title\":\"test pull request $1\",\"merge_commit_sha\":null}"
}
runs() { # sha json-of-check-runs [json-of-commit-statuses]
	fx "GET_repos_${repo/\//_}_commits_$1_check-runs_per_page_100" "{\"check_runs\":$2}"
	fx "GET_repos_${repo/\//_}_commits_$1_status" "{\"statuses\":${3:-[]}}"
}
actions='"app":{"slug":"github-actions"}'
green='[{"id":1,"status":"completed","conclusion":"success","name":"check",'"$actions"'},{"id":2,"status":"completed","conclusion":"success","name":"security",'"$actions"'}]'
fresh() { # a fixture set where pull request 7 is ready to merge, and release pull request 9 too
	fixtures="$tmp/fixtures/$1"
	mkdir -p "$fixtures"
	pr 7 develop clean "$sha7" false clean
	runs "$sha7" "$green"
	pr 9 main develop "$devsha" false clean
	runs "$devsha" "$green"
	fx "GET_repos_${repo/\//_}_rules_branches_develop" '[]'
	fx "GET_repos_${repo/\//_}_rules_branches_main" '[]'
	fx "GET_repos_${repo/\//_}_git_ref_heads_main" "{\"object\":{\"sha\":\"$mainsha\"}}"
	fx "GET_repos_${repo/\//_}_git_ref_heads_develop" "{\"object\":{\"sha\":\"$devsha\"}}"
	fx "PUT_repos_${repo/\//_}_pulls_7_merge" '{"merged":true,"sha":"1234567890abcdef"}'
	fx "PUT_repos_${repo/\//_}_pulls_9_merge" '{"merged":true,"sha":"fedcba0987654321"}'
}
# GitHub's answer when a private repository on the free plan asks for its rulesets.
no_rulesets='gh: Upgrade to GitHub Pro or make this repository public to enable this feature. (HTTP 403)'

failures=0
# expect <case> <exit code> <text the output must hold> -- <command>...
expect() {
	local name=$1 want=$2 text=$3 got=0 out
	shift 4
	: >"$tmp/gh.log"
	out=$(cd "$tmp/clone" && PATH="$tmp/bin:$PATH" GH_LOG="$tmp/gh.log" GH_FIXTURES="$fixtures" \
		BF_REPO=$repo BF_STATE_WAIT=0 "$@" 2>&1) || got=$?
	if [ "$got" = "$want" ] && printf '%s\n' "$out" | grep -qF -- "$text"; then
		printf 'ok    %-44s exit %s: %s\n' "$name" "$got" "$(printf '%s\n' "$out" | grep -F -- "$text" | head -n 1)"
	else
		printf 'FAIL  %-44s exit %s, wanted %s and "%s". Output:\n%s\n' "$name" "$got" "$want" "$text" "$out"
		failures=$((failures + 1))
	fi
}
no_merge_sent() {
	if grep -q -- '-X PUT' "$tmp/gh.log"; then
		printf 'FAIL  %-44s a merge request was sent\n' "$1"
		failures=$((failures + 1))
	fi
}

mg="$here/merge-guard.sh"
pb="$here/protect-branches.sh"

echo "merge-guard.sh"
fresh usage
expect "no pull request number" 64 "usage:" -- "$mg"
expect "a number that isn't one" 64 "digits only" -- "$mg" 7a
expect "an unknown option" 64 "unknown option" -- "$mg" --force 7

fresh base-main
pr 7 main clean "$sha7" false clean
expect "base is main" 1 "REFUSE: the base is main. A merge into main is a release" -- "$mg" 7
no_merge_sent "base is main"

fresh base-other
pr 7 feat/x clean "$sha7" false clean
expect "base is another branch" 1 "REFUSE: the base is \"feat/x\", not develop" -- "$mg" 7
no_merge_sent "base is another branch"

fresh head-long
pr 7 develop main "$sha7" false clean
expect "head is a long branch" 1 "REFUSE: the head is main" -- "$mg" 7

fresh draft
pr 7 develop clean "$sha7" true clean
expect "draft" 1 "REFUSE: the pull request is a draft" -- "$mg" 7
no_merge_sent "draft"

fresh merged
pr 7 develop clean "$sha7" false clean closed true
expect "already merged" 1 "already merged" -- "$mg" 7

fresh closed
pr 7 develop clean "$sha7" false clean closed false
expect "closed" 1 "is closed" -- "$mg" 7

fresh dirty
pr 7 develop clean "$sha7" false dirty
expect "mergeable state dirty" 1 '"dirty"' -- "$mg" 7

fresh red-security
runs "$sha7" '[{"id":1,"status":"completed","conclusion":"success","name":"check",'"$actions"'},{"id":2,"status":"completed","conclusion":"failure","name":"security",'"$actions"'}]'
expect "security check red" 1 '"security" ended "failure"' -- "$mg" 7
no_merge_sent "security check red"

fresh rerun-green
runs "$sha7" '[{"id":1,"status":"completed","conclusion":"success","name":"check",'"$actions"'},{"id":2,"status":"completed","conclusion":"failure","name":"security",'"$actions"'},{"id":3,"status":"completed","conclusion":"success","name":"security",'"$actions"'}]'
expect "a red run, then a green re-run" 0 "READY" -- "$mg" --check 7

fresh check-missing
runs "$sha7" '[{"id":2,"status":"completed","conclusion":"success","name":"security",'"$actions"'}]'
expect "check has no run" 1 '"check" has no GitHub Actions run' -- "$mg" 7

fresh check-running
runs "$sha7" '[{"id":1,"status":"in_progress","conclusion":null,"name":"check",'"$actions"'},{"id":2,"status":"completed","conclusion":"success","name":"security",'"$actions"'}]'
expect "check still running" 1 "isn't finished (in_progress)" -- "$mg" 7

fresh ruleset-check
fx "GET_repos_${repo/\//_}_rules_branches_develop" '[{"type":"required_status_checks","parameters":{"required_status_checks":[{"context":"lint"}]}}]'
expect "a check the ruleset requires is missing" 1 '"lint" has no GitHub Actions run' -- "$mg" 7

fresh no-rulesets
printf '%s\n' "$no_rulesets" >"$fixtures/GET_repos_${repo/\//_}_rules_branches_develop.fail"
expect "no rulesets on the plan: a loud warning" 0 "develop HAS NO RULESET" -- "$mg" --check 7
expect "no rulesets on the plan: READY when green" 0 "READY" -- "$mg" --check 7
no_merge_sent "no rulesets on the plan"

fresh no-rulesets-red
printf '%s\n' "$no_rulesets" >"$fixtures/GET_repos_${repo/\//_}_rules_branches_develop.fail"
runs "$sha7" '[{"id":1,"status":"completed","conclusion":"success","name":"check",'"$actions"'}]'
expect "no rulesets on the plan: own checks still hold" 1 '"security" has no GitHub Actions run' -- "$mg" 7
no_merge_sent "no rulesets on the plan: own checks still hold"

fresh other-403
printf 'gh: Resource not accessible by integration (HTTP 403)\n' >"$fixtures/GET_repos_${repo/\//_}_rules_branches_develop.fail"
expect "another 403 on the rules" 3 "CANNOT CHECK: GitHub didn't return the rules of develop" -- "$mg" 7
no_merge_sent "another 403 on the rules"

fresh rules-502
printf 'gh: Bad Gateway (HTTP 502)\n' >"$fixtures/GET_repos_${repo/\//_}_rules_branches_develop.fail"
expect "a 5xx on the rules" 3 "CANNOT CHECK: GitHub didn't return the rules of develop" -- "$mg" 7

fresh status-not-a-run
runs "$sha7" '[{"id":1,"status":"completed","conclusion":"success","name":"check",'"$actions"'}]' '[{"id":5,"state":"success","context":"security"}]'
expect "a commit status named security" 1 '"security" has no GitHub Actions run' -- "$mg" 7
no_merge_sent "a commit status named security"

fresh other-app
runs "$sha7" '[{"id":1,"status":"completed","conclusion":"success","name":"check",'"$actions"'},{"id":2,"status":"completed","conclusion":"success","name":"security","app":{"slug":"some-other-app"}}]'
expect "a check run named security from another app" 1 '"security" has no GitHub Actions run' -- "$mg" 7

fresh no-override
runs "$sha7" '[{"id":1,"status":"completed","conclusion":"success","name":"check",'"$actions"'}]'
expect "BF_REQUIRED_CHECKS doesn't drop security" 1 '"security" has no GitHub Actions run' -- env BF_REQUIRED_CHECKS=check "$mg" 7

fresh conflict
pr 8 develop conflict "$sha8" false clean
runs "$sha8" "$green"
expect "trial merge conflicts" 1 "REFUSE: the trial merge with develop conflicts in: a.txt" -- "$mg" 8
no_merge_sent "trial merge conflicts"

fresh moved
pr 7 develop clean "$sha8" false clean
runs "$sha8" "$green"
expect "head moved under the script" 1 "REFUSE: the head moved" -- "$mg" 7

fresh develop-gone
rm "$fixtures/GET_repos_${repo/\//_}_git_ref_heads_develop"
expect "develop missing before the merge" 2 "develop is missing" -- "$mg" 7
no_merge_sent "develop missing before the merge"

fresh github-down
printf 'HTTP 502: Bad Gateway\n' >"$fixtures/GET_repos_${repo/\//_}_pulls_7.fail"
expect "GitHub doesn't answer" 3 "CANNOT CHECK" -- "$mg" 7

fresh release-wrong-base
expect "--release on a pull request into develop" 1 'REFUSE: the base is "develop", not main' -- "$mg" --release 7
no_merge_sent "--release on a pull request into develop"

fresh release-wrong-head
pr 7 main clean "$sha7" false clean
expect "--release with a feature branch head" 1 'REFUSE: the head is "clean" of test/repo, not develop' -- "$mg" --release 7
no_merge_sent "--release with a feature branch head"

fresh release-without-flag
expect "develop into main without --release" 1 "only with --release" -- "$mg" 9
no_merge_sent "develop into main without --release"

fresh release-no-rulesets
printf '%s\n' "$no_rulesets" >"$fixtures/GET_repos_${repo/\//_}_rules_branches_main.fail"
expect "--release --check, no rulesets on the plan" 0 "READY: pull request 9 can merge into main" -- "$mg" --check --release 9

fresh release
expect "--release merges develop into main" 0 "MERGED: pull request 9 into main" -- "$mg" --release 9
grep -q -- '-X PUT repos/test/repo/pulls/9/merge -f merge_method=merge -f sha='"$devsha" "$tmp/gh.log" || {
	echo "FAIL  the release wasn't a merge commit at the checked head"
	failures=$((failures + 1))
}

repo=test/public
fresh repo-option
expect "--repo names another repository" 0 "READY: pull request 7 can merge into develop" -- "$mg" --repo test/public --check 7
if ! grep -q 'repos/test/public/pulls/7' "$tmp/gh.log" || grep -q 'repos/test/repo/' "$tmp/gh.log"; then
	echo "FAIL  --repo test/public read another repository"
	failures=$((failures + 1))
fi
expect "--repo=OWNER/NAME merges there" 0 "MERGED: pull request 7 into develop" -- "$mg" --repo=test/public 7
repo=test/repo
fresh repo-bad
expect "--repo that isn't owner/name" 64 "owner/name" -- "$mg" --repo not-a-repo 7
expect "--repo with no value" 64 "needs OWNER/NAME" -- "$mg" 7 --repo

fresh merge-refused
printf 'HTTP 405: Pull Request is not mergeable\n' >"$fixtures/PUT_repos_${repo/\//_}_pulls_7_merge.fail"
expect "GitHub refuses the merge" 1 "didn't merge pull request 7" -- "$mg" 7

fresh check-only
expect "--check on a ready pull request" 0 "READY" -- "$mg" --check 7
no_merge_sent "--check on a ready pull request"

fresh merges
expect "a ready pull request merges" 0 "MERGED: pull request 7 into develop" -- "$mg" 7
grep -q -- '-X PUT repos/test/repo/pulls/7/merge -f merge_method=merge -f sha='"$sha7" "$tmp/gh.log" || {
	echo "FAIL  the merge wasn't a merge commit at the checked head"
	failures=$((failures + 1))
}

echo
echo "protect-branches.sh"
fresh protect-usage
expect "an unknown argument" 64 "unknown argument" -- "$pb" --force
expect "a bad repository name" 64 "owner/name" -- env BF_REPO=not-a-repo "$pb" --dry-run

fresh protect-dry
expect "--dry-run prints the request" 0 '"required_status_checks": [{ "context": "check" }, { "context": "security" }]' -- "$pb" --dry-run
if [ -s "$tmp/gh.log" ]; then
	echo "FAIL  --dry-run called gh"
	failures=$((failures + 1))
fi

protected='[{"type":"deletion"},{"type":"non_fast_forward"},{"type":"required_status_checks","parameters":{"required_status_checks":[{"context":"check"},{"context":"security"}]}}]'
fresh protect-create
fx "GET_repos_${repo/\//_}_rulesets_includes_parents_false" '[]'
fx "POST_repos_${repo/\//_}_rulesets" '{"id":42}'
fx "GET_repos_${repo/\//_}_rules_branches_main" "$protected"
fx "GET_repos_${repo/\//_}_rules_branches_develop" "$protected"
expect "creates the ruleset" 0 "PROTECTED: main and develop." -- "$pb"

fresh protect-update
fx "GET_repos_${repo/\//_}_rulesets_includes_parents_false" '[{"id":7,"name":"Protect main and develop"}]'
fx "PUT_repos_${repo/\//_}_rulesets_7" '{"id":7}'
fx "GET_repos_${repo/\//_}_rules_branches_main" "$protected"
fx "GET_repos_${repo/\//_}_rules_branches_develop" "$protected"
expect "updates the ruleset with the same name" 0 "update: PUT repos/test/repo/rulesets/7" -- "$pb"

fresh protect-refused
fx "GET_repos_${repo/\//_}_rulesets_includes_parents_false" '[]'
printf 'HTTP 403: Resource not accessible by integration\n' >"$fixtures/POST_repos_${repo/\//_}_rulesets.fail"
expect "GitHub refuses the ruleset" 1 "NOT PROTECTED: GitHub didn't create" -- "$pb"

fresh protect-incomplete
fx "GET_repos_${repo/\//_}_rulesets_includes_parents_false" '[]'
fx "POST_repos_${repo/\//_}_rulesets" '{"id":42}'
fx "GET_repos_${repo/\//_}_rules_branches_main" '[{"type":"deletion"}]'
fx "GET_repos_${repo/\//_}_rules_branches_develop" "$protected"
expect "a rule is missing after the change" 1 'main has no rule "non_fast_forward"' -- "$pb"

echo
if [ "$failures" -gt 0 ]; then
	echo "$failures case(s) failed"
	exit 1
fi
echo "all cases passed"
