---
title: Ledger migrations run in two cores and two processes, so they must be idempotent and one-time work must be race-safe
date: 2026-10-15
category: best-practices
module: packages/core-ts/src/storage/sqlite.ts
problem_type: best_practice
component: database
severity: high
applies_when:
  - "Adding a column or table to the SQLite task ledger"
  - "Backfilling data during a migration"
tags: [sqlite, migration, core-ts, core-py, read_at, meta]
---

# Ledger migrations: idempotent, race-safe, written twice

## Context

The ledger is one SQLite file opened by `TaskStore` (TS) and `_TaskStore` (`packages/core-py/src/tidegap/scheduler.py`). The tick, the MCP server, the CLI and the Python core can all open a v0.16 file at the same time. v0.17 added `title`, `origin_*`, `parent_task_id`, `read_at`, `deadline_kind`, `quota_provider` and a `meta` table.

## Rules

- **Add columns with a pragma check, then ALTER.** `addColumn` returns true only when THIS call added the column. Both cores do this.
- **Catch "duplicate column name" and treat it as "another process migrated first".** The pragma check and the ALTER are not atomic. Python checks `"duplicate column name" in str(err).lower()` and re-raises anything else.
- **One-time backfill runs only when `addColumn` returned true.** `read_at = COALESCE(completed_at, enqueued_at)` for `completed`/`failed` rows, so an upgrade does not flood the inbox. A store that lost the race skips it. If it ran the backfill anyway, it would re-mark tasks the user already marked unread.
- **Both cores carry the same backfill SQL.** Whichever process migrates first does it.
- **Never write `read_at` from `upsert`.** The tick holds an in-memory record without `readAt`. Writing it back would clear a mark set by another process. Only `markRead` / `markUnread` touch it. Identity columns are insert-only for the same reason.
- **Ledger-wide facts that are not tasks go in `meta`** (`last_tick_at` via `LAST_TICK_META_KEY`), not in a task row.
- **Python must read and preserve every new column**, even when it never writes them (`_VISIBILITY_COLUMNS`), and needs its own `mark_read`.

## Test pattern

Tests in `packages/core-ts/test/storage.test.ts`:
- Seed a v0.16 file with raw SQL, open it, assert columns, index and backfill, then mark unread, reopen and assert the backfill did not rerun.
- Open two stores on one file in sequence: both succeed.
- Race branch, deterministic: pass an injected `db` whose `exec` intercepts `ADD COLUMN read_at`. Inside the hook, a second `TaskStore` migrates and marks a task unread. The real ALTER then fails with "duplicate column". Assert the loser skipped the backfill. This is a simulated race, not a real multi-process run. Real processes cannot hit the window reliably.
- `core-py/tests/test_task_visibility.py` covers the Python side against a TS-written ledger.
