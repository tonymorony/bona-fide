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
   takes effect **24 hours** later.
2. **A Contributor opens a PR or issue.**
   - **Exempt** (the check passes at once): repo collaborators with write, maintain or admin
     access; anyone listed in Vouch's `VOUCHED.td`; anyone with a prior merged PR in the repo;
     and a short allowlist of maintenance bots. A Maintainer can also waive any single item with
     the label `bona-fide:waive`. PRs and issues opened before the repo's first Binding took effect
     are exempt too.
   - **Denounced** in `VOUCHED.td`: the check fails and no Deposit is offered. A denouncement
     outranks the waiver label.
   - Otherwise the check asks for a Deposit, or a vouch from a Maintainer. It links to a deposit
     page, and agents have their own path.
3. **The Contributor or their agent deposits USDC into the escrow on Arc.** The check turns
   green within seconds. The App counts only Deposits made after the item was opened.
4. **Outcomes, enforced by the contract:**

   | Outcome | Who triggers | Money |
   |---|---|---|
   | Merged, approved by a Maintainer, closed as completed, or labelled `bona-fide:ok` | Keeper | **100% refunded** |
   | No decision before the Timeout | The Keeper, or **anyone** | **100% refunded** |
   | Maintainer labels `bona-fide:bad-faith` and **signs with their wallet** | Anyone relays the signature | ≤ 50% to the forfeit router, the rest refunded |

5. **Triage (optional).** An automated reviewer reads each item that holds a Deposit. For clearly
   good work it suggests acceptance; for likely bad faith it drafts a verdict with reasons and asks
   the Maintainer to review and sign. It never forfeits and never refunds on its own: only the
   Maintainer's signature can forfeit, as the escrow requires.
6. **Decision log.** Every triage suggestion and every early Refund on acceptance is recorded with
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

## Scope

| Included | Not included |
|---|---|
| Escrow and forfeit router on Arc | A card on-ramp, amounts adjusted by country |
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
