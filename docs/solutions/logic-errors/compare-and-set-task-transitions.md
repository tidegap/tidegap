---
title: Task writes from several processes are compare-and-set, timing-guarded after an await, and series successors are insert-once
date: 2026-10-15
last_updated: 2026-10-30
category: logic-errors
module: packages/core-ts/src/storage/sqlite.ts, packages/core-ts/src/scheduler.ts, packages/core-ts/src/jobs.ts, packages/core-py/src/tidegap/scheduler.py (transition_if, _write_if), packages/cli/src/channels/channel-setup.ts (recordTest)
problem_type: logic_error
component: tooling
severity: high
applies_when:
  - "Adding a write to a task row from the UI server, the CLI or a ticker"
  - "Storing a result computed after an await (a forecast fetch, a channel test send)"
  - "Creating a row whose id is derived, such as a series successor"
  - "Choosing an HTTP status for a refused action in the UI API"
  - "A process that is about to exit fails the rows it was running"
  - "A step calls a provider that bills, and the process can die before the answer is stored"
  - "Adding a Python scheduler action that reads a row and then writes it"
tags: [sqlite, compare-and-set, transitionIf, insertIfAbsent, race, ui-api, dispatcher, failHeldRuns, forced-stop, batch, check-then-write, external-id, double-billing, core-py, stale-cache]
---

# Compare-and-set task transitions

## Context

The UI server, `tidegap` commands and one or more tickers write the same SQLite ledger. Each holds an in-memory copy of a row. An upsert from a stale copy silently undoes another process's write (cancel, run now, stop series, a claim).

## Rules

- **Every cross-process write is `store.transitionIf(next, expectedStatuses, unchangedSince?)`**, reached through `Scheduler.writeIf`. The UPDATE has `WHERE task_id = ? AND status IN (...)`. It returns false and writes nothing on a miss. `writeIf` then reloads the cache from the ledger.
- **`upsert` no longer owns `repeat` or the identity columns** (title, origin_*, parent_task_id, series_id, origin_session_id). They are insert-only. A stale copy therefore cannot undo a "stop series" from another process. `read_at` is likewise never written by upsert.
- **A miss is not an error.** Cancel re-reads and retries once, then reports the refreshed row. `runNow` and `reschedule` turn a miss into a refusal. The sweep (`rescheduleIfPending`) skips the row.
- **After an async wait, also guard the timing columns.** `scheduleProviderCall` reads the stored row before `fetchForecast` and passes it as `unchangedSince`. The UPDATE then requires `scheduled_for`, `not_before`, `deadline` and `intensity_source` to equal that read (`IS`, so NULL matches NULL). Status alone is not enough: during the forecast await the UI can run the task now or pin it while the status stays `scheduled`, and the late write would overwrite the new time.
- **Derived ids use `insertIfAbsent`** (`INSERT ... ON CONFLICT DO NOTHING`, true only for the inserter). Series successor id is `<series_id>~<n+1>`, so two dispatchers finishing one occurrence create one successor. The successor is written before the parent's terminal write, so a crash between them leaves the series alive, never ended.
- **A stop and a rollover can cross.** Rollover reads `repeat` from the stored row (a stop wins), inserts, then re-reads. If `repeat` became `none` meanwhile it ends the successor. Stop writes `repeat = none` first and then cancels pending occurrences. One side always sees the other.
- **Start dispatcher is idempotent.** `DispatcherControl.start` refuses (409) while a UI-started child is alive (`ui_child`, pid in ledger meta `ui_dispatcher`) and while any other ticker ticked recently (`ticking`, from `last_tick_at`). It spawns `tidegap tick --daemon` only when both are clear. The server never dispatches itself.

## HTTP status in the UI API

- `TaskActionError` and `InvalidDeadlineError` are refusals: **409** with the core's one-line rule. A lost race surfaces the same way, so a second click says what happened.
- Anything else is **500** with a fixed generic body (`action failed`, `could not start the dispatcher`). Exception text can hold paths or SQL. See `loopback-web-ui-hardening.md`.
- Do not map unknown errors to 409 to look friendly: it hides real faults as user mistakes.

