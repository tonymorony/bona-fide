# Bona Fide GitHub App

The App decides who must put down a Deposit to open a PR or an issue, asks for it, and notices it
on-chain. Its Keeper refunds Deposits, relays the Forfeits Maintainers sign, and binds repos to
their Maintainer's wallet. Terms such as Binding and Exemption are defined in
[../CONTEXT.md](../CONTEXT.md).

## Turn it on for a repo

Install the App, then commit `.github/bona-fide.yml` on the default branch. Without the file, the
App does nothing in that repo.

```yaml
amount: 1          # USDC, more than 0 and at most 50, up to 6 decimals
forfeit: 50%       # the share of a Deposit a Forfeit can use to fund open source: 0% to 50%
timeout: 7 days    # how long the Maintainer has to decide: 1 to 60 whole days
exempt_bots:       # optional: bots that need no Deposit
  - pre-commit-ci[bot]
```

Every key is optional, and the amount, forfeit share and timeout above are the defaults. The Keeper
also reads `maintainer`, the Maintainer's wallet address, when it proposes the repo's Binding. If a
value can't be read, the App pauses: PRs get a neutral check that names the problem, and issues get
nothing.

Write each `exempt_bots` login on its own `- ` line, exactly as GitHub shows it. In the one-line
`[a, b]` form, a login ending in `[bot]` must be quoted. GitHub's Copilot coding agent opens PRs as
`Copilot`.

### The Binding comes first

The escrow charges each Deposit the terms of the repo's active on-chain Binding, not the file. The
Keeper proposes a Binding once the Maintainer has proved control of the wallet, and it takes effect
24 hours later. So:

- **Before the repo's first Binding is active,** nobody is asked for a Deposit, since the escrow
  would refuse it. PRs get a neutral check: "No Deposit needed: not set up here yet", which links
  Maintainers to the setup page, or, once a Binding is proposed, "No Deposit needed: starts in about
  N hours", with the time in UTC. Issues get nothing.
- **PRs and issues opened before the first Binding took effect** never need a Deposit. Their check
  passes with "No Deposit needed: opened before Bona Fide started here", and issues get nothing.
  Bona Fide starts in a repo at the block time of the repo's first `RepoActivated` event, so a
  later Binding with new terms doesn't move the start.
- **Once it is active,** the check shows the Binding's amount, forfeit share and Timeout. If the
  file asks for other terms, the check adds a line saying new terms are pending, with their start
  time once the Keeper has proposed them. Deposits made before then keep the terms shown.

When a Binding takes effect, whoever activated it, the watcher sees the escrow's `RepoActivated`
event in the same block scan as Deposits and checks the repo's open PRs and issues again. After the
repo's first Binding, they were all opened before Bona Fide started, so their checks pass; after a
later one, they show its terms. It checks the 20 most recently updated (`RECHECK_LIMIT` in
`src/watcher.ts`) and logs when more are open; each of those is checked again on its next event.

## How the check decides

In order:

1. **Denounced** in `VOUCHED.td` (a `-login` line): the check fails and no Deposit is offered. This
   outranks every Exemption, and acceptance too.
