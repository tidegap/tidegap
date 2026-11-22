---
title: "Job actions that surprise the owner: --wake binds the editing session, jobs run spends the next slot, an edit's cancel shows as the last run"
date: 2026-11-22
category: logic-errors
module: packages/cli/src/commands/jobs.ts (wakeFlag, runJobsAction, lastLine), packages/core-ts/src/jobs.ts (runJobNow, sweepJob, firstOccurrence), packages/cli/src/ui/jobs-api.ts (jobView)
problem_type: logic_error
component: tooling
symptoms:
  - "jobs edit --wake from another session moved the wake to that session"
  - "jobs run on a daily job with a window ran tomorrow's occurrence now, and the next run came a day later than expected"
  - "jobs show printed `last run: ok` with the id of an occurrence an edit cancelled; jobs history lists that row as cancelled"
root_cause: logic_error
resolution_type: documentation_update
severity: medium
tags: [jobs, wake, run-now, calendar-slot, last-run, jobs-show, edit, cancel]
---

# Job actions that surprise the owner

## Problem

Three job actions did something other than what the owner expected while using jobs during batch 41. Two of them work as designed and only the explanation was missing. The third shows a mixed state.

## Symptoms

- `tidegap jobs edit <id> --wake failures`, run from a second Claude Code session, moved the wake to that session. The first session no longer woke.
- `tidegap jobs run <id>` on a daily job with a window, after that day's run, ran the next day's occurrence at once. The run after it came on the day after that.
- `tidegap jobs show <id>` printed `last run: ok … (<id>~7)` while `jobs history` listed `<id>~7` as `cancelled`. The edit had cancelled that occurrence.

## What Didn't Work

- Reading `--wake` as a property of the job. The wake belongs to the session that runs the command, on `add` and on `edit` alike.
- Reading `jobs run` as "one extra run now". The job has one pending occurrence, and run now moves that occurrence forward. It adds no second row.
- Reading `last run:` as one record. The line takes its outcome from the job row and its task id from another field, and the two can disagree.

## Solution

1. **`--wake` binds the session that runs the command.** `wakeFlag` in `packages/cli/src/commands/jobs.ts` takes the session from the CLI's own process (`currentSession`), on `add` and on `edit`. An edit from another session rebinds the job. The CLI says `updated <id>; wake moved from session <8 characters>… to this session`, and `--json` gives `wake_unbound_session`. An edit without `--wake` keeps the binding. The jobs docs page states this (`apps/web/content/docs/10-jobs.md`, wake section). Test: "edit --wake from a second session rebinds the job…" in `packages/cli/test/jobs-cli.test.ts`. This works as designed since #271, and batch 41 did not change it.
2. **`jobs run` runs the pending occurrence, and that can be the next slot.** `runJobNow` in `packages/core-ts/src/jobs.ts` expedites the job's one pending occurrence ("no second row"). After today's run, that occurrence belongs to tomorrow. For a calendar-anchored job (a window, weekdays or weekly), the early run uses up tomorrow's slot. Run now clears `notBefore`, so `firstOccurrence` marks the slot with the minute before its deadline, and the successor goes to the slot after it. An invented example: a job with `--window 06:00-08:00` ran today at 06:40. `jobs run` at 15:00 runs tomorrow's occurrence now, and the next run is the day after tomorrow. For a run-anchored job (daily with no window), the next run is due one period after this run's start, so the job's rhythm moves to the hour of `jobs run`. The CLI reply (`<id>: <task> marked to run now; the next tick runs it`) says neither.
3. **An occurrence that a job action cancels becomes the "last run" with the outcome of the run before.** In `sweepJob`, the outcome block sets `lastTaskId` (and `lastRunStartedAt`, taken from the row's `dispatched` event or else kept) for every tracked occurrence that ended. It sets `lastOutcome` only for completed, failed or a plain cancel. A cancel with a job-action reason (`ACTION_CANCEL_REASONS`: paused, edited, removed, duplicate, ended) leaves `lastOutcome` from the run before. `jobView` in `packages/cli/src/ui/jobs-api.ts` builds `last_run` from `job.lastOutcome` plus the row of `job.lastTaskId`. `jobs show` (`lastLine`) and the page's job card read that view. Rule 3 of `floating-jobs-occurrence-sweep.md` says nothing is recorded for these cancels. That holds for the outcome and the failure count, but not for `lastTaskId`.

## Why This Works

- Item 1: one job wakes one session, so the latest `--wake` wins. The rebind message makes the move visible.
- Item 2: the one-live-occurrence rule (`floating-jobs-occurrence-sweep.md`) and "a calendar slot is used once, run or not" (its rule 4) together give this placement. To get an extra run without moving the schedule, queue a one-off task. `jobs run` is for "run the next one now".
- Item 3 is a real mismatch: two fields that a reader joins are updated under different conditions.

## Prevention

- Item 1 has a test and a docs sentence. No change is needed.
- TODO (item 2, no test or fix): add a sweep test for a run now on a future slot of a calendar job (the successor is the slot after). Consider a CLI reply that names the next run after the early one.
- TODO (item 3, no test or fix): keep `lastTaskId` on the last occurrence that got an outcome, or skip that write for a job-action cancel. Add a test: a job runs once, is edited, and `jobs show` still names the completed run.

## Related

- `floating-jobs-occurrence-sweep.md` (the sweep, its rules 3 and 4, the terms)
- `run-now-clears-not-before-without-audit.md` (why run now has no `notBefore`)
- `../best-practices/wake-an-idle-session-from-a-stop-hook.md` (the wake marker)
