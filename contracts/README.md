# BonaFideEscrow

A refundable good-faith deposit for one GitHub PR or issue, paid in USDC. The contract is immutable: it has no
owner or admin, no upgrade path, no pause, and no rescue or sweep function.

- `repoId = keccak256("github:" + lowercase("owner/repo"))`, computed off-chain.
- `key = keyOf(repoId, kind, number) = keccak256(abi.encode(repoId, kind, number))`, where `kind` is 0 for a PR
  and 1 for an issue.
- A forfeit needs an EIP-712 signature over `Forfeit(bytes32 key,uint256 serial,uint256 sigDeadline)` in the
  domain `{name: "BonaFide", version: "1", chainId, verifyingContract}`. The maintainer can sign with an EOA or
  with a deployed ERC-1271 wallet.

## One-signature deposits

`depositWithAuthorization(repoId, kind, number, from, validAfter, validBefore, salt, signature)` takes a deposit
without an `approve`. The contributor, a person or an agent, signs once off-chain; anyone, usually the App, submits
it and pays the gas.

- The signature covers USDC's EIP-3009 `ReceiveWithAuthorization` in USDC's domain `{name: "USDC", version: "2",
  chainId, verifyingContract: USDC}`, with `to` = the escrow, `value` = the repo's active `amount`, and
  `nonce = authorizationNonce(key, salt) = keccak256(abi.encode(key, salt))`.
- The nonce ties the authorization to one PR or issue, so a front-runner can't spend it on another. USDC lets only
  `to` redeem it, so no one can redirect the funds.
- The depositor is `from`, whoever submits, so every refund goes to `from`.
- An EOA signs 65 bytes `r ‖ s ‖ v`. A smart wallet signs whatever its ERC-1271 check accepts: a Circle agent wallet
  signs over Circle's replay-safe wrapper. The wallet must already be deployed (USDC has no ERC-6492), and an
  EIP-7702-delegated EOA passes only if its delegate implements ERC-1271.
- USDC accepts an authorization once, strictly between `validAfter` and `validBefore`. Anyone holding an unused one
  can submit it until `validBefore`, so keep the window short, or revoke it with USDC's `cancelAuthorization`.

## Guarantees

The invariant suite checks each of these after every call.

1. **USDC leaves only to the deposit's own depositor or to the forfeit sink.** It never goes to the keeper, a
   maintainer, a relayer or anyone else.
2. **At most half of any deposit goes to the forfeit sink.** The forfeited share is `amount × forfeitBps / 10000`,
   rounded down, with `forfeitBps ≤ 5000`. The rest goes back to the depositor.
3. **The contract's USDC balance equals the sum of active deposits.** USDC sent to the contract directly, without
   `deposit`, is never paid out to anyone.
4. **The keeper can't forfeit on its own.** A forfeit needs the signature of the maintainer snapshotted in that
   deposit, for that deposit's serial. A signature for an earlier deposit on the same PR or issue doesn't work.
5. **After the deadline no one can forfeit, and anyone can refund 100% to the depositor.**
6. **A repo config change never alters an existing deposit.** Each deposit keeps its own amount, forfeit share,
   maintainer and deadline.
7. **A new or changed repo config takes effect only `bindingDelay` after it is proposed.** Anyone may activate it
   once the delay has passed.
8. **Each deposit resolves exactly once: it is refunded or forfeited.** A PR or issue can take a new deposit only
   after the previous one is resolved, and the new deposit gets a new serial.

## Trust model

| Who | Can | Cannot |
|---|---|---|
| Keeper (the GitHub App) | Propose a repo config: maintainer, forfeit share ≤ 50%, timeout of 1–60 days, amount ≤ `maxAmount`. It is public (`RepoProposed`) and takes effect only after `bindingDelay`. Refund any active deposit in full to its depositor at any time, which can pre-empt a forfeit. | Receive funds. Forfeit without the maintainer's signature. Change an existing deposit. Skip the delay. Pause, upgrade or sweep the contract. |
| Maintainer | Sign a forfeit for a deposit that names them, before its deadline. | Receive any of the forfeited amount (it goes to the forfeit sink). Forfeit after the deadline or send more than the configured share to the sink. |
| Anyone | Activate a config once its delay has passed. Refund any deposit once its deadline has passed. Relay a signed forfeit. | Anything else. |

A lost or compromised keeper key can at worst:

