#!/usr/bin/env bash
# Installs a Bona Fide release on this server, starts the App, and serves the site through Caddy.
# deploy.sh unpacks the release into /opt/bona-fide/.incoming and runs this script from there.
# It never reads .env: it only checks that the file exists and that only its owner can read it.
#
# Caddy is found on its own: a container that publishes port 443, or else the caddy service on
# this host. To choose, set CADDY_CONTAINER=<name>, or CADDYFILE=<path> for a Caddy on the host.
set -euo pipefail

incoming=$(cd "$(dirname "$0")" && pwd)
dir=$(dirname "$incoming")
site="$dir/site"
snippet="$site/Caddyfile.bonafide"
# A glob, not the file's path: if Caddy ever can't see $site, it still starts and serves its other
# sites, where a missing file would stop it.
import_line="import $site/*.bonafide"
health_url="http://127.0.0.1:8930/health"
upstream_default="127.0.0.1:8930"
container_upstream="bona-fide-app:3000"

caddy_container=""
container_config=""
caddyfile=""
backup=""

say() { printf '%s\n' "$*"; }
step() { printf '\n==> %s\n' "$*"; }
die() {
	printf '\nerror: %s\n' "$*" >&2
	exit 1
}

preflight() {
	step "Checking the server"
	command -v docker >/dev/null || die "Docker isn't installed. Install Docker Engine, then deploy again."
	docker compose version >/dev/null 2>&1 ||
		die "Docker Compose v2 isn't installed. Install the docker compose plugin, then deploy again."
	command -v curl >/dev/null || die "curl isn't installed. Install it, then deploy again."
	if [ ! -f "$dir/.env" ]; then
		cp "$incoming/.env.example" "$dir/.env.example"
		die "$dir/.env doesn't exist. Create it from the example, fill it in, then deploy again:
  cp $dir/.env.example $dir/.env && chmod 600 $dir/.env"
	fi
	local mode
	mode=$(stat -c %a "$dir/.env")
	if [ "$mode" != 600 ]; then
		say "warning: other users on this server can read $dir/.env (mode $mode). Run: chmod 600 $dir/.env"
	fi
	say "Docker, Docker Compose and $dir/.env are in place."
}

# The container that publishes the host's port 443, if any.
container_on_port_443() {
	local rows
	rows=$(docker ps --format '{{.Names}}	{{.Ports}}')
	awk -F'\t' 'index($2, ":443->") { print $1; exit }' <<<"$rows"
}

# The --config path the Caddy container runs with, or the image's default.
container_config_path() {
	local arg previous="" config=/etc/caddy/Caddyfile
	while IFS= read -r arg; do
		if [ "$previous" = --config ]; then config=$arg; fi
		case "$arg" in --config=*) config=${arg#--config=} ;; esac
		previous=$arg
	done < <(docker inspect -f '{{range .Args}}{{println .}}{{end}}' "$1")
	say "$config"
}

