---
description: Defer a task to the cleanest grid-energy window inside a deadline. Invoke this command automatically whenever the user signals a task is not time-critical — phrases like "do this later", "by tomorrow", "tonight", "overnight", "by EOD", "sometime this week", "when you have a moment", "remind me to", "queue this up", "schedule this", "no rush", "not urgent". Don't run the task inline; route it through /tidegap:defer with the user's wording converted to an ISO-8601 deadline. The scheduler then picks the cleanest grid hour inside that deadline (lower carbon than running now), uses Anthropic/OpenAI Batch APIs for 50% cost reduction when possible, and writes an auditable per-task carbon receipt.
---

The user wants to defer the following task to a cleaner-grid window using the
`tidegap` MCP server. This is the central UX of the Tidegap Claude Code plugin —
take a "do it later" request and route it to a real scheduler.

## When to invoke automatically (without the user explicitly typing /tidegap:defer)

Any of these signals means the user has implicitly opted into deferral.
Convert their wording to an ISO-8601 deadline and call `schedule_task`:

| User phrase                  | Implied deadline                        |
| ---------------------------- | --------------------------------------- |
| "by tomorrow"                | tomorrow, end of working day (18:00)    |
| "tonight" / "overnight"      | tomorrow, 06:00 local                   |
| "by EOD"                     | today, 18:00 local                      |
| "this week"                  | Friday, 18:00 local                     |
| "next week"                  | next Friday, 18:00 local                |
| "when you have a moment"     | +24 h                                   |
| "remind me to X"             | +24 h, unless a time is named           |
| "no rush" / "not urgent"     | +48 h                                   |
| "schedule this for X"        | parse X explicitly                      |
| "queue this up"              | +12 h                                   |
| "before my weekly limit resets" / "before the quota resets" | `deadline_kind: "quota_reset"` (no `deadline`) |

