---
description: Change a queued Tidegap task's deadline, earlier or later, and re-score its window. Use it when the deadline moved; /tidegap:later only delays the start.
---

Re-score and reschedule a queued or scheduled Tidegap task against a new
deadline. Useful when:
- The user's plans shifted and the work can wait longer (extend) — gives
  the scheduler more window to find a clean hour.
- The user pulled in the deadline (compress) — the task is re-scored;
  if the new window costs more carbon than the budget, the task may
  end up `failed` with `CarbonBudgetExceededError`.

Throws if the task is already running or terminal, or if the new
deadline is invalid / in the past.

## Arguments

`$ARGUMENTS`

Expected format:

```
<task_id> --by <duration-or-iso8601>
```

- `<task_id>` — required.
- `--by <duration>` — accepts `2h`, `24h`, `3d`, or an ISO-8601 timestamp.

Convert duration to absolute ISO-8601 before calling. Validate future.

## What to do

1. Parse `task_id` and the new deadline.
2. Call the `tidegap` MCP server's **`update_deadline`** tool with:
   - `task_id`
   - `deadline` — the resolved ISO-8601 timestamp.
3. Show the new `scheduled_for`, `status`, and `new_deadline` from the
   response — one line each. (The response does not carry a carbon
   estimate; if the user wants the re-scored estimate, follow up with
   `/tidegap:check <task_id>`.)

If the response indicates carbon budget can no longer be met under the
new deadline, tell the user, and offer two options:
- Drop the `carbon_budget_g` constraint (requires `/tidegap:cancel` then
  fresh `/tidegap:defer` without budget).
- Pick a different deadline.

## Examples

```
/tidegap:reschedule 7f3a2b9e --by 48h
/tidegap:reschedule 7f3a2b9e --by 4h
```
