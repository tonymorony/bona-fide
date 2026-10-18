# Suppressions

A suppression is where the repo tells a scanner or a linter to stay quiet about something. Without a reason, a
reader can't tell a judgement from a finding someone buried; without a date, it outlives its reason. So every
suppression says **what it lets through and why that is safe here**, and **when someone looks at it again**.

[`scripts/lint-suppressions.ts`](../../scripts/lint-suppressions.ts) enforces this in the `workflows` step of
the `security` check, and runs on its own with `node scripts/lint-suppressions.ts`. A missing reason or date
fails; so does a date beyond the horizon. A date that has passed warns on every run but doesn't block: the
point is a second look, not a red check on someone else's unrelated pull request.

## Where suppressions go

| Tool | Where | Carries | Horizon |
|---|---|---|---|
| Slither | [`contracts/slither.db.json`](../../contracts/slither.db.json), one entry per finding | `id`, `check`, `description`, `reason`, `review_by` | 12 months |
| gitleaks | [`.gitleaks.toml`](../../.gitleaks.toml), an `[[allowlists]]` entry | `description`: what the match is, why it isn't a secret, and `review-by: YYYY-MM-DD` (gitleaks has no expiry field) | 12 months |
| OSV-Scanner | `osv-scanner.toml` beside the lockfile, an `[[IgnoredVulns]]` entry | `id`, `reason`, `ignoreUntil` | 90 days |
| OSV, for a submodule | `ignoreAdvisories` of the submodule in [`dependency-policy.json`](../../dependency-policy.json) | `reason`, `review_by` | 90 days |
| zizmor | `ignore:` in [`.github/zizmor.yml`](../../.github/zizmor.yml), or `# zizmor: ignore[rule]` in a workflow | a comment with the reason and `review-by: YYYY-MM-DD`, on the line or the line above | 12 months |
| Inline comments | `eslint-disable`, `@ts-ignore`, `@ts-expect-error`, `@ts-nocheck`, `prettier-ignore`, `biome-ignore`, `shellcheck disable=`, `slither-disable`, `solhint-disable`, `forge-lint: disable`, `forgefmt: disable`, `gitleaks:allow`, `nosemgrep`, `NOSONAR` | the reason and `review-by: YYYY-MM-DD`, in the one format below, on the line, the line above, or anywhere in a block comment that opens on the line | 12 months |

Not allowed, because they have nowhere to put a reason: `.gitleaksignore` fingerprint files, other ignore files
for scanners, and switching a whole Slither detector or severity off in `contracts/slither.config.json`.
Narrow the suppression to the one finding instead.

An OSV ignore hides a live advisory until a fix lands, so it expires within a quarter, and its reason names the
code path and why this repo doesn't reach it. The others usually record a stable fact (bytecode isn't a
number, a timestamp read can't move a Timeout measured in days), which needs re-reading, not renewing.

## The one format

Every inline suppression in the repo is written the same way: the tool's own directive, then ` -- `, the
reason, `; review-by: ` and the date.

```ts
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- viem's generic call type doesn't follow a union of calls; review-by: 2027-04-18
/* eslint-disable @typescript-eslint/no-unsafe-member-access --
   GitHub's webhook JSON is untyped here, and only the fields read are relied on; review-by: 2027-04-18 */
```

```shell
# shellcheck disable=SC2016 # the server's shell expands it, not this one; review-by: 2027-04-18
```

` -- ` is where ESLint itself reads a directive's description, so the reason travels with the rule names.
Tools without that syntax (shellcheck, zizmor, gitleaks) take the same text after their own comment marker.
The lint matches `review-by:` with the hyphen and the colon; "review by 2027-04-18" is not a date to it.

## A reason that holds

It names the thing and the argument: "`amount == 0` only stops an empty flush; anyone can raise the balance,
and that only lets flush() send it to the fixed recipient." Not: "false positive", "test data", "noisy rule",
"legacy", "for now". Those are conclusions with the reasoning left out, and the lint refuses the common ones.

## Add one

1. Try not to: fix the finding, narrow the path, or drop the dependency.
2. Write the entry in the tool's own file, with its reason and date. Never as a command-line flag in a
   workflow or script, where this lint can't see it.
3. Run `node scripts/lint-suppressions.ts`, then `npm run security`.
4. Say in the pull request that it adds a suppression, so it is reviewed as a decision.

## Today's suppressions (2026-10-19)

