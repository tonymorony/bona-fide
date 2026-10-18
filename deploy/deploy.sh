#!/usr/bin/env bash
# Deploys the Bona Fide App and its pages to a server over ssh, in one command:
# packs a release, copies it to /opt/bona-fide, runs install.sh there, then checks the site.
# It never reads, prints or copies .env.
#
#   deploy/deploy.sh [--dry-run] <ssh-host>
#
#   --dry-run        print the plan and the commands, and run nothing on the server
#   PAGES_DIR        the built static pages to publish (default: web/dist). If it doesn't
#                    exist, the pages already on the server stay.
#   CADDY_CONTAINER  passed to install.sh: the Caddy container, if detection picks the wrong one
#   CADDYFILE        passed to install.sh: the main Caddyfile of a Caddy that runs on the host
set -euo pipefail

remote_dir=/opt/bona-fide

say() { printf '%s\n' "$*"; }
# "1 file", "2 files": the number of files under $1.
files_in() {
	local count
	count=$(find "$1" -type f | wc -l | tr -d ' ')
	if [ "$count" = 1 ]; then say "1 file"; else say "$count files"; fi
}
die() {
	printf '\nerror: %s\n' "$*" >&2
	exit 1
}
usage() {
	awk 'NR > 1 && !/^#/ { exit } NR > 1 { sub(/^# ?/, ""); print }' "$0"
	exit "${1:-0}"
}

dry_run=0
host=""
while [ $# -gt 0 ]; do
	case "$1" in
	--dry-run) dry_run=1 ;;
	-h | --help) usage 0 ;;
	-*) usage 2 >&2 ;;
	*)
		[ -z "$host" ] || usage 2 >&2
		host=$1
		;;
	esac
	shift
done
[ -n "$host" ] || usage 2 >&2

