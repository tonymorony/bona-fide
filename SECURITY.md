# Security

Bona Fide holds other people's USDC: Deposits in an escrow on Arc, and Bounties in Maintainers' Bounty
wallets. If you find a way to break one of the guarantees below, or anything else that could cost someone
funds, a key or their GitHub repo, please tell us privately first.

## Report a vulnerability

Use GitHub's private vulnerability reporting:
[**Report a vulnerability**](https://github.com/tonymorony/bona-fide/security/advisories/new) (the repo's
**Security** tab). Only the maintainer sees the report, and we can work on a fix and an advisory together there.

Please don't open a public issue, pull request or discussion about it. In the report, include:

- what is affected: a contract and its address, or a file and commit;
- how to reproduce it, ideally as a Foundry test or a script against Arc Testnet or a local anvil;
- what an attacker gains, and what they need first (a key, a role, a repo setting);
- whether you think funds are at risk now. If they are, start the title with **URGENT**.

There is no bug bounty: Bona Fide pays nothing for reports, though we'll gladly credit you in the advisory.
(The product's Bounties are something else: USDC a Maintainer posts on an issue.)

## What to expect

Bona Fide has one maintainer, so these are the promises we can keep:

- an acknowledgement within 7 days;
- a first assessment, and what we plan to do, within 30 days;
- updates in the advisory as the work goes on, and a disclosure date agreed with you. By default the
  advisory is published once a fix is deployed, or 90 days after the report, whichever comes first;
- credit in the advisory, under the name you choose, unless you'd rather not.

## In scope

| Part | Where | Notes |
|---|---|---|
| The contracts on Arc | [`contracts/src`](contracts/src), deployed at the addresses in [`sdk/src/deployments.ts`](sdk/src/deployments.ts) | `BonaFideEscrow`, `CharityRouter`, `BountyWallet`, `BountyWalletFactory`. Anything that breaks a guarantee in [CONTEXT.md](CONTEXT.md) or [contracts/README.md](contracts/README.md) |
| The GitHub App and its Keeper | [`app/`](app) | Checks, Exemptions, Record Exemptions, Bindings, Refunds, Forfeit relays, Bounty Payouts, the decision log; what a stolen Keeper key or webhook secret allows |
| The deposit relay and the App's endpoints | [`app/`](app) | `/relay/deposit`, `/forfeit`, `/binding-proof`, `/bounty/payout`, `/decisions`, `/webhook` |
| The pages | [`web/`](web) | The deposit, verdict, setup, repo and Bounty pages and the landing page. For example, a page that gets someone to sign something other than what it shows, or script injection |
| The agent MCP server | [`agent/`](agent) | What an AI agent, or a repo it reads, can make it sign or pay |
| The SDK | [`sdk/`](sdk) (`@bona-fide/sdk`) | Ids, typed data, the signature check, the deployment addresses |
| The deploy and the security check | [`deploy/`](deploy), [`.github/`](.github), [`scripts/`](scripts) | The container, Caddy, the deploy scripts, and the supply chain: workflows, pinned tools, dependencies |

### The contracts can't be patched

The deployed contracts have no owner, no upgrade path, no pause and no rescue function. That is what makes
their guarantees hold, and it also means a bug in them can't be fixed in place. A fix is a new deployment:

- the App, the SDK and the pages move to the new addresses and stop asking for Deposits on the old escrow;
- Deposits already in the old escrow stay under its rules. After its Timeout, anyone can Refund a Deposit to
  its Depositor, and the Keeper can Refund earlier;
- Bounty wallet owners can turn off Keeper payouts and withdraw unreserved USDC from the old wallets at any
  time, then create wallets from a new factory.

So for a contract bug, the response may be a warning and a move to new contracts rather than a patch, and the
disclosure date matters more than usual: please give us time to move people before it is public. The
contracts' [trust model](contracts/README.md#trust-model) says what the Keeper, a Maintainer and anyone else
can and can't do; a report that shows one of them doing more is what we most want to hear.

## Out of scope

- **Other people's systems.** Arc, USDC and Circle (blocklisting, CCTP, attestations), GitHub, and Protocol
  Guild's contracts: report to them. How Bona Fide depends on them is in the contracts'
  [assumptions](contracts/README.md#assumptions).
- **A dependency's own bug,** unless the way Bona Fide uses it makes it exploitable here. Report it upstream,
  and tell us if you think we're affected.
- **Behaviour the docs describe as intended,** such as the Keeper refunding a Deposit early, a Maintainer's
  signed Forfeit within the Binding's share, or what the model advises in triage, which never decides a payout
  on its own.
- **Instances other people run,** from a fork or a copy of this code.
- Volume denial of service against the hosted App, spam on issues or pull requests, social engineering, and
  scanner output without a way to exploit it.

When you test, use Arc Testnet or a local anvil (the `*.anvil.test.ts` suites show how), your own repos and
your own funds. Don't touch other people's Deposits, Bounties or repos, and don't read or keep data that isn't
yours.

## Supported versions

The contracts at the addresses in [`sdk/src/deployments.ts`](sdk/src/deployments.ts), and the `main` branch
of the App, the pages, the agent and the SDK. Fixes aren't backported to older commits.

## How the repo checks itself

Every pull request, every push to `main` and `develop`, and a weekly run go through the `security` check:
workflow linting, secret scanning, known-vulnerability scanning, the dependency policy and Slither over the
contracts. `npm run security` runs the same checks locally. `security` and `check` (lint, types and every test
suite) are required: on this public repository a ruleset on `main` and `develop` requires both; the private
working repository can't hold a ruleset on its GitHub plan, so its merges go only through
[`scripts/merge-guard.sh`](scripts/merge-guard.sh), which refuses unless both are green GitHub Actions runs. See
[docs/security/dependency-policy.md](docs/security/dependency-policy.md) and
[docs/security/suppressions.md](docs/security/suppressions.md).
