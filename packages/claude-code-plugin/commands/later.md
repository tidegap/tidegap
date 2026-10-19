---
description: Postpone a queued Tidegap task to a later window
---

Run a queued or scheduled Tidegap task later. The task never moves earlier.

## Arguments

`$ARGUMENTS`

Expected: a `task_id`, then one of:

- a preset: `1h`, `tonight`, `tomorrow_morning` or `after_limit_reset`
- an exact later time (ISO-8601, or wording like "at 15:00" converted to ISO-8601)
- a delay in minutes (1 to 10080)

If the task id or the target is missing, ask the user. Suggest
`/tidegap:check` to list candidates.

## What to do

1. Call the `tidegap` MCP server's **`postpone_task`** tool with `task_id`
   and exactly one of:
   - `preset` — `1h`, `tonight`, `tomorrow_morning` or `after_limit_reset`
   - `until` — the exact ISO-8601 time
   - `delay_minutes` — the number of minutes
2. For `after_limit_reset`, pass `reset_at` (ISO-8601) only when the user
   gave the reset time.
3. Show the new earliest start and the planned run time. One short line.
   If the tool refuses (target not later than the planned start, or "needs
   the reset time"), repeat the reason.

## Examples

```
/tidegap:later 7f3a2b9e tonight
/tidegap:later 7f3a2b9e tomorrow_morning
/tidegap:later 7f3a2b9e after_limit_reset
/tidegap:later 7f3a2b9e 90
```
