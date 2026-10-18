#!/usr/bin/env bash
# Fail if a word that must not be published appears in the tree or in commit messages.
#
# The words come from SCRUB_WORDS (one per line), or from the file named by SCRUB_WORDS_FILE. They match
# case-insensitively, as whole words. The output names the file and line (or the commit) of each hit and
# never the word, so a log can't publish what the check exists to keep out. A file whose path holds a word
# is named by its position in git ls-files, not by its path.
#
#   SCRUB_RANGE  the commits whose messages to check, as git rev-list arguments. CI sets it to the pull
#                request's or the push's commits; locally it defaults to the commits no remote has yet.
#                Set it to "none" to check only the tree. A range git can't list fails the check.
#
# With no words configured (a fork's pull request has no secrets, and a repository may not have set the
# secret yet), it checks nothing, warns, and exits 3, which scripts/security.sh reports as "skipped".
set -euo pipefail

root=$(git rev-parse --show-toplevel)
cd "$root"

words=$(mktemp)
trap 'rm -f "$words"' EXIT
if [ -n "${SCRUB_WORDS_FILE:-}" ]; then
	cat -- "$SCRUB_WORDS_FILE" >"$words"
else
	printf '%s\n' "${SCRUB_WORDS:-}" >"$words"
fi
# Drop blank lines, carriage returns and surrounding spaces.
sed -e 's/\r$//' -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//' -e '/^$/d' "$words" >"$words.clean"
mv "$words.clean" "$words"

if [ ! -s "$words" ]; then
	echo "::warning::scrub: skipped, nothing was checked: SCRUB_WORDS is empty. Set the repository secret SCRUB_WORDS (a fork's pull request gets no secrets)"
	exit 3
fi
if [ -n "${GITHUB_ACTIONS:-}" ]; then
	while IFS= read -r word; do echo "::add-mask::$word"; done <"$words"
fi
count=$(wc -l <"$words" | tr -d ' ')

hits=0

# Whether a path holds a scrubbed word, with / . _ - as word breaks.
path_has_word() { printf '%s\n' "$1" | tr '/._-' '    ' | grep -q -i -w -F -f "$words"; }
# The path's position in git ls-files, which names a file without showing its path.
position_of() {
	local n=0 path
	while IFS= read -r -d '' path; do
		n=$((n + 1))
		[ "$path" != "$1" ] || break
	done < <(git ls-files -z --cached --others --exclude-standard)
	printf '%s\n' "$n"
}

# File contents: tracked files plus new files not yet ignored. With -z, grep gives the path, a NUL, the line
# number, a NUL and the line; only the path and the line number are kept, and only a path without a word.
while IFS= read -r -d '' path && IFS= read -r -d '' line && IFS= read -r _; do
	if path_has_word "$path"; then
		echo "::error::scrub: a scrubbed word appears at line $line of file #$(position_of "$path") of git ls-files"
	else
		echo "::error::scrub: a scrubbed word appears at $path:$line"
	fi
	hits=$((hits + 1))
done < <(git grep -z --untracked -I -n -i -w -F -f "$words" || true)

# File paths: a hit names the path's position in git ls-files, not the path, which would show the word.
n=0
while IFS= read -r -d '' path; do
	n=$((n + 1))
	if path_has_word "$path"; then
		echo "::error::scrub: a scrubbed word appears in the path of file #$n of git ls-files"
		hits=$((hits + 1))
	fi
done < <(git ls-files -z --cached --others --exclude-standard)

# Commit messages, with author and committer names. The range is listed first, so a range git can't
# resolve fails the check instead of passing it with nothing read.
range=${SCRUB_RANGE:-HEAD --not --remotes}
checked=0
if [ "$range" != none ]; then
	read -r -a revs <<<"$range"
	commits=$(git rev-list "${revs[@]}") || {
		echo "::error::scrub: git couldn't list the commits in \"$range\", so no commit message was checked"
		exit 1
	}
	while IFS= read -r commit; do
		[ -n "$commit" ] || continue
		checked=$((checked + 1))
		if git log -1 --format='%an%n%cn%n%B' "$commit" | grep -q -i -w -F -f "$words"; then
			echo "::error::scrub: a scrubbed word appears in the message or author of commit $commit"
			hits=$((hits + 1))
		fi
	done <<<"$commits"
fi

if [ "$hits" -gt 0 ]; then
	echo "::error::scrub: $hits hit(s). Reword them; for a commit message, rewrite the branch before it is merged"
	exit 1
fi
echo "scrub: $count word(s), no hits in the tree, its paths or $checked commit message(s)"
