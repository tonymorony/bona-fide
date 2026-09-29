# Bona Fide

Refundable good-faith Deposits for open source: **https://bonafide.lysakov.com**

A Contributor nobody has vouched for, a person or an AI agent, puts down a small USDC Deposit to open a PR or an
issue. Good-faith work gets it back in full. Bad faith, signed by a Maintainer, forfeits at most half, which funds
open-source maintainers (Protocol Guild). Nobody else can receive any of it: not the Maintainers, and not whoever
runs Bona Fide. The spec is in [docs/spec.md](docs/spec.md), and the terms are in [CONTEXT.md](CONTEXT.md).

| Folder | What it is |
|---|---|
| [contracts/](contracts/README.md) | The escrow and the forfeit router on Arc |
| [app/](app/README.md) | The GitHub App: the check, the Keeper and the deposit relay |
| [agent/](agent/README.md) | The MCP server that lets an AI agent make a Deposit |
| [web/](web/) | The deposit, verdict, setup and repo pages; `npm run build` writes them and the landing page into `web/dist/` |
| [web/landing/](web/landing/) | The landing page at https://bonafide.lysakov.com |
| [deploy/](deploy/README.md) | Running the App and the pages on one server |

## The landing page

`web/landing/` is plain static files with no build step: `index.html`, `landing.css`, `landing.js` and `config.js`,
and the identity in `brand/`. Nothing loads from another site, and there are no trackers or cookies. The page reads
its live numbers from Arc in the visitor's browser: counts of Deposits, Refunds and Forfeits from the escrow's
events, and the forfeit router's USDC balance.

- **Settings:** [`config.js`](web/landing/config.js) names the network the numbers come from and whether the Install
  buttons link to the GitHub App. For mainnet, fill in its escrow, router and deploy block, then set `network:
  "mainnet"`. Any new RPC or explorer origin also goes in the `connect-src` of `index.html`'s Content-Security-Policy.
- **Identity:** the mark, lockups, hero illustration, favicon, touch icon and social card are files in
  `web/landing/brand/`, so a new identity is a file replacement. The palette is in CSS variables at the top of
  `landing.css`.
- **Tests:** `node --test 'web/test/landing/*-test.mjs'`. They need Node 24, Foundry (`forge`, `anvil`, `cast`), the
  contracts' submodules (`git submodule update --init --recursive`) and Google Chrome (`CHROME` points at another
  binary). With `SCREENSHOTS=<folder>`, the browser tests save a picture of each render.
  `node web/test/landing/frames.mjs` renders the page against the live network and saves pictures in
  `web/test/landing/frames/`.
- **Deploy:** `npm run build` in `web/` copies the landing page into `web/dist/` beside the other pages, and
  `deploy/deploy.sh <ssh host>` publishes `web/dist/` as the site (see [deploy/README.md](deploy/README.md)).

## Status

Bona Fide runs on Arc testnet at https://bonafide.lysakov.com. The escrow and the forfeit router are immutable: a
mainnet deployment is a new pair of contracts.

## License

MIT. See [LICENSE](LICENSE).
