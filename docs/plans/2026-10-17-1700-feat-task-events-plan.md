---
title: Task Events Audit Trail - Plan
type: feat
date: 2026-10-17
artifact_contract: ce-unified-plan/v1
product_contract_source: ce-plan-bootstrap
execution: code
---

# Task Events Audit Trail - Plan

## Goal Capsule

- **Objective:** A Tidegap user, or an agent, can open one task and see who changed it and when: created, moved, run now, cancelled, dispatched, deferred, finished. An early run shows as "expedited by page, not_before was X", not as a planner move.
- **Means:** an append-only `task_events` table in the shared ledger, written in the same SQLite transaction as the task write, through the existing compare-and-set seams (KTD1, KTD2).
- **Authority:** R-IDs win on behavior, KTDs on mechanism. Binding constraints: `docs/solutions/logic-errors/compare-and-set-task-transitions.md`, `docs/solutions/best-practices/shared-sqlite-ledger-migrations.md`, `docs/solutions/logic-errors/run-now-clears-not-before-without-audit.md`, `docs/spec/ui-client-api.md`.
- **Execution profile:** branch `feat/task-events` on `origin/main` at `35d5d28`. TypeScript and Python. One PR. Another branch (`feat/origin-session`) edits `scheduler.ts`: keep hunks small and at the write seams.
- **Stop conditions:** stop and report if a same-transaction write cannot be done on both `node:sqlite` and `better-sqlite3` drivers, or if the event write changes the outcome of any existing compare-and-set test.
- **Who finishes:** the implementer opens the PR. Vitalii merges.

---

## Product Contract

### Summary

Add a per-task event log. Every task mutation in the TS core writes one row; the Python ticker writes rows for dispatch, completion, failure and cancellation. `tidegap queue show`, `GET /api/tasks/<id>`, the page drawer and the MCP single-task view show the log.

### Problem Frame

`Scheduler.runNow` clears `not_before` in one write and leaves no trace. Afterwards nobody can tell that a person overrode the earliest start, what it was, or who did it. The same gap exists for every other action: cancel, Later, reschedule and Telegram commands overwrite the row. Users and agents debug "why did this run at 14:00" with no record.

### Requirements

- R1. Table `task_events` (id, task_id, at, kind, actor, details) in the shared ledger, created with `CREATE TABLE IF NOT EXISTS` by both cores, indexed by `(task_id, at)`.
- R2. Kinds: `created|rescheduled|postponed|expedited|cancelled|dispatched|completed|failed|deferred|replied`.
- R3. Actors: `agent:<host>|page|client:<name>|cli|tick|telegram|openclaw|system`. Default `system`.
- R4. Details is a JSON object with snake_case keys: `from` / `to` timing (`scheduled_for`, `not_before`, `deadline`) for moves and run-now, plus `reason`, `preset`, `provider`, `model`, `error`, `retry_at`, `batch_id`, `child_task_id`, `series` where they apply.
- R5. The event row is written in the same transaction as the task change. A compare-and-set write that misses writes no event.
- R6. Every TS mutation path writes exactly one event: enqueue, enqueueProviderCall, series rollover successor, cancelTask (and series end), runNow, expediteTask, rescheduleTask, postponeTask, updateDeadline, rescheduleIfPending, retryTask, replyToTask (on the parent), closure and provider dispatch, batch submit, deferral (including the claude-code limit deferral), completion and failure.
- R7. The Python core writes `dispatched` on claim and `completed` / `failed` / `cancelled` on terminal writes, same schema. The TS store reads those rows.
- R8. `tidegap queue show <id>` prints a `Events:` list, oldest first (newest last); `--json` adds `events`.
- R9. `GET /api/tasks/<id>` returns `events[]`, the newest 50, oldest first.
- R10. The page's task drawer shows a text-only "Events" section.
- R11. MCP `check_queue_status` with `task_id` includes the last 5 events.
- R12. Retention: events live as long as their task row.
- R13. Docs: `docs/spec/ui-client-api.md` (`events[]`), README one line, CHANGELOG Unreleased, the run-now solution doc points at the fix.

### Scope Boundaries

