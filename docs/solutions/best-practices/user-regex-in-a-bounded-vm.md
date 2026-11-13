---
title: "A user's regular expression compiles and runs only inside one bounded vm call"
date: 2026-11-13
category: best-practices
module: packages/core-ts/src/job-wake.ts (wakePatternError, matchWake, boundedTest)
problem_type: best_practice
component: tooling
severity: medium
applies_when:
  - "A user, an agent or a config file supplies a regular expression that the daemon or a server runs"
  - "CodeQL reports js/regex-injection or js/polynomial-redos on a pattern built from input"
tags: [regex, redos, vm, codeql, regex-injection, jobs, wake]
---

# A user's regular expression runs inside one bounded vm call

## Context

#271 added `jobs add --wake match=<pattern>`: the job sweep tests a JavaScript regular expression (flag `m`) against each completed run's result text and wakes the bound session on a match. The sweep runs in the tick daemon, so a pattern that backtracks without end would hold every task, not only this job.

The first version ran the match inside `vm` with a timeout, but checked the pattern on add with a plain `new RegExp(pattern, "m")` and a test on the empty string. CodeQL flagged `js/regex-injection` there: a compile or a test outside the sandbox has no time limit.

## Guidance

- **One function does the compile and the test, in one `runInContext` call with `timeout`.** `boundedTest` (`job-wake.ts`) puts `pattern` and `text` in a fresh context and runs `new RegExp(pattern, "m").test(text)` there. The add-time checks (`wakePatternError`: does it compile, does it match an empty output) and the sweep's match (`matchWake`) both call it. No other code compiles the pattern.
- **Cap both sides.** The pattern is at most 200 characters (`JOB_WAKE_PATTERN_MAX_CHARS`); the match reads the first 65,536 characters of the text (`JOB_WAKE_TEXT_MAX_CHARS`); the limit is 50 ms (`JOB_WAKE_MATCH_TIMEOUT_MS`).
- **Decide what a timeout means, and make it the safe side.** For a wake, a timeout and a stored pattern that no longer compiles count as a match: a broken rule wakes once rather than missing an alert. A filter that hides data would choose the other side.
- **Refuse what is useless at add time.** A pattern that matches the empty string would wake on every run, so it is refused, through the same bounded call.
- **An error thrown inside the context is not an `Error` of this realm.** `err instanceof Error` is false for a `SyntaxError` from the `vm` context. Read `err.code` (`ERR_SCRIPT_EXECUTION_TIMEOUT` for the timeout) and `err.message` as plain properties.

## Proof

`packages/core-ts/test/job-wake.test.ts`: a catastrophic pattern times out inside 500 ms and counts as matched; a pattern that does not compile, is over 200 characters or matches an empty output is refused; only the first 64 KiB is read.

## Related

- `telegram-channel-security.md` and `channels-url-policy-and-child-process-rules.md`: CodeQL `js/polynomial-redos` on our own patterns, fixed by not using a regex.
- `wake-an-idle-session-from-a-stop-hook.md`: what a wake does after the match.
