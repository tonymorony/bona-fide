# Bona Fide: context

Refundable good-faith deposits for open-source contributions. An escrow contract on Arc holds
each Deposit. A GitHub App asks Contributors nobody has vouched for to make one, and resolves it.
Maintainers can also fund Bounties on issues from their own Bounty wallet, paid when a PR that
closes the issue is merged.

## Terms

| Term | Meaning | Avoid |
|---|---|---|
| **Deposit** | USDC a Contributor puts down for one PR or issue, held by the escrow until it is refunded or forfeited | stake, bet, fee, bond, collateral |
| **Contributor** | Whoever opens the PR or issue: a person or an AI agent | user |
| **Depositor** | The address that paid a Deposit, and the only address a Refund can reach | — |
| **Maintainer** | The repo's decision-maker, bound on-chain by address, who signs Forfeits | owner, admin |
| **Keeper** | The App's signer: proposes Bindings, triggers early Refunds and Refunds at the Timeout, relays signed Forfeits. It can never take funds | operator, admin, oracle |
| **Refund** | 100% of a Deposit back to its Depositor: on merge or Acceptance (Keeper), or after the Timeout (the Keeper, or anyone) | return, release |
| **Acceptance** | A Maintainer's word on GitHub that a PR or issue is good work, given by someone who can push: a merge, an issue closed as completed by someone other than its author, the `bona-fide:ok` label, or an approving review. The Keeper refunds on it, though while the item is marked bad faith only a merge refunds. A Contributor's record counts it only when someone other than the author merged, closed or labelled it, and the author can't push | approval (one way to give it), sign-off, verdict |
| **Forfeit** | The Maintainer's signed bad-faith verdict: up to 50% goes to the Forfeit sink, the rest is refunded | slash, penalty, confiscation |
| **Forfeit sink** | The escrow's single immutable address for forfeited USDC. At launch it is the Charity router | treasury, pool |
| **Charity router** | An immutable contract with one fixed recipient, an open-source sustainability fund. Anyone can flush its balance to that fund through CCTP | donation wallet, burn |
| **Exemption** | A reason a Contributor needs no Deposit: repo collaborator, vouched in `VOUCHED.td`, a prior merged PR, a Waiver, a PR or issue opened before the repo's first Binding took effect, or a Record Exemption | whitelist |
| **Waiver** | A Maintainer's `bona-fide:waive` label that exempts one PR or issue | skip, bypass |
| **Record Exemption** | An Exemption the App grants for one PR or issue from its Contributor's Bona Fide record: enough Refunds on work others accepted across public repos, Forfeits in fewer than two repos, not denounced, and an automated reviewer that didn't hold it back. Forfeits in a second repo end it | auto-waiver, waiver (that is the Maintainer's label), trust score, reputation |
| **Binding** | A repo's on-chain configuration (Maintainer, amount, forfeit share, Timeout). The Keeper proposes it only after the Maintainer's signed proof of wallet control, and it takes effect 1 hour later | registration |
| **Timeout** | How long the Maintainer has to decide after a Deposit. After it, anyone can Refund | expiry |
| **Serial** | A Deposit's unique number, or a Bounty's within its Bounty wallet. A Forfeit or Payout signature names it, so the signature can't be replayed | nonce |
| **Bounty** | USDC a Maintainer posts on one issue from their Bounty wallet, reserved until it is paid in full to one payee or cancelled. Paid at most once | reward, prize, grant, tip |
| **Bounty wallet** | A repo's contract on Arc that holds its Maintainer's Bounties, owned by that Maintainer, which caps what the Keeper may pay with a per-payout and a per-period limit | PolicyWallet, treasury, vault, pool |
| **Payout** | One Bounty paid to its payee: by the Keeper within the limits, by anyone relaying the Maintainer's signature, or by the Maintainer directly. Each links its transaction | reward, release, claim |
| **Payee** | The address a Payout reaches: the wallet the Contributor of the merged PR made known | recipient, winner |

## What the escrow guarantees

1. USDC leaves only to a Deposit's own Depositor or to the Forfeit sink.
2. A Forfeit takes at most 50% of a Deposit.
3. Nobody profits from a rejection: not the Maintainer, not the Keeper, not whoever runs the App.
4. The Keeper alone can never Forfeit.
5. After the Timeout, a Refund always works.
6. Changing a Binding never changes an existing Deposit.

## What a Bounty wallet guarantees

1. USDC leaves only to an open Bounty's payee, once, or to its owner's withdrawal.
2. The Keeper pays only a posted Bounty, in full, within the per-payout and per-period limits, and
   only while the Maintainer allows it.
3. The Keeper never receives funds, posts or changes a Bounty, raises a limit or withdraws.
4. Above the limits, only the Maintainer's signature, which can't be replayed, or the Maintainer pays.
5. A Bounty's amount stays reserved until it is paid or cancelled.