- Planner moves (`replanSweep`, the first window pick after enqueue, quota sweep re-plans that are not caller-driven) are not user actions. `rescheduleIfPending` is the exception because R6 names it.
- No new UI controls, filters or event search.
- OpenClaw changes only the actor name it passes.
- The Python core does not record created / moves / cancels from its own API beyond R7.

---

## Planning Contract

### Key Technical Decisions

- KTD1. **Store owns the transaction.** `TaskStore` gets a private `tx(fn)` (`BEGIN IMMEDIATE` / `COMMIT` / `ROLLBACK`, re-entrant by depth) and `recordEvent`, `listTaskEvents(taskId, {limit})`. `transitionIf`, `upsert` and `insertIfAbsent` take an optional trailing `event`; with one, the task write and the INSERT run in one `tx`, and the INSERT runs only when the task write changed one row.
- KTD2. **Scheduler seam is `writeIf` / `persist`.** Both take an optional event spec `{kind, actor?, details?}`. When none is given, `writeIf` infers a terminal event when `next.status` is `completed|failed|cancelled` and the cached status differs. That covers the many failure branches with no edits. Details are built in one helper (`eventDetails(prev, next, kind, extra)`): timing `from`/`to` for move kinds and `expedited`, provider/model from `bodyJson` for `created|dispatched|completed|failed`, first line of `error` for `failed`.
- KTD2a. **Path-to-kind map (the R2 list is closed).** enqueue / enqueueProviderCall / rollover successor / reply child: `created`. rescheduleTask, updateDeadline (`reason: deadline`), rescheduleIfPending (`reason: quota_sweep`), retryTask (`reason: retry`): `rescheduled`. postponeTask: `postponed`. runNow, expediteTask: `expedited`. cancelTask, series end: `cancelled`. closure dispatch, provider dispatch, batch submit (`batch_id`): `dispatched`. deferTask: `deferred`. reply parent: `replied`. Completion / failure writes: `completed` / `failed`. expediteTask and retryTask then also dispatch, which is a second mutation and records `dispatched`. A claim (`claimScheduled`) carries no event: the TS `dispatched` row goes on the write just before the provider call (or the `submitted` write for batch, with `batch_id`), so a claim that is released records nothing.
- KTD3. **Actor is per scheduler with a per-call override.** `SchedulerOptions.actor` (default `system`). Mutation methods take an optional `{ actor }` (cancel already has an opts bag; others get a trailing optional param). Reasoning: the `tidegap ui` server shares one scheduler between the page token and client tokens. `DispatchOptions` is the provider-call options type and is not used for the actor (deviation from the brief; dispatch events use the scheduler's actor, `tick` in `tidegap tick`).
- KTD4. **Actor strings are validated** against R3 with a regex; `client:<name>` / `agent:<host>` names are cut to 64 chars and control characters dropped. An invalid actor becomes `system` rather than throwing, so an audit write never blocks a task action.
- KTD5. **Retention by trigger.** `AFTER DELETE ON tasks` trigger deletes the task's events. No prune exists today; any future prune in either core gets retention for free.
- KTD6. **Python parity by contextvar.** `_TaskStore.upsert` reads the stored status in the same locked section and inserts a terminal event when the status changes to a terminal one; `claim_scheduled` inserts `dispatched`. The actor comes from a module `ContextVar` that `Scheduler.tick` sets to `tick` with a token and resets in `finally` (default `system`). The upsert opens `BEGIN IMMEDIATE` before reading the stored status, so another process cannot write between the read and the update. Same DDL string in both cores; a Python test compares it with the TS source.
- KTD7. **Surfaces share one line formatter.** Core exports `formatTaskEvent(e)`: `<at> <kind> by <actor>[ — <summary>]`. CLI and MCP use it; the page renders its own text from the same fields.

### Assumptions

- Event `at` uses `new Date().toISOString()` in TS and the Python core's existing UTC ISO helper; ordering is `at, id`.
- `session mode` in details is left for `feat/origin-session` to add (the field does not exist on main).
- The CLI text section is named `Events:` because `History:` already labels the conversation turns in `renderTask`.

---

## Implementation Units

### U1. Ledger table, transaction, store API

- **Goal:** R1, R2, R3, R5, R12 at the store level.
- **Files:** `packages/core-ts/src/storage/sqlite.ts`, `packages/core-ts/src/types.ts` (event types), `packages/core-ts/src/index.ts` (exports), `packages/core-ts/test/task-events.test.ts`.
- **Approach:** KTD1, KTD4, KTD5. DDL appended to `SCHEMA`.
- **Test scenarios:** table and index exist after open; `transitionIf` with event on a miss writes no event; hit writes one; a throwing INSERT rolls back the task write; delete of a task row removes its events; `listTaskEvents` limit returns the newest N oldest-first; invalid actor stored as `system`.

### U2. Scheduler recording

- **Goal:** R4, R6.
- **Files:** `packages/core-ts/src/scheduler.ts`, `packages/core-ts/src/task-events.ts` (details helper, formatter, actor validation), `packages/core-ts/test/task-events.test.ts`.
- **Approach:** KTD2, KTD3. `rescheduleTask` and `postponeTask` share a private move with the event kind; `postponeTask` adds `preset`. `scheduleProviderCall(taskId, deadline, event?)` forwards to `persist`. `replyToTask` records `replied` on the parent and `created` (with `parent_task_id`) on the child.
- **Test scenarios:** one test per R6 path asserting exactly one new event, its kind, actor and key details; regression: `runNow` on a task with `notBefore` records `expedited` with `from.not_before` equal to the old value; a CAS miss in `runNow` records nothing; a claim followed by a release records nothing; per-call actor beats scheduler actor.

### U3. Python parity

- **Goal:** R7.
- **Files:** `packages/core-py/src/tidegap/scheduler.py`, `packages/core-py/tests/test_task_events.py`, `packages/core-ts/test/task-events.test.ts` (reads a Python-shaped row).
- **Approach:** KTD6.
- **Test scenarios:** Python tick dispatch→complete writes `dispatched` then `completed` with actor `tick`; failure writes `failed`; after `tick` returns, a cancel records actor `system`; DDL in both cores matches; TS `listTaskEvents` reads a row inserted with Python's exact INSERT statement.

### U4. Surfaces and actors

- **Goal:** R8 to R11 and actor wiring.
- **Files:** `packages/cli/src/commands/queue.ts`, `packages/cli/src/commands/tick.ts`, `packages/cli/src/ui/api.ts`, `packages/cli/src/ui/server.ts`, `packages/cli/ui/detail.js`, `packages/core-ts/src/channels/commands.ts`, `packages/mcp-server/src/server.ts`, `packages/openclaw-plugin/src/index.ts`, tests in `packages/cli/test/queue.test.ts`, `packages/cli/test/ui-actions.test.ts`, `packages/cli/test/ui-server.test.ts`, MCP server tests.
- **Approach:** `actionScheduler` actor from `QueueWriteOptions.actor` (default `cli`); `tick` scheduler `tick`; ui server passes `page` or `client:<name>` into `handleApi` and on to each action; Telegram commands pass `telegram`; MCP scheduler `agent:mcp`; OpenClaw scheduler `openclaw`.
- **Test scenarios:** queue show prints events newest last; API detail returns `events` capped at 50; a client-token run-now records `client:<name>`, page-token records `page`; MCP `check_queue_status` shows at most 5 events; page drawer renders an Events section (the existing page test pattern).

### U5. Docs

- **Goal:** R13.
- **Files:** `docs/spec/ui-client-api.md`, `README.md`, `CHANGELOG.md`, `docs/solutions/logic-errors/run-now-clears-not-before-without-audit.md`.

---

## Verification Contract

- `pnpm install --frozen-lockfile`, `pnpm build`, `pnpm preflight` (core-py venv inside the worktree), `node scripts/check-versions.mjs`.
- Tool-surface snapshot: update only if an MCP tool description changes (output text is not in the snapshot).
- Tests use temp DB paths or `:memory:`; nothing touches `~/.tidegap`.

## Definition of Done

- Every R-ID except R13 covered by a test (R13 checked by diff review); preflight green; no new npm dependency; no dead code from abandoned attempts; PR open against `main`, not merged.
