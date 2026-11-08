---
description: Show Tidegap tasks — the list, or one task's status, result and carbon receipt. Use it when the user asks whether a task finished or what it returned; it changes no task's status, and marks a finished task read.
---

Check the status of one or all Tidegap deferred tasks.

## Arguments

`$ARGUMENTS`

- If `$ARGUMENTS` looks like a single task id (alphanumeric, dash, underscore
  only), check that one specific task.
- If `$ARGUMENTS` is empty, list every known task — the summary always
  includes queued, scheduled, running, completed, failed and cancelled
  tasks (there is no age cutoff), including tasks persisted by previous
  sessions.
- `--all` / `all` is accepted for compatibility and behaves the same as an
  empty argument.

## What to do

1. Call the `tidegap` MCP server's **`check_queue_status`** tool with:
   - `task_id` — the parsed id, omit for the list view.
2. Render the result as a compact table — never raw JSON. For each task:
   - `id` (last 8 chars suffice)
   - `title` — when the response carries one
   - `status` — `queued`, `scheduled`, `running`, `completed`, `failed`,
     `cancelled`
   - `scheduled_for` — relative time ("in 2h", "yesterday 14:30")
   - `region`
   - For `completed` tasks: append the **carbon receipt** (fields as they
     appear in the response, when present):
     - `estimated_carbon_g` (what the scheduler projected)
     - `actual_carbon_g` (what was billed against the actual grid intensity
       at dispatch time, if present)
     - `delta_pct` — `+X%` or `-X%` actual vs estimated
     - `grid_source` — which feed produced the intensity. If it is `mock`
       the response says so explicitly ("SYNTHETIC (mock) grid data") —
       repeat that caveat instead of presenting the grams as measured.
     - `energy_source` — confidence tier of the per-model energy
       coefficients (`measured` / `estimated` / `fallback`)
   - For `failed`: short error reason: the first line of the error, and its
     next step when the error has one (the line after a Files & Folders hint).
3. If exactly one task is requested, show its `title`, `origin`,
   `deadline_kind` (for a quota reset: the label, reset time and margin) and
   the `prompt:` line. If the response carries a `Result:` block (the LLM
   response), include it verbatim under the table. Viewing a completed or
   failed task marks it read; the user can undo that with
   `tidegap queue unread <task_id>`.
4. For the list view, relay the `last_tick_at` line: it shows when the
   dispatcher last ran ("never recorded" means nothing has dispatched yet).
5. End with a short hint line:
   - If anything is `queued` or `scheduled`: "Next dispatch tick: ~5 min
     (if the `tidegap tick` daemon is installed — otherwise run
     `tidegap tick --once`)."
   - If everything is `completed`: nothing.

## Examples

```
/tidegap:check
/tidegap:check abc123de
/tidegap:check --all
```