- refund deposits early, which pays their depositors;
- bind a repo to a maintainer key it controls. This is visible for `bindingDelay` before it applies, it affects
  only deposits made afterwards, and even then the forfeited share goes to the forfeit sink, never to the keeper.

Watch `RepoProposed` events.

The forfeit sink is an immutable address fixed at deployment: at launch, the [Charity router](#charity-router). The
constructor rejects a sink equal to the keeper or to the escrow itself, and a `bindingDelay` under 1 hour.

### Assumptions

- The token is standard USDC: no fee on transfer, no rebasing.
- If Circle blocklists a depositor, that deposit can't be resolved until they are removed from the list.
- If Circle blocklists the forfeit sink, forfeits revert, but refunds still work.
- A maintainer's smart wallet must be deployed before it signs. ERC-6492 counterfactual signatures aren't
  supported.

## Charity router

`CharityRouter` is the escrow's forfeit sink. Forfeited USDC waits in it until someone flushes it through Circle's
CCTP to one fixed recipient on one fixed chain, set at deployment. At launch that recipient is Protocol Guild's
1-year vesting contract on Base, so forfeits fund open-source maintainers (Protocol Guild). Like the escrow, the
router is immutable: no owner or admin, no upgrade path, no pause, and no other way to move USDC.

- The constructor takes `(IERC20 usdc, ITokenMessengerV2 messenger, uint32 destinationDomain, bytes32 mintRecipient)`,
  all immutable. It rejects zero addresses, a zero recipient, and any domain the messenger has no route to, such as
  Arc's own domain 26. Domain 0 is valid: it is Ethereum.
- `flush()` can be called by anyone. It reverts with `NothingToFlush` when the balance is 0. Otherwise it approves
  exactly its balance to CCTP's `TokenMessengerV2` and burns all of it with
  `depositForBurn(uint256 amount, uint32 destinationDomain, bytes32 mintRecipient, address burnToken, bytes32 destinationCaller, uint256 maxFee, uint32 minFinalityThreshold)`
  (selector `0x8e0250ee`), using the fixed domain and recipient, `destinationCaller = 0`, `maxFee = 0` and
  `minFinalityThreshold = 2000`: a Standard Transfer. CCTP pulls exactly that amount, so no allowance is left. It
  emits `Flushed(caller, amount)`.

### How to flush

```shell
cast send <router> "flush()" --rpc-url https://rpc.mainnet.arc.io --account <any account with USDC for gas>
```

Anyone can flush. Batch flushes, for example once a week, rather than flushing after each forfeit: each flush is
one CCTP message that needs its own mint on Base, and on Protocol Guild's vest its own vesting stream (below).

### How the mint is completed

A flush burns the USDC on Arc. The recipient gets it when someone submits the message and Circle's attestation to
`MessageTransmitterV2.receiveMessage` on the destination chain. Arc is CCTP domain 26.

```shell
# 1. Fetch the message and its attestation (on testnet, use iris-api-sandbox.circle.com).
curl -s "https://iris-api.circle.com/v2/messages/26?transactionHash=<flush tx>" \
  | jq -r '.messages[0] | .status, .message, .attestation'
# 2. Once the status is "complete", mint on the destination chain.
cast send 0x81D40F21F12A8F0E3252Bccb954D722d4c464B64 "receiveMessage(bytes,bytes)" <message> <attestation> \
  --rpc-url <destination chain RPC> --account <any account with gas there>
```

`MessageTransmitterV2` is `0x81D40F21F12A8F0E3252Bccb954D722d4c464B64` on Ethereum, Arbitrum and Base, and
`0xE737e5cEBEEBa77EFE34D4aa090756590b1CE275` on their testnets.

- **Anyone can relay the mint,** because `destinationCaller` is 0: the keeper, the recipient, or a volunteer. The
  relayer pays the destination chain's gas. It can't change the amount or the recipient, which are part of the
  attested message, and a message mints only once because its nonce can be used only once.
- **The mint doesn't expire.** Standard Transfers from Arc testnet were attested within minutes, with
  `expirationBlock = 0` and `feeExecuted = 0` (checked 2026-09-27).
- **The router doesn't use Circle's Forwarding Service,** which relays the mint for a fee. That service needs
  `depositForBurnWithHook` and a `maxFee` that covers a fee the router can't know on-chain.

On Protocol Guild's Base vest (`0xffaaCCFe120f3fC47f42102cF4F28e837cd49A20`), the mint is credited like any USDC
transfer, but it starts vesting only when someone calls `createVestingStreams` for USDC. Anyone can call it, and it
needs Base gas. Each call creates a new 365-day stream, which is another reason to batch flushes.

```shell
cast send 0xffaaCCFe120f3fC47f42102cF4F28e837cd49A20 "createVestingStreams(address[])" \
  "[0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913]" --rpc-url <Base RPC> --account <any account with gas there>
```

### Trust model

- **Anyone can flush the whole balance to the fixed recipient and relay its mint.** No one, including the keeper, a
  maintainer and the deployer, can choose the amount, the chain or the recipient, or move the router's USDC any
  other way.
- **Circle is trusted, as with any USDC.** It signs the attestations and can pause or upgrade CCTP
  (`TokenMessengerV2` is an upgradeable proxy), blocklist addresses and set CCTP fees. The router adds no other
  trust.
- **The recipient is fixed.** If the recipient loses its key or moves, flushes still pay the old address. Changing
  it means deploying a new router and a new escrow. The launch recipient is Protocol Guild's one-year vesting
  contract on Base, which funds Ethereum's open-source core maintainers.
- **The router never pays a CCTP fee.** Standard Transfers from Arc are free: `minFee()` is 0 on the testnet and
  mainnet messengers (checked 2026-09-27). If Circle sets a fee, `depositForBurn` reverts with
  `Insufficient max fee`, so flushes fail and the USDC waits in the router until the fee is 0 again. Nothing is lost.
- **One flush burns at most 10,000,000 USDC,** CCTP's `burnLimitsPerMessage` on Arc testnet and mainnet (checked
  2026-09-27). A single forfeit is at most 25 USDC, so a flush is due long before that. A larger balance couldn't be
  flushed.
