# Bona Fide for AI agents

An [MCP](https://modelcontextprotocol.io) server that lets an AI agent make the refundable Deposit a
repo asks for on its PR or issue, within a limit you set, follow it until it is refunded, and read
the Bounties it can work on.

The server never holds keys and never runs wallet commands. It reads the escrow and the Bounty wallets
on Arc and prepares what to sign or send. The agent's own wallet does the signing and sending.

| Tool | What it does |
|---|---|
| `get_deposit_rules` | The repo's Binding: the Deposit it asks for, the Timeout and the forfeit share, and whether the item already has an active Deposit |
| `prepare_signed_deposit` | USDC's authorization for the Deposit, as typed data for the agent's wallet to sign |
| `submit_signed_deposit` | Sends that signature to the App, which makes the Deposit and pays its gas |
| `prepare_two_step_deposit` | The Deposit as two transactions for the agent's wallet to send: an approve, then the deposit |
| `get_deposit_status` | The item's Deposit: none, active, refunded or forfeited, its Serial, and when its Timeout ends |
| `prepare_refund` | After the Timeout, the escrow's `refund` transaction, which anyone can send |
| `get_bounty` | An issue's Bounty in the repo's Bounty wallet, who may pay it, and the line that names your Payee |

Every tool only reads the chain or prepares calldata. Only `submit_signed_deposit` sends anything, and
it sends a signature the agent's wallet already made.

## What a Deposit means

A repo that uses Bona Fide asks Contributors nobody has vouched for, people and agents alike, for a
small USDC Deposit on each PR or issue. The escrow holds it on Arc:

- **Merged or accepted:** refunded in full.
- **No decision before the Timeout:** refunded in full. After the Timeout, anyone can trigger the
  Refund.
- **Bad faith, signed by a Maintainer:** up to the repo's forfeit share (at most 50%) funds open
  source, and the rest is refunded.

Refunds always go to the address that paid, the Depositor. Nobody, not the Maintainer and not whoever
runs the App, can take the money.

## Before you start

- **Node 24** and a clone of this repository. At its root, run `npm ci`.
- **A wallet for the agent on Arc** that holds the Deposit in USDC. Two kinds work:
  - **A Circle agent wallet.** A person sets it up once, before the agent can use it (see
    [below](#set-up-a-circle-agent-wallet)).
  - **Any wallet whose key the agent's own tools control**, such as a plain EOA used with
    [Foundry](https://getfoundry.sh)'s `cast`. On Arc, gas is paid in USDC, so it needs no other
    token.

### Set up a Circle agent wallet

Only a person can do this. An agent must never accept Circle's Terms for you: Circle counts an
agent's acceptance as yours.

1. Install the [Circle CLI](https://www.npmjs.com/package/@circle-fin/cli):
   `npm install -g @circle-fin/cli`.
2. Run `circle terms show`, read the Terms it links to, then accept them with `circle terms accept`.
3. Log in with `circle wallet login <your email> --testnet`, or without `--testnet` on Arc mainnet.
   Type the one-time code from the email yourself. The first login creates the wallets, and a
   session lasts 28 days.
4. Find the agent's wallet address with `circle wallet list --type agent --chain ARC-TESTNET`
   (`--chain ARC` on mainnet).
5. Fund it. On testnet, `circle wallet fund --address <wallet> --chain ARC-TESTNET` uses Circle's
   faucet.

A Circle agent wallet is a smart account that is deployed with its first transaction. **Until then it
can't sign**, so the one-signature path fails. Make its first Deposit with the
[two transactions](#two-transactions) path, which deploys it. Circle sponsors the gas for agent
wallets.

## Add the server to Claude Code

```sh
claude mcp add bona-fide \
  -e ESCROW_ADDRESS=0xe2fe798427CFb43134FC37F6EE054c2da818fAc9 \
  -e RPC_URL=https://rpc.mainnet.arc.io \
  -e APP_URL=https://bofi.live \
  -e MAX_DEPOSIT_USDC=5 \
  -- node /path/to/bona-fide/agent/src/main.ts
```

Or add it to a project's `.mcp.json`:

```json
{
  "mcpServers": {
    "bona-fide": {
      "command": "node",
      "args": ["/path/to/bona-fide/agent/src/main.ts"],
      "env": {
        "ESCROW_ADDRESS": "0xe2fe798427CFb43134FC37F6EE054c2da818fAc9",
        "RPC_URL": "https://rpc.mainnet.arc.io",
        "APP_URL": "https://bofi.live",
        "MAX_DEPOSIT_USDC": "5"
      }
    }
  }
}
```

Run `/mcp` in Claude Code to check that `bona-fide` is connected. The values above are Bona Fide's escrow and App on
Arc mainnet.

| Variable | Default | What it is |
|---|---|---|
| `ESCROW_ADDRESS` | required | The Bona Fide escrow on Arc |
| `RPC_URL` | `https://rpc.testnet.arc.io` | An Arc RPC endpoint. For Arc mainnet, `https://rpc.mainnet.arc.io` |
| `APP_URL` | none | The Bona Fide App. Needed only to submit one-signature Deposits |
| `MAX_DEPOSIT_USDC` | `5` | The most the tools will prepare or submit for one Deposit, in USDC |
| `BOUNTY_FACTORY_ADDRESS` | the factory deployed with `ESCROW_ADDRESS` | The Bounty wallet factory `get_bounty` reads. Needed only with another escrow |

With Bona Fide's own escrow, the server also knows its block explorer, and links to it.

## Add the skill

[`skills/bona-fide/SKILL.md`](skills/bona-fide/SKILL.md) tells an agent when and how to use these
tools: how to tell a real request for a Deposit from a forged one, when to stop and ask the person it works for,
what to do after the Deposit, and how to name its Payee for a Bounty. It is an
[Agent Skill](https://agentskills.io), so Claude Code and other agents that read skills can load it.
For Claude Code, copy the folder into a project's `.claude/skills/` or into `~/.claude/skills/`:

```sh
cp -R /path/to/bona-fide/agent/skills/bona-fide ~/.claude/skills/
```

## When a PR or issue asks for a Deposit

The App's "Bona Fide" check on a PR, and its comment on a PR or issue, end with a line GitHub doesn't
show, for agents:

```html
<!-- bona-fide:deposit-request {"v":1,"chainId":5042,"escrow":"0xe2fe798427CFb43134FC37F6EE054c2da818fAc9","repo":"acme/widgets","kind":"pr","number":128,"amount":"1000000","depositUrl":"https://bofi.live/deposit?repo=acme%2Fwidgets&kind=pr&number=128","llmsTxtUrl":"https://bofi.live/llms.txt"} -->
```

Read it from the check run's `output.summary` or the comment's `body` through GitHub's API, with
`depositRequestIn` from `@bona-fide/sdk` or as JSON. It is there only while the App asks for a
Deposit.

Anyone can post the same line in a comment, so take it only from the check run whose `app.slug` is
`bona-fide-deposits`, or from a comment whose `performed_via_github_app.slug` is
`bona-fide-deposits` (by `bona-fide-deposits[bot]`). Even then, its amount is only a hint: pass its
`repo`, `kind` and `number` to `get_deposit_rules` and pay what the escrow says. If its `escrow` or
`chainId` isn't the escrow and chain this server reads, stop and ask.

## How an agent deposits

First, `get_deposit_rules(repo, kind, number)` reads the repo's rules for a PR (`kind: "pr"`) or an
issue (`kind: "issue"`). It returns the amount, the Timeout and the forfeit share, and says whether the
item already has an active Deposit and who paid it. Then the agent picks one of two paths.

### One signature

The agent signs once, and the Bona Fide App submits the Deposit and pays its gas.

1. `prepare_signed_deposit(repo, kind, number, from)` returns:
   - `typedData`, USDC's authorization for the escrow to take exactly the Deposit from `from`;
   - `circleCommand`, which signs it with a Circle agent wallet and prints the signature;
   - `submit`, the fields to pass on in step 3.
2. The agent signs `typedData` with its wallet: with `circleCommand`, or with any EIP-712 signer, for
   example `cast wallet sign --data '<typedData JSON>' --account <name>`.
3. `submit_signed_deposit` takes the `submit` fields and the `signature`. It sends them to the App,
   waits for the Deposit on-chain and returns the transaction.

The signature is valid for 10 minutes and pays only this PR's or issue's Deposit, once. If the
repo's amount changes before it is submitted, the App refuses it; prepare and sign again.

A smart-account wallet must already be deployed to sign, and an EOA with an EIP-7702 delegation can
sign only if its delegate supports ERC-1271. Otherwise, use the two transactions path.

### Two transactions

For agents that send their own transactions, `prepare_two_step_deposit(repo, kind, number, from)`
returns two, each as calldata (`to`, `data`) and as a `circle wallet execute` command:

1. an approve that lets the escrow take exactly the Deposit;
2. the deposit itself.

Send them from `from`, in that order.

## The limit

The tools refuse to prepare or submit a Deposit above `MAX_DEPOSIT_USDC`. They enforce it themselves:
Circle's spending policies apply only on mainnet, and Circle doesn't document whether they cover
contract calls or signatures. The agent's wallet can still send anything else it holds, so give it no
more than it needs.

## After your Deposit

`get_deposit_status(repo, kind, number)` reads the item's Deposit from the escrow: `none`, `active`,
`refunded` or `forfeited`; its amount, Depositor and Serial; when its Timeout ends and whether it
has passed; and, once resolved, how much was refunded and how much forfeited. With Bona Fide's own
escrow it links the Depositor's page on the block explorer.

The Keeper refunds a Deposit as soon as the PR is merged or the item is accepted. If no one decides
before the Timeout, anyone can Refund it after. `prepare_refund(repo, kind, number, from)` then
returns the escrow's `refund` call, as calldata and as a `circle wallet execute` command, to send
from `from`. The whole Deposit goes back to its Depositor, whoever sends it; the sender pays only
gas, so no limit applies. Before the Timeout, only the Keeper can Refund, and the tool refuses,
saying how long is left. It refuses too for an item with no Deposit, or one already refunded or
forfeited.

## Bounties

`get_bounty(repo, issue, payee?)` reads the Bounty on an issue from the repo's Bounty wallet: the one
its active Binding's Maintainer created. A wallet anyone else made for the repo doesn't count. It
says whether the Bounty is `open`, `paid` or `cancelled`, its amount, and whether the wallet lets
the Keeper pay it: Keeper payouts on, within the per-payout limit and within what the Keeper has
left this period. Even then the App pays only after its checks on the merged PR pass. Otherwise the
Maintainer pays, with a signature anyone can relay or directly.

A Bounty is paid to the Payee the author of the merged PR that closes the issue names, on a line
of its own in the PR's description or in their own comment on it:

```text
Bounty wallet: 0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed
```

Only the PR author's words count, and only a description or comment nobody else has edited since.
The latest line wins: a comment over the description, a later comment over an earlier one, and in
one text the last line. Pass `payee` to get that exact line for your wallet, checksummed, and to
check that the Bounty wallet can pay it: it can't pay the zero address, itself or the Keeper.

The tool reads one issue at a time. Listing every open Bounty in a repo takes a scan of the wallet's
logs since the factory was deployed; the repo's page on the Bona Fide site does that.

## The relay API

`submit_signed_deposit` calls the App's relay. Agents that don't use MCP can call it directly.

`POST {APP_URL}/relay/deposit` with a JSON body:

```json
{
  "repo": "owner/name",
  "kind": "pr",
  "number": 42,
  "from": "0x…",
  "value": "1000000",
  "validAfter": "0",
  "validBefore": "1790000000",
  "salt": "0x…",
  "signature": "0x…"
}
```

`value` is in USDC base units (6 decimals); `validAfter` and `validBefore` are Unix times in seconds.
The signature is over USDC's `ReceiveWithAuthorization` with `to` = the escrow and
`nonce = authorizationNonce(key, salt)`; `prepare_signed_deposit` builds it.

| Status | `code` | Meaning |
|---|---|---|
| 200 | | The Deposit is on-chain: `{"txHash"}` |
| 400 | `invalid` | The body is malformed; `error` says which fields |
| 404 | `not-served` | This App doesn't relay Deposits |
| 409 | `inactive` | The repo isn't active |
| 409 | `amount-changed` | The amount is now `amount`: sign again for it |
| 409 | `already-deposited` | The item already has a Deposit, from `depositor` |
| 409 | `in-flight` | A Deposit for the item is being relayed right now |
| 413 | `too-large` | The body is over 16 KiB |
| 422 | `expired` | The authorization has expired, or has under two minutes left |
| 422 | `bad-signature` | USDC refused the signature |
| 422 | `low-balance` | The wallet holds less USDC than the Deposit |
| 422 | `would-fail` | The Deposit would fail on-chain for another reason; `error` gives it |
| 429 | `rate-limited` | Too many requests, or Deposits from this wallet or for this item today; retry after `Retry-After` seconds |
| 429 | `paused` | A relayed Deposit for this item or from this wallet reverted on-chain in the last 10 minutes; retry after `Retry-After` seconds |
| 502 | `reverted` | The transaction `txHash` reverted, so no Deposit was made. The relay then sends none for this item or from this wallet for 10 minutes |
| 503 | `unavailable` | The relay can't reach the chain; try again shortly |
| 504 | `unconfirmed` | The transaction `txHash` was sent but isn't confirmed yet |

Every error body has an `error` message, for a person, and a `code`, for a program. The codes, and
the body and answer of every route, are in `@bona-fide/sdk`: `relayDepositRoute` encodes this body
and `refusalIn` reads a refusal.

## Tests

```sh
npm test
npm run typecheck
```

The tests need Foundry (`forge`, `anvil` and `cast`). They run the real escrow, the Bounty wallet
factory and a USDC mock with EIP-3009 on a local anvil chain. The end-to-end test also starts the App, which the root's `npm ci`
installs too.
