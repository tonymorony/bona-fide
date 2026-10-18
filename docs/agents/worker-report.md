<!-- A worker's last message, sent once: 20 lines at most, facts only, in this order. -->

```
PR: <number or link>, <ready | draft>, base develop
HEAD: <commit> "<subject>", pushed: <yes | no: why>
SUITES: <each suite run, with its pass and fail counts>; CI: not read
TEST: <name>. Fails on <base commit>: "<failure line>". Passes on <head commit>: "<pass line>"
      (or "no test: <why no test can fail for this task>")
SCREENSHOTS: <each state, before and after; or "no page changed">
DECISIONS FOR ANTON: <the choice, the option built, one sentence of reason; or "none">
NOT DONE: <part of the task, and why; or "none">
DIDN'T RUN: <step, and why; or "none">
DENIED: <exact command, and what you did next; or "none">
LEFTOVERS:
- <what, where, and whether it predates this change; five lines at most>
- or: none, after looking at <what you looked at>
```

1. Paste output; don't paraphrase it.
2. A step that didn't run goes under DIDN'T RUN, never as "done" or "should pass".
3. Don't grade your own work, open issues, or ask for a merge.
4. If something blocked you, still send this, starting with `BLOCKED: <what>`.
