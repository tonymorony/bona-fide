# Bona Fide pages

The web pages Contributors and Maintainers use, built as plain static files. Terms such as Deposit,
Forfeit and Binding are defined in [../CONTEXT.md](../CONTEXT.md).

| Page | Who | What it does |
|---|---|---|
| `deposit.html?repo=owner/name&kind=pr\|issue&number=N` | Contributor | Shows the repo's terms, then takes the Deposit: one signature that the App relays, or two transactions (approve, then deposit) from the Contributor's wallet. After the Timeout, the Keeper refunds the Deposit, and anyone can send the Refund here too. The App's `DEPOSIT_PAGE_URL` |
| `verdict.html?repo=…&kind=…&number=N` | Maintainer | Signs the bad-faith verdict (a Forfeit) for one Deposit and sends it to the App's Keeper. The App's `SIGN_PAGE_URL` |
| `setup.html?repo=owner/name` | Maintainer | Signs the one-time proof of wallet control, so the Keeper proposes the repo's Binding. The App's `SETUP_PAGE_URL` |
| `repo.html?repo=owner/name` | Anyone | The repo's terms, its Deposits and how each ended, its decision log, and the forfeit router's balance, with a button anyone can press to send it on |

## Build

```shell
npm ci
npm run build                 # Arc testnet
npm run build -- mainnet      # Arc mainnet
```

The build writes `dist/`: the four pages and `dist/assets/`, which holds their scripts (viem bundled
in), the stylesheet and the mark. [`deploy/deploy.sh`](../deploy/README.md) publishes `web/dist` as
it finds it.

One build serves one network, set in [`networks.ts`](networks.ts): its chain id and RPC, the escrow,
the forfeit router, USDC, the explorer, and how the pages name where Forfeits go. The build stops
while the network's escrow or router address is missing, as mainnet's are until the contracts are
deployed there.

## What the pages talk to

- **The App, on the same origin:** `POST /relay/deposit`, `/forfeit` and `/binding-proof`. Their
  answers are documented in [../app/README.md](../app/README.md#endpoints) and
  [../agent/README.md](../agent/README.md#the-relay-api). The pages handle each one, 413, 429 with
  `Retry-After`, 502, 503 and 504 included. After a 504 the deposit page watches the transaction
  instead of asking for a new signature.
- **The App's decision log,** `GET /decisions?repo=owner/name` on the same origin, from the repo
  page: how many decisions Bona Fide made versus left to the Maintainer, and the latest 50, each with
  what was suggested and why, the facts checked, what was done and its transaction, and the model's
  cost. A Record Exemption also shows the record the model read: the Contributor's counts in public
  repos and their GitHub profile's numbers. Every string in it is shown as text. If the App doesn't answer, or answers out of shape, the
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

The typed data is built in [`src/typed-data.ts`](src/typed-data.ts). Times are shown in the reader's
time zone, with UTC in a tooltip.

## The brand

The mark and wordmark in each page's top bar come from [`brand/`](brand): `mark.svg` (also the
favicon), `lockup.html` and `brand.css`. Replacing those files replaces the identity everywhere.

## Tests

```shell
npm test
npm run typecheck
```

The tests need Foundry (`forge`, `anvil`), the contracts' submodules
(`git submodule update --init --recursive`), `npm ci` in `app/`, and Google Chrome. They cover:

- the typed data, signed with fresh keys and accepted by the real escrow on anvil and by the App's
  relay and Keeper;
- every answer of the App's endpoints, the page's copy of `bona-fide.yml` parsing against the App's,
  the ABIs against the Foundry artifacts, and the repo page's history;
- each page in headless Chrome against anvil, with a mock wallet: a one-signature Deposit that the
  App's relay sends and that ends in a `Deposited` event, two transactions, a verdict, a Binding
  proof, a Refund and a flush, the relay's refusals, the repo page's decision log (full, with Record
  Exemptions, empty, and unreadable), and every page at 1280 and 390 px with no
  console errors, no sideways scroll, and no request to another site.

`CHROME` points the tests at another Chrome binary. With `SCREENSHOTS=<folder>`, the browser tests
save a picture of each state they check.
