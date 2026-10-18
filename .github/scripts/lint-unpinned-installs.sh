#!/usr/bin/env bash
# Refuse an install that isn't pinned in the commands CI and deploys run: the workflows, the scripts they
# call, and the deploy scripts. Each pattern names what to do instead.
set -euo pipefail

root=$(git rev-parse --show-toplevel)
cd "$root"
self=.github/scripts/lint-unpinned-installs.sh

files=()
while IFS= read -r file; do
	[ "$file" = "$self" ] || [ ! -f "$file" ] || files+=("$file")
done < <(git ls-files --cached --others --exclude-standard -- '.github/workflows/*.yml' '.github/workflows/*.yaml' \
	'.github/scripts/*.sh' 'scripts/*.sh' 'deploy/*.sh' 'deploy/Dockerfile')
[ "${#files[@]}" -gt 0 ] || {
	echo "unpinned installs: no files to check"
	exit 0
}

# One command per line: join lines continued with a trailing backslash, drop comment lines, and keep the
# file and line number the command starts on.
commands=$(mktemp)
trap 'rm -f "$commands"' EXIT
awk '
  FNR == 1 { if (held != "") print where ":" held; held = "" }
  {
    line = $0
    if (held == "") { if (line ~ /^[[:space:]]*#/) next; where = FILENAME ":" FNR }
    if (line ~ /\\$/) { held = held substr(line, 1, length(line) - 1) " "; next }
    print where ":" held line
    held = ""
  }
  END { if (held != "") print where ":" held }
' "${files[@]}" >"$commands"

bad=0
check() { # $1 = what is wrong and what to do, $2 = pattern, $3 = pattern that makes a hit acceptable
	local hits
	hits=$(grep -E -e "$2" "$commands" | grep -vE -e "${3:-^$}" || true)
	if [ -n "$hits" ]; then
		echo "::error::$1"
		printf '%s\n' "$hits"
		bad=1
	fi
}

check 'pip install without --require-hashes: install from a requirements file compiled with hashes' \
	'\b(pip3?|python3? -m pip|uv pip) install\b' '--require-hashes'
check 'npm install/add/update resolves new versions: use npm ci, which installs package-lock.json exactly' \
	'\bnpm (i|install|add|update|up)\b' '@[0-9]+\.[0-9]+\.[0-9]+'
check 'npx can download a package: use npm exec --no -- <bin> for a local tool, or pin name@x.y.z' \
	'\bnpx\b' '--no-install|@[0-9]+\.[0-9]+\.[0-9]+'
check 'yarn/pnpm add or install without a frozen lockfile' \
	'\b(yarn|pnpm) (add|install|i)\b' '--frozen-lockfile|--immutable'
check 'an installer piped into a shell: fetch it with .github/scripts/fetch-pinned.sh, which checks its SHA-256' \
	'(curl|wget)[^|]*\|[[:space:]]*(sudo[[:space:]]+)?(ba|z)?sh\b'
check 'a floating ref (@latest, @main, @master)' \
	'@(latest|main|master)\b'
check 'go install / cargo install without a version' \
	'\b(go install|cargo install)\b' '@v?[0-9]|--version'
check 'foundryup without a pinned version: fetch forge with .github/scripts/fetch-pinned.sh' \
	'\bfoundryup\b' '(-i|--install) v?[0-9]'
check 'apt-get/apt install without a pinned version (name=version)' \
	'\bapt(-get)? install\b' '[a-z0-9.+-]+=[0-9]'

# One Foundry everywhere: the check workflow installs FOUNDRY with foundry-toolchain, and the security check
# fetches forge from .github/pinned-tools.txt. forge fmt's output differs between releases, so they agree.
pinned_forge=$(awk '$1 == "forge" { print $2 }' .github/pinned-tools.txt | sort -u)
check_forge=$(sed -nE 's/^[[:space:]]+FOUNDRY:[[:space:]]*"?v?([0-9]+\.[0-9]+\.[0-9]+)"?.*/\1/p' .github/workflows/check.yml)
if [ -z "$pinned_forge" ] || [ "$pinned_forge" != "$check_forge" ]; then
	echo "::error::Foundry differs: .github/pinned-tools.txt pins forge ${pinned_forge:-nothing}, .github/workflows/check.yml FOUNDRY is v${check_forge:-nothing}. Bump both together"
	bad=1
fi

if [ "$bad" -ne 0 ]; then
	echo "::error::unpinned install found: pin it (docs/security/dependency-policy.md)"
	exit 1
fi
echo "unpinned installs: none in ${#files[@]} file(s)"
