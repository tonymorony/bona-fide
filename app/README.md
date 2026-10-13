# Bona Fide GitHub App

The App decides who must put down a Deposit to open a PR or an issue, asks for it, and notices it
on-chain. Its Keeper refunds Deposits, relays the Forfeits Maintainers sign, and binds repos to
their Maintainer's wallet. With [triage](#triage) on, an automated reviewer reads each PR or issue
that holds a Deposit and suggests a verdict to the Maintainer. Terms such as Binding and Exemption are defined in
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
triage: on         # on or off: whether triage reads PRs and issues that hold a Deposit
```

Every key is optional, and the amount, forfeit share, timeout and triage setting above are the
defaults. The Keeper
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
   [Refunds](#refunds)), so a later push doesn't ask for a new one. An approving review of a PR
   from someone with write, maintain or admin access accepts it too, and the check names who
   approved. A reviewer's latest review counts: a later request for changes, or a dismissal,
   withdraws their approval, and a comment doesn't. Approvals are read only for a PR that no
   Exemption covers, so an exempt author's check names the Exemption instead, and they're ignored
   while the PR carries `bona-fide:bad-faith`.
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
`bona-fide:waive` or `bona-fide:ok` label is added or removed, when a PR is approved, when a Deposit
lands, and when someone presses **Re-run** on the check or **Re-run all checks** on its suite.

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
- someone with write, maintain or admin access approves the PR, or the check runs again while their
  approval stands. Not while the PR carries `bona-fide:bad-faith`;
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

## Triage

With `ANTHROPIC_API_KEY` set as well as the Keeper's key, an automated reviewer reads each PR or
issue whose check counts a Deposit, and suggests a verdict to the Maintainer in a note. It asks
Claude through Anthropic's API: `claude-opus-5` unless `TRIAGE_MODEL` names another model. It needs
the Keeper because its notes promise Refunds and link the sign page. A repo turns it off with
`triage: off` in `.github/bona-fide.yml`.

**Privacy:** with triage on, the title and body of each PR or issue that holds a Deposit, the
repo's description, and for a PR its list of changed files and its diff, are sent to Anthropic's
API.

**What the model reads.** The repo's name and description, and the item's kind, number, author,
title and body. For a PR, also the first 100 changed files with their added and deleted lines, and
the unified diff. The body is cut at 20,000 characters and the diff at 60,000 (`BODY_BUDGET` and
`DIFF_BUDGET` in `src/triage/triage.ts`), and the model is told where each was cut and how much was
left out. GitHub makes no diff for a very large PR; the model is told so and reads the rest.

**What it posts.** A new comment, separate from the App's comment on issues and the Keeper's note:

- **Good-faith work:** a suggestion to accept it, with the model's reasons, and that approving the
  PR or adding `bona-fide:ok` refunds the Deposit in full now. For an issue: adding `bona-fide:ok`
  or closing it as completed.
- **Likely bad faith** (spam, off-topic, or generated noise): a draft verdict with the model's
  reasons. It says that nothing has been forfeited and only the Maintainer's signature can forfeit
  the Deposit. If the Maintainer agrees, they add `bona-fide:bad-faith` and sign the Forfeit on the
  sign page, which the draft links; if not, they do nothing, and the Deposit is refunded on merge or
  acceptance, or at the Timeout.
- **Unsure:** nothing.

Each note says it is a suggestion from an automated reviewer and that the Maintainer decides.
Triage never adds a label, refunds or forfeits: whatever the model answers, it changes only what the
note says.

**When it runs.** Once per Deposit: when the check first counts the Deposit, as it lands or the
next time the item is checked. Never for an item that is exempt, denounced, waived, accepted, or
labelled `bona-fide:bad-faith`, and not if a Maintainer adds one of those labels while the model
reads. The note starts with a hidden marker naming the Deposit's Serial, `<!-- bona-fide:triage
serial=N -->`, so a redelivered webhook, a re-check or a restart doesn't triage the same Deposit
twice. A new Deposit on the same item is triaged anew. When the model was unsure, declined or
failed, nothing is posted, so after a restart the next check of the item asks again.

The webhook doesn't wait for the model: triage runs after the check is posted, and a model that
declines, fails or can't be reached is logged and stays silent. It never fails the webhook, delays
a Refund or changes the check.

**Untrusted text on both sides.** The item's text goes to the model between tags carrying a random
token, and the model is told that instructions inside it are data. The model's reasons are made
plain before they're posted: at most four, each on one line and at most 300 characters, with links
removed, HTML escaped and `@mentions` broken so they ping nobody.

**The request.** One non-streaming request per Deposit, with adaptive thinking at medium effort, a
JSON schema for the answer (`verdict` and `reasons`), and at most 16,000 output tokens. With
Anthropic's server-side fallbacks on (`fallbacks: "default"`), a request the model declines is
retried on Anthropic's default fallback model; a decline that stands gives no suggestion.

**The log line.** Each time triage runs, the App's log gets one JSON line with `"event": "triage"`:
the repo, kind, number, Serial and author; the sizes of what the model read and how much was cut;
the model that answered, its verdict and reasons; the action (`noted-accept`, `drafted-verdict`,
`silent`, `skipped: …` or `failed: …`); and the input and output tokens. A failure names its kind,
such as `failed: rate limited`, never the error's text. Each time the model was asked, the decision
also goes into the [decision log](#decision-log).

## Decision log

The App records each decision it makes, or leaves to the Maintainer, so anyone can check why money
moved or didn't. Each public repo's page shows the log and the counts, read from
[`GET /decisions`](#get-decisions).

**What is recorded.**

- **Triage,** each time the model was asked: what it suggested and why, and what the App did.
- **Early Refunds on acceptance:** the Keeper refunds a Deposit because the PR was merged, the issue
  was closed as completed by someone other than its author, the `bona-fide:ok` label was added, or
  someone with write, maintain or admin access approved the PR.

Each decision has an id, a time, the repo and the PR or issue, the Deposit's Serial, and:

| Field | What it holds |
|---|---|
| `type` | `triage` or `early-refund`. `waive`, `pay` and `hold` are kept for decisions the App doesn't make yet |
| `inputs` | A summary of what was read: for triage, the sizes of the title, body, file list and diff and how much of each was cut; for a Refund, where it was found, such as `webhook pull_request closed` or `check`. Never the item's text |
| `suggestion` | The model's verdict and reasons, as plain lines with links removed, or null when no model suggested anything |
| `witnesses` | The facts checked, as `{name, value}`: the Deposit and who paid it, the Exemption status, the labels (read again after the model answered), who merged, closed or approved and with what access |
| `action` | What was done: `noted-accept`, `drafted-verdict`, `silent`, `skipped: a Maintainer decided`, `failed: <kind>` or `refunded`. Never an error's text |
| `txHash` | The Refund's transaction, when money moved |
| `outcome` | `decided` or `escalated`, below |
| `cost` | The model, its input and output tokens, and an estimate in USD from its list price (`claude-opus-5`: $5 in and $25 out per million tokens), or null when the model has no price on file |

**Decided or escalated.** A decision is `decided` when the App acted on its own: an early Refund,
or a note suggesting the Maintainer accept the item. It is `escalated` when the App left it to the
Maintainer: a draft bad-faith verdict, an unsure model, a model that declined or failed, or a
Maintainer who decided while the model read.

**What is never recorded.** Refunds at the Timeout, and Refunds of a Deposit the check doesn't count
(one made before its item was opened, or on an item that is exempt or whose Contributor is
denounced): those decide nothing. Nor triage that never asked the model: triage off, a Maintainer's
label already on the item, a Deposit triaged before, or a GitHub failure before the model was asked,
which the next check tries again. No item text and no error text is ever recorded.

**Private repos.** Each decision records whether GitHub says the repo is private, from the webhook's
or the installation's repository data; when that isn't known, it counts as private. A private repo's
decisions are kept, but never served: `GET /decisions` answers for it exactly as for a repo with no
decisions, so it doesn't show the repo exists. A repo that turns private hides everything it had; one
that turns public shows only the decisions made since.

**Storage.** The Node host appends each decision as one JSON line to `DECISIONS_PATH`
(`data/decisions.jsonl` in its working directory by default), created with the first decision and
readable by its owner only. On start it reads the whole file back; a line that isn't a decision,
such as one torn by a crash mid-write, is skipped and counted in the start-up line, and the next
decision starts a line of its own. Memory keeps the counts of every repo and its latest 50 decisions
(`KEPT_PER_REPO` in `src/decisions/log.ts`). If a decision can't be written, the host logs the error
and still serves it until a restart; it never fails the Refund or the note. The file isn't rotated.
The log sits behind the `DecisionLog` port in `src/ports.ts`, so another host can keep it elsewhere.

## GitHub App permissions and events

| Permission | Access | Used for |
|---|---|---|
| Checks | Read and write | The "Bona Fide" check on each PR |
| Issues | Read and write | The comment and label on issues |
| Pull requests | Read and write | Reading a PR when a Deposit lands or its check is re-run, finding merged PRs, reading approvals, reading a PR's files and diff for triage, and the Keeper's and triage's notes on PRs |
| Contents | Read | `.github/bona-fide.yml` and `VOUCHED.td` on the default branch |
| Metadata | Read | Required by GitHub |

Events:

- **Pull request.** The App acts on opened, reopened, synchronize, labeled, unlabeled and closed.
- **Issues.** The App acts on opened, reopened, labeled, unlabeled and closed.
- **Pull request review.** The App acts on submitted with the state approved: it checks the PR
  again, and an approval from someone with write, maintain or admin access accepts it.
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

`npm start` runs `src/node.ts`: an HTTP server for GitHub's webhooks and
[`GET /decisions`](#get-decisions), a watcher that polls the escrow for Deposits, and, with `KEEPER_PRIVATE_KEY` set, [the Keeper](#the-keeper) and its
[endpoints](#endpoints). With `RELAYER_PRIVATE_KEY` set, it also runs the
[deposit relay](#post-relaydeposit), and with `ANTHROPIC_API_KEY` set as well as the Keeper's key,
[triage](#triage). It and the decision file it opens, `src/decisions/file.ts`, are the only files
that use Node: everything `src/index.ts` exports also bundles for a Workers-style runtime. Triage's Claude reviewer, `src/triage/claude.ts`, isn't among
those exports: Anthropic's SDK looks for Node's globals when they exist, and the bundle check allows
none, so a host imports it directly.

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
| `ANTHROPIC_API_KEY` | unset | Turns [triage](#triage) on, with the Keeper. Sends each PR's or issue's text and diff to Anthropic's API |
| `TRIAGE_MODEL` | `claude-opus-5` | The Claude model triage asks |
| `DECISIONS_PATH` | `data/decisions.jsonl` | The [decision log](#decision-log)'s JSONL file. Put it on storage that outlives the process |
| `TRUST_PROXY` | unset | `1` makes the per-IP limits count the rightmost `X-Forwarded-For` address instead of the connection's. Set it only behind a reverse proxy that overwrites `X-Forwarded-For`; see [Limits](#limits) |

The Keeper's address needs a little USDC on Arc for gas, and nothing more: no Deposit or Forfeit can
reach it.

## Endpoints

With the Keeper on, the host serves `POST /forfeit` and `POST /binding-proof` next to the
webhook, and it always serves [`GET /decisions`](#get-decisions). Both take and return JSON. A refusal is `{"error": "…"}` with status 400 (the request is
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

### `GET /decisions`

Served whenever the App runs, with or without the Keeper. `GET /decisions?repo=owner/name` answers a
public repo's [decision log](#decision-log): the counts of decisions made and left to the
Maintainer, and its latest 50 decisions, the newest first. A decision has the fields above, without
`private`.

```json
{
  "counts": { "decided": 12, "escalated": 3 },
  "decisions": [
    {
      "id": "…",
      "at": "2026-09-01T12:00:00.000Z",
      "repo": "octocat/hello-world",
      "item": { "kind": "pr", "number": 7 },
      "serial": "3",
      "type": "early-refund",
      "inputs": { "source": "webhook pull_request closed" },
      "suggestion": null,
      "witnesses": [{ "name": "Merged by", "value": "@octocat" }],
      "action": "refunded",
      "txHash": "0x…",
      "outcome": "decided",
      "cost": null
    }
  ]
}
```

A private repo, or one with no decisions, answers `{"counts": {"decided": 0, "escalated": 0},
"decisions": []}`. A `repo` that isn't owner/name gets 400. It is read-only and takes no
credentials, so it allows any origin and answers a CORS preflight; any method other than `GET` gets
405. Answers aren't cached.

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
10 to `POST /relay/deposit`, and 30 to `GET /decisions`; the relay also takes 30 a minute per repo.
Every request counts, well-formed or not. Past a limit the answer is `429` with `Retry-After`.

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
