#!/usr/bin/env bash
# Download the named tools from .github/pinned-tools.txt for this platform, check each one's SHA-256
# before anything runs it, and install it into $PINNED_BIN.
#
#   .github/scripts/fetch-pinned.sh zizmor actionlint gitleaks
#   .github/scripts/fetch-pinned.sh --offline zizmor      verify what is installed, download nothing
#
# PINNED_BIN defaults to $RUNNER_TEMP/pinned-bin in Actions and $TMPDIR/bona-fide-pinned-bin elsewhere.
# In Actions the directory is added to PATH for the steps that follow. A tool already installed
# from the same pin is hashed again and, when it still matches, not downloaded again.
set -euo pipefail

offline=0
if [ "${1:-}" = --offline ]; then
	offline=1
	shift
fi

root=$(git rev-parse --show-toplevel)
pins="$root/.github/pinned-tools.txt"
if [ -n "${PINNED_BIN:-}" ]; then
	bin=$PINNED_BIN
elif [ -n "${RUNNER_TEMP:-}" ]; then
	bin=$RUNNER_TEMP/pinned-bin
else
	bin=${TMPDIR:-/tmp}/bona-fide-pinned-bin
fi
mkdir -p "$bin"

machine="$(uname -s)-$(uname -m)"
# An x86_64 shell under Rosetta (an Intel build of Node or bash runs this) still sits on Apple silicon, and
# runs the arm64 binaries natively. A real Intel Mac has no pinned rows and is refused.
if [ "$machine" = Darwin-x86_64 ] && [ "$(sysctl -n hw.optional.arm64 2>/dev/null)" = 1 ]; then
	machine=Darwin-arm64
fi
case "$machine" in
Linux-x86_64) platform=linux-x64 ;;
Darwin-arm64) platform=darwin-arm64 ;;
*)
	echo "::error::no pinned tools for $machine; add rows to .github/pinned-tools.txt" >&2
	exit 2
	;;
esac

hash_of() {
	if command -v sha256sum >/dev/null 2>&1; then
		sha256sum "$1" | cut -d ' ' -f 1
	else
		shasum -a 256 "$1" | cut -d ' ' -f 1
	fi
}

[ "$#" -gt 0 ] || {
	echo "usage: $0 <tool>..." >&2
	exit 2
}

for tool in "$@"; do
	row=$(awk -v t="$tool" -v p="$platform" '$1 == t && $3 == p' "$pins")
	if [ -z "$row" ]; then
		echo "::error::$tool has no $platform row in .github/pinned-tools.txt" >&2
		exit 2
	fi
	read -r _ version _ sha256 member url <<<"$row"
	case "$url" in
	https://*) ;;
	*)
		echo "::error::$tool: the URL must be https" >&2
		exit 2
		;;
	esac

	# The stamp holds the pin the tool was installed from and the installed file's own SHA-256. A cached tool
	# is used only when both still match: the pin in the file, and the bytes on disk.
	stamp="$bin/.$tool.sha256"
	if [ -x "$bin/$tool" ] && [ -f "$stamp" ]; then
		read -r stamped_pin stamped_file <"$stamp" || true
		if [ "${stamped_pin:-}" = "$sha256" ] && [ "${stamped_file:-}" = "$(hash_of "$bin/$tool")" ]; then
			echo "$tool $version: already in $bin (sha256 verified)"
			continue
		fi
		echo "$tool $version: the copy in $bin doesn't match its pin or its recorded hash" >&2
	fi
	if [ "$offline" = 1 ]; then
		echo "::error::$tool $version isn't verified in $bin, and --offline downloads nothing: run once without --offline" >&2
		exit 1
	fi

	tmp=$(mktemp -d)
	curl --silent --show-error --fail --location --retry 3 \
		--proto '=https' --tlsv1.2 --output "$tmp/download" "$url"
	actual=$(hash_of "$tmp/download")
	if [ "$actual" != "$sha256" ]; then
		echo "::error::$tool $version: SHA-256 mismatch for $url (pinned $sha256, got $actual)" >&2
		rm -rf "$tmp"
		exit 1
	fi

	if [ "$member" = - ]; then
		install -m 0755 "$tmp/download" "$bin/$tool"
	else
		mkdir "$tmp/x"
		tar -xzf "$tmp/download" -C "$tmp/x" "$member"
		install -m 0755 "$tmp/x/$member" "$bin/$tool"
	fi
	printf '%s %s\n' "$sha256" "$(hash_of "$bin/$tool")" >"$stamp"
	rm -rf "$tmp"
	echo "$tool $version: installed to $bin/$tool (sha256 verified)"
done

if [ -n "${GITHUB_PATH:-}" ]; then
	echo "$bin" >>"$GITHUB_PATH"
fi
