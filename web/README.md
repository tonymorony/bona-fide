# Bona Fide pages

The web pages Contributors and Maintainers use, built as plain static files. Terms such as Deposit,
Forfeit and Binding are defined in [../CONTEXT.md](../CONTEXT.md).

| Page | Who | What it does |
|---|---|---|
| `deposit.html?repo=owner/name&kind=pr\|issue&number=N` | Contributor | Shows the repo's terms, then takes the Deposit: one signature that the App relays, or two transactions (approve, then deposit) from the Contributor's wallet. After the Timeout, the Keeper refunds the Deposit, and anyone can send the Refund here too. The App's `DEPOSIT_PAGE_URL` |
| `verdict.html?repo=…&kind=…&number=N` | Maintainer | Signs the bad-faith verdict (a Forfeit) for one Deposit and sends it to the App's Keeper. The App's `SIGN_PAGE_URL` |
| `setup.html?repo=owner/name` | Maintainer | Signs the one-time proof of wallet control, so the Keeper proposes the repo's Binding. The App's `SETUP_PAGE_URL` |
| `repo.html?repo=owner/name` | Anyone | The repo's terms, its Deposits and how each ended, its Bounties, its decision log, and the forfeit router's balance, with a button anyone can press to send it on |
| `bounties.html?repo=owner/name[&issue=N[&payee=0x…]]` | Maintainer | The repo's Bounty wallet: create it, fund it, post and cancel Bounties, withdraw, set the limits and turn Keeper payouts off and on. With `issue`, pay that Bounty: directly, or by a signature the App's Keeper relays. The App's `BOUNTY_PAGE_URL` |

## Build

```shell
npm ci                        # at the repo root
npm run build                 # Arc testnet
npm run build -- mainnet      # Arc mainnet
```

The build writes `dist/`: the five pages and `dist/assets/`, which holds their scripts (viem bundled
in), the stylesheet, and the fonts and drawings the stylesheet names, each under a hashed name.
[`deploy/deploy.sh`](../deploy/README.md) builds it again before each deploy, for the network the
landing page's `config.js` names.

One build serves one network, set in [`networks.ts`](networks.ts): its chain id and RPC, the escrow,
the forfeit router, USDC and the explorer, from the SDK's
[deployments](../sdk/src/deployments.ts), and how the pages name where Forfeits go. The build stops
while the network's escrow or router address is missing. `bountyFactory` and `bountyFactoryFromBlock` name the Bounty wallet factory and its
deploy block. Empty, as on testnet, the build goes on: the Bounty page
says Bounties aren't available on the network yet, and the setup and repo pages leave them out.

## The Bounty page

`bounties.html` is the Maintainer's. Everything on it is read from the chain, never from the App.

- **The repo's Bounty wallet is the active Binding Maintainer's,** `factory.walletOf(repoId,
  maintainer)`. Anyone can create a wallet for any repo, so the page never looks one up by the
  connected wallet: another address sees "This isn't the Maintainer wallet", and its own wallet
  for the repo shows nowhere. Without an active Binding, the page sends the Maintainer to setup.
- **Create:** `factory.create(repoId, perPayoutLimit, periodLimit, periodLength)` from the
  Maintainer's wallet, suggested at 50 USDC a Bounty and 200 USDC every 7 days, each explained.
- **Manage:** fund with one EIP-3009 signature that the Maintainer's own wallet then sends
  (`fundWithAuthorization`), or approve and `fund`; post a Bounty on an issue and cancel an open
  one; withdraw unreserved USDC to the connected wallet; set the limits; turn Keeper payouts off
  and on, the emergency stop. Every transaction is simulated first, and each card says what came of
  it: refused and why, sent and waiting, reverted, or done, with its transaction.
- **Bounties** are rebuilt from the wallet's `BountyPosted`, `BountyCancelled` and `Paid` events
  since the factory's deploy block: open, paid (to whom, by Bona Fide, a signature or the
  Maintainer, with the transaction) or cancelled.
