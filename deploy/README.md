# Deploy Bona Fide

Run the App (webhooks, the Keeper and the deposit relay) and the static pages on one server, behind
Caddy, on one origin. You deploy with one command from your machine.

## How it fits together

```
                ┌─ /webhook, /relay/*, /forfeit, /binding-proof, /bounty/payout, /decisions, /health ─> App container (127.0.0.1:8930)
client ─443─> Caddy
                └─ everything else ─> static pages in /opt/bona-fide/site/pages
```

Caddy gets the site's TLS certificate and caps request bodies at 1 MB. The App listens on
127.0.0.1 only, so Caddy is the one way in.

| File in `deploy/` | What it is |
|---|---|
| `Dockerfile` | The App's image: production dependencies only, runs as `node`, checks `/health` |
| `docker-compose.yml` | The `bona-fide-app` service: port 8930 on 127.0.0.1, settings from `.env`, restarts unless stopped, read-only filesystem except the `bona-fide-data` volume for the decision log and Contributor records, no capabilities, 512 MB of memory |
| `Caddyfile.bonafide` | The site block. Its first line names the site's hosts, the main one first: change it to run your own instance |
| `.env.example` | Every setting the App reads, with a line on each |
| `deploy.sh` | The command you run from your machine. It copies the release into a new private directory on the server (`mktemp -d`) and checks its SHA-256 before unpacking it |
| `install.sh` | What `deploy.sh` runs on the server |

On the server, everything lives in `/opt/bona-fide`:

```
/opt/bona-fide/
├── .env                     your settings and keys: chmod 600, never in the repo
├── docker-compose.yml  Dockerfile  .dockerignore  .env.example
├── package.json  package-lock.json  the workspace's: the App's dependencies, pinned
├── sdk/                     the SDK the App imports
├── app/                     the App's source
├── site/Caddyfile.bonafide  the site block Caddy imports
├── site/pages/              the static pages
├── REVISION                 the installed commit
├── deploys.log              one line per finished deploy: time and commit
└── backups/                 Caddy's files as they were before each of the last 10 deploys
```

## What you need

- **The server:** Linux with Docker Engine, the Docker Compose plugin and curl, and Caddy already
  serving ports 80 and 443, either as a service on the host or in a container. You reach it over
  ssh as a user who can write to `/opt` and run `docker`.
- **Your machine:** a checkout of this repo, with bash, git, ssh, scp, tar and curl.

## First deploy

1. **Point the DNS at the server.** Add an A record for the site's host name with the server's
   address, and check it with `dig +short <host name>`. If the domain's DNS is on Cloudflare, set
   the record to **DNS only** (grey cloud), not proxied: Caddy must get its own certificate and see
   real client addresses. Proxying through Cloudflare needs an origin certificate and
   `CF-Connecting-IP` handling, which this setup doesn't cover.

2. **Preview the deploy.** `deploy/deploy.sh --dry-run <ssh host>` prints what it would copy and run.
   Nothing reaches the server.

3. **Deploy once.** `deploy/deploy.sh <ssh host>` stops before it changes anything, because
   `/opt/bona-fide/.env` doesn't exist yet. It leaves `.env.example` there for you.

