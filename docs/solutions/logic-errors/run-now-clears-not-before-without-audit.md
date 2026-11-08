---
title: Run-now clears not_before and leaves no audit trail
date: 2026-10-17
category: logic-errors
module: packages/core-ts/src/scheduler.ts (runNow)
problem_type: logic_error
component: tooling
severity: low
last_updated: 2026-11-08
applies_when:
  - "Changing runNow, expedite or reschedule"
  - "Debugging why a task ran before its requested earliest time"
  - "Adding a write that makes a task due now (a manual retry), or a reader that shows when a task runs next"
tags: [scheduler, not-before, run-now, audit, ledger, retry, batch-api]
---

# Run-now clears `not_before`

`Scheduler.runNow` writes `status: "scheduled"`, `scheduledFor: now`, `intensitySource: "expedited"` and `notBefore: undefined` in one compare-and-set write (see `compare-and-set-task-transitions.md`).

## Effect

The user's earliest-start constraint is dropped. Afterwards the row cannot tell whether the task once had `not_before`, what it was, or that a person overrode it. Only `intensitySource: "expedited"` survives, and it also marks runs that never had a `not_before`.

This is deliberate: run-now means "now". The gap is the missing record. For the `claude-code` plan, a manual `run-now` also looks the same as a due run in the tick log.

## Fix

Fixed by PR #86 (https://github.com/tidegap/tidegap/pull/86, "feat: task events (audit trail)"). `runNow` and `expediteTask` write an `expedited` row to `task_events` in the same transaction as the update, with `details.from.not_before` holding the cleared value and the actor (`page`, `client:<name>`, `cli`, `telegram`, …). Read the old value with `TaskStore.listTaskEvents(taskId)`, not from the task row: the row still has no `notBefore` after a run-now. Regression test: `packages/core-ts/test/task-events.test.ts` ("runNow records expedited with the old not_before").

## Update 2026-11-08 (PRs #236, #238, retries)

- **A manual retry is a run-now.** `retryWrite` (`scheduler.ts`) clears `notBefore` and sets `intensitySource: "expedited"`, as `runNow` does. Without the mark, a failed task whose deadline is more than 24 hours away is a Batch candidate (`isBatchCandidate` returns false only for `expedited`), so the next tick would send the retry to the provider Batch API and run it whenever the provider picks. Its audit row is a `rescheduled` event with `reason: "retry"`, which also starts a new attempt count; it writes no `expedited` event.
- **A reader of "the next attempt" ends the wait on Run now.** The task view's `next_attempt_at` (`attemptFields` in `packages/cli/src/ui/api.ts`) comes from the last `attempt_failed` event's `retry_at`. An `expedited` or `dispatched` event after it ends that wait, and the row's current `notBefore` is the floor, because Later and Reschedule move it. Before the #238 review fix the page showed the policy's time after a Run now.

## Related

`postpone-later-never-sooner.md`: "Later" never lowers `notBefore`; Run now is the only way to go sooner.