- **If Circle blocklists the router,** flushes revert, and so do forfeits (see the escrow's assumptions). CCTP's own
  denylist checks the router and the account that sends the flush: a denylisted account can't flush, but anyone
  else can.
- **Send USDC to the router as an ERC-20 transfer.** It has no `receive` function, so a native USDC transfer on Arc
  reverts.

## Bounty wallet

`BountyWallet` holds one repo's Bounties: USDC its Maintainer funds and posts on issues, paid when a PR that closes
the issue is merged. Each repo's Maintainer has their own wallet, deployed by `BountyWalletFactory`. Neither has an
admin other than the wallet's owner, an upgrade path or a pause other than the owner's Keeper switch.

- **One wallet per `(repoId, owner)`.** `repoId` is the escrow's. `factory.create(repoId, perPayoutLimit,
  periodLimit, periodLength)` deploys the caller's wallet with CREATE2 and the caller as its immutable `owner`.
  Its address depends only on `(repoId, owner)`: `factory.predict(repoId, owner)` gives it before it exists, and
  `factory.walletOf(repoId, owner)` once it does. The App and the pages look up the wallet of the repo's Binding
  Maintainer; a wallet anyone else creates for the repo is ignored. The factory emits
  `WalletCreated(repoId, owner, wallet)`.
- **Funding.** `fund(amount)` after an `approve`, or `fundWithAuthorization(from, amount, validAfter, validBefore,
  nonce, signature)`: one EIP-3009 `ReceiveWithAuthorization` signature with `to` = the wallet, which anyone may
  submit. Anyone may fund. A plain USDC transfer funds the wallet too, without a `Funded` event.
- **Bounties.** `postBounty(issueNumber, amount)` reserves `amount` of the unreserved balance for one issue, under a
  new serial. `cancelBounty(issueNumber)` releases it. An issue has at most one open Bounty; a cancelled one can be
  posted again under a new serial, and a paid one never again. Only the owner can post or cancel.
- **Payouts.** A payout sends an open Bounty's whole amount to one payee, once. There are three ways:
  - `keeperPay(issueNumber, payee)`: the Keeper only, while `keeperEnabled`, if `amount ≤ perPayoutLimit` and the
    Keeper's payouts in the current period stay within `periodLimit`;
  - `payWithSignature(issueNumber, payee, deadline, signature)`: anyone relays the owner's signature (below), at
    any amount, whether or not the Keeper is enabled;
  - `ownerPay(issueNumber, payee)`: the owner directly, such as from a multisig.

  The payee can't be zero, the wallet or the Keeper. It can be the owner: that only returns funds the owner could
  withdraw anyway.
- **Owner controls.** `withdraw(to, amount)` takes unreserved USDC at any time (`to` can't be zero, the wallet or
  the Keeper). `setLimits(perPayoutLimit, periodLimit, periodLength)` and `setKeeperEnabled(enabled)` take effect
  at once.
- **Views.** `bountyOf(issueNumber)` returns `(amount, serial, status, payee)` with status `None`, `Open`, `Paid` or
  `Cancelled`. `reserved()` is the sum of open Bounties, `available()` the balance minus `reserved()`, and
  `keeperAllowance()` what the Keeper could still pay in total if it paid now. `spentInPeriod()` and
  `periodStart()` describe the current period.
- **Events.** `Funded(from, amount)`, `BountyPosted(issueNumber, serial, amount)`,
  `BountyCancelled(issueNumber, serial, amount)`, `Paid(issueNumber, serial, payee, amount, method)` with method
  `Keeper`, `Signature` or `Owner`, `Withdrawn(to, amount)`, `LimitsSet(perPayoutLimit, periodLimit, periodLength)`
  and `KeeperEnabled(enabled)`. The constructor emits `LimitsSet` and `KeeperEnabled(true)`, so the logs rebuild
  every Bounty and setting. The balance comes from USDC's `Transfer` events, or `balanceOf`.

### The budget and the limits

- **The budget is what the owner has funded.** Every open Bounty is reserved against the balance, so a Bounty is
  always payable, and the owner can withdraw only what no Bounty reserves.
- **The Keeper can't choose an amount.** It can only pay an open Bounty, in full.
- **`perPayoutLimit`** caps each Keeper payout. A Bounty above it needs the owner's signature.
- **`periodLimit`** caps the Keeper's payouts per period. A period starts with the first Keeper payout after the
  previous period ended, and lasts `periodLength` (1 hour to 365 days). Periods never overlap, so the Keeper pays at
  most `periodLimit` in one period, and at most `2 × periodLimit` within any `periodLength` of time (the end of one
  period and the start of the next). A rolling window would tighten that to `periodLimit`, at the cost of storing
  every payout's time.
- **Limit changes apply at once, raising as well as lowering.** The current period keeps what it has spent. A delay
  on raising would protect nothing: the owner can already pay any amount by signature or withdraw everything.

### Signatures

A payout above the limits needs an EIP-712 signature by the owner over
`Payout(uint256 issueNumber,uint256 serial,address payee,uint256 amount,uint256 deadline)` in the domain
`{name: "BonaFide Bounty", version: "1", chainId, verifyingContract: the wallet}`:

```json
{
  "domain": { "name": "BonaFide Bounty", "version": "1", "chainId": 5042002, "verifyingContract": "<wallet>" },
  "primaryType": "Payout",
  "types": {
    "Payout": [
      { "name": "issueNumber", "type": "uint256" },
      { "name": "serial", "type": "uint256" },
      { "name": "payee", "type": "address" },
      { "name": "amount", "type": "uint256" },
      { "name": "deadline", "type": "uint256" }
    ]
  },
  "message": { "issueNumber": 42, "serial": 7, "payee": "<contributor>", "amount": 250000000, "deadline": 1790000000 }
}
```

- `serial` and `amount` are the open Bounty's (`bountyOf`). The wallet checks the signature against them, so it
  pays only the Bounty that was signed, its whole amount, to the signed payee.
- **It can't be replayed.** A Bounty is paid once. The domain names the wallet, so a signature for one of the
  owner's wallets doesn't work on another. A cancelled Bounty posted again gets a new serial, so cancelling revokes
  every unused signature for it.
- It works until `deadline`, inclusive. Anyone can relay it, including the Keeper.
- The owner signs with an EOA, 65 bytes `r ‖ s ‖ v` with a low `s`, or with a deployed ERC-1271 wallet, as for the
  escrow's Forfeit signature.

### Guarantees

The invariant suite checks each of these after every call.

1. **USDC leaves a wallet only to an open Bounty's payee, once, or to the owner's `withdraw` target.** It never goes
   to the Keeper or a relayer.
2. **Keeper payouts stay within the limits.** Each is at most `perPayoutLimit`, and in each period they total at
   most `periodLimit`.
3. **Each Bounty is paid at most once,** for its posted amount, and a paid issue takes no new Bounty.
4. **`reserved` is the sum of open Bounties, and never more than the wallet's balance.** A withdrawal can't touch
   it.
5. **A payout signature works only for the wallet, issue, serial, payee, amount and deadline it names,** and only
   if the owner signed it.
6. **A disabled Keeper can't pay.**
7. **Only the owner can post, cancel, withdraw, set limits or switch the Keeper.**

### Trust model

| Who | Can | Cannot |
|---|---|---|
| Keeper (the GitHub App) | Pay an open Bounty, in full, to a payee it chooses, within `perPayoutLimit` and the period's `periodLimit`, while the owner allows it. Relay the owner's signed payouts. | Receive funds. Post, change or cancel a Bounty. Choose an amount. Raise a limit. Withdraw. Turn itself back on. Own a wallet. |
| Owner (the Maintainer) | Fund, post and cancel Bounties, pay any open Bounty by signature or directly, withdraw unreserved USDC, set limits, turn Keeper payouts off and on. | Take back a reserved Bounty without cancelling it first. Pay a Bounty twice. |
| Anyone | Fund a wallet. Relay the owner's signed payout. Create their own wallet for any repo. | Anything else. |

A lost or compromised Keeper key can at worst pay **posted** Bounties to the wrong payee, each at most
`perPayoutLimit` and at most `periodLimit` per period, until the owner calls `setKeeperEnabled(false)`. It can't
touch unreserved funds, Bounties above `perPayoutLimit`, or a wallet whose owner turned it off. Watch `Paid` events
with method `Keeper`.

Whoever runs the App never holds funds: the wallet is the owner's, and the Keeper only moves its USDC to payees.
The App's checks before a Keeper payout (merged, linked to the issue, checks green, a known payee wallet, a model
that doesn't hold it back) are off-chain; the contract bounds what happens if they fail.

### Assumptions

- The token is standard USDC, as for the escrow. If Circle blocklists a payee, payouts to it revert and the Bounty
  stays open.
- The owner is immutable. A Maintainer who changes wallets withdraws, cancels and creates a wallet under the new
  address, which is also where the App will look once the Binding names it.
- Send USDC as an ERC-20 transfer. The wallet has no `receive` function, so a native USDC transfer on Arc reverts.
- An owner smart wallet must be deployed before it signs. ERC-6492 counterfactual signatures aren't supported.

## Tests

```shell
forge test                                   # all suites: 5–10 min on a laptop
forge test --no-match-path 'test/invariant/*' # unit and fuzz only: seconds
FOUNDRY_INVARIANT_RUNS=10000 forge test --match-path 'test/invariant/*'   # deeper invariant campaign
```

- **Unit tests** (`test/BonaFideEscrow.t.sol`) cover every revert path and happy path. They include an ERC-1271
  maintainer wallet and a hostile re-entrant token.
- **Fuzz tests** (`test/BonaFideEscrow.fuzz.t.sol`) run 1,000 runs each over amounts, forfeit shares, timeouts
  and timestamps.
- **Invariant tests** (`test/invariant/BonaFideEscrow.invariant.t.sol`) are handler-based and run 8 invariants ×
  1,500 runs × 100 calls (12,000 runs). They use `fail_on_revert`, so any valid action that reverts fails the run.
- **Charity router tests** use a mock `TokenMessengerV2` that records every `depositForBurn`.
  `test/CharityRouter.t.sol` covers the constructor checks, the Standard Transfer to the fixed domain and recipient,
  the exact approval, and a real escrow forfeit reaching the recipient. `test/CharityRouter.fuzz.t.sol` flushes any
  amount from any caller, and sends arbitrary calldata that must move nothing. The router invariant suite runs
  4 invariants × 1,500 runs × 100 calls: USDC leaves only through a burn to the fixed recipient, each flush sends
  the whole balance, no allowance is left, and anyone can flush exactly when there is a balance. The router itself
  is a fuzz target, so every state-changing function in its ABI gets called; `fail_on_revert` is off for this suite
  because flushing an empty router reverts by design.
- **Bounty wallet tests.** `test/BountyWallet.t.sol` and `test/BountyWalletFactory.t.sol` cover every revert
  path and happy path, including an ERC-1271 owner, a high-`s` signature and a re-entrant token.
  `test/BountyWallet.fuzz.t.sol` fuzzes both limits, signatures by any key over any fields, withdrawals against
  reservations and CREATE2 addresses. The invariant suite (`test/invariant/BountyWallet.invariant.t.sol`) runs
  7 invariants × 1,500 runs × 100 calls over three wallets: two of one EOA owner, for cross-wallet replays, and one of
  an ERC-1271 owner.
- **Deploy script tests** (`test/Deploy.t.sol`, `test/DeployBountyWalletFactory.t.sol`) cover the deploy order, the
  forfeit sink, the mainnet guard, the environment and `FORFEIT_RECIPIENT` parsing.

## Deployments

| Network | Escrow | Forfeit router | Binding delay | Forfeits go to |
|---|---|---|---|---|
| Arc (chain 5042) | [`0xe2fe798427CFb43134FC37F6EE054c2da818fAc9`](https://explorer.arc.io/address/0xe2fe798427CFb43134FC37F6EE054c2da818fAc9) | [`0xe36fe5152C6A54946b15df3fEBDc068AF48581dc`](https://explorer.arc.io/address/0xe36fe5152C6A54946b15df3fEBDc068AF48581dc) | 1 hour | Protocol Guild's vest on Base |
| Arc Testnet (chain 5042002) | [`0x05283F2c7D94D66669227Cecf75abBbd024771A7`](https://explorer.testnet.arc.io/address/0x05283F2c7D94D66669227Cecf75abBbd024771A7) | [`0xae079DC6536c270d2743c0721cfC41c94E12ca9f`](https://explorer.testnet.arc.io/address/0xae079DC6536c270d2743c0721cfC41c94E12ca9f) | 1 hour | A test address on Base Sepolia |

Both escrows take Deposits of at most 50 USDC. The mainnet pair was deployed in blocks 24,583,717 and 24,583,718.

## Deploy (dry run only)

`script/Deploy.s.sol` deploys the Charity router, then the escrow with `forfeitSink` = the router. It reads these
environment variables:

| Variable | Default | Notes |
|---|---|---|
| `USDC` | required | Arc USDC is `0x3600000000000000000000000000000000000000` on testnet and mainnet, with 6 decimals |
| `KEEPER` | required | |
| `CCTP_MESSENGER` | required | `TokenMessengerV2`: `0x8FE6B999Dc680CcFDD5Bf7EB0974218be2542DAA` on Arc testnet, `0x28b5a0e9C621a5BadaA536219b3a228C8168cf5d` on Arc mainnet |
| `DEST_DOMAIN` | required | The recipient's CCTP domain: 0 Ethereum, 3 Arbitrum, 6 Base. At launch, `6` |
| `FORFEIT_RECIPIENT` | required | The recipient's USDC address on that chain, as an address or a bytes32. At launch, Protocol Guild's Base vest `0xffaaCCFe120f3fC47f42102cF4F28e837cd49A20` |
| `BINDING_DELAY` | `86400` | Seconds; at least 3600 |
| `MAX_AMOUNT` | `50000000` | 50 USDC in base units |

On Arc mainnet (chain 5042) the script reverts unless `CONFIRM_MAINNET=yes` is set.

Without `--broadcast`, this only simulates the deployment, as a fork of Arc testnet using read-only calls:

```shell
USDC=0x3600000000000000000000000000000000000000 KEEPER=<keeper address> \
CCTP_MESSENGER=0x8FE6B999Dc680CcFDD5Bf7EB0974218be2542DAA DEST_DOMAIN=6 FORFEIT_RECIPIENT=<recipient address> \
forge script script/Deploy.s.sol --rpc-url https://rpc.testnet.arc.io
```

It needs `--rpc-url`: the router's constructor asks the messenger whether it routes to `DEST_DOMAIN`, and a fresh
local chain has no messenger.

### Bounty wallet factory

`script/DeployBountyWalletFactory.s.sol` deploys `BountyWalletFactory(USDC, KEEPER)`, with the same `USDC`, `KEEPER`
and `CONFIRM_MAINNET` conventions. It needs no RPC to simulate:

```shell
USDC=0x3600000000000000000000000000000000000000 KEEPER=<keeper address> \
forge script script/DeployBountyWalletFactory.s.sol --rpc-url https://rpc.testnet.arc.io
```

Each Maintainer then creates their own wallet: `cast send <factory> "create(bytes32,uint256,uint256,uint32)" <repoId>
<perPayoutLimit> <periodLimit> <periodLength>` from the Binding's Maintainer address.