If the user does NOT signal "later" (e.g. "summarize this", "write a
function", "what does X do"), do not auto-defer. Run inline.

If the user explicitly typed `/tidegap:defer ...`, follow the explicit
args. The auto-invocation above is for the unprompted case only.

## Arguments

`$ARGUMENTS`

Parse `$ARGUMENTS` into:

- **Prompt** — everything before the first `--` flag, or the whole argument
  string if no flags are present. Required. If empty, ask the user what task
  they want to defer.
- **`--by <duration>`** — deadline. Accepts `2h`, `30m`, `24h`, `3d`, or an
  ISO-8601 timestamp. **Default: 24h from now.** Must resolve to the future.
  `--by quota-reset` (or `--by quota-reset:<label>`, e.g. `quota-reset:claude`)
  means "before the next weekly subscription-quota reset": pass
  `deadline_kind: "quota_reset"` (and `quota_provider: "<label>"` when a label
  is named) and no `deadline`. The server resolves the deadline from
  `TIDEGAP_QUOTA_RESET_<LABEL>` in `~/.tidegap/config`; if it answers that no
  quota reset is configured, relay its message.
- **`--title <text>`** — optional short title. Default: the first line of
  the prompt.
- **`--budget <grams>`** — optional hard cap on grams CO2-equivalent. If the
  scheduler can't find a window that meets it, the task fails fast with a
  `CarbonBudgetExceededError`.
- **`--region <zone>`** — optional Electricity Maps zone code (e.g.
  `US-CAL-CISO`, `GB`, `FR`). **Default: omit the field** — the server
  resolves its own default (`TIDEGAP_DEFAULT_REGION` if configured, then the
  stored setting from `tidegap region set`, then a guess from the host
  machine's timezone, falling back to `GB`). The `region` and
  `region_source` lines in the tool response tell you what it picked and
  why; relay that to the user.
- **`--model <name>`** — optional vendor model id (e.g.
  `claude-sonnet-5`). Without it the server uses the chosen provider's
  default: `claude-sonnet-5` for `anthropic` (overridable with
  `TIDEGAP_DEFAULT_MODEL`), `gpt-6-sol` for `openai`. The `model` line in the
  tool response shows what it picked.
- **`--output <abs-path>`** — optional absolute file path. When the
  task completes, Tidegap writes `{ taskId, result, receipt }` as JSON
  to this path. Useful if the user wants the result to land in an
  inbox folder (so `tail -f` or a file-watcher surfaces it) rather
  than polling `/tidegap:check` by hand. Recommend
  `~/.tidegap/inbox/<task_id>.json` when the user is unsure where to
  put it.
- **`--provider <anthropic|openai>`** — optional. Default `anthropic`.
- **`--repeat <none|daily|weekly>`** — optional. Default `none`: the task
  runs once, also with `--by quota-reset`. `daily` / `weekly` queue the next
  occurrence each time one finishes (each occurrence is one provider call).
  `--by quota-reset --repeat weekly` repeats before every weekly reset
  (pass `repeat: "quota_reset"` for that case so it follows the reset
  exactly). Stop a series with `/tidegap:cancel <task_id>` and say "stop the
  series" (`cancel_task` with `series: true`).

## What to do

1. Convert `--by` to an absolute ISO-8601 deadline (`now + duration` if a
   duration, otherwise the parsed timestamp). Validate it is in the future.
   For `--by quota-reset[:<label>]` skip this step.
2. Call the `tidegap` MCP server's **`schedule_task`** tool with:
   - `prompt` — the parsed user prompt
   - `deadline` — the ISO-8601 deadline you computed (omit for quota reset)
   - `deadline_kind` — `"quota_reset"` for `--by quota-reset`, otherwise omit
   - `quota_provider` — the label from `--by quota-reset:<label>`, otherwise omit
   - `title` — the parsed `--title`, omit if not given
   - `region` — the parsed zone, omit if the user gave none (the server
     resolves its default)
   - `carbon_budget_g` — the parsed budget, omit if not given
   - `model` — the parsed model hint, omit if not given
   - `output_path` — the parsed `--output` value, omit if not given
   - `provider` — the parsed `--provider` value, omit if not given
   - `repeat` — the parsed `--repeat` value (`"quota_reset"` when combined
     with `--by quota-reset` and `weekly`), omit if not given or `none`
   - `origin_session_id` — exactly `"${CLAUDE_SESSION_ID}"`. Claude Code
     substitutes this session's id, so the task can later be resumed with
     `claude --resume`. The server drops a value that is not a session id.
   - **Do not pass `dispatch`.** As of v0.7.1 the MCP server defaults
     to persistent provider_call mode, which is what the user wants
     99% of the time.
3. After the tool returns, report back in this exact shape. Every field
   below is present verbatim in the tool response — do not invent numbers
   the response does not carry (e.g. savings % or band; those come from
   `recommend_window` / `/tidegap:plan`, not from `schedule_task`):

   ```
   Deferred ✓
     task id        <task_id>
     title          <title>
     scheduled for  <scheduled_for as relative + absolute, e.g. "in 3h, 22:15 UTC">
     deadline       <deadline> (plus the deadline_kind line for a quota reset)
     est. carbon    <estimated_carbon_g_co2> g CO2e
     region         <region>
     grid source    <grid_source>
     persisted to   <persisted_to>
     repeat         <repeat line, only when the response has one>
     resume         <resume line, only when the response has one>
     check status   /tidegap:check <task_id>
     cancel         /tidegap:cancel <task_id>
   ```

   If the response contains the "SYNTHETIC (mock) grid data" warning
   (`grid_source: mock`), repeat it prominently — the carbon numbers are
   illustrative, not measured. If the tool response mentions `tidegap tick`/
   daemon, surface that warning verbatim to the user — they need to know
   whether the task will actually dispatch or just sit in the queue.

4. If `schedule_task` raises `CarbonBudgetExceededError`, do NOT silently fall
   back. Tell the user the budget could not be met, show the cheapest feasible
   window inside the deadline, and ask if they want to relax `--budget` or
   extend `--by`.

5. Do **not** dispatch the task synchronously. The whole point of `/tidegap:defer`
   is to hand off to the Tidegap scheduler. If the user wanted a sync call, they
   would have just made one.

## Examples

```
/tidegap:defer summarize today's GitHub notifications --by 4h
/tidegap:defer translate the README to Russian --by 24h --budget 0.5 --region GB
/tidegap:defer regenerate the test fixtures --by 2026-05-15T08:00:00Z --model claude-haiku-4-5
/tidegap:defer overnight log triage --by 8h --region US-MIDA-PJM --output ~/.tidegap/inbox/log-triage.json
/tidegap:defer refactor the test helpers --by quota-reset:claude
/tidegap:defer check my weekly limit list --by quota-reset --repeat weekly
```

Only this command carries the session id. A model that calls the
`schedule_task` MCP tool directly, without the command, does not know the
session id, so that task has no resume line.

## Related commands

- `/tidegap:check [<task_id>]` — list / get status of deferred tasks
- `/tidegap:plan <task> --by <when>` — preview window without committing
- `/tidegap:cancel <task_id>` — drop a queued/scheduled task
- `/tidegap:expedite <task_id>` — run now, bypass the carbon window
- `/tidegap:reschedule <task_id> --by <new>` — change the deadline
- `/tidegap:retry <task_id>` — re-dispatch a failed task
- `/tidegap:grid <zone>` — look at the grid, no task involved