4. **Fill in `.env` on the server.**

   ```shell
   cd /opt/bona-fide
   cp .env.example .env && chmod 600 .env
   ```

   Each line in the file says what goes there. For the values that take more than a copy and paste:

   - `WEBHOOK_SECRET`: make one with `openssl rand -hex 32`, and set the same value in the GitHub
     App's settings.
   - `GITHUB_PRIVATE_KEY`: copy the App's private key file to `/opt/bona-fide/app.pem`. This puts
     it into `.env` on one line, then deletes the file:

     ```shell
     (umask 077; { grep -v '^GITHUB_PRIVATE_KEY=' .env; printf "GITHUB_PRIVATE_KEY='%s'\n" "$(awk '{ printf "%s\\n", $0 }' app.pem)"; } >.env.new) && mv .env.new .env && rm app.pem
     ```

   - `KEEPER_PRIVATE_KEY`: the key of the address the escrow names as its Keeper.
     `RELAYER_PRIVATE_KEY` may be the same key or a new one (`cast wallet new`). Arc gas is paid in
     USDC, so send each address a little USDC on Arc.
   - `BOUNTY_FACTORY_ADDRESS`, for [Bounties](../app/README.md#bounties): the `BountyWalletFactory`
     deployed with the same Keeper address as the escrow, with its deploy block in
     `BOUNTY_FACTORY_FROM_BLOCK`. Subscribe the GitHub App to **Issue comment** events too, so a
     Contributor who names their wallet after the merge is paid.

5. **Deploy again.** `deploy/deploy.sh <ssh host>` starts the App, then adds the site to Caddy.
   It finds Caddy as the container that publishes port 443, or else the `caddy` service on the
   host. To choose, set `CADDY_CONTAINER=<name>`, or `CADDYFILE=<path>` for Caddy on the host.
   - **Caddy runs on the host:** the deploy adds `import /opt/bona-fide/site/*.bonafide` to
     `/etc/caddy/Caddyfile` and ends with `https://<host name>/health answers 200 ok`.
   - **Caddy runs in a container:** the deploy stops and names the settings that container lacks,
     with its Compose project. Go on to step 6.

6. **Caddy in a container only: give it three settings, once.** Add them to its Compose service
   and recreate it. The `bona-fide` network exists from step 5. Keep the settings where that
   stack's own deploys won't overwrite them.

   ```yaml
   services:
     caddy:
       environment:
         BONA_FIDE_UPSTREAM: bona-fide-app:3000   # the App, over the network below
       volumes:
         - /opt/bona-fide/site:/opt/bona-fide/site:ro
       networks:
         - default                                # keep the networks it uses now
         - bona-fide
   networks:
     bona-fide:
       external: true
   ```

   Then `deploy/deploy.sh <ssh host>` adds the import line to Caddy's Caddyfile and ends with
   `https://<host name>/health answers 200 ok`.

7. **Send GitHub's webhooks here.** In the GitHub App's settings, set the webhook URL to
   `https://<host name>/webhook` with the secret from `.env`. Under **Advanced**, redeliver a recent
   delivery: it should get 200.

## Redeploy

```shell
git pull
deploy/deploy.sh <ssh host>
```

A deploy replaces the App's code and the pages, rebuilds the image on the newest `node:24-alpine`
(or, if it can't pull that, on the one the server has), and recreates the container only if
something changed. It never touches `.env`.

- The pages are built into `web/dist` first, for the network `web/landing/config.js` names (see
  [../web/README.md](../web/README.md#build)), so run `npm ci` at the repo root once. To publish
  pages built some other way, set `PAGES_DIR` to their folder; if it doesn't exist, the pages
  already on the server stay.
- Uncommitted changes in `app/`, `sdk/`, `web/`, the root package files or `deploy/` are deployed too, and the revision is marked `-dirty`.
- If the connection drops during a deploy, run it again: every step is safe to repeat.

## Logs

```shell
ssh <ssh host> 'cd /opt/bona-fide && docker compose logs -f --tail=100'
```

With triage on, each triage decision is one JSON line with `"event":"triage"`; `grep '"event":"triage"'`
picks them out. With Bounties on, each Payout is one with `"event":"pay"`, and each Bounty left to the
Maintainer one with `"event":"hold"`.

The App logs its errors in full, and an RPC error can include the RPC's URL. If `RPC_URL` holds an
API key, don't share the logs as they are. `docker compose config` prints every value in `.env`, so
don't run it where others can see.

Caddy's own logs: `journalctl -u caddy` for the host service, or `docker logs <container>`.

## The decision log

The App keeps its [decision log](../app/README.md#decision-log) in `/data/decisions.jsonl` on the
`bona-fide-data` Docker volume, so it survives deploys, rebuilds and restarts; `docker-compose.yml`
sets `DECISIONS_PATH` to it. It holds private repos' decisions too, though the App never serves
those. With `ANTHROPIC_API_KEY` set, the same volume holds `/data/records.jsonl` (`RECORDS_PATH`),
which links each Deposit to its Contributor for [Record Exemptions](../app/README.md#record-exemption).
It names who deposited in private repos, so treat it like the log. A lost file is rebuilt from the
chain and GitHub, a few Deposits a second; the Record Exemptions granted are in the decision log.

To read the log or back it up:

```shell
ssh <ssh host> 'docker exec bona-fide-app tail -n 20 /data/decisions.jsonl'
ssh <ssh host> 'docker exec bona-fide-app cat /data/decisions.jsonl' > decisions.jsonl
```

`docker compose down -v` deletes the volume and the log with it; `docker compose down` keeps it.

## Restart

```shell
ssh <ssh host> 'cd /opt/bona-fide && docker compose restart'
```

`restart` keeps the settings the container started with. After you edit `.env`, run
`docker compose up -d` instead: it recreates the container with the new values.

After an outage longer than about 85 minutes, the watcher can miss Deposits made in the meantime.
Set `WATCH_FROM_BLOCK` in `.env` to a block from before the outage and run `docker compose up -d`.
Once the App has caught up, comment the line out and run `docker compose up -d` again.

## Roll back

Each finished deploy adds its time and commit to `/opt/bona-fide/deploys.log`. To go back:

```shell
ssh <ssh host> 'tail -n 5 /opt/bona-fide/deploys.log'
git switch --detach <commit>
deploy/deploy.sh <ssh host>
git switch -
```

Caddy's files from before each of the last 10 deploys are in `/opt/bona-fide/backups/`.

## Check it

- `curl https://<host name>/health` answers `ok`.
- `docker compose ps` in `/opt/bona-fide` shows `bona-fide-app` as `(healthy)`.
- `/opt/bona-fide/REVISION` holds the installed commit.

## Known limits

- **Per-IP limits need `TRUST_PROXY=1`.** Behind Caddy every connection comes from Caddy, so the
  App counts each caller by the rightmost `X-Forwarded-For` address instead, which Caddy sets to
  the client's real address, dropping any value a client sends. `.env.example` sets it. It is safe
  only while Caddy is the one way in: keep the App bound to 127.0.0.1, and keep the `bona-fide`
  Docker network for Caddy alone, since anything else on it could send its own `X-Forwarded-For`.
- **Bodies over 1 MB get 413 from Caddy.** Caddy cuts such a request off midway, and the App logs
  `webhook failed: Error: aborted` for it.
- **The import line can live in another stack's Caddyfile.** When Caddy runs in a container that
  another project deploys, the import line goes into that project's Caddyfile. If its deploy replaces
  the file, this site disappears at Caddy's next reload until you deploy again. Add
  `import /opt/bona-fide/site/*.bonafide` to that project's own Caddyfile to keep it.
- **If Caddy can't see `/opt/bona-fide/site`, this site goes dark, but Caddy keeps running.** The
  import is a glob, and a glob that matches no file is skipped. So a Caddy container recreated
  without the mount still starts and serves its other sites, and the deploy's check reports this
  site missing.