2. **Accepted:** the `bona-fide:ok` label means a Maintainer accepted the PR or issue. The check
   passes with a reason that names the label, and the Keeper refunds the Deposit (see
   [Refunds](#refunds)), so a later push doesn't ask for a new one.
3. **Exempt:** the check passes at once for
   - the `bona-fide:waive` label on the PR or issue;
   - anyone vouched for in `VOUCHED.td`;
   - an allowed bot: `dependabot[bot]`, `renovate[bot]`, `github-actions[bot]`, and any login in
     `exempt_bots`. Any other bot, AI coding agents included, follows the same rules as a person;
   - anyone with write, maintain or admin access;
   - anyone with a merged PR in the repo;
   - a PR or issue opened before the repo's first Binding took effect (see
     [The Binding comes first](#the-binding-comes-first)).
4. **Deposited:** a Deposit for this PR or issue, made after it was opened, turns the check green
   and shows who paid, with a link to its transaction on Arc's block explorer.
5. **Not live yet:** the repo's Binding isn't active, so the check is neutral (see above).
6. **Deposit needed:** otherwise the check asks for the Deposit and links to the deposit page.

`VOUCHED.td` is read from the repo root, then from `.github/`. PRs get one check named "Bona Fide"
on their head commit. Issues get one comment, edited in place, and the `bona-fide:deposit-required`
label while a Deposit is needed.

While the check asks for a Deposit, its Details link opens the deposit page. Once it stops asking,
the link goes to the App's homepage, where GitHub points a check that never had a link: GitHub's API
can replace a check's link but not remove it.

The check is evaluated again when the PR or issue is reopened, when a PR gets new commits, when the
`bona-fide:waive` or `bona-fide:ok` label is added or removed, when a Deposit lands, and when
someone presses **Re-run** on the check or **Re-run all checks** on its suite.

### Clock skew

An item's `created_at` comes from GitHub's clock, and a Deposit's time from its Arc block. A
Deposit counts if its block is at most `CLOCK_SKEW_SECONDS` (120 seconds, in `src/config.ts`) older
than the item, so a small difference between the two clocks can't drop a Deposit made right after
the item was opened. It works the other way for a repo's start: a PR or issue opened at most
`CLOCK_SKEW_SECONDS` after the repo's first Binding took effect counts as opened before it.

## The Keeper

The Keeper is the App's signer. Every transaction it sends is one of the escrow's `refund`,
`forfeit`, `proposeRepo` or `activateRepo`, so it can move USDC only the ways the escrow allows: to a
Deposit's own Depositor, or at most half of a Deposit to the Forfeit sink. See
[../contracts/README.md](../contracts/README.md#trust-model).

### Refunds

The Keeper refunds a Deposit in full to its Depositor when:

- the PR is merged;
- the issue is closed as completed by someone other than its author;
- the `bona-fide:ok` label is added, or the check runs again while the label is on;
- the check doesn't count the Deposit: its block is more than `CLOCK_SKEW_SECONDS` older than the
  PR or issue (see [Clock skew](#clock-skew)), or the item is exempt, or its Contributor is
  denounced. Anyone can deposit for a PR number that doesn't exist yet, which would keep the real
  Contributor from depositing, so the Keeper refunds such a Deposit as soon as the item opens;
- its Timeout has passed.

After its Timeout anyone may refund a Deposit, and the Keeper does so on its own, with no webhook:
every `REFUND_MS` (30 seconds by default) it refunds each active Deposit whose deadline is at or
before the latest block's time. It finds them in the escrow's `Deposited`, `Refunded` and
`Forfeited` events, read from `ESCROW_FROM_BLOCK` on, so a restart misses none. Just before sending,
it reads the Deposit again and refunds only that one, and only if it is still active. A refund that
fails, for example while the RPC is down, is tried again on later polls, less and less often (at
most every 1,024 polls, about 8.5 hours at the default `REFUND_MS`). The Keeper follows at most
10,000 open Deposits, the ones due first; past that, it logs how many it dropped, and anyone can
refund those after their Timeout.

A Deposit made before its item exists doesn't depend on the item's `opened` delivery. The watcher
remembers it and looks for the item again on later polls, less and less often (at most every 1,024
polls, about 17 minutes at the default `POLL_MS`), until the item exists and is checked, which
refunds the Deposit, or until the Deposit is refunded or forfeited. It remembers at most 100 such
Deposits; past that, the one waiting longest is dropped and waits for its item's own events.

It never refunds because the author closed their own PR or issue, or because an item was closed
without being accepted (a PR closed unmerged, an issue closed as not planned or a duplicate). Such a
Deposit waits for a Forfeit or the Timeout, when the Keeper refunds it. While an item carries
`bona-fide:bad-faith`, a re-check never refunds its Deposit either, even if its Contributor has
since become exempt or denounced: the Maintainer's signature or the Timeout decides.

A refunded Deposit no longer counts for the check.

### Forfeits

The `bona-fide:bad-faith` label moves no funds. The Keeper answers it with a note that links the
Maintainer to the sign page, names the Maintainer's wallet and the deadline, and says where a
Forfeit would send the USDC. The Maintainer's signature is what forfeits: the sign page sends it to
`POST /forfeit`, and the Keeper relays it.

### Bindings

A Maintainer binds a repo by committing `.github/bona-fide.yml` with a `maintainer` wallet on the
default branch (see [Turn it on for a repo](#turn-it-on-for-a-repo)), then signing a proof of
control of that wallet and sending it to `POST /binding-proof`. The Keeper proposes the file's
amount, forfeit share and Timeout for that wallet. The Binding takes effect after the escrow's
Binding delay, 24 hours at launch; the Keeper activates it then.

### Signer hygiene

- The key comes only from `KEEPER_PRIVATE_KEY`. The host prints the Keeper's address, never the key,
  and a malformed key stops it with a message that doesn't repeat it.
- Each transaction is simulated with `eth_call` first, so one the escrow would reject costs no gas.
  Transactions go out one at a time, with nonces from viem's shared nonce manager, so another
  sender in the App with the same key never reuses one.
- Each action reads the on-chain state first, so a redelivered webhook or a repeated request does
  nothing twice.
- If a transaction fails, for example because the RPC is down, the webhook answers 500 and GitHub
  marks the delivery as failed. Redeliver it from the App's advanced settings. The Deposit watcher
  retries on its own.

## GitHub App permissions and events

| Permission | Access | Used for |
|---|---|---|
| Checks | Read and write | The "Bona Fide" check on each PR |
| Issues | Read and write | The comment and label on issues |
| Pull requests | Read and write | Reading a PR when a Deposit lands or its check is re-run, finding merged PRs, and the Keeper's notes on PRs |
| Contents | Read | `.github/bona-fide.yml` and `VOUCHED.td` on the default branch |
| Metadata | Read | Required by GitHub |

Events:

- **Pull request.** The App acts on opened, reopened, synchronize, labeled, unlabeled and closed.
- **Issues.** The App acts on opened, reopened, labeled, unlabeled and closed.
- **Check run.** The App acts on rerequested, which GitHub sends when someone presses **Re-run** on
  the Bona Fide check. GitHub subscribes Apps with write access to Checks to this event
  automatically.
- **Check suite.** The App acts on rerequested, which GitHub sends when someone presses **Re-run all
  checks** on the App's suite. The App lists its Bona Fide runs in the suite and checks the PR each
  one was posted for again: GitHub lists no PRs on the suite of a fork's commit. Like check runs,
  GitHub subscribes Apps with write access to Checks to this event automatically.

## Run it

```shell
npm ci
npm start
```

`npm start` runs `src/node.ts`: an HTTP server for GitHub's webhooks, a watcher that polls the
escrow for Deposits, and, with `KEEPER_PRIVATE_KEY` set, [the Keeper](#the-keeper) and its
[endpoints](#endpoints). With `RELAYER_PRIVATE_KEY` set, it also runs the
[deposit relay](#post-relaydeposit). It is the only file that uses Node: everything `src/index.ts`
exports also bundles for a Workers-style runtime.

The host reads these environment variables:

| Variable | Default | Notes |
|---|---|---|
| `WEBHOOK_SECRET` | required | The App's webhook secret |
| `GITHUB_APP_ID` | required | |
| `GITHUB_PRIVATE_KEY` | required | The App's PEM key; `\n` escapes are allowed |
| `RPC_URL` | required | An Arc RPC endpoint that serves historical state |
| `ESCROW_ADDRESS` | required | |
| `ESCROW_FROM_BLOCK` | `0` | The escrow's deploy block. Searches start here, and on start the Keeper reads every Binding proposed and every Deposit made since |
| `DEPOSIT_PAGE_URL` | required | The check links to it with `?repo=owner/repo&kind=pr\|issue&number=N` |
| `SETUP_PAGE_URL` | required | The Maintainer's setup page. Until a repo is set up, its checks link Maintainers to it with `?repo=owner/repo` |
| `EXPLORER_URL` | `https://explorer.arc.io` | The block explorer a check links each Deposit's transaction to. On Arc testnet, `https://explorer.testnet.arc.io` |
| `PORT` | `3000` | |
| `POLL_MS` | `1000` | How often the watcher polls |
| `WATCH_FROM_BLOCK` | 10,000 blocks before the latest | Where the watcher starts after a restart |
| `KEEPER_PRIVATE_KEY` | unset | The key of the escrow's `keeper` address. Without it the App runs its checks only |
| `SIGN_PAGE_URL` | required with the Keeper | The Maintainer's sign page, with the same query as the deposit page |
| `ACTIVATE_MS` | `30000` | How often the Keeper looks for Bindings to activate |
| `REFUND_MS` | `30000` | How often the Keeper looks for Deposits past their Timeout to refund |
| `RELAYER_PRIVATE_KEY` | unset | Signs and pays the gas for relayed Deposits. It may be the Keeper's key |
| `TRUST_PROXY` | unset | `1` makes the per-IP limits count the rightmost `X-Forwarded-For` address instead of the connection's. Set it only behind a reverse proxy that overwrites `X-Forwarded-For`; see [Limits](#limits) |

The Keeper's address needs a little USDC on Arc for gas, and nothing more: no Deposit or Forfeit can
reach it.

## Endpoints

With the Keeper on, the host serves `POST /forfeit` and `POST /binding-proof` next to the
webhook. Both take and return JSON. A refusal is `{"error": "…"}` with status 400 (the request is
wrong), 404 (nothing to act on), 409 (the on-chain state doesn't allow it) or 429 (try again after
`Retry-After` seconds; see [Limits](#limits)).

Neither endpoint takes credentials: the signature in the body authorizes the action. So both answer
a CORS preflight and allow any origin, and a sign page on another origin can call them. Any method
other than `POST` gets 405.

### `POST /forfeit`

Relays a Forfeit the Maintainer signed.

```json
{
  "repo": "octocat/hello-world",
  "kind": "pr",
  "number": 7,
  "sigDeadline": 1790000000,
  "signature": "0x…"
}
```

- `kind` is `"pr"` or `"issue"`. `sigDeadline` is Unix seconds, as a number or a decimal string.
- The signature is EIP-712 over `Forfeit(bytes32 key,uint256 serial,uint256 sigDeadline)` in the
  domain `{name: "BonaFide", version: "1", chainId, verifyingContract: <escrow>}`, where `key` and
  `serial` are the Deposit's. The Keeper checks it off-chain against the Deposit's own Maintainer
  and serial, as the escrow does: an ERC-1271 wallet, or a 65-byte signature with `v` 27 or 28 and
  a low `s`. Then it simulates the Forfeit and sends it.
- `200 {"txHash": "0x…"}` once the transaction is mined.
- `502 {"error": "…", "txHash": "0x…"}` if the transaction passed simulation but reverted on-chain,
  so no funds moved. The Keeper then relays no Forfeit for that Deposit, or signed by its
  Maintainer's wallet, for 10 minutes (see [Limits](#limits)).

### `POST /binding-proof`

Proposes the Binding in the repo's `.github/bona-fide.yml`, once its Maintainer has proved control of
the wallet.

```json
{
  "repo": "octocat/hello-world",
  "maintainer": "0x…",
  "nonce": "0x…",
  "deadline": 1790000000,
  "signature": "0x…"
}
```

The proof is EIP-712 in the escrow's domain, which names the chain id and the escrow:

```
EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)
  name "BonaFide", version "1", chainId 5042 on Arc mainnet (5042002 on testnet),
  verifyingContract: the escrow

Binding(string repo,address maintainer,bytes32 nonce,uint256 deadline)
  repo        "github:" and the repo's full name in lowercase, such as "github:octocat/hello-world"
  maintainer  the wallet being bound: the one in bona-fide.yml
  nonce       32 random bytes, so each proof is a new message
  deadline    Unix seconds; the proof is refused after it
```

With Foundry, write the typed data to a file and sign it with the Maintainer's wallet:

```json
{
  "types": {
    "EIP712Domain": [
      { "name": "name", "type": "string" },
      { "name": "version", "type": "string" },
      { "name": "chainId", "type": "uint256" },
      { "name": "verifyingContract", "type": "address" }
    ],
    "Binding": [
      { "name": "repo", "type": "string" },
      { "name": "maintainer", "type": "address" },
      { "name": "nonce", "type": "bytes32" },
      { "name": "deadline", "type": "uint256" }
    ]
  },
  "primaryType": "Binding",
  "domain": { "name": "BonaFide", "version": "1", "chainId": 5042, "verifyingContract": "<escrow>" },
  "message": {
    "repo": "github:octocat/hello-world",
    "maintainer": "<wallet>",
    "nonce": "0x8f1c3e7a9b2d4f6081a3c5e7f9b1d3f5a7c9e1b3d5f7a9c1e3b5d7f9a1c3e5b7",
    "deadline": 1790000000
  }
}
```

```shell
echo "0x$(openssl rand -hex 32)"   # a new nonce for each proof
cast wallet sign --data --from-file binding.json --account <maintainer account>
```

The Keeper checks the signature, that Bona Fide is installed on the repo, and that the wallet is the
`maintainer` in `.github/bona-fide.yml` on the default branch. Then:

- `200 {"status": "proposed", "txHash": "0x…", "effectiveAt": 1790086400}`: the Binding is proposed
  and can be activated at `effectiveAt`.
- `200 {"status": "pending", "effectiveAt": …}` or `200 {"status": "active"}`: that Binding is
  already pending or active, so nothing was sent. Proposing it again would restart the delay.

The Keeper doesn't store nonces, so a proof works until its deadline; keep the deadline short.
Sending a proof again proposes what `bona-fide.yml` says at that moment, and sends nothing if that
Binding is already pending or active.

### `POST /relay/deposit`

With `RELAYER_PRIVATE_KEY` set, the host relays a Contributor's one-signature Deposit (an EIP-3009
authorization) and pays its gas. It checks that the repo is active and the value is the current
amount, and simulates the Deposit before sending it. It takes 10 requests a minute per IP and 30
per repo. It sends no CORS headers, so the deposit page must be served from the App's origin. The
request and every answer are in [../agent/README.md](../agent/README.md#the-relay-api).

### Limits

The host reads at most 16 KiB of a request's body on these endpoints, and at most 1 MiB of a webhook
delivery: `MAX_JSON_BODY_BYTES` and `MAX_WEBHOOK_BODY_BYTES` in `src/config.ts`. A request over its
limit gets `413 {"error": "…"}` as soon as it passes it, or at once if its `Content-Length` says so,
and the host closes the connection without reading the rest. GitHub's deliveries for the events the
App acts on are far smaller.

Each client IP may send 10 requests a minute to `POST /forfeit` and `POST /binding-proof` together,
and 10 to `POST /relay/deposit`; the relay also takes 30 a minute per repo. Every `POST` counts,
well-formed or not. Past a limit the answer is `429` with `Retry-After`.

Behind a reverse proxy every connection comes from the proxy, so all clients would share one
address's limits. With `TRUST_PROXY=1` the host counts each request against the rightmost
`X-Forwarded-For` entry instead: the address the proxy saw. Set it only when the App is reachable
solely through a proxy that overwrites `X-Forwarded-For`, as Caddy does by default, for example
with the App bound to `127.0.0.1`. If clients can reach the App directly, or the proxy passes a
client's own `X-Forwarded-For` on, anyone could pick the address their requests count against.
Unset, empty or `0`, the host ignores the header; any other value stops the host.

A relayed transaction can pass simulation and still revert on-chain, for instance when a
smart-contract wallet answers ERC-1271 differently in the transaction than in the simulation, and
each revert costs gas. So after a relayed Forfeit reverts, the Keeper relays no Forfeit for that
Deposit, or signed by its Maintainer's wallet, for 10 minutes (`REVERT_COOLDOWN_MS` in
`src/relay/rate-limit.ts`). After a relayed Deposit reverts, the relay sends no Deposit for that PR
or issue, or from that wallet, for the same 10 minutes. Meanwhile each gets `429` with
`Retry-After`, and a Contributor can still deposit from their own wallet.

## Tests

```shell
npm test            # all suites
npm run typecheck
```

Each run first builds the contracts with `forge build`, and the `*.anvil.test.ts` suites deploy the
real escrow on a local anvil chain. So the tests need Foundry's `forge` and `anvil`, and the
contracts' submodules (`git submodule update --init --recursive`).

## Deploy

To run the App and its pages on your own server behind Caddy, follow
[../deploy/README.md](../deploy/README.md). The host answers `GET /health` with `ok` and no
signature, for container and uptime checks.
