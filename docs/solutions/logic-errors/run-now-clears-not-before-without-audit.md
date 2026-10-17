---
title: Run-now clears not_before and leaves no audit trail
date: 2026-10-17
category: logic-errors
module: packages/core-ts/src/scheduler.ts (runNow)
problem_type: logic_error
component: tooling
severity: low
applies_when:
  - "Changing runNow, expedite or reschedule"
  - "Debugging why a task ran before its requested earliest time"
tags: [scheduler, not-before, run-now, audit, ledger]
---

# Run-now clears `not_before`

`Scheduler.runNow` writes `status: "scheduled"`, `scheduledFor: now`, `intensitySource: "expedited"` and `notBefore: undefined` in one compare-and-set write (see `compare-and-set-task-transitions.md`).

## Effect

The user's earliest-start constraint is dropped. Afterwards the row cannot tell whether the task once had `not_before`, what it was, or that a person overrode it. Only `intensitySource: "expedited"` survives, and it also marks runs that never had a `not_before`.

This is deliberate: run-now means "now". The gap is the missing record. For the `claude-code` plan, a manual `run-now` also looks the same as a due run in the tick log.

## Follow-up

Keep the old value in a `task_events` table (task id, time, kind, before/after) written in the same transaction as the update. No such table or TODO file exists yet; this doc is the pointer. Until then, do not rely on `notBefore` after a run-now, and do not add code that reads it from a row in `expedited` state.