- **Paying one Bounty,** `&issue=N&payee=0x…`, as the App links a Maintainer to a Payout it left
  to them. The page shows the Bounty, the payee and why it waited (above the per-payout limit,
  above what's left this period, Keeper payouts off, or held within the limits). When the App
  knew no wallet, it leaves out `payee`, and the Maintainer pastes the Contributor's address,
  which must be lowercase or EIP-55 checksummed, and not zero, the Keeper or the wallet. Then:
  - **Pay now** (`ownerPay`), the simplest path: one transaction from the connected owner.
  - **Sign instead:** the EIP-712 `Payout(issueNumber, serial, payee, amount, deadline)` in the
    wallet's domain, valid for 1 hour, sent to `POST /bounty/payout` for the Keeper to relay and
    pay the fee. It suits a multisig owner or a wallet without USDC for the fee. If the App doesn't
    send it, the page offers to send the same signature from the connected wallet
    (`payWithSignature`), since anyone may.

## What the pages talk to

- **The App, on the same origin:** `POST /relay/deposit`, `/forfeit`, `/binding-proof` and
  `/bounty/payout` (`{"repo", "issue", "payee", "deadline", "signature"}`, `deadline` in unix
  seconds as a number). Their
  answers are documented in [../app/README.md](../app/README.md#endpoints) and
  [../agent/README.md](../agent/README.md#the-relay-api). The pages handle each one, 413, 429 with
  `Retry-After`, 502, 503 and 504 included. After a 504 the deposit page watches the transaction
  instead of asking for a new signature.
- **The App's decision log,** `GET /decisions?repo=owner/name` on the same origin, from the repo
  page: how many decisions Bona Fide made versus left to the Maintainer, and the latest 50, each with
  what was suggested and why, the facts checked, what was done and its transaction, and the model's
  cost. A Record Exemption also shows the record the model read: the Contributor's counts in public
  repos and their GitHub profile's numbers. A Bounty Payout or a Bounty held for the Maintainer
  links the merged PR, and says why it was held. Every string in it is shown as text. If the App doesn't answer, or answers out of shape, the
  page says it couldn't read the log rather than showing zeros.
- **The network's public RPC,** for every on-chain read: terms, Deposits, balances, and the repo
  page's history, which it reads in ranges of 10,000 blocks, the most Arc's RPC answers at once.
- **GitHub's API, from `setup.html` only,** to read the repo's `.github/bona-fide.yml` and show its
  terms before the Maintainer signs. If GitHub doesn't show the file, the Maintainer can still sign:
  the Keeper reads the file itself.

Nothing loads from a CDN or any other site, and the pages carry no trackers or analytics. They send
no `Referer`.

## Wallets

- **Browser wallets** are found through EIP-6963, or `window.ethereum` for a wallet that doesn't
  announce itself. A wallet on another network is asked to switch, and to add the network first if
  it doesn't know it. On a phone without a wallet in the browser, the picker suggests opening the
  page in the wallet app's browser.
- **Smart wallets must already be deployed** on the network to sign. The escrow and USDC check
  signatures with OpenZeppelin's `SignatureChecker`, which doesn't unwrap ERC-6492. The pages
  recognize an ERC-6492 signature and say so; on the deposit page, two transactions work instead,
  since the first one deploys the wallet.
- **WalletConnect** isn't bundled. Its SDK comes under the WalletConnect Community License, not an
  open-source license, and needs a project ID from Reown. `walletConnectProjectId` stays empty, which
  hides the option, and a build with it set stops.

## Signatures

| Page | Signs | Valid for |
|---|---|---|
| Deposit | USDC's EIP-3009 `ReceiveWithAuthorization`: the escrow may take exactly the Deposit, once, for this PR or issue | 10 minutes |
| Setup | `Binding(repo, maintainer, nonce, deadline)` in the escrow's EIP-712 domain | 30 minutes |
| Verdict | `Forfeit(key, serial, sigDeadline)` in the escrow's EIP-712 domain | 1 hour |
| Bounty, to fund | USDC's EIP-3009 `ReceiveWithAuthorization` with `to` = the Bounty wallet, sent at once from the same wallet | 10 minutes |
| Bounty, to pay | `Payout(issueNumber, serial, payee, amount, deadline)` in the domain `BonaFide Bounty`, version 1, of the wallet | 1 hour |

The typed data comes from the SDK's [`typed-data.ts`](../sdk/src/typed-data.ts), and the windows
from [`src/windows.ts`](src/windows.ts). Times are shown in the reader's
time zone, with UTC in a tooltip.

## The brand

The pages share the landing page's Certificate design, and have one theme, light.

- **Identity:** the mark and wordmark in each page's top bar come from [`brand/`](brand): `mark.svg`
  (the landing page's seal), `lockup.html` and `brand.css`, which also holds the palette and the three
  typefaces. Replacing those files replaces the identity everywhere. The tab's icon is
  `landing/brand/favicon.svg`.
- **Shared files:** the stylesheets name the landing page's fonts (`landing/fonts/`) and its guilloche
  drawings (`landing/brand/`) by their path in the repo, as `url("../landing/…")`. The build copies
  each into `dist/assets/`, with the fonts' licence as `assets/OFL.txt`, so the pages load nothing
  from the landing page's folders and work without it.
- **The certificate:** on the deposit page, the terms are the certificate being issued: the paper,
  frame, waves and seal are drawn behind the page's own text. Everywhere else, statuses are stamps and
  amounts are set in the display face.

## Tests

```shell
npm test
npm run typecheck
```

The tests need Foundry (`forge`, `anvil`), the contracts' submodules
(`git submodule update --init --recursive`), `npm ci` at the repo root, and Google Chrome. They cover:

- the typed data, signed with fresh keys and accepted by the real escrow on anvil and by the App's
  relay and Keeper, and the Bounty page's Payout and funding signatures and every call it sends,
  accepted by the real Bounty wallet and factory;
- every answer of the App's endpoints, the page's copy of `bona-fide.yml` parsing against the App's,
  the ABIs against the Foundry artifacts, and the repo page's history;
- each page in headless Chrome against anvil, with a mock wallet: a one-signature Deposit that the
  App's relay sends and that ends in a `Deposited` event, two transactions, a verdict, a Binding
  proof, a Refund and a flush, the relay's refusals, the repo page's decision log (full, with Record
  Exemptions, empty, and unreadable), the Bounty page's flows (create, fund, post, cancel,
  withdraw, limits, the Keeper switch, a Payout paid directly, relayed, sent after the relay
  failed, and with a pasted payee), the repo page's Bounties, and every page at 1280 and 390 px with no
  console errors, no sideways scroll, and no request to another site.

`CHROME` points the tests at another Chrome binary. With `SCREENSHOTS=<folder>`, the browser tests
save a picture of each state they check.
