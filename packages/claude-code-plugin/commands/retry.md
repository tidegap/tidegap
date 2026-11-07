---
description: Run a failed Tidegap task again under the same id, a command or claude-code task included, as attempt 1 of a new count. For a task that has not failed, /tidegap:expedite runs it now.
---

Run a Tidegap task that failed again. Only valid when the task's current
status is `failed`. A failed run has already been tried again by its retry
policy (one retry after 30 minutes by default) unless its failure was
permanent; this command starts a new count. A new receipt overwrites the
old. The deadline does not block it.

Common failure causes worth checking before retry:
- Provider returned a transient error (529 overloaded, 5xx) and its
  retries are used up — retry almost certainly works.
- Carbon budget not met ("No window inside the deadline keeps the task
  under … gCO2e") — a retry runs the task now, at the current grid
  intensity, so the budget does not hold. `/tidegap:reschedule` does not
  take a failed task: to keep the budget, queue it again with
  `/tidegap:defer <task> --by <later deadline> --budget <grams>`.
- Auth error (401 / 403) — provider key is wrong or expired. Fix the
  key, then retry.
- A command or `claude-code` task: the retry makes it due now and the
  next `tidegap tick` runs it; a shell command then runs again.

## Arguments

`$ARGUMENTS`

Expected: a single `task_id`. If empty, list tasks via
`check_queue_status` with no arguments (the tool has no status filter),
pick out the ones whose status is `failed` from the summary, then ask
which to retry.

## What to do

1. Call the `tidegap` MCP server's **`retry_task`** tool with `task_id`.
2. Show the resulting status. `scheduled` means the next tick runs it. If
   the status is `failed` again, surface the error string verbatim and
   propose a likely cause from the list above.

## Examples

```
/tidegap:retry 7f3a2b9e
```
