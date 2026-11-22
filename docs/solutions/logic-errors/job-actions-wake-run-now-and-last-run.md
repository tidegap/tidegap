---
title: "Job actions that surprise the owner: --wake binds the editing session, jobs run spends the next slot, an edit's cancel shows as the last run"
date: 2026-11-22
category: logic-errors
module: packages/cli/src/commands/jobs.ts (wakeFlag, runJobsAction, lastLine), packages/core-ts/src/jobs.ts (runJobNow, runNowRefusal, sweepExtraRun, recordLastRun, jobLastRun), packages/cli/src/ui/jobs-api.ts (jobView)
problem_type: logic_error
component: tooling
symptoms:
  - "jobs edit --wake from another session moved the wake to that session"
  - "jobs run on a daily job with a window ran tomorrow's occurrence now, and the next run came a day later than expected"
  - "jobs show printed `last run: ok` with the id of an occurrence an edit cancelled; jobs history lists that row as cancelled"
root_cause: logic_error
resolution_type: code_fix
severity: medium
tags: [jobs, wake, run-now, extra-run, calendar-slot, last-run, jobs-show, edit, cancel]
---

# Job actions that surprise the owner

## Problem

Three job actions did something other than what the owner expected while using jobs during batch 41. The first works as designed, and only the explanation was missing. The second and the third were bugs, fixed on 2026-11-22: `jobs run` is now an extra run, and `last run` names only a run that ran.

## Symptoms

- `tidegap jobs edit <id> --wake failures`, run from a second Claude Code session, moved the wake to that session. The first session no longer woke.
- `tidegap jobs run <id>` on a daily job with a window, after that day's run, ran the next day's occurrence at once. The run after it came on the day after that.
- `tidegap jobs show <id>` printed `last run: ok … (<id>~7)` while `jobs history` listed `<id>~7` as `cancelled`. The edit had cancelled that occurrence.

## What Didn't Work

- Reading `--wake` as a property of the job. The wake belongs to the session that runs the command, on `add` and on `edit` alike.
- Keeping `jobs run` as "run the pending occurrence now". The owner reads it as "one extra run now", and the old behaviour spent the next slot: a daily 10:00 job skipped a day.
- Showing `last run:` from two fields that the sweep wrote under different conditions. The outcome came from the job row and the task id from another field, and the two disagreed.

## Solution

1. **`--wake` binds the session that runs the command.** `wakeFlag` in `packages/cli/src/commands/jobs.ts` takes the session from the CLI's own process (`currentSession`), on `add` and on `edit`. An edit from another session rebinds the job. The CLI says `updated <id>; wake moved from session <8 characters>… to this session`, and `--json` gives `wake_unbound_session`. An edit without `--wake` keeps the binding. The jobs docs page states this (`apps/web/content/docs/10-jobs.md`, wake section). Test: "edit --wake from a second session rebinds the job…" in `packages/cli/test/jobs-cli.test.ts`. This works as designed since #271, and batch 41 did not change it.
2. **`jobs run` adds an extra run and leaves the planned occurrence alone (fixed 2026-11-22).** Before the fix, `runJobNow` expedited the job's one pending occurrence. After today's run that occurrence belonged to tomorrow, so the early run used up tomorrow's slot (a calendar job) or moved the job's rhythm to the hour of `jobs run` (a run-anchored job). Now `runJobNow` in `packages/core-ts/src/jobs.ts` inserts `<job>~<seq>x`, due now, with the job's current template, and tracks it in `extraTaskId` (column `extra_task_id`). `pendingTaskId` and the planned row do not change. `sweepExtraRun` settles the extra run: it retries by the job's policy, it never moves `lastRunStartedAt` (the schedule anchor), the failure count or `runsLeft`, and `until` is not checked. Edge cases:
   - Refused while a run is `running` or `submitted` (`an occurrence is already running`), or while one is due or starts within 5 minutes (`RUN_NOW_SOON_MS`): `a run is already starting at HH:MM (<id>)`, in the job's zone (`runNowRefusal`). A pending extra retry that starts later is replaced and cancelled as `duplicate`.
   - An extra run does not count toward `--count`, and `--until` is not checked for it.
   - A pause, a remove, the job's end or an edit of the run fields cancels a pending extra run. A title, notify or schedule edit keeps it.
   - `jobs show` and `jobs history` mark it `run now`; the CLI reply names the planned run that keeps its time.
   - The page, Mac app, extension and Telegram call the same `runJobNow`. MCP has no job run action.

   Tests: `packages/core-ts/test/jobs.test.ts`, "run now: an extra run beside the planned occurrence" (nine cases, from "adds <job>~<n>x due now…" to "the later finish is the last run…"); `packages/cli/test/jobs-tick.test.ts`, "jobs run leaves the planned occurrence: the tick runs only the extra run…" and "an extra run does not count toward --count…"; `packages/cli/test/jobs-cli.test.ts`, "run now is refused (exit 1) while the planned run starts within 5 minutes, and while the extra run has not run yet". `pnpm qa cli` S20 checks the reply, the refusal, the planned `~2` and the `run now` mark.
3. **`last run` names the newest run that ran (fixed 2026-11-22).** Before the fix, the outcome block of `sweepJob` set `lastTaskId` for every tracked occurrence that ended, a cancel included, but set `lastOutcome` only for completed, failed or a skip. After `jobs edit` cancelled the pending occurrence, `jobs show` printed `last run: ok` with the cancelled row's id. Now `recordLastRun` writes `lastTaskId` and `lastOutcome` together, only for a completed or failed row, and only when it finished no earlier than the current last run (an extra run and a planned run can finish in one sweep). A cancel, by a job action or a skip, records no last run. The read side, `jobLastRun`, takes the outcome from the row's status (`runOutcome`), and for a job row an older version wrote that names a cancelled occurrence it falls back to the newest completed or failed run. `last_run.started_at` is that run's own `dispatched` event. `jobs history` still lists the cancelled row as `cancelled`. Tests: `packages/core-ts/test/jobs.test.ts`, "an edit's cancel and a skip never become the last run; a job row that names a cancelled one falls back to the newest run"; `packages/cli/test/jobs-tick.test.ts`, "last run after an edit's cancel names the run that ran, with its own times; history still lists the cancelled one".

## Why This Works

- Item 1: one job wakes one session, so the latest `--wake` wins. The rebind message makes the move visible.
- Item 2: the extra run has its own field and its own id shape (`x`), so the planned occurrence keeps its slot and its anchor. To run the planned occurrence early instead, use `tidegap queue run-now <run id>`; that one does use the slot (rule 4 of `floating-jobs-occurrence-sweep.md`).
- Item 3: one function writes the two fields that a reader joins, under one condition, and the reader checks the row it names.

## Prevention

- Item 1 has a test and a docs sentence. No change is needed.
- Items 2 and 3 have the tests named above. A new writer of `lastTaskId` goes through `recordLastRun`; a new reader of the last run goes through `jobLastRun`.

## Related

- `floating-jobs-occurrence-sweep.md` (the sweep, its rules 3 and 4, the terms)
- `run-now-clears-not-before-without-audit.md` (why run now has no `notBefore`)
- `../best-practices/wake-an-idle-session-from-a-stop-hook.md` (the wake marker)
