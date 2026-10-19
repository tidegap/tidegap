---
name: tidegap
description: Auto-defer "do it later" / "by tomorrow" / "tonight" / "overnight" / "by EOD" / "when you have a moment" / "remind me to" / "queue this up" / "no rush" / "not urgent" tasks. Route through /tidegap:defer (slash command) or schedule_task (MCP tool) so the LLM dispatch fires at the cleanest electricity-grid hour inside the deadline — lower carbon, Anthropic/OpenAI Batch APIs (50% of sync list price, projected) when the deadline allows. Skip deferral when the user is actively waiting (interactive coding, live chat, debugging).
---

# Carbon-aware coding with Tidegap

When the user has a task that can wait, route it through Tidegap instead of
dispatching synchronously. Grid carbon intensity swings substantially over a
single day as the generation mix shifts, so a few hours of delay can move a
deferrable LLM call into a cleaner hour. The saving depends on region and day:
in one GB run on 2026-09-30 the forecast peak was 183 gCO2/kWh and the
recommended window 88 gCO2/kWh (about 52 % lower, for that run only; forecast,
projected — see https://github.com/tidegap/tidegap/blob/main/docs/claims.md).
For tasks deferred more than 24 hours, Tidegap can route through the provider
Batch APIs (50% of sync list price, projected) when the deadline allows.

## When to defer

Defer when **all** of these are true:

1. The user explicitly accepts latency: "later", "tomorrow", "by Friday",
   "when you get a chance", "no rush", "before EOD".
2. The task is **bounded** — one well-defined deliverable, not an iterative
   conversation where the user is waiting on the next reply to decide their
   next move.
3. The deadline gives the scheduler **room to shop**: at least 2 hours of
   forecast horizon. (Below 2h, intraday variation is too narrow to matter.)

## When to NOT defer

- The user is going to act on the result before continuing the conversation.
- The task involves real-time data the answer depends on (live search,
  rate-sensitive comparisons).
- The deadline has passed, or it is < 30 minutes away.
- The user is debugging — they want fast iteration, not a queue.

## How to defer

Use the **`/tidegap:defer`** slash command — that is its sole purpose. Pass:

- The full task prompt (verbatim or summarised — the user's intent).
- `--by <duration>` matching what the user said. If they said "tomorrow",
  use `--by 24h`. If they said "by Friday at 9", convert to ISO-8601.
- `--region` only when the user named one. Otherwise let the default fire.
- `--budget` only when the user gave a numeric carbon ceiling.
- `--output <path>` only when the user wants the result written to a
  file (so `tail -f` or a file-watcher surfaces it).
- `--repeat daily|weekly` only when the user asks for a repeating task
  ("every week", "each reset"). Default `none`: a one-off, also for
  `--by quota-reset`.

The command passes this session's id (`origin_session_id`), so `tidegap ui`
and `tidegap queue show` print `cd <cwd> && claude --resume <id>` for the task.

The command will return immediately with a `task_id`, the scheduled time, and
the projected carbon. You do **not** need to dispatch the task yourself.

As of v0.7.1 the MCP server persists tasks to `~/.tidegap/queue.db` by
default — queued tasks survive Claude Code restarts and are shared
across MCP hosts.

## The full command surface

| Command | Purpose |
|---|---|
| `/tidegap:defer <task> --by <when>` | Queue a deferrable LLM task |
| `/tidegap:plan <task> --by <when>` | Preview the chosen window, no commit |
| `/tidegap:check [<id>\|--all]` | List or detail of queued tasks |
| `/tidegap:cancel <id> \| --all` | Remove a task (or all queued/scheduled) |
| `/tidegap:expedite <id>` | Run now, bypass the carbon window |
| `/tidegap:reschedule <id> --by <new>` | Change the deadline, re-score |
| `/tidegap:retry <id>` | Re-dispatch a failed task |
| `/tidegap:grid <zone>` | Just look at the grid, no task involved |
| `/tidegap:later <id> <preset\|time>` | Run a queued task later (postpone) |
| `/tidegap:usage [--spend]` | Show Claude Code limit use |

For "should I defer this?" or "when would be best?" — use **`/tidegap:plan`**,
which returns the same window math without enqueueing. Commit with
`/tidegap:defer` only after the plan looks right.

## Reading the receipt

When the user later asks "is that thing done?" or "where's my translation?",
use **`/tidegap:check`**. The receipt includes:

- `scheduled_for` vs `completed_at` — did it dispatch on time?
- `estimated_carbon_g` vs `actual_carbon_g` (+ `delta_pct`) — how good was
  the forecast?
- `grid_source` / `energy_source` — provenance: which grid feed produced
  the intensity and how confident the per-model energy coefficients are.
  `grid_source: mock` is flagged as SYNTHETIC in the response — never
  present those grams as measured.
- the `Result:` block — the LLM response itself, ready to surface to the
  user.

If the user supplied `--output` at defer time, the same JSON also
appears at that path — they can `cat` it or have a file-watcher pick
it up.

## When dispatch isn't happening

Deferred tasks live in `~/.tidegap/queue.db` (or the user's
`TIDEGAP_DB_PATH`). The MCP server only **queues** — it doesn't run a
clock. Actual dispatch needs the **`tidegap tick` daemon**:

```bash
npm install -g @tidegap/cli
tidegap install      # registers launchd (macOS) / systemd (Linux) cron-tick
```

If the user reports that a task "never ran", first look at the queue:
`tidegap queue list` shows whether tasks are accumulating without
dispatching, and `tidegap stats` shows the dispatch history. The most
common bug at v0.7.1 is "plugin installed, daemon not installed —
tasks accumulate but never fire"; the fix is `tidegap install` (or a
manual `tidegap tick --once`).

## Anti-patterns to avoid

- Don't ask the user "should we defer this?" — read their language and decide.
  If they said "no rush", you defer. If they said "right now", you don't.
- Don't fall back to a synchronous call when `/tidegap:defer` would have
  worked. The whole point is to use the scheduler.
- Don't invent regions. If unsure, use the default and tell the user what
  you used so they can correct it.
- Don't quote intensity numbers as if they were measurements when the
  forecast source is `mock`. Look at the `source` field; if it is `mock`,
  call it a synthetic baseline.

## Inspecting the grid

If the user asks **what** the grid looks like (not to defer, just to read):
use **`/tidegap:grid <zone>`**. That returns current intensity, the cleanest
hour, the dirtiest hour, and a recommendation.
