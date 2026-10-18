#!/usr/bin/env bash
# Lints every shell script in the repo with shellcheck, and checks its layout with shfmt.
# git lists the files, tracked or new, so node_modules and the contracts' submodules stay out.
#
#   scripts/lint-shell.sh
#
# shfmt runs with its defaults: tabs, as the scripts are written. SHFMT names its binary if it isn't on PATH.
set -euo pipefail

cd "$(dirname "$0")/.."
shfmt=${SHFMT:-shfmt}
command -v shellcheck >/dev/null || {
	echo "shellcheck isn't installed: brew install shellcheck, or your Linux distribution's shellcheck package" >&2
	exit 1
}
command -v "$shfmt" >/dev/null || {
	echo "shfmt isn't installed: brew install shfmt, or https://github.com/mvdan/sh/releases" >&2
	exit 1
}

scripts=()
while IFS= read -r -d '' file; do scripts+=("$file"); done < <(git ls-files -z --cached --others --exclude-standard -- '*.sh')
[ ${#scripts[@]} -gt 0 ] || exit 0

shellcheck "${scripts[@]}"
"$shfmt" --diff "${scripts[@]}"
echo "${#scripts[@]} shell scripts pass shellcheck and shfmt."
