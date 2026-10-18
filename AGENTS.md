# AGENTS.md

Notes for coding agents working in this repository. People start at [README.md](README.md).

Bona Fide asks Contributors a repo doesn't know yet for a refundable USDC Deposit on their PR or
issue. An immutable escrow on Arc holds it; a GitHub App asks for it, and its Keeper refunds it or
relays a Forfeit the Maintainer signed. Maintainers can also pay Bounties from their own Bounty
wallet.

## Words

Use the terms in [CONTEXT.md](CONTEXT.md), capitalized as there, in code, comments, copy and docs.
Its "Avoid" column matters: a Deposit is never a stake, bet, fee or bond, and Forfeits fund
open-source maintainers through Protocol Guild, never "charity" or "donations".

## Map

| Folder | What it is | Start at |
|---|---|---|
| `contracts/` | Solidity with Foundry: `BonaFideEscrow`, `CharityRouter`, `BountyWallet`, `BountyWalletFactory` | [contracts/README.md](contracts/README.md): guarantees and trust model |
| `sdk/` | `@bona-fide/sdk`: generated ABIs, ids, typed data, the signature check, deployments | [sdk/src/index.ts](sdk/src/index.ts) |
| `app/` | The GitHub App: checks, Exemptions, the Keeper, the deposit relay, triage, Bounty Payouts | [app/src/index.ts](app/src/index.ts); the Node host is `app/src/node.ts` |
| `agent/` | An MCP server that lets an AI agent make a Deposit from its own wallet | [agent/src/server.ts](agent/src/server.ts) |
| `web/` | The deposit, verdict, setup, repo and Bounty pages, and the static landing page | [web/build.ts](web/build.ts), [web/src/pages/](web/src/pages/) |
| `deploy/` | One Docker container behind Caddy | [deploy/README.md](deploy/README.md) |

`app/`, `agent/` and `web/` import `@bona-fide/sdk` from `sdk/src`: put anything two of them need
about the contracts there, not in a copy.

## Commands

```shell
git submodule update --init --recursive   # the contracts' forge-std and OpenZeppelin
npm ci                                    # every TypeScript package, from the root lockfile
(cd contracts && forge test)
(cd sdk && npm test && npm run typecheck) # the same two scripts in app/, agent/ and web/
npm run format --workspaces               # Prettier, 120 columns
```

Tests named `*.anvil.test.ts` deploy the real contracts to a local anvil; `*.chrome.test.ts` drive
Google Chrome. Every vitest suite runs `forge build` first. They need Node 24, Foundry and Chrome.

## Rules

- **The deployed contracts can't change.** They have no owner and no upgrade path. Editing
  `contracts/src` changes only the next deployment, so keep the TypeScript working against the
  contracts already on Arc, at the addresses in `sdk/src/deployments.ts`.
- **After a contract change,** run `forge build` in `contracts/` and `npm run abi` in `sdk/`.
  `sdk/test/abi.test.ts` fails while `sdk/src/abi.ts` is stale.
- **New addresses** go in `sdk/src/deployments.ts` and `web/landing/config.js`; a test checks they agree.
- **Never broadcast to mainnet or handle keys.** Deploy scripts revert on chain 5042 unless
  `CONFIRM_MAINNET=yes`; dry-run them, and leave sending to a person. Keys and secrets live in
  `.env` files, which are never committed. A new environment variable goes in
  `deploy/.env.example`, which a test checks.
- **The model's answer is a suggestion, never a release condition.** Triage and Bounty review
  advise; merged PRs, signatures, checks and limits decide every payout, and a person signs
  anything punitive.
- **TypeScript runs as written:** Node 24 strips the types, so use only erasable syntax (no
  `enum`, `namespace` or parameter properties) and import local files with their `.ts` extension.
- **The pages load nothing from another site** and set no cookies or trackers: bundle what they
  need.
