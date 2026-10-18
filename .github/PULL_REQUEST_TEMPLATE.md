<!--
Title: Conventional Commits, <type>(<scope>): <description>, with type feat, fix, chore, docs,
refactor, test, ci, build or perf. Example: fix(app): refund a Deposit when the PR is merged.
Base: develop. A release (develop into main) is Anton's.
Every claim below is something you saw on the head commit. Write "none" or "n/a"; delete no
section. docs/agents/pr-body.md has a filled-in example.
-->

Closes #

## What and why

<!-- Two to five sentences: what a Contributor, a Maintainer or a caller gets now, and why it's
built this way. -->

## Proof

Head commit:

Red without the change: `<command>` on `<base commit>`

```
<last lines of the real output, with the failure>
```

Green with the change: the same command on the head commit

```
<last lines of the real output, with the counts>
```

<!-- No behaviour changed (docs, CI): write "No test:" and why, and delete the two blocks. -->

- Also run: <!-- forge test; npm test and npm run typecheck in each package touched; counts -->
- Trial merge: <!-- a batch only: the branch, the PRs in order, and the full test run on it; else n/a -->
- Screenshots: <!-- a changed page only: | State | Before | After |; else "no page changed" -->
- Not exercised: <!-- what didn't run, and why; or none -->

## Risk

- Touches `contracts/`, signatures, Refunds, Forfeits, Payouts, the Keeper, secrets, `deploy/` or
  a guard: <!-- no | yes: what, and the independent review -->
- New dependency, network host, environment variable or permission: <!-- none | each, and why -->
- Works against the contracts already on Arc: <!-- yes: how you know | n/a -->

## Decisions for Anton

<!-- A numbered list: the choice, the option built, one sentence of reason. Or none. -->

## Not in this PR

<!-- What a reader might expect that this doesn't do, and where it lives; each step left for Anton
as one exact command. Or none. -->
