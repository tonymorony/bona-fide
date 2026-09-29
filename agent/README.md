# Bona Fide for AI agents

An [MCP](https://modelcontextprotocol.io) server that lets an AI agent make the refundable Deposit a
repo asks for on its PR or issue, within a limit you set.

The server never holds keys and never runs wallet commands. It reads the repo's rules from the escrow
on Arc and prepares what to sign or send. The agent's own wallet does the signing and sending.

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

- **Node 24** and a clone of this repository. In `agent/`, run `npm ci`.
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
  -e ESCROW_ADDRESS=<escrow address> \
  -e APP_URL=<Bona Fide App URL> \
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
        "ESCROW_ADDRESS": "<escrow address>",
        "APP_URL": "<Bona Fide App URL>",
        "MAX_DEPOSIT_USDC": "5"
      }
    }
  }
}
```

Run `/mcp` in Claude Code to check that `bona-fide` is connected.

| Variable | Default | What it is |
|---|---|---|
| `ESCROW_ADDRESS` | required | The Bona Fide escrow on Arc |
| `RPC_URL` | `https://rpc.testnet.arc.io` | An Arc RPC endpoint. For Arc mainnet, `https://rpc.mainnet.arc.io` |
| `APP_URL` | none | The Bona Fide App. Needed only to submit one-signature Deposits |
| `MAX_DEPOSIT_USDC` | `5` | The most the tools will prepare or submit for one Deposit, in USDC |

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

| Status | Meaning |
|---|---|
| 200 | The Deposit is on-chain: `{"txHash"}` |
| 400 | The body is malformed; `error` says which fields |
| 404 | This App doesn't relay Deposits |
| 409 | The repo isn't active, the amount is now `amount`, the item already has a Deposit from `depositor`, or one is being relayed |
| 413 | The body is over 16 KiB |
| 422 | The Deposit would fail on-chain, for example a bad or expired signature; `error` gives the reason |
| 429 | Too many requests, or a relayed Deposit for this item or from this wallet reverted on-chain in the last 10 minutes; retry after `Retry-After` seconds |
| 502 | The transaction `txHash` reverted, so no Deposit was made. The relay then sends none for this item or from this wallet for 10 minutes |
| 503 | The relay can't reach the chain; try again shortly |
| 504 | The transaction `txHash` was sent but isn't confirmed yet |

Every error body has an `error` message.

## Tests

```sh
npm test
npm run typecheck
```

The tests need Foundry (`forge`, `anvil` and `cast`). They run the real escrow and a USDC mock with
EIP-3009 on a local anvil chain. The end-to-end test also starts the App, so run `npm ci` in `app/`
first.
