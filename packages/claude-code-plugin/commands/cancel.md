---
description: Cancel a queued or scheduled Tidegap task by id, or every pending task with --all. Use it when the work is no longer wanted; to run it later, use /tidegap:later. On a repeating task it skips one run; --series ends the series.
---

Cancel a queued or scheduled Tidegap task. Idempotent — calling on a task
that is already completed/failed/cancelled returns the existing status
without error.

## Arguments

`$ARGUMENTS`

Expected: a single `task_id` (the alphanumeric identifier `schedule_task`
returned), optionally followed by `--series`.

Cancelling one occurrence of a repeating task skips it; the next
occurrence is queued. `--series` (or "stop the series") also ends the
series.

If `$ARGUMENTS` is empty, ask the user which task they want to cancel
(suggest running `/tidegap:check` first to list candidates).

If `$ARGUMENTS` is `--all` or `all`, instead call the `cancel_all` MCP
tool to bulk-cancel every queued/scheduled task. Confirm the count with
the user before reporting success.

## What to do

1. Call the `tidegap` MCP server's **`cancel_task`** tool with:
   - `task_id` — the parsed id.
   - `series` — `true` when `--series` was given, otherwise omit.
2. Show the resulting status and (if present) `terminated_at`. One short
   line.

## Examples

```
/tidegap:cancel 7f3a2b9e
/tidegap:cancel 7f3a2b9e --series
/tidegap:cancel --all
```