repo=$(cd "$(dirname "$0")/.." && pwd)
pages=${PAGES_DIR:-web/dist}
case "$pages" in /*) pages_dir=$pages ;; *) pages_dir="$repo/$pages" ;; esac

revision=$(git -C "$repo" rev-parse HEAD)
if [ -n "$(git -C "$repo" status --porcelain -- package.json package-lock.json sdk/package.json sdk/src app/package.json app/src deploy)" ]; then
	revision="$revision-dirty"
	say "warning: the App, the SDK or deploy/ has uncommitted changes. They're deployed too, and the revision is marked -dirty."
fi
short=$(printf '%.12s' "$revision")
domain=$(awk '/^[^#[:space:]][^{]* \{$/ { sub(/,$/, "", $1); print $1; exit }' "$repo/deploy/Caddyfile.bonafide")
[ -n "$domain" ] || die "Can't find the site's host name in deploy/Caddyfile.bonafide. Its site block must start with a line such as: example.com {"

tmp=${TMPDIR:-/tmp}
stage=$(mktemp -d "${tmp%/}/bona-fide-deploy.XXXXXX")
trap 'rm -rf "$stage"' EXIT

# The release, laid out as /opt/bona-fide expects it.
release="$stage/release"
mkdir -p "$release/sdk" "$release/app" "$release/site"
cp "$repo/deploy/docker-compose.yml" "$repo/deploy/Dockerfile" "$repo/deploy/.env.example" "$repo/deploy/install.sh" "$release/"
cp "$repo/deploy/Dockerfile.dockerignore" "$release/.dockerignore"
cp "$repo/deploy/Caddyfile.bonafide" "$release/site/"
cp "$repo/package.json" "$repo/package-lock.json" "$release/"
cp "$repo/sdk/package.json" "$release/sdk/"
cp -R "$repo/sdk/src" "$release/sdk/src"
cp "$repo/app/package.json" "$release/app/"
cp -R "$repo/app/src" "$release/app/src"
if [ -d "$pages_dir" ]; then
	cp -R "$pages_dir" "$release/site/pages"
	pages_note="site/pages/: $(files_in "$release/site/pages") from $pages"
else
	pages_note="no pages: $pages doesn't exist, so the pages already on the server stay"
fi
say "$revision" >"$release/REVISION"
find "$release" -name .DS_Store -delete
secrets=$(find "$release" \( -name .env -o -name '.env.*' \) ! -name .env.example)
[ -z "$secrets" ] || die "Nothing was sent: the release would include an env file. Remove it, then deploy again:
$secrets"

tarball="$stage/bona-fide-$short.tgz"
case "$(tar --version 2>/dev/null)" in
*bsdtar*) COPYFILE_DISABLE=1 tar --no-mac-metadata --no-xattrs -czf "$tarball" -C "$release" . ;;
*) tar -czf "$tarball" -C "$release" . ;;
esac

# The release goes to a directory only the deploy user can write, made fresh for it, and is checked
# against its digest before anything in it runs: anyone on the server can write to /tmp.
if command -v sha256sum >/dev/null 2>&1; then digest=$(sha256sum "$tarball" | cut -d' ' -f1)
else digest=$(shasum -a 256 "$tarball" | cut -d' ' -f1); fi
remote_tmp='$remote_tmp'
remote_tarball="$remote_tmp/bona-fide-$short.tgz"
caddy_env=""
if [ -n "${CADDY_CONTAINER:-}" ]; then caddy_env="$caddy_env CADDY_CONTAINER=$(printf %q "$CADDY_CONTAINER")"; fi
if [ -n "${CADDYFILE:-}" ]; then caddy_env="$caddy_env CADDYFILE=$(printf %q "$CADDYFILE")"; fi
remote_script="set -e
echo \"$digest  $remote_tarball\" | sha256sum -c --quiet -
mkdir -p $remote_dir
rm -rf $remote_dir/.incoming
mkdir $remote_dir/.incoming
tar -xzf $remote_tarball -C $remote_dir/.incoming --no-same-owner
rm -rf $remote_tmp
${caddy_env# }${caddy_env:+ }bash $remote_dir/.incoming/install.sh </dev/null"

if [ "$dry_run" = 1 ]; then
	say "Dry run: deploying $short to $host. Nothing is copied or run on the server."
	say
	say "Release ($(files_in "$release"), $(du -h "$tarball" | cut -f1 | tr -d ' ') packed):"
	say "  docker-compose.yml  Dockerfile  .dockerignore  .env.example  install.sh  REVISION"
	say "  package.json and package-lock.json: the workspace's"
	say "  sdk/: package.json and src/ ($(files_in "$release/sdk/src"))"
	say "  app/: package.json and src/ ($(files_in "$release/app/src"))"
	say "  site/Caddyfile.bonafide"
	say "  $pages_note"
	say
	say "1. Copy the release to $host, into a new private directory (sha256 $digest):"
	say "   remote_tmp=\$(ssh $host 'mktemp -d')"
	say "   scp -q -o ServerAliveInterval=5 -o ServerAliveCountMax=6 $tarball $host:$remote_tarball"
	say
	say "2. Install it on $host:"
	say "   ssh -o ServerAliveInterval=5 -o ServerAliveCountMax=6 $host '"
	printf '%s\n' "$remote_script" | sed 's/^/     /'
	say "   '"
	say "   install.sh then, on $host:"
	say "   - checks Docker, Docker Compose, curl, and that $remote_dir/.env exists (it never reads it)"
	say "   - finds Caddy: a container that publishes port 443, else the caddy service on the host"
	say "   - installs docker-compose.yml, Dockerfile, the package files, sdk/, app/ and site/pages/ in $remote_dir"
	say "   - runs 'docker compose up -d --build' and waits for http://127.0.0.1:8930/health"
	say "   - installs $remote_dir/site/Caddyfile.bonafide, adds 'import $remote_dir/site/*.bonafide'"
	say "     to Caddy's main Caddyfile if it isn't there, validates, and reloads Caddy; if Caddy"
	say "     rejects the config, it puts both files back"
	say
	say "3. Check the site from here:"
	say "   curl -sS https://$domain/health   (expect: ok)"
	exit 0
fi

say "Deploying $short to $host ($pages_note)."
made=$(ssh -o ServerAliveInterval=5 -o ServerAliveCountMax=6 "$host" 'mktemp -d') ||
	die "Nothing was sent: couldn't make a private directory on $host."
case "$made" in /*) ;; *) die "Nothing was sent: $host answered mktemp with '$made'." ;; esac
remote_tarball=${remote_tarball//\$remote_tmp/$made}
remote_script=${remote_script//\$remote_tmp/$made}
scp -q -o ServerAliveInterval=5 -o ServerAliveCountMax=6 "$tarball" "$host:$remote_tarball"
ssh -o ServerAliveInterval=5 -o ServerAliveCountMax=6 "$host" "$remote_script"

# The first certificate can take Caddy a little while, so the check retries for about a minute.
url="https://$domain/health"
printf '\n==> Checking %s\n' "$url"
proxied="the DNS record for $domain is proxied through Cloudflare. Set it to DNS only (grey cloud),
so Caddy gets its own certificate and sees real client IPs."
for attempt in 1 2 3 4 5 6 7 8 9 10 11 12; do
	rm -f "$stage/headers" "$stage/body" "$stage/error"
	code=$(curl -sS --max-time 10 -D "$stage/headers" -o "$stage/body" -w '%{http_code}' "$url" 2>"$stage/error") || code=000
	body=""
	server=""
	if [ -f "$stage/body" ]; then body=$(head -c 200 "$stage/body"); fi
	if [ -f "$stage/headers" ]; then
		server=$(awk -F': *' 'tolower($1) == "server" { sub(/\r$/, "", $2); name = tolower($2) } END { print name }' "$stage/headers")
	fi
	if [ "$code" = 200 ] && [ "$body" = ok ]; then
		if [ "$server" = cloudflare ]; then say "warning: $url answers, but $proxied"; fi
		say "$url answers 200 ok. Deployed $short."
		exit 0
	fi
	case "$code/$server" in
	525/* | 526/* | */cloudflare) die "$url answers $code: $proxied" ;;
	esac
	say "attempt $attempt: $code ${server:+(server: $server) }$(head -n 1 "$stage/error" 2>/dev/null)"
	sleep 5
done
die "$url didn't answer 200 ok. The App is installed on $host; check that:
- the DNS A record for $domain points to the server, not proxied (dig +short $domain);
- ports 80 and 443 reach Caddy, which needs them to get the certificate;
- Caddy's logs on the server show the certificate for $domain."