## A forced stop fails only the rows its own tick holds (PR #178)

A second stop signal, at least 1 s after the first, ends `tidegap tick --daemon` at once. Before the exit, the daemon fails the rows its tick moved to `running`, through `Scheduler.failHeldRuns` (`packages/core-ts/src/scheduler.ts`).

- **Track the rows; do not query by status.** `holding()` records a row and its phase when its dispatch starts (provider call, Batch submit, Batch poll) and drops it when the dispatch settles. `submitBatch` switches the phase to provider call before its routed sync fallback: that submit already failed, so no batch exists. Each write goes through `writeIf(..., ["running"])`, so a row that another writer finished first keeps its status. A second call changes nothing.
- **Why not every `running` row.** Other processes move rows of the same ledger to `running`: the MCP server's run now (`expediteTask`) and the OpenClaw loop. The tick lock keeps out only a second `tidegap tick`. A row stranded by an earlier crash has the same status. Status alone cannot tell a live run in another process from a dead one, so the forced exit touches only the rows it knows it owns.
- **Synchronous.** It runs in the signal listener just before `process.exit`, which does not wait for promises. The ledger store is synchronous, so the write lands before the exit.
- **Only job runs recover by themselves.** The source comment says the job sweep frees the rows this method leaves. That holds for job runs: the sweep fails a `running` occurrence after its caps of awake time (`floating-jobs-occurrence-sweep.md`, rule 5). For a plain task, nothing in the TypeScript core or CLI moves a row out of `running` outside the dispatch paths (checked at #178). A plain task stranded by a crash, or by a forced exit whose write failed, stays `running` until a person cancels it.
- **Settle a held row by its phase (batch 25).** A failed row is retried by `retryTask` (`retry_task`) and, for a job run, by the job sweep, so failing a row whose batch may be alive bills it twice. `failHeldRuns` now acts by phase. A provider call fails with `JOB_INTERRUPTED_ERROR`, as before. A Batch poll goes back to `submitted` with its batch id (no event: `running` to `submitted` implies none), and the next tick polls the live batch. A Batch submit may have been accepted before the stop, and the batch id is stored only after the provider answers, so the row fails with `BATCH_SUBMIT_INTERRUPTED_ERROR` (`packages/core-ts/src/jobs.ts`) and `phase: "batch_submit"` in the failed event. The error text is the marker: Node `retryTask` and Python `retry_task` refuse such a row before any other refusal, and the job sweep records the failure without a retry run. The shared fixture `packages/core-ts/test/fixtures/interrupted-batch-submit.json` holds the text for both cores. A tick with no stop handler (`tick --once` under a service manager, or SIGKILL) runs none of this; the job sweep's `interrupted()` returns a job's `running` row that has a batch id to `submitted`, after the same deadline-based limit, and fails other rows as before.
- **The external id is the evidence; record it in the write that records acceptance.** `submitBatch` writes `submitted` and the `batchId` in one `writeIf` right after the provider answers. So a row with a batch id has a live batch: poll it again, never fail it. A row stopped before that write may or may not have one, and nothing local can tell. That unknown case gets its own error, checked by every retry path before any other refusal, and the message tells the user to check the provider's batch list. The phase in `held` is not enough by itself: the job sweep runs in a later tick that never saw the phase, so it reads `batchId` on the row. For the next step that calls a billing provider: store the provider's id in the same write that records the acceptance, settle an interrupted row by that id, and give the unknown case a marker that no retry path accepts.
- **Open (batch 25).** A plain (non-job) Batch row that a killed tick left `running` with its batch id stays `running`: no sweep frees plain rows, so its paid result is never polled. And when the `submitted` write itself fails (it is caught and logged), the batch is live but the row is `running` with no batch id. For a job run, the job sweep later fails it with the retryable `JOB_INTERRUPTED_ERROR`, and its retry run can bill a second time; a plain row stays `running`.
- **Not built (#178 review, cut in #185): a try/catch per row.** `failHeldRuns` has none, so a `writeIf` that throws (the ledger is busy past its 5 s `busy_timeout`) would leave every later held row `running`. There is no later row: the tick awaits one dispatch at a time, so `held` has at most one row whatever its phase, and a guard per row would protect no other row. The throw does not block the exit either: the tick's forced-stop hook releases the tick lock in a `finally`, and the daemon exits in its own `finally`. Revisit when a tick dispatches rows in parallel.

Tests: `packages/core-ts/test/scheduler.test.ts`, "Scheduler.failHeldRuns: a forced tick stop (KTD12)": a row in flight fails, a settled row and a row not reached keep their status, a row another writer moved first is left, a crash-stranded row is left, a Batch poll goes back to `submitted`, a Batch submit fails with the Batch-submit error, and `retryTask` refuses it. `packages/core-ts/test/jobs-sweep.test.ts` covers the sweep side, and `test_retry_task_refuses_a_row_stopped_during_a_batch_submit` in `packages/core-py/tests/test_batch.py` the Python refusal.

## The Python core: every write to an existing row is compare-and-set (batch 27)

The Python scheduler caches rows in `_tasks`. Before batch 27 it wrote the ledger with `upsert`, which set `status` with no status condition; only the claims (`claim_scheduled`, `claim_submitted`) were compare-and-set. #195 made `_lookup_record` read a provider-call row from the ledger before an action checks its status (a cached `scheduled` copy of a row Node had failed was expedited and ran again). A fresh read shrank the window to "between one read and the next `upsert`" but did not close it: a Node claim in that gap was overwritten and `expedite_task` ran the row twice; the success path after a call kept only a `cancelled` row; the failure path wrote `failed` over a cancel; `_fail` checked the cached status.

Now the Python core mirrors the Node one (`packages/core-py/src/tidegap/scheduler.py`):

- **`_TaskStore.transition_if(record, expected, unchanged_since=None)`** is `transitionIf`: it updates the columns `upsert` updates with `WHERE task_id = ? AND status IN (...)`, and with `unchanged_since` (from `timing_of`, read before an await) also requires `scheduled_for`, `not_before`, `deadline` and `intensity_source` to be unchanged (`IS`). A hit writes the terminal event in the same transaction. Its `quota_provider` rule is the Node one: a moved occurrence of a `quota_reset` series keeps its label (the stored `repeat` decides, since Python never writes it). **`Scheduler._write_if`** is `writeIf`: on a miss it reloads the record from the ledger in place and returns false. A cancel whose write raises (a busy ledger) puts the cached copy back as it was, so a dispatch in this process does not take the row for cancelled and leave its awaiter waiting.
- **Status sets are the Node ones**, listed once in `packages/core-ts/test/fixtures/task-transition-guards.json`: `cancel_task` takes the status read (a miss reads again, tries once more, then returns the row); `expedite_task` and `update_deadline` take `queued` or `scheduled`; `retry_task` takes `failed`; a provider call's schedule write after a forecast takes the pending statuses with the timing guard, a closure's (`_schedule`) the pending statuses only, as the Node `schedule` (the closure lives in this process and no other writer plans its window; a timing miss would strand the row); a closure `_dispatch` takes the pending statuses; a sync call first writes `running` from `running` or `scheduled`, so a row cancelled after its claim, such as during the backoff of a failed routed Batch submit, is not sent; every result after a call, a Batch submit or a poll takes `running` and drops the result with a warning; the budget `_fail` in `_schedule_provider_call` takes the pending statuses, every other `_fail` the unfinished ones.
- **No scheduler write uses `upsert`.** `enqueue_provider_call` inserts with `insert_if_absent` and refuses an id that another process inserted after its duplicate check (Node `enqueueProviderCall` with `insertIfAbsent`, the same). `enqueue` starts its insert in the background (it is synchronous), so it uses `insert_if_absent` on a copy of the queued record. A background upsert of the live record object would write whatever status the schedule loop had set by then (`running`), and the loop's own compare-and-set would then miss. A closure write that finds no row inserts it (`insert_if_absent=True`): the row belongs to this process, and the background insert may not have landed.
- **A closure awaiter never waits forever on a miss, in both cores.** A closure write that misses rejects the awaiter and drops the body: Python `_schedule`, `_dispatch`, `_fail` and `update_deadline` (`TaskCancelledError` for a cancelled row), Node `schedule`, `dispatch` and `failTask` (`rejectMissedClosure`, "task <id> cancelled"). Before batch 27 the Node `schedule` and `failTask` returned on a miss and left `defer()` pending for good.
- **A missed Batch submit is reported, in both cores.** The row keeps its status (a cancel), the batch id is not stored, and the tick entry is `failed` with "batch <id> is not stored, and the provider may still run and bill it".

Tests: `packages/core-py/tests/test_task_transitions.py` runs every action on a row in every status, each race with a stale read (another process writes between the read and the write, through its own connection), each dispatch race of the fixture, and the Python-only writes (`_fail`, a closure cancelled before its window, a budget failure and a schedule write after a forecast, a closure re-plan after another process moved its deadline, an `update_deadline` on a closure another process cancelled, a cancel whose write raises, an enqueue that meets another process's row). `packages/core-ts/test/task-transition-guards.test.ts` drives the Node actions and dispatch races with the same fixture, checks the write sets against the core's `PENDING_STATUSES` and `UNFINISHED_STATUSES`, and covers the Node closure misses and the insert-once enqueue. For the next Python write: go through `_write_if` with the statuses of its Node twin, add the case to the fixture, and write the race test first so it fails on the unguarded write.

## A late result with no compare-and-set: check, then write, guarded by the start time (PR #188)

`ChannelSetup.test` (`packages/cli/src/channels/channel-setup.ts`) sends a test message, then records the result as the channel's last delivery. With retries, a send can run up to its 20 s job cap. Meanwhile a Connect, here or in `tidegap ui` in another process, can write a newer record, and a Remove can delete the row. Before #188 the late result wrote over the Connect's `ok` with an old error, and after a Remove it left a last-delivery record for a channel that no longer existed.

The last delivery is a JSON value in the ledger `meta` table (key `channel_last:<id>`), not a task row, so `transitionIf` does not apply. `recordTest` uses a start time instead:

- Read the start time before the send (`startedAt`).
- After the send, on the pass path and the failure path alike: skip when the row is gone; skip when the stored record's `at` is later than `startedAt`; else write. The same process has no await between the check and the write.
- Equal is not later, so a frozen clock (tests, fake time) still records.
- Only the record is skipped. The caller still gets the test's own outcome: a failed test throws its delivery error; a passing test returns the current status, or rejects `not_found` after a Remove.

Why this shape (plan KTD1, `docs/plans/2026-10-28-0424-refactor-channels-and-region-leftovers-plan.md`):

- The stored `at` is already shared state in the ledger, so the check covers a Connect or a Remove in another process with no new state. Rejected: a per-id generation counter in `ChannelSetup` (one process only, and it repeats what `at` records); Connect and Remove that wait for a test in flight (they would wait for a full send with retries).
- Only a write that leaves a record counts. A failed Connect, a disconnect and a settings change leave none, so a stale test still records after them: the values it sent are still the channel's values.
- The CLI and `tidegap ui` read one machine clock, so `at` values from the two processes compare.

Accepted residuals (#188 review):

- It is check-then-write, not compare-and-set. A record that another process writes between the two ledger statements is overwritten. The `recordTest` comment says so.
- Any later record counts as newer, including an event send or a second test. A passing test that overlaps a failed event send leaves the channel in backoff.

For the next late write to a value with no compare-and-set: read a start marker before the await; right before the write, check that the target still exists and holds nothing newer than the marker; keep the check and the write in one synchronous step; name the cross-process gap in a comment. Test method: `../developer-experience/deterministic-process-kill-tests.md`, section "Race tests around a slow send".

## Related

- `quota-reset-deadlines.md`: the first use of this idea (`updateIfPending`), now one case of `transitionIf`.
- `repeat-series-and-replies.md`
- `floating-jobs-occurrence-sweep.md`: the job sweep's own interrupted check (rule 5).
- `../tooling-decisions/running-claude-p-from-a-daemon.md` and `../best-practices/channels-url-policy-and-child-process-rules.md`: what a forced exit does to the `claude -p` and command groups.