# Where a path inside a container lives on this host, if a bind mount provides it.
host_path_of() {
	local mounts source target
	mounts=$(docker inspect -f '{{range .Mounts}}{{if eq .Type "bind"}}{{.Source}}|{{.Destination}}{{println}}{{end}}{{end}}' "$1")
	while IFS='|' read -r source target; do
		if [ "$target" = "$2" ]; then
			say "$source"
			return
		fi
	done <<<"$mounts"
	while IFS='|' read -r source target; do
		case "$2" in "$target"/*)
			say "$source${2#"$target"}"
			return
			;;
		esac
	done <<<"$mounts"
}

find_caddy() {
	if [ -n "${CADDY_CONTAINER:-}" ]; then
		caddy_container=$CADDY_CONTAINER
	elif [ -n "${CADDYFILE:-}" ]; then
		caddyfile=$CADDYFILE
	else
		caddy_container=$(container_on_port_443)
		if [ -z "$caddy_container" ]; then
			systemctl is-active --quiet caddy 2>/dev/null || die "No Caddy found: no container publishes port 443, and the caddy service isn't running.
Set CADDY_CONTAINER=<container name>, or CADDYFILE=<main Caddyfile> for a Caddy on this host, and deploy again.
Nothing was changed."
			caddyfile=/etc/caddy/Caddyfile
		fi
	fi

	if [ -n "$caddy_container" ]; then
		docker exec "$caddy_container" caddy version >/dev/null 2>&1 ||
			die "The container $caddy_container isn't a running Caddy. Set CADDY_CONTAINER to the Caddy container's name. Nothing was changed."
		container_config=$(container_config_path "$caddy_container")
		caddyfile=$(host_path_of "$caddy_container" "$container_config")
		[ -n "$caddyfile" ] ||
			die "Can't add the site to Caddy: $caddy_container reads $container_config, which isn't a file on this host.
Mount Caddy's config from this host, then deploy again. Nothing was changed."
		say "Caddy runs in the container $caddy_container, with its config at $caddyfile."
	else
		command -v caddy >/dev/null ||
			die "The caddy command isn't on this host. If Caddy runs in a container, set CADDY_CONTAINER=<name>. Nothing was changed."
		[ -f "$caddyfile" ] || die "$caddyfile doesn't exist. Set CADDYFILE to Caddy's main Caddyfile. Nothing was changed."
		say "Caddy runs on this host, with its config at $caddyfile."
	fi
}

# Moves $1 to $2, swapping out what was there.
replace() {
	rm -rf "$2.old"
	if [ -e "$2" ]; then mv "$2" "$2.old"; fi
	mv "$1" "$2"
	rm -rf "$2.old"
}

install_files() {
	step "Installing release $(cat "$incoming/REVISION")"
	cp "$incoming/docker-compose.yml" "$incoming/Dockerfile" "$incoming/.dockerignore" "$incoming/.env.example" "$incoming/REVISION" "$dir/"
	cp "$incoming/package.json" "$incoming/package-lock.json" "$dir/"
	replace "$incoming/sdk" "$dir/sdk"
	replace "$incoming/app" "$dir/app"
	mkdir -p "$site"
	if [ -d "$incoming/site/pages" ]; then
		replace "$incoming/site/pages" "$site/pages"
		local count
		count=$(find "$site/pages" -type f | wc -l | tr -d ' ')
		if [ "$count" = 1 ]; then say "Pages: 1 file."; else say "Pages: $count files."; fi
	else
		mkdir -p "$site/pages"
		say "This release has no pages, so the pages already on the server stay."
	fi
}

start_app() {
	step "Building and starting the App"
	(cd "$dir" && docker compose up -d --build --remove-orphans)
	say "Waiting for $health_url"
	local _
	for _ in $(seq 1 30); do
		if [ "$(curl -fsS --max-time 3 "$health_url" 2>/dev/null)" = ok ]; then
			say "The App answers: ok"
			return
		fi
		sleep 2
	done
	local missing
	missing=$(docker logs --tail 50 bona-fide-app 2>&1 | sed -nE 's/^Error: Set ([A-Z0-9_]+)\.$/\1/p' | tail -n 1)
	if [ -n "$missing" ]; then
		die "The App didn't start: $dir/.env has no value for $missing.
Fill it in, then deploy again. The App stops at the first missing value, so check the others
against $dir/.env.example too."
	fi
	die "The App didn't answer on $health_url within a minute.
To see why: cd $dir && docker compose ps && docker compose logs --tail=50"
}

# A Caddy container can serve the site once it sees $site and reaches the App.
check_container() {
	local problems="" upstream
	if ! docker exec "$caddy_container" test -r "$snippet"; then
		problems="$problems
  - $site isn't mounted in the container."
	fi
	upstream=$(docker exec "$caddy_container" sh -c "printf %s \"\${BONA_FIDE_UPSTREAM:-$upstream_default}\"")
	if docker exec "$caddy_container" sh -c 'command -v wget' >/dev/null 2>&1; then
		if ! docker exec "$caddy_container" wget -q -O /dev/null -T 5 "http://$upstream/health" 2>/dev/null; then
			problems="$problems
  - Caddy can't reach the App at $upstream."
		fi
	else
		say "Can't check that Caddy reaches the App at $upstream: its image has no wget."
	fi
	[ -n "$problems" ] || return 0
	restore_snippet

	local project service files
	project=$(docker inspect -f '{{index .Config.Labels "com.docker.compose.project.working_dir"}}' "$caddy_container")
	service=$(docker inspect -f '{{index .Config.Labels "com.docker.compose.service"}}' "$caddy_container")
	files=$(docker inspect -f '{{index .Config.Labels "com.docker.compose.project.config_files"}}' "$caddy_container")
	die "The App is running, but Caddy can't serve the site yet:$problems

Caddy runs in the container $caddy_container${project:+ (Compose service \"$service\" in $project, from $files)}.
Give that service these settings once, recreate it, and deploy again:

    environment:
      BONA_FIDE_UPSTREAM: $container_upstream
    volumes:
      - $site:$site:ro
    networks:            # keep the networks it uses now (default, if none are listed)
      - default
      - bona-fide

and at the top level of the same Compose file:

    networks:
      bona-fide:
        external: true

Caddy's config was not changed."
}

validate_caddy() {
	if [ -n "$caddy_container" ]; then
		docker exec "$caddy_container" caddy validate --config "$container_config" --adapter caddyfile 2>&1
	else
		caddy validate --config "$caddyfile" --adapter caddyfile 2>&1
	fi
}

reload_caddy() {
	if [ -n "$caddy_container" ]; then
		docker exec "$caddy_container" caddy reload --config "$container_config" --adapter caddyfile 2>&1
	elif systemctl is-active --quiet caddy 2>/dev/null; then
		systemctl reload caddy 2>&1
	else
		caddy reload --config "$caddyfile" --adapter caddyfile 2>&1
	fi
}

# `cat >` keeps each file's inode, which a container's single-file mount needs to see the change.
restore_snippet() {
	if [ -f "$backup/Caddyfile.bonafide" ]; then
		cat "$backup/Caddyfile.bonafide" >"$snippet"
	else
		rm -f "$snippet"
	fi
}

restore_caddy() {
	cat "$backup/Caddyfile" >"$caddyfile"
	restore_snippet
}

hook_caddy() {
	step "Serving the site through Caddy"
	backup="$dir/backups/$(date -u +%Y%m%dT%H%M%SZ)"
	mkdir -p "$backup"
	cp -p "$caddyfile" "$backup/Caddyfile"
	if [ -f "$snippet" ]; then cp -p "$snippet" "$backup/Caddyfile.bonafide"; fi
	cp "$incoming/site/Caddyfile.bonafide" "$snippet"

	if [ -n "$caddy_container" ]; then check_container; fi

	if grep -qE "^[[:space:]]*import[[:space:]]+${site//./\\.}/(\\*\\.bonafide|Caddyfile\\.bonafide)[[:space:]]*$" "$caddyfile"; then
		say "$caddyfile already imports $snippet."
	else
		printf '\n%s\n' "$import_line" >>"$caddyfile"
		say "Added to $caddyfile: $import_line"
	fi

	local output
	if ! output=$(validate_caddy); then
		restore_caddy
		die "Caddy rejected the new config, so its files are back as they were. Caddy says:
$output"
	fi
	say "Caddy accepts the config."
	output=$(reload_caddy) || die "Caddy didn't reload, though the new config is valid. Reload or restart Caddy yourself. Caddy says:
$output"
	say "Caddy reloaded."

	local old
	for old in $(find "$dir/backups" -mindepth 1 -maxdepth 1 -type d | sort -r | tail -n +11); do rm -rf "$old"; done
}

finish() {
	printf '%s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$(cat "$dir/REVISION")" >>"$dir/deploys.log"
	step "Deployed $(cat "$dir/REVISION")"
	(cd "$dir" && docker compose ps)
	rm -rf "$incoming"
}

preflight
find_caddy
install_files
start_app
hook_caddy
finish
