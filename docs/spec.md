# Bona Fide: specification

Refundable good-faith deposits for open-source contributions. Terms are defined in
[../CONTEXT.md](../CONTEXT.md).

## In one paragraph

A Contributor nobody has vouched for, whether a person or an AI agent, puts down a small USDC
Deposit to open a PR or an issue. Good-faith work gets it back. Bad-faith work loses up to half,
which funds open-source maintainers through Protocol Guild. **Nobody can profit from a rejection:
not the Maintainer, not the Keeper, not whoever runs the App.**

## Why

AI tools make plausible-looking contributions nearly free to produce, and reviewing them is not
free. Maintainers answer by closing their doors to outside contributions, or by explicit vouching
(for example [Vouch](https://github.com/mitchellh/vouch)). Bona Fide adds a third path for people
nobody has vouched for yet: a small deposit that honest contributors always get back.

## How it works

1. **The Maintainer installs the Bona Fide GitHub App** and commits `.github/bona-fide.yml` on
   the default branch:
   - `amount`: default **1 USDC**;
   - `forfeit` share: default **50%** (0–50%);
   - `timeout`: default **7 days** (1–60);
   - the Maintainer's wallet address.

   The Maintainer signs a one-time message with that wallet to prove control, so a typo can't
   bind an address nobody holds. The Keeper proposes the Binding only after that proof, and it
   takes effect **1 hour** later.
2. **A Contributor opens a PR or issue.**
   - **Exempt** (the check passes at once): repo collaborators with write, maintain or admin
     access; anyone listed in Vouch's `VOUCHED.td`; anyone with a prior merged PR in the repo;
     and a short allowlist of maintenance bots. A Maintainer can also waive any single item with
     the label `bona-fide:waive`. PRs and issues opened before the repo's first Binding took effect
     are exempt too.
   - **A good record (optional):** a Contributor whose Bona Fide record, across every repo, scores at
     least the repo's `record_threshold` (Refunds on accepted work in public repos, plus up to two
     merged PRs elsewhere), who never had a Deposit forfeited anywhere and isn't denounced, gets a
     Record Exemption if an automated reviewer of the record agrees. The reviewer can hold it back,
     never grant it alone. The check then says why, such as "No Deposit needed: 4 Refunds, 0
     Forfeits across 3 repos", citing public repos only. A later Forfeit ends it, and a repo turns it
     off with `record_exemption: off`.
   - **Denounced** in `VOUCHED.td`: the check fails and no Deposit is offered. A denouncement
     outranks the waiver label.
   - Otherwise the check asks for a Deposit, or a vouch from a Maintainer. It links to a deposit
     page, and agents have their own path. The check stays in progress while it waits, and the
     App leaves one comment with the same link, so the author gets an email.
3. **The Contributor or their agent deposits USDC into the escrow on Arc.** The check turns
   green within seconds. The App counts only Deposits made after the item was opened.
4. **Outcomes, enforced by the contract:**

   | Outcome | Who triggers | Money |
   |---|---|---|
   | Merged, or approved, closed as completed or labelled `bona-fide:ok` by a Maintainer | Keeper | **100% refunded** |
   | No decision before the Timeout | The Keeper, or **anyone** | **100% refunded** |
   | Maintainer labels `bona-fide:bad-faith` and **signs with their wallet** | Anyone relays the signature | ≤ 50% to the forfeit router, the rest refunded |

5. **Triage (optional).** An automated reviewer reads each item that holds a Deposit. For clearly
   good work it suggests acceptance; for likely bad faith it drafts a verdict with reasons and asks
   the Maintainer to review and sign. It never forfeits and never refunds on its own: only the
   Maintainer's signature can forfeit, as the escrow requires.
6. **Decision log.** Every triage suggestion, every Record Exemption the reviewer was asked about,
   and every early Refund on acceptance is recorded with
   what was read, what the model suggested, the facts checked, what was done, its transaction and
   its model cost. Each public repo's page shows the log and how many decisions the App made
   versus left to the Maintainer. Private repos' decisions are never published.

## Why on-chain, why Arc

- **Whoever runs the App must be unable to touch the money.** A database would make them a
  custodian. The escrow can pay only the Depositor, or the forfeit router.
- **Rules nobody can bend:** refund on merge, refund on timeout, forfeits capped at 50%, and no
  profit to anyone.
- **Arc fits the job:**
  - USDC is native, so the gas is tiny and priced in dollars, and finality is sub-second.
  - Arc's USDC supports EIP-3009 authorizations, so a Contributor can deposit with **one
    signature** that anyone relays.
  - Once a person has set up a Circle agent wallet (accepting Circle's Terms and logging in), an
    AI agent can deposit on its own. The wallet is a smart account, so its signatures are
    ERC-1271.

## Contract: `BonaFideEscrow`

Solidity 0.8.30 (Cancun), Foundry, OpenZeppelin 5.7. Immutable: no owner, no admin, no upgrade,
no pause, no sweep.

**Constructor:** `(IERC20 usdc, address keeper, address forfeitSink, uint64 bindingDelay,
uint256 maxAmount)`. It rejects zero addresses, a `forfeitSink` equal to the Keeper or to the
escrow itself, a `bindingDelay` under 1 hour, and `maxAmount == 0`.

**Bindings.**
- `repoId = keccak256("github:" ‖ lowercase("owner/repo"))`.
- `proposeRepo(repoId, maintainer, forfeitBps, timeout, amount)` is Keeper-only. It takes effect
  after `bindingDelay`, through `activateRepo` (anyone may call).
- Bounds: `forfeitBps ≤ 5000`, `1 day ≤ timeout ≤ 60 days`, `0 < amount ≤ maxAmount`.

**Deposits.**
- `key = keccak256(abi.encode(repoId, kind, number))`, where kind is PR or issue. There is one
  active Deposit per key; a new one is allowed after resolution.
- `deposit(repoId, kind, number)` pulls `amount` after an `approve`.
- `depositWithAuthorization(repoId, kind, number, from, validAfter, validBefore, salt,
  signature)` takes one EIP-3009 signature from `from`, and anyone may submit it. The
  authorization nonce must equal `keccak256(abi.encode(key, salt))`, so a signed authorization
  can't be redirected to another PR.
- Each Deposit snapshots its Depositor, amount, forfeit share, Maintainer, deadline and a
  Serial.

**Resolution (exactly once).**
- `refund(key)`: the Keeper at any time, or anyone after the deadline. Pays 100% to the
  Depositor.
- `forfeit(key, sigDeadline, signature)`:
  - requires an EIP-712 signature by the snapshotted Maintainer over
    `Forfeit(bytes32 key,uint256 serial,uint256 sigDeadline)` (ERC-1271 wallets included);
  - must happen before the deadline;
  - sends `amount × forfeitBps / 10000` to the forfeit sink and the rest to the Depositor.

The guarantees are listed in [../CONTEXT.md](../CONTEXT.md) and proved by the unit, fuzz and
invariant suites in `contracts/test`.

## Forfeit router: `CharityRouter`

- The escrow's `forfeitSink` is an immutable router with **one fixed recipient**: Protocol
  Guild's 1-year vesting contract on Base, which funds Ethereum's open-source core maintainers.
- Anyone can flush the router's balance through Circle's CCTP (a Standard Transfer). CCTP burns
  the USDC on Arc and mints it to the recipient on Base.
- If CCTP ever charges a fee on this route, flushes revert and the USDC waits in the router;
  nothing is lost.
- After a mint, anyone can call `createVestingStreams([USDC])` on the Protocol Guild vest to
  start it vesting. Each call makes a new stream, so flushes are batched.
- Nobody chooses a recipient per repo or per Deposit.

## Bounties

Maintainers fund Bounties on issues from their own Bounty wallet on Arc. The wallet enforces the
budget, a per-payout limit and a per-period limit; the Keeper can pay only what the Maintainer
posted, within them.

**Contracts (built).** Solidity 0.8.30, like the escrow. Details, the signature format, guarantees
and trust model are in [../contracts/README.md](../contracts/README.md#bounty-wallet).
- `BountyWalletFactory(usdc, keeper)` is immutable. `create(repoId, perPayoutLimit, periodLimit,
  periodLength)` deploys the caller's `BountyWallet` with CREATE2 at an address that depends only
  on `(repoId, owner)`; `predict` and `walletOf` find it from the repo's Binding Maintainer.
- The owner funds the wallet, posts a Bounty per issue (`postBounty`, reserving its amount) and can
  cancel it, withdraw anything unreserved, set the limits, and turn Keeper payouts off.
- A Payout sends a posted Bounty's whole amount to one payee, once: `keeperPay` within the limits,
  `payWithSignature` with the owner's EIP-712 signature over
  `Payout(uint256 issueNumber,uint256 serial,address payee,uint256 amount,uint256 deadline)` at any
  amount, or `ownerPay`.

**The App (built).** Details are in [../app/README.md](../app/README.md#bounties). When a PR that
GitHub links as closing an issue with an open Bounty is merged, the App checks the witnesses: merged,
linked to the issue, the first merged PR that closes it, every check on its head commit green, a
payee wallet its author named in a `Bounty wallet: 0x…` line of their own, the Keeper switch on, and
the amount within the per-payout limit and the period's allowance. Only then does it ask a model
whether the PR resolves the issue. The model can hold a Payout back, never trigger one: only
`resolves` lets the Keeper call `keeperPay`. Anything else, and anything above the limits, gets a
note linking the Maintainer to the Bounty page (`?repo=owner/name&issue=N&payee=0x…`), where they
sign the Payout; the App relays it at `POST /bounty/payout`. Each run reads the Bounty on-chain
first, so nothing is paid twice. Every Payout's note links its transaction, and each Payout or hold
is a `pay` or `hold` decision in the decision log.

**The pages (built).** Details are in [../web/README.md](../web/README.md#the-bounty-page).
`bounties.html?repo=owner/name` is the Maintainer's: create the Bounty wallet with suggested limits,
fund it, post and cancel Bounties, withdraw, change the limits and turn Keeper payouts off. With
`&issue=N&payee=0x…` it pays one Bounty: directly with `ownerPay`, or by a signed Payout the App
relays, which the Maintainer's wallet sends itself if the App doesn't. Without `payee`, the
Maintainer pastes the Contributor's wallet. The repo page shows each Bounty, open or paid with its
transaction, and the wallet's limits and balance, read from the chain.

## Scope

| Included | Not included |
|---|---|
| Escrow, forfeit router and Bounty wallets on Arc | A card on-ramp, amounts adjusted by country |
| GitHub App: checks, labels, config, Exemptions | GitLab, Codeberg |
| Deposit page, the Maintainer's sign page, a public repo page | A deposit-gated security-report inbox |
| Agent path: an endpoint and an MCP tool | Any paid tier or fee |

## Known limits

- The Keeper chooses each repo's Maintainer address. A compromised Keeper could bind a repo to
  its own key, but the Binding is public and delayed, it affects only new Deposits, and the
  worst it can do is send forfeits to the router, never take them.
- The Keeper can pre-empt a Forfeit by refunding in full.
- There is no way to cancel a pending Binding (only overwrite it) or to deactivate a repo.
- If Circle blocklists a Depositor, that Deposit is frozen. If it blocklists the router,
  Forfeits revert but Refunds still work.
- Smart wallets that aren't deployed yet (ERC-6492) can't sign Forfeits or authorizations.
- Anyone can deposit for any key, including a PR not yet opened. The App ignores such Deposits,
  and the Keeper refunds them.
- The (repo, number) key links a Depositor address to a GitHub account. Use a fresh address if
  that matters to you.
- A lost or compromised Keeper key can pay posted Bounties to the wrong payee, within each wallet's
  per-payout and per-period limits, until the Maintainer turns Keeper payouts off. It can't touch
  anything else.
- A Keeper period starts at the first Keeper Payout after the last one ended, so within any span
  of one period length the Keeper can pay up to twice the period limit.
- The App pays the author of the first merged PR that GitHub links as closing the issue, to the
  wallet they named. A collaborator who can push could merge their own PR to claim a Bounty; the
  checks, the model, the limits and the Keeper switch stand against that, and the Maintainer can
  cancel a Bounty before a merge.
- A Contributor's record links Deposits to GitHub logins, not addresses, so someone running several
  accounts could build a record by accepting their own work under another login. The witnesses, the
  reviewer, and the Maintainer's Waiver label and denouncements stand against that.
