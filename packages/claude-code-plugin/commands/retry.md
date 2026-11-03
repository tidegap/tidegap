---
description: Re-dispatch a failed Tidegap task under the same id. Use it after a transient provider error; for a task that has not failed, /tidegap:expedite runs it now.
---

Re-dispatch a deferred Tidegap task that previously failed. Only valid
when the task's current status is `failed`. A new receipt overwrites
the old.

Common failure causes worth checking before retry:
- Provider returned a transient error (529 overloaded, 5xx) — retry
  almost certainly works.
- Carbon budget not met ("No window inside the deadline keeps the task
  under … gCO2e") — a retry runs the task now, at the current grid
  intensity, so the budget does not hold. `/tidegap:reschedule` does not
  take a failed task: to keep the budget, queue it again with
  `/tidegap:defer <task> --by <later deadline> --budget <grams>`.
- Auth error (401 / 403) — provider key is wrong or expired. Fix the
  key, then retry.

## Arguments

`$ARGUMENTS`

Expected: a single `task_id`. If empty, list tasks via
`check_queue_status` with no arguments (the tool has no status filter),
pick out the ones whose status is `failed` from the summary, then ask
which to retry.

## What to do

1. Call the `tidegap` MCP server's **`retry_task`** tool with `task_id`.
2. Show the resulting status. If status is again `failed`, surface the
   error string verbatim and propose a likely cause from the list above.

## Examples

```
/tidegap:retry 7f3a2b9e
```
