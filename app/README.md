# Bona Fide GitHub App

The App decides who must put down a Deposit to open a PR or an issue, asks for it, and notices it
on-chain. Its Keeper refunds Deposits, relays the Forfeits Maintainers sign, and binds repos to
their Maintainer's wallet. With [triage](#triage) on, an automated reviewer reads each PR or issue
that holds a Deposit and suggests a verdict to the Maintainer. With a [Record Exemption](#record-exemption),
a Contributor whose Bona Fide record is good enough needs no Deposit. With [Bounties](#bounties) on,
the Keeper pays a Maintainer's Bounty on an issue when a PR that closes it is merged. Terms such as
Binding, Exemption and Payout are defined in [../CONTEXT.md](../CONTEXT.md).

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
record_exemption: on  # on or off: whether a good Bona Fide record can stand in for a Deposit
record_threshold: 3   # the score a record needs for that: a whole number from 1 to 100
bounties: on       # on or off: whether the Keeper pays the repo's Bounties on its own
```

Every key is optional, and the amount, forfeit share, timeout, triage, Record Exemption and Bounty
settings above are the defaults. The Keeper
also reads `maintainer`, the Maintainer's wallet address, when it proposes the repo's Binding. If a
value can't be read, the App pauses: PRs get a neutral check that names the problem, and issues get
nothing.

Write each `exempt_bots` login on its own `- ` line, exactly as GitHub shows it. In the one-line
`[a, b]` form, a login ending in `[bot]` must be quoted. GitHub's Copilot coding agent opens PRs as
`Copilot`.

### The Binding comes first

The escrow charges each Deposit the terms of the repo's active on-chain Binding, not the file. The
Keeper proposes a Binding once the Maintainer has proved control of the wallet, and it takes effect
1 hour later. So:

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
   outranks every Exemption, and Acceptance too.
2. **Accepted:** the `bona-fide:ok` label means a Maintainer accepted the PR or issue. It counts
   only when the last to add it has write, maintain or admin access, since triage access is enough
   to add a label; the same goes for `bona-fide:waive`. The check
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
     [The Binding comes first](#the-binding-comes-first));
   - a [Record Exemption](#record-exemption) granted for this PR or issue: its Contributor's Bona
     Fide record is good enough. It is granted after the check first asks for a Deposit, and it
     outranks a Deposit made meanwhile, which the Keeper then refunds as for any Exemption.
4. **Deposited:** a Deposit for this PR or issue, made after it was opened, turns the check green
   and shows who paid, with a link to its transaction on Arc's block explorer.
5. **Not live yet:** the repo's Binding isn't active, so the check is neutral (see above).
6. **Deposit needed:** otherwise the check asks for the Deposit and links to the deposit page. It
   stays in progress until the Deposit lands: GitHub shows a finished check that asks for something
   as failed, with a red cross on the commit, before the Contributor has done anything.

`VOUCHED.td` is read from the repo root, then from `.github/`. PRs get one check named "Bona Fide"
on their head commit. A PR or issue that is asked for a Deposit also gets one comment from the App,
edited in place as things change: a comment reaches the author's inbox, and a check doesn't. Issues
have no checks, so they carry the `bona-fide:deposit-required` label too while a Deposit is needed.

Only the App's own comment and check carry the real link. Anyone can comment on a public PR, so a
Contributor should follow a link only from the comment marked with the App's **bot** badge, or from
the check.

While the check asks for a Deposit, its Details link opens the deposit page. Once it stops asking,
the link goes to the App's homepage, where GitHub points a check that never had a link: GitHub's API
can replace a check's link but not remove it.

The check is evaluated again when the PR or issue is reopened, when a PR gets new commits, when the
`bona-fide:waive` or `bona-fide:ok` label is added or removed, when a PR is approved, when a Deposit
lands, when a Record Exemption is granted, and when someone presses **Re-run** on the check or
**Re-run all checks** on its suite.

### Clock skew

An item's `created_at` comes from GitHub's clock, and a Deposit's time from its Arc block. A
Deposit counts if its block is at most `CLOCK_SKEW_SECONDS` (120 seconds, in `src/config.ts`) older
than the item, so a small difference between the two clocks can't drop a Deposit made right after
the item was opened. It works the other way for a repo's start: a PR or issue opened at most
`CLOCK_SKEW_SECONDS` after the repo's first Binding took effect counts as opened before it.

## The Keeper

The Keeper is the App's signer. Every transaction it sends is one of the escrow's `refund`,
`forfeit`, `proposeRepo` or `activateRepo`, so it can move USDC only the ways the escrow allows: to a
Deposit's own Depositor, or at most half of a Deposit to the Forfeit sink. With
[Bounties](#bounties) on, it also sends a Bounty wallet's `keeperPay` and `payWithSignature`, which
pay a posted Bounty in full to one payee and never to the Keeper. See
[../contracts/README.md](../contracts/README.md#trust-model).

### Refunds

The Keeper refunds a Deposit in full to its Depositor when:

- the PR is merged;
- the issue is closed as completed by someone other than its author with write, maintain or admin
  access. Not while the issue carries `bona-fide:bad-faith`;
- someone with write, maintain or admin access adds the `bona-fide:ok` label, or the check runs again
  while their label is on. Not while the item carries `bona-fide:bad-faith`;
- someone with write, maintain or admin access approves the PR, or the check runs again while their
  approval stands. Not while the PR carries `bona-fide:bad-faith`;
- the check doesn't count the Deposit: its block is more than `CLOCK_SKEW_SECONDS` older than the
  PR or issue (see [Clock skew](#clock-skew)), or the item is exempt (a Record Exemption too), or its Contributor is
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
`bona-fide:bad-faith`, nothing but a merge refunds its Deposit early: not the label, not closing it
as completed (GitHub's default), and not a re-check, even if its Contributor has since become exempt
or denounced. The Maintainer's signature or the Timeout decides.

The check, these Refunds and a Contributor's record (see [Record Exemption](#record-exemption)) ask
one question, whether a Maintainer accepted the item, and `src/acceptance.ts` answers it for all
three, with where they differ named there.

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
Binding delay, 1 hour on Arc; the Keeper activates it then.

### Signer hygiene

- The key comes only from `KEEPER_PRIVATE_KEY`. The host prints the Keeper's address, never the key,
  and a malformed key stops it with a message that doesn't repeat it.
- Each transaction is simulated with `eth_call` first, so one the escrow or a Bounty wallet would
  reject costs no gas. Transactions go out one at a time, escrow and Bounty wallets alike, with
  nonces from viem's shared nonce manager, so another sender in the App with the same key never
  reuses one.
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
`DIFF_BUDGET` in `src/model/model.ts`), and the model is told where each was cut and how much was
left out. GitHub makes no diff for a very large PR; the model is told so and reads the rest.

**What it posts.** A new comment, separate from the App's comment on issues and the Keeper's note:

- **Good-faith work:** a suggestion to accept it, with the model's reasons, and that approving the
  PR or adding `bona-fide:ok` refunds the Deposit in full now. For an issue: adding `bona-fide:ok`
  or closing it as completed.
- **Likely bad faith** (spam, off-topic, or generated noise): a draft verdict with the model's
  reasons. It says that nothing has been forfeited and only the Maintainer's signature can forfeit
  the Deposit. If the Maintainer agrees, they add `bona-fide:bad-faith` and sign the Forfeit on the
  sign page, which the draft links; if not, they do nothing, and the Deposit is refunded on merge or
  Acceptance, or at the Timeout.
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

## Record Exemption

With `ANTHROPIC_API_KEY` set, a Contributor whose Bona Fide record is good enough needs no Deposit.
It is an Exemption like the others, named so it isn't taken for a Maintainer's Waiver label. A repo
turns it off with `record_exemption: off` in `.github/bona-fide.yml`, and sets how good a record must
be with `record_threshold` (3 by default). Without the key there are no Record Exemptions, and no
record is kept.

**The record.** A Contributor's Deposits across every repo the App is installed on, each linked to
them through the author of the PR or issue it was for: Deposits are keyed by repo, kind and number,
and anyone can pay one. The author is their GitHub account's id, which a rename keeps and nobody else
ever gets, not their login. The App reads the escrow's `Deposited`, `Refunded` and `Forfeited` events
from `ESCROW_FROM_BLOCK` on, as the Keeper does, and looks each Deposit up on GitHub when it is made
and again when it ends. A Refund counts as **on accepted work** when, as it is looked up, someone else
accepted the work while the Deposit was on it:

- the PR was merged, not by its author; or the issue was closed as completed, or either labelled
  `bona-fide:ok`, by someone other than its author with write, maintain or admin access;
- the author can't push to the repo: work in a repo they own, or in an org where they can push, they
  could accept themselves;
- and the Deposit was made before the item was merged or closed, give or take `CLOCK_SKEW_SECONDS`:
  work accepted before it put nothing at risk.

Each PR or issue counts once, however many Deposits were made on it. Other Refunds don't count, at
the Timeout or of a Deposit that wasn't needed: an ignored item is refunded too. Nor does a PR
approved but not yet merged when its Deposit was refunded.

**The score,** in one line:

```
score = Refunds on accepted work in public repos + min(merged PRs in other people's repos, 2)
```

Merged PRs in other people's repos are GitHub's search count for `is:pr is:merged author:<login>
-user:<login> -user:<owner of the repo being checked>`. At most 2 count (`MERGED_CAP` in
`src/records/exemption.ts`), below the default threshold of 3, so there a Record Exemption needs at
least one Refund on accepted work.

**The witnesses.** A Record Exemption is granted only when all of these hold, and the model can't
change any of them:

1. the score is at least the repo's `record_threshold`;
2. Deposits on the Contributor's items were forfeited in fewer than 2 repos the App can see, private
   ones included (`FORFEIT_REPOS` in `src/config.ts`). Anyone can deposit on anyone's PR or issue, so
   one Maintainer could forfeit a Deposit on a Contributor's item in their own repo; one repo's
   Forfeits alone don't end a Record Exemption;
3. the repo doesn't denounce them in `VOUCHED.td` (a denouncement is checked first, as always);
4. `record_exemption` is on;
5. and the model suggests `waive`.

The model answers `waive`, `require` or `flag`, with 1 to 3 reasons. It can hold a Record Exemption
back, never grant one alone: it reads the record's numbers and the Contributor's public GitHub
profile, never the threshold or the witnesses.

- **`waive`:** the check is evaluated again and passes, citing the counts: "No Deposit needed: 4
  Refunds across 3 repos". A Deposit made meanwhile is refunded by the Keeper, as for
  any Exemption.
- **`require`,** or a model that declines or fails: nothing changes and nothing is posted. The
  check keeps asking for the Deposit.
- **`flag`:** the check keeps asking for the Deposit, and a note for the Maintainer lists the
  model's reasons, made safe as triage's are: plain lines, links removed, HTML escaped, `@mentions`
  broken, at most 3 of at most 300 characters. It says a Maintainer who trusts the Contributor can
  add `bona-fide:waive`.

**Private repos.** The counts the check shows, and the model reads, are of public repos only, so a
record never reveals who contributes to a private repo. A Forfeit in a private repo still counts
toward the 2 repos that end a Record Exemption, and the check never says whether any Deposit was
forfeited.

**When it runs.** When the check asks a Contributor for a Deposit: they aren't denounced or
otherwise exempt, no Deposit counts yet, and the repo's Binding is active. The check is posted first,
asking for the Deposit, and the record is weighed in the background, since the model can take longer
than GitHub waits for a webhook. The witnesses come first, from memory and one cached GitHub read:
when one fails, the model isn't asked and nothing is recorded. The model is asked once per PR or
issue and author: new commits, labels, approvals and Deposits don't ask again. Reopening the item,
or pressing **Re-run** on its check, does, while the check still asks for a Deposit, but not within
10 minutes of the last answer (`ASK_AGAIN_MS`): each answer is paid for.

**It stays.** A Record Exemption granted for an item stays its Exemption on every later check and
across restarts: the App reads it back from the [decision log](#decision-log)'s latest `waive`
decision for the item, which is on disk. It ends on the next check after any of the Contributor's
Deposits is forfeited, anywhere, and while the repo has `record_exemption: off`. A higher threshold
later doesn't end it.

**What goes to Anthropic's API:** the repo's name, the item's kind and number, the Contributor's
login, and numbers: their Refunds, other Refunds, Forfeits and open Deposits in public repos, and
their GitHub account's age, public repos, followers and merged PRs elsewhere. No text anyone wrote.
The request is triage's: `TRIAGE_MODEL`, adaptive thinking at medium effort, a JSON schema
(`verdict` and `reasons`), and Anthropic's server-side fallbacks. The record sits between tags
carrying a random token, and the model is told it is data.

**GitHub reads.** The profile and the search count are read at most once an hour per Contributor
(`PROFILE_TTL_MS`). The record looks up at most 5 Deposits per watcher poll (`LOOKUPS_PER_TICK` in
`src/records/records.ts`), Forfeits first, so catching up on a long history stays under GitHub's
rate limit. Until the escrow's history has been read once, and while a Forfeit isn't linked to its
Contributor, no Record Exemption is granted. One granted before a restart stands meanwhile; a
Forfeit that landed while the App was down ends it once the record has caught up.

**Storage.** The Node host appends each Deposit's link (its repo, whether the repo is private, its
author and how it ended) as one JSON line to `RECORDS_PATH` (`data/records.jsonl` by default),
readable by its owner only. On start it reads them back, so only Deposits that ended while it was
down are looked up again. A line that isn't a link is skipped.

**Known limits.** The record links Deposits through GitHub logins, not addresses. Someone with
several GitHub accounts could build a record by accepting their own work under another login, in
repos they control; the witnesses, the cap on merged PRs, the model, and the Maintainer's Waiver
label and denouncements stand against that. A Forfeit in a repo the App was uninstalled from, or on
an item since deleted, can't be linked, and doesn't count.

## Bounties

A Maintainer funds Bounties on issues from their repo's Bounty wallet (see
[../contracts/README.md](../contracts/README.md#bounty-wallet)). When a PR that closes an issue with
an open Bounty is merged, the App checks the witnesses below and asks a model whether the PR
resolves the issue. If everything holds, the Keeper pays the Bounty in full to the wallet the PR's
author named, within the Maintainer's limits. Anything else is left to the Maintainer, who can sign
the Payout. Every Payout's note links its transaction.

**Setup.** Set `BOUNTY_FACTORY_ADDRESS` (and `BOUNTY_FACTORY_FROM_BLOCK`, its deploy block) and
`BOUNTY_PAGE_URL`, with the Keeper's key: the Keeper pays, so Bounties need it. The factory must name
the same Keeper. A repo's Bounty wallet is `factory.walletOf(repoId, maintainer)`, where
`maintainer` is the repo's active Binding's Maintainer: a wallet anyone else creates for the repo is
ignored, and a repo without an active Binding or a wallet has no Bounties. A repo turns the Keeper's
payouts off with `bounties: off` in `.github/bona-fide.yml`; a Maintainer's signed Payout is still
relayed. Without `ANTHROPIC_API_KEY` the App still checks every merge, but each Bounty waits for the
Maintainer: only the model can confirm a PR resolves its issue.

**The note on the issue.** When the Maintainer posts a Bounty, the App posts a note on its issue, so
Contributors see it where they work: the amount, how it is paid, the `Bounty wallet:` line to add,
and a link to the repo page (`repo.html?repo=owner/name`, beside `BOUNTY_PAGE_URL`). It says the
Keeper pays the first merged PR that closes the issue, with green checks and a model that agrees it
resolves it, within the Maintainer's limits. If the Keeper wouldn't pay it on its own (`bounties:
off`, the Keeper's payouts off, no `ANTHROPIC_API_KEY`, or an amount above the per-payout limit,
which the note names), it says the Maintainer can sign the Payout instead. Only a Bounty from the
repo's Bounty wallet gets one, still open under the same Serial, on an open issue in a repo with a
readable `.github/bona-fide.yml`: a Bounty cancelled or paid first, or on a closed issue or a PR,
gets none. Every minute (`BOUNTY_NOTE_MS` in `src/bounties/posted.ts`), the App reads the factory's
`WalletCreated` and the known wallets' `BountyPosted` events since its last look, one log query per
10,000 blocks and 100 wallets, plus one for a range in which a wallet was created. A range the RPC
won't answer is read again in halves, down to one block, by every poller. After a restart it reads them
again from `BOUNTY_FACTORY_FROM_BLOCK`, and the note's hidden marker, `<!-- bona-fide:bounty-posted
issue=N serial=S -->`, keeps it from posting twice; a Bounty posted again after a cancel has a new
Serial and gets a new note. A note GitHub refuses is tried again on later looks, less and less
often.

**When it runs.** On these deliveries, after the webhook is answered, since the model can take
longer than GitHub waits:

- `pull_request` `closed` with `merged: true`: each issue in the same repo the PR closes;
- `issues` `closed` as completed: the PR whose merge closed it, or else the first merged PR that
  closes it, so a missed PR delivery is caught up by the issue's;
- `issue_comment` `created` or `edited` on a merged PR, by its author, with a `Bounty wallet:` line,
  and `pull_request` `edited` on a merged PR whose body has one: the author naming their wallet.

**Which issues a PR closes.** GitHub's own links, read through GraphQL: the PR's
`closingIssuesReferences`, the issues its closing keywords (`Fixes #42`) or the Development sidebar
link to, in the same repo; and, the other way, an issue's `closedByPullRequestsReferences`, to find
the first merged one, all of them, 100 a page. These hold after a restart or a redelivery, where a
parse of the body could miss a sidebar link. But they show the links as they are now, and a PR's
author can add one after the merge by editing its description. GitHub closes an issue on merge by the
links the PR had then, so the issue's last `ClosedEvent` names the PR whose merge closed it, and that
is the witness that the merge was for the issue. A merge's delivery can arrive before GitHub closes the
issue; it waits, and the issue's `closed` delivery settles the Bounty.

**The witnesses.** The Keeper pays only when all of these hold, and the model can't change any:

1. the PR is merged;
2. the repo was created before its Binding took effect. A repo's id is its `owner/name`, and a rename
   or a deletion frees the name for anyone to take, with its Binding and Bounty wallet: a newer repo
   by that name waits for the Maintainer;
3. GitHub links the PR as closing the issue;
4. it is the first merged PR that closes the issue. A later one waits for the Maintainer, and so does
   any PR when more than 500 PRs link the issue;
5. its merge closed the issue: a person, a commit or another PR closing it waits for the Maintainer;
6. every check on the PR's head commit is green: each latest check run is `success`, `neutral` or
   `skipped`, and each commit status `success`. One that failed, or is still running, holds the
   Payout. The App reads all of them, not only a branch protection's required checks, which GitHub
   only shows an App with the Administration permission. Its own "Bona Fide" check is left out: it
   is about the Deposit, not the code. A commit with no checks at all passes;
7. the PR's author named a wallet the Bounty wallet can pay: not the zero address, the wallet
   itself or the Keeper's;
8. the Bounty is open, the Keeper's payouts are on, and its amount is within `perPayoutLimit` and
   what is left of the period's `keeperAllowance()`;
9. `bounties` is on in `.github/bona-fide.yml`;
10. and the model says the PR `resolves` the issue, with at least one reason.

The witnesses are read first. When one fails, the model isn't asked.

**Naming the payee.** The PR's author adds a line of its own to the PR description or to a comment
of their own on the PR:

```
Bounty wallet: 0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed
```

The label's case doesn't matter, and the address may be in backticks. A mixed-case address must
match its EIP-55 checksum; an all-lowercase one is taken as it is. Only the author's own words count:
a description or comment someone else wrote, or edited last, is ignored, since anyone who can push to
the repo can edit both. The latest declaration wins: a comment over the description, a later comment
over an earlier one, and in one text the last line. Editing the description doesn't make it later
than a comment, so to change the wallet after commenting, comment again. Comments are read from the
PR's latest 100.

Without a wallet, or with one that isn't an address or can't be paid, the App posts a note on the PR
asking the author to add the line, once per Bounty, and records a `hold`. When the author adds it,
the `issue_comment` or `pull_request` `edited` delivery runs the Payout again.

**What the model reads.** As for triage: the repo's name and description, the issue's title and
body, and the PR's number, author, title, body, first 100 changed files and diff, each cut to
triage's budgets and said where it was cut. The issue and the PR each sit between tags carrying a
random token, and the model is told their text is data. It answers `resolves`, `partial` or
`unrelated`, with 1 to 3 reasons, and is told to say `partial` when in doubt. The request is
triage's: `TRIAGE_MODEL`, adaptive thinking at medium effort, a JSON schema and Anthropic's
server-side fallbacks. **Privacy:** with Bounties on, the issue's and the merged PR's text and diff
are sent to Anthropic's API, but only for a PR that closes an issue with an open Bounty and passes
every witness.

**Held for the Maintainer.** A failing witness (other than a missing wallet), `partial`,
`unrelated`, a model that declines, gives no reasons or fails, no model at all, or a wallet that
refuses the Keeper's payout at the last moment: the Keeper pays nothing and posts a note on the PR
that says why, lists the model's reasons if it gave any (made plain and safe as triage's are), and
links the Maintainer to the [Bounty page](#the-bounty-page) to sign the Payout. A Bounty above the
limits gets the same note: it needs the Maintainer's signature. A held Bounty stays held for that
PR: later deliveries don't ask the model again, so nobody can ask until it says `resolves`.

**Paying.** `keeperPay(issueNumber, payee)` through the Keeper's usual path: the Bounty is read again
just before sending and paid only if it is still open under the same serial, the call is simulated,
and the transaction goes out in turn with the escrow's. Then a note on the PR and one on the issue
say how much went to which wallet, and link the transaction on `EXPLORER_URL`. A transaction that
reverts, or a wallet that would revert it, leaves the Bounty to the Maintainer as above. An RPC or
GitHub error before the Payout is logged and changes nothing: redeliver the webhook from the App's
advanced settings, or any later delivery for the PR or issue tries again.

**Never twice.** Each run reads the Bounty on-chain first: a paid or cancelled Bounty is never paid
again, whether by a redelivery, a restart, both of a merge's deliveries at once, or a second PR. The
runs for one issue go one at a time. The notes start with hidden markers naming the issue and the
Bounty's Serial, `<!-- bona-fide:bounty-paid issue=N serial=S -->` (and `bounty-held`,
`bounty-payee`), so each is posted once. A Bounty found already paid, by the Maintainer's signature,
by the Maintainer directly or by the Keeper before a crash cut its notes short, still gets its note
on the issue, with the transaction read from the wallet's `Paid` event; the PR gets one only if the
Bounty went to the wallet its author named.

### The Bounty page

Notes link the Maintainer to `BOUNTY_PAGE_URL` with this query:

```
?repo=owner/name&issue=42&payee=0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed
```

`payee` is the checksummed wallet the PR's author named, and is left out while there is none or it
can't be paid. The page reads the Bounty from the repo's wallet, has the Maintainer sign the Payout,
and either sends `payWithSignature` itself or relays it through
[`POST /bounty/payout`](#post-bountypayout), so the Maintainer needn't pay gas.

## Decision log

The App records each decision it makes, or leaves to the Maintainer, so anyone can check why money
moved or didn't. Each public repo's page shows the log and the counts, read from
[`GET /decisions`](#get-decisions).

**What is recorded.**

- **Triage,** each time the model was asked: what it suggested and why, and what the App did.
- **Early Refunds on Acceptance:** the Keeper refunds a Deposit because the PR was merged, the issue
  was closed as completed by someone other than its author, the `bona-fide:ok` label was added, or
  someone with write, maintain or admin access approved the PR.
- **Record Exemptions,** each time the model was asked to weigh a Contributor's record: what it
  suggested and why, the witnesses, and what the App did.
- **Bounties:** each Payout the Keeper made (`pay`), each Bounty it left to the Maintainer or held
  until the author names a wallet (`hold`), and each Payout the Maintainer signed that the App
  relayed (`pay`). The item is the Bounty's issue, and the Serial the Bounty's.

Each decision has an id, a time, the repo and the PR or issue, the Deposit's Serial, and:

| Field | What it holds |
|---|---|
| `type` | `triage`, `early-refund`, `waive` (a Record Exemption), `pay` (a Payout of a Bounty) or `hold` (a Bounty left to the Maintainer) |
| `inputs` | A summary of what was read: for triage, the sizes of the title, body, file list and diff and how much of each was cut; for a Refund, where it was found, such as `webhook pull_request closed` or `check`; for a Record Exemption, the Contributor's login and the numbers the model read; for a Bounty, the delivery, the PR's number, the `method` (`keeper` or `signature`) and the sizes of what the model read. Never the item's text |
| `suggestion` | The model's verdict (`accept`, `bad-faith` or `unsure` for triage; `waive`, `require` or `flag` for a Record Exemption; `resolves`, `partial` or `unrelated` for a Bounty) and reasons, as plain lines with links removed, or null when no model suggested anything |
| `witnesses` | The facts checked, as `{name, value}`: the Deposit and who paid it, the Exemption status, the labels (read again after the model answered), who merged, closed or approved and with what access; for a Record Exemption, the score and threshold, the Forfeits, the denouncement and the setting; for a Bounty, each witness above with its value: merged by whom, the closing link, the first merged PR, the checks, the payee, the Bounty, the Keeper switch, the limits and the setting |
| `action` | What was done: `noted-accept`, `drafted-verdict`, `silent`, `skipped: a Maintainer decided`, `failed: <kind>` or `refunded`; for a Record Exemption, `waived`, `required`, `flagged`, `silent` or `failed: <kind>`; for a Bounty, `paid`, `held: <why>` (such as `held: checks not green`, `held: above the per-payout limit`, `held: model said partial`, `held: payee wallet needed`), `silent` or `failed: <kind>`. Never an error's text |
| `txHash` | The Refund's or Payout's transaction, when money moved |
| `outcome` | `decided` or `escalated`, below |
| `cost` | The model, its input and output tokens, and an estimate in USD from its list price (`claude-opus-5`: $5 in and $25 out per million tokens), or null when the model has no price on file |

**Decided or escalated.** A decision is `decided` when the App acted on its own: an early Refund,
a note suggesting the Maintainer accept the item, a Record Exemption granted, or the Keeper's
Payout of a Bounty. It is `escalated` when the App left it to the Maintainer: a draft bad-faith
verdict, an unsure model, a model that declined or failed, a Maintainer who decided while the model
read, a Record Exemption the model held back (`required` or `flagged`: the Deposit ask stands, and
the Maintainer can still waive it), or a held Bounty. A Payout the Maintainer signed is `escalated`
too: the Maintainer decided it, and the App only relayed it.

**What is never recorded.** Refunds at the Timeout, and Refunds of a Deposit the check doesn't count
(one made before its item was opened, or on an item that is exempt or whose Contributor is
denounced): those decide nothing. Nor triage that never asked the model: triage off, a Maintainer's
label already on the item, a Deposit triaged before, or a GitHub failure before the model was asked,
which the next check tries again. Nor a Record Exemption the witnesses ruled out before the model
was asked. Nor a Bounty run that changes nothing: one already held, a payee still missing after the
author was asked, or a Bounty already paid. No item text and no error text is ever recorded.

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
| Checks | Read and write | The "Bona Fide" check on each PR, and a merged PR's check runs for a Bounty |
| Commit statuses | Read | A merged PR's commit statuses for a Bounty. Only with Bounties on |
| Issues | Read and write | The comment and label on issues, how a Deposit's issue was closed for a Contributor's record, and the Bounty notes on issues |
| Pull requests | Read and write | Reading a PR when a Deposit lands or its check is re-run, finding merged PRs, reading approvals, reading a PR's files and diff for triage, whether a Deposit's PR was merged for a Contributor's record, the issues a merged PR closes and its author's comments for a Bounty, and the Keeper's, triage's, Record Exemption's and Bounty notes on PRs |
| Contents | Read | `.github/bona-fide.yml` and `VOUCHED.td` on the default branch |
| Metadata | Read | Required by GitHub |

A Record Exemption also reads a Contributor's public profile and a search count of their merged PRs,
which need no other permission.

Events:

- **Pull request.** The App acts on opened, reopened, synchronize, labeled, unlabeled and closed,
  and with Bounties on, edited.
- **Issues.** The App acts on opened, reopened, labeled, unlabeled and closed.
- **Issue comment.** With Bounties on, the App acts on created and edited: a merged PR's author
  naming their wallet. Subscribe to it when you turn Bounties on.
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
npm ci      # at the repo root: it installs the App and the SDK it imports
npm start
```

`npm start` runs `src/node.ts`: an HTTP server for GitHub's webhooks and
[`GET /decisions`](#get-decisions), a watcher that polls the escrow for Deposits, and, with `KEEPER_PRIVATE_KEY` set, [the Keeper](#the-keeper) and its
[endpoints](#endpoints). With `RELAYER_PRIVATE_KEY` set, it also runs the
[deposit relay](#post-relaydeposit), and with `ANTHROPIC_API_KEY` set as well as the Keeper's key,
[triage](#triage). With `BOUNTY_FACTORY_ADDRESS` set as well as the Keeper's key, it pays
[Bounties](#bounties) and notes each one posted on its issue. With `ANTHROPIC_API_KEY` set, it also follows Contributors' records for
[Record Exemptions](#record-exemption), on the watcher's timer. It and the files it opens,
`src/decisions/file.ts` and `src/records/file.ts`, are the only files that use Node: everything
`src/index.ts` exports also bundles for a Workers-style runtime. The Claude model that triage,
Record Exemptions and Bounties ask, `src/model/claude.ts`, isn't among those exports: Anthropic's SDK
looks for Node's globals when they exist, and the bundle check allows none, so a host imports it
directly.

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
| `RPC_RPS` | `3` | The RPC requests sent each second at most, with a log query counted as three. Requests beyond it wait their turn, a poller's behind a webhook's but never behind more than three in a row, so the Timeout refunds and the watcher keep up under any load, and a burst, such as the Keeper's read of the escrow's history on start, never runs into the RPC's rate limit. The default suits Arc's public RPC |
| `WATCH_FROM_BLOCK` | 10,000 blocks before the latest | Where the watcher starts after a restart |
| `KEEPER_PRIVATE_KEY` | unset | The key of the escrow's `keeper` address. Without it the App runs its checks only |
| `SIGN_PAGE_URL` | required with the Keeper | The Maintainer's sign page, with the same query as the deposit page |
| `ACTIVATE_MS` | `30000` | How often the Keeper looks for Bindings to activate |
| `REFUND_MS` | `30000` | How often the Keeper looks for Deposits past their Timeout to refund |
| `RELAYER_PRIVATE_KEY` | unset | Signs and pays the gas for relayed Deposits. It may be the Keeper's key |
| `ANTHROPIC_API_KEY` | unset | Turns [triage](#triage) on, with the Keeper, and [Record Exemptions](#record-exemption), and lets the Keeper pay [Bounties](#bounties). Sends each PR's or issue's text and diff, and the numbers of some Contributors' records, to Anthropic's API |
| `TRIAGE_MODEL` | `claude-opus-5` | The Claude model triage, Record Exemptions and Bounties ask |
| `BOUNTY_FACTORY_ADDRESS` | unset | The `BountyWalletFactory`. With the Keeper's key, turns [Bounties](#bounties) on |
| `BOUNTY_FACTORY_FROM_BLOCK` | `0` | The factory's deploy block. The App looks for a Bounty's `Paid` event, and for the Bounties posted, from here on |
| `BOUNTY_PAGE_URL` | required with the factory | The [Bounty page](#the-bounty-page), linked with `?repo=owner/repo&issue=N&payee=0x…` |
| `DECISIONS_PATH` | `data/decisions.jsonl` | The [decision log](#decision-log)'s JSONL file. Put it on storage that outlives the process |
| `RECORDS_PATH` | `data/records.jsonl` | The JSONL file of the Deposits linked to Contributors for [Record Exemptions](#record-exemption). Put it beside `DECISIONS_PATH` |
| `TRUST_PROXY` | unset | `1` makes the per-IP limits count the rightmost `X-Forwarded-For` address instead of the connection's. Set it only behind a reverse proxy that overwrites `X-Forwarded-For`; see [Limits](#limits) |

The Keeper's address needs a little USDC on Arc for gas, and nothing more: no Deposit or Forfeit can
reach it.

## Endpoints

With the Keeper on, the host serves `POST /forfeit` and `POST /binding-proof` next to the
webhook, with Bounties on also [`POST /bounty/payout`](#post-bountypayout), and it always serves
[`GET /decisions`](#get-decisions). They take and return JSON. A refusal is `{"error": "…"}` with status 400 (the request is
wrong), 404 (nothing to act on), 409 (the on-chain state doesn't allow it) or 429 (try again after
`Retry-After` seconds; see [Limits](#limits)).

None of them takes credentials: the signature in the body authorizes the action. So each answers a
CORS preflight and allows any origin, and a sign page on another origin can call them. Any method
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
the wallet. The Keeper pays for each proposal, so within an hour of one (`PROPOSAL_COOLDOWN_MS`) it
proposes no other for the repo: a changed file gets `429` with `Retry-After`, and the Binding already
proposed or active still answers.

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

### `POST /bounty/payout`

Relays a Payout the Maintainer signed, so the Bounty page needn't make them pay gas.

```json
{
  "repo": "octocat/hello-world",
  "issue": 42,
  "payee": "0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed",
  "deadline": 1790000000,
  "signature": "0x…"
}
```

- `issue` is the issue's number. `payee` is an address, in any case.
  `deadline` is Unix seconds, as a number or a decimal string.
- The signature is EIP-712 over
  `Payout(uint256 issueNumber,uint256 serial,address payee,uint256 amount,uint256 deadline)` in the
  domain `{name: "BonaFide Bounty", version: "1", chainId, verifyingContract: <the repo's Bounty
  wallet>}`, where `serial` and `amount` are the open Bounty's (`bountyOf(issue)`). See
  [../contracts/README.md](../contracts/README.md#signatures).
- The Keeper finds the repo's wallet from its active Binding's Maintainer, reads the Bounty, checks
  the payee is one the wallet can pay and the signature against the wallet's owner, as the wallet
  does: an ERC-1271 wallet, or a 65-byte signature with `v` 27 or 28 and a low `s`. Then it simulates
  `payWithSignature` and sends it. The limits and the Keeper switch don't apply: the signature is
  the Maintainer's.
- `200 {"txHash": "0x…"}` once the transaction is mined. The App then posts the paid note on the
  issue, and on the first merged PR that closes it, and records a `pay` decision.
- `404` if Bona Fide isn't installed on the repo, the repo has no Bounty wallet, or the issue no
  Bounty; `409` if the Bounty was already paid or cancelled; `400` for an expired signature, a
  payee the wallet can't pay, or a signature that isn't the owner's.
- `502 {"error": "…", "txHash": "0x…"}` if the transaction passed simulation but reverted on-chain,
  so no funds moved. The Keeper then relays no Payout for that Bounty, or signed by that owner, for
  10 minutes.

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
per repo, and refuses an authorization with under two minutes left. It pays for at most 10 Deposits
a day from one wallet and 3 for one PR or issue: an exempt item's Deposit is refunded at once, so
one balance could otherwise go round and round at the relayer's cost. It sends no CORS headers, so the deposit page must be served from the App's origin. The
request and every answer are in [../agent/README.md](../agent/README.md#the-relay-api).

### Limits

The host reads at most 16 KiB of a request's body on these endpoints, and at most 1 MiB of a webhook
delivery: `MAX_JSON_BODY_BYTES` and `MAX_WEBHOOK_BODY_BYTES` in `src/config.ts`. A request over its
limit gets `413 {"error": "…"}` as soon as it passes it, or at once if its `Content-Length` says so,
and the host closes the connection without reading the rest. GitHub's deliveries for the events the
App acts on are far smaller.

Each client IP may send 10 requests a minute to `POST /forfeit`, `POST /binding-proof` and
`POST /bounty/payout` together,
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
`src/relay/rate-limit.ts`), and after a relayed Payout reverts, no Payout for that Bounty or signed
by its wallet's owner. After a relayed Deposit reverts, the relay sends no Deposit for that PR
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
