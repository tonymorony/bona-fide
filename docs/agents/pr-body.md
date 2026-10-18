# The PR body

Every PR uses [.github/PULL_REQUEST_TEMPLATE.md](../../.github/PULL_REQUEST_TEMPLATE.md). GitHub
fills it in for `gh pr create` in a terminal; with `--body` or `gh api`, paste it in yourself.

How to fill it in:

- **Title:** Conventional Commits, `<type>(<scope>): <description>`, in the imperative, under 72
  characters. The scope is the folder or part: `app`, `sdk`, `web`, `agent`, `contracts`, `deploy`,
  `docs`, `ci`.
- **Closing line:** `Closes #<n>` for each issue. GitHub closes issues only on a merge into the
  default branch (`main`), so after a merge into `develop` the orchestrator closes each one with a
  comment that names the PR.
- **Proof:** the real output, pasted, not described (P-1, S-2). Red on the base commit, green on the
  head, both from the same command. Run the red side in a second worktree at the base commit.
- **Trial merge:** for a batch (P-3), one throwaway branch from `develop` with each PR merged in a
  stated order, and every suite run on it.
- **Screenshots:** for a changed page (P-2), a before and after of each state that moves, from
  `SCREENSHOTS=<folder> npm test` in `web/`. Attach them to the PR; commit none to the branch.
- **Risk:** if the first line is "yes", the PR waits for an independent review (B-6).
- **Decisions for Anton:** numbered, so he can answer "1 ok, 2 b" (O-1).

## A made-up example

~~~markdown
Closes #123

## What and why

The verdict page showed "Refunded" as soon as the Keeper sent the Refund, before the transaction
was mined. It now shows "Refund sent" with the transaction link until the receipt arrives, so a
Contributor never sees a Refund that later fails.

## Proof

Head commit: `4f2c9a1`

Red without the change: `npx vitest run test/verdict.test.ts` on `9b1e0d7`

```
 FAIL  test/verdict.test.ts > shows "Refund sent" until the receipt arrives
AssertionError: expected 'Refunded' to be 'Refund sent'
 Tests  1 failed | 11 passed (12)
```

Green with the change: the same command on the head commit

```
 Tests  12 passed (12)
```

- Also run: `npm test` in `web/` (84 passed), `npm run typecheck` in `web/` (no errors).
- Trial merge: n/a
- Screenshots:

| State | Before | After |
|---|---|---|
| Refund sent, not mined | (image) | (image) |

- Not exercised: the page on a real Arc transaction; anvil only.

## Risk

- Touches `contracts/`, signatures, Refunds, Forfeits, Payouts, the Keeper, secrets, `deploy/` or a guard: no; display only.
- New dependency, network host, environment variable or permission: none
- Works against the contracts already on Arc: n/a, no contract call changed

## Decisions for Anton

1. "Refund sent" rather than "Refund pending": it says what happened. Built.

## Not in this PR

- The same wording in the GitHub check: #124.
~~~
