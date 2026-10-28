---
title: Task writes from several processes are compare-and-set, timing-guarded after an await, and series successors are insert-once
date: 2026-10-15
last_updated: 2026-10-28
category: logic-errors
module: packages/core-ts/src/storage/sqlite.ts, packages/core-ts/src/scheduler.ts
problem_type: logic_error
component: tooling
severity: high
applies_when:
  - "Adding a write to a task row from the UI server, the CLI or a ticker"
  - "Computing a new schedule after an await (forecast fetch) and then storing it"
  - "Creating a row whose id is derived, such as a series successor"
  - "Choosing an HTTP status for a refused action in the UI API"
  - "A process that is about to exit fails the rows it was running"
tags: [sqlite, compare-and-set, transitionIf, insertIfAbsent, race, ui-api, dispatcher, failHeldRuns, forced-stop, batch]
---

# Compare-and-set task transitions

## Context

The UI server, `ebb` commands and one or more tickers write the same SQLite ledger. Each holds an in-memory copy of a row. An upsert from a stale copy silently undoes another process's write (cancel, run now, stop series, a claim).

## Rules

- **Every cross-process write is `store.transitionIf(next, expectedStatuses, unchangedSince?)`**, reached through `Scheduler.writeIf`. The UPDATE has `WHERE task_id = ? AND status IN (...)`. It returns false and writes nothing on a miss. `writeIf` then reloads the cache from the ledger.
- **`upsert` no longer owns `repeat` or the identity columns** (title, origin_*, parent_task_id, series_id, origin_session_id). They are insert-only. A stale copy therefore cannot undo a "stop series" from another process. `read_at` is likewise never written by upsert.
- **A miss is not an error.** Cancel re-reads and retries once, then reports the refreshed row. `runNow` and `reschedule` turn a miss into a refusal. The sweep (`rescheduleIfPending`) skips the row.
- **After an async wait, also guard the timing columns.** `scheduleProviderCall` reads the stored row before `fetchForecast` and passes it as `unchangedSince`. The UPDATE then requires `scheduled_for`, `not_before`, `deadline` and `intensity_source` to equal that read (`IS`, so NULL matches NULL). Status alone is not enough: during the forecast await the UI can run the task now or pin it while the status stays `scheduled`, and the late write would overwrite the new time.
- **Derived ids use `insertIfAbsent`** (`INSERT ... ON CONFLICT DO NOTHING`, true only for the inserter). Series successor id is `<series_id>~<n+1>`, so two dispatchers finishing one occurrence create one successor. The successor is written before the parent's terminal write, so a crash between them leaves the series alive, never ended.
- **A stop and a rollover can cross.** Rollover reads `repeat` from the stored row (a stop wins), inserts, then re-reads. If `repeat` became `none` meanwhile it ends the successor. Stop writes `repeat = none` first and then cancels pending occurrences. One side always sees the other.
- **Start dispatcher is idempotent.** `DispatcherControl.start` refuses (409) while a UI-started child is alive (`ui_child`, pid in ledger meta `ui_dispatcher`) and while any other ticker ticked recently (`ticking`, from `last_tick_at`). It spawns `ebb tick --daemon` only when both are clear. The server never dispatches itself.

## HTTP status in the UI API

- `TaskActionError` and `InvalidDeadlineError` are refusals: **409** with the core's one-line rule. A lost race surfaces the same way, so a second click says what happened.
- Anything else is **500** with a fixed generic body (`action failed`, `could not start the dispatcher`). Exception text can hold paths or SQL. See `loopback-web-ui-hardening.md`.
- Do not map unknown errors to 409 to look friendly: it hides real faults as user mistakes.

## A forced stop fails only the rows its own tick holds (PR #178)

A second stop signal, at least 1 s after the first, ends `tidegap tick --daemon` at once. Before the exit, the daemon fails the rows its tick moved to `running`, through `Scheduler.failHeldRuns` (`packages/core-ts/src/scheduler.ts`).

- **Track the rows; do not query by status.** `holding()` records a row when its dispatch starts (provider call, Batch submit, Batch poll) and drops it when the dispatch settles. `failHeldRuns` writes each held row `failed` with `JOB_INTERRUPTED_ERROR` through `writeIf(..., ["running"])`, so a row that another writer finished first keeps its status. A second call fails nothing.
- **Why not every `running` row.** Other processes move rows of the same ledger to `running`: the MCP server's run now (`expediteTask`) and the OpenClaw loop. The tick lock keeps out only a second `tidegap tick`. A row stranded by an earlier crash has the same status. Status alone cannot tell a live run in another process from a dead one, so the forced exit touches only the rows it knows it owns.
- **Synchronous.** It runs in the signal listener just before `process.exit`, which does not wait for promises. The ledger store is synchronous, so the write lands before the exit.
- **Only job runs recover by themselves.** The source comment says the job sweep frees the rows this method leaves. That holds for job runs: the sweep fails a `running` occurrence after its caps of awake time (`floating-jobs-occurrence-sweep.md`, rule 5). For a plain task, nothing in the TypeScript core or CLI moves a row out of `running` outside the dispatch paths (checked at #178). A plain task stranded by a crash, or by a forced exit whose write failed, stays `running` until a person cancels it.
- **Open (#178 review): a Batch row can run twice.** `submitBatch` stores the batch id only after the provider accepts the submit. A forced exit during that call fails the row with no batch id, and `retryTask` (`retry_task`) dispatches it again while the provider still runs the first batch. A forced exit during a poll fails a row whose batch is still alive; `retryTask` clears the batch id and dispatches again. Both cases need a person to retry.
- **Not built (#178 review, cut in #185): a try/catch per row.** `failHeldRuns` has none, so a `writeIf` that throws (the ledger is busy past its 5 s `busy_timeout`) would leave every later held row `running`. There is no later row: the tick awaits one dispatch at a time, so `held` has at most one row, and a guard per row would protect no other row. The throw does not block the exit either: the tick's forced-stop hook releases the tick lock in a `finally`, and the daemon exits in its own `finally`. Revisit when a tick dispatches rows in parallel.

Tests: `packages/core-ts/test/scheduler.test.ts`, "Scheduler.failHeldRuns: a forced tick stop (KTD12)": a row in flight fails, a settled row and a row not reached keep their status, a row another writer moved first is left, and a crash-stranded row is left.

## Related

- `quota-reset-deadlines.md`: the first use of this idea (`updateIfPending`), now one case of `transitionIf`.
- `repeat-series-and-replies.md`
- `floating-jobs-occurrence-sweep.md`: the job sweep's own interrupted check (rule 5).
- `../tooling-decisions/running-claude-p-from-a-daemon.md` and `../best-practices/channels-url-policy-and-child-process-rules.md`: what a forced exit does to the `claude -p` and command groups.