**Slither: 9 findings, all triaged, `review_by` 2027-10-18.** The contracts are deployed and immutable, so
none can be fixed on Arc; each was read against the code and the contracts' guarantees.

| Detector | Impact | Where | Why it can't cost anyone funds |
|---|---|---|---|
| `incorrect-equality` | Medium | `CharityRouter.flush()`: `amount == 0` | It only rejects an empty flush. Sending the router USDC can't block a flush or send USDC anywhere but the fixed recipient |
| `timestamp` | Low | `BonaFideEscrow.activateRepo`: `block.timestamp < effectiveAt` | The Binding delay is at least 1 hour; a block producer's seconds of drift can't skip it. The flagged `maintainer == address(0)` isn't a time comparison |
| `timestamp` | Low | `BonaFideEscrow.refund`: `block.timestamp < deadline` | The Timeout is 1 to 60 days, and a Refund pays only the Depositor |
| `timestamp` | Low | `BonaFideEscrow.forfeit`: the deadline and `sigDeadline` | A Forfeit still needs the Maintainer's signature for that serial and takes at most 50%; drift moves its cut-off by seconds |
| `timestamp` | Low | `BonaFideEscrow._record`: `maintainer == address(0)` | Not a time comparison; the timestamp only sets a deadline days away |
| `timestamp` | Low | `BountyWallet.keeperPay`: period rollover | Periods are at least 1 hour; the documented limits hold whatever the timestamp |
| `timestamp` | Low | `BountyWallet.payWithSignature`: `block.timestamp > deadline` | The owner's own expiry; the signature fixes issue, serial, payee and amount, and pays once |
| `timestamp` | Low | `BountyWallet.keeperAllowance()` | A view; it changes no state |
| `too-many-digits` | Informational | `BountyWalletFactory` constructor | The "literal" is `type(BountyWallet).creationCode`, hashed for CREATE2, not a typed number |

**zizmor's persona.** The default persona hides one audit-level finding, `secrets-outside-env`, for
`SCRUB_WORDS` in the `scrub` step: zizmor suggests holding secrets in a deployment environment. The scrub
words aren't a credential, and an environment would add a deployment record to every pull request; zizmor
reports it as "1 suppressed" and it needs no entry.

**Inline: 22 ESLint comments and one shellcheck comment, all `review-by` 2027-04-18.** ESLint's typed rules
came with its configuration, and each place where a rule is wrong about this code says why:

| Rule | Where | Why |
|---|---|---|
| `no-unsafe-*`, `no-explicit-any` | `app/src/webhook.ts` (2), `app/src/keeper/keeper.ts` (2), `app/src/bounties/bounties.ts` | GitHub's webhook JSON is untyped; only the fields read are relied on. Typing it (`@octokit/webhooks-types`) would remove these |
| `no-unnecessary-condition` | `app/src/github.ts` (3), `web/src/pages/deposit.ts` | GitHub sends null for deleted accounts and labels, and a fork's runs list no pull requests, though its types say otherwise; a click can change the page's phase while an allowance loads |
| `no-explicit-any`, `no-unsafe-argument`, `no-unnecessary-type-assertion` | `web/src/pages/bounties.ts`, `web/src/pages/deposit.ts` (2), `web/src/wallet.ts` (2) | viem's generic call types don't follow a union of calls, and EIP-1193 events each pass their own arguments |
| `no-base-to-string` | `web/src/wallet.ts`, `web/build.ts` | A wallet's error message can be anything; in the build, a hardening follow-up that no template reaches today |
| `no-misused-promises` | `app/src/node.ts`, `web/test/support/site.ts` | In the server, a hardening follow-up that is unreachable today; in the test server, a failure should fail the run |
| `return-await` | `web/src/pages/deposit.ts` | Returned without await on purpose, so an error painting a mined Deposit isn't shown as a failed send |
| `await-thenable` | `app/test/keeper-bindings.anvil.test.ts`, `app/test/node-keeper.anvil.test.ts` | The tests await values that are sometimes undefined, and check them |
| `vitest/no-conditional-expect` | `web/test/bona-fide-yml.test.ts` | Each case expects what the App's parser decided |
| shellcheck `SC2016` | `deploy/deploy.sh` | The server's shell expands the variable, not the local one |

**Nothing else.** No gitleaks allowlists (the whole history scans clean), no OSV ignores, no zizmor ignores and
no ignored submodule advisories.
