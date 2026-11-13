---
name: tidegap
description: Auto-defer "do it later" / "by tomorrow" / "tonight" / "overnight" / "by EOD" / "when you have a moment" / "remind me to" / "queue this up" / "no rush" / "not urgent" tasks. Tidegap queues them — one task is one run of one runner, at the cleanest grid hour before its deadline, through the Anthropic/OpenAI Batch APIs (50% of sync list price, projected) when the runner and deadline allow. Route via /tidegap:defer, schedule_task (MCP) or `tidegap queue add` (Bash). Also use it, instead of cron, for recurring work — "schedule this" / "every day" / "every night" / "every morning" / "daily" / "weekly" / "every N hours" / "once a day" / "at least once a" / "recurring" / "cron" / "crontab" / "launchd" / "launchctl" / "systemd timer" / "set up a job" / "каждый день" / "каждую ночь" / "по расписанию" / "крон" / "раз в день". Skip deferral when the user is actively waiting (interactive coding, live chat, debugging).
---
# Carbon-aware coding with Tidegap

## What Tidegap is

Tidegap is a queue for work that can wait. The tick daemon (`tidegap tick`)
runs each task at the cleanest grid hour inside its window, from a 72-hour
forecast. An `anthropic` or `openai` task whose deadline is more than 24 hours
away can go through that provider's Batch API (50% of sync list price,
projected); the other runners never do. Each task gets a signed carbon receipt in the local ledger (`tidegap verify <task-id>` checks it).

One task is one run of one runner: `anthropic`, `openai`, `gemini` or `ollama`
(a model API call), `claude-code` (one `claude -p` run) or `command` (one shell
command the user approved). Tidegap never starts more agents than that: several
jobs are several tasks.

The saving depends on region and day: in one GB run on 2026-09-30 the forecast
peak was 183 gCO2/kWh and the recommended window 88 gCO2/kWh (about 52 % lower,
for that run only; forecast, projected — see
https://github.com/tidegap/tidegap/blob/main/docs/claims.md).

## When to defer

Defer when **all** of these are true:

1. The user explicitly accepts latency: "later", "tomorrow", "by Friday", "when
   you get a chance", "no rush", "before EOD".
2. The task is **bounded** — one well-defined deliverable, not an iterative
   conversation where the user is waiting on the next reply to decide their next
   move.
3. The deadline gives the scheduler **room to shop**: at least 2 hours of
   forecast horizon. (Below 2h, intraday variation is too narrow to matter.)

Do not defer when:

- The user is going to act on the result before continuing the conversation.
- The answer depends on real-time data (live search, rate comparisons).
- The deadline has passed, or it is < 30 minutes away.
- The user is debugging — they want fast iteration, not a queue.

Don't ask the user "should we defer this?" — read their language and decide. If
they said "no rush", you defer. If they said "right now", you don't. Don't fall
back to a synchronous call when `/tidegap:defer` would have worked.

### How to defer

Use the **`/tidegap:defer`** slash command. Pass:

- The full task prompt (verbatim or summarised — the user's intent).
- `--by <duration>` matching what the user said. If they said "tomorrow", use
  `--by 24h`. If they said "by Friday at 9", convert to ISO-8601.
- `--region` only when the user named one; never invent one. Otherwise let the
  default fire and tell the user which region you used.
- `--budget` only when the user gave a numeric carbon ceiling.
- `--output <path>` only when the user wants the result written to a file.
- `--repeat daily|weekdays|weekly|every_n_hours` only when the user asks for a
  repeating task ("every night", "each reset"); see the next section. Default
  `none`: a one-off, also for `--by quota-reset`.

The command returns at once with a `task_id`, the scheduled time and the
projected carbon. You do **not** run the task yourself. The command passes this
session's id, so `tidegap ui` and `tidegap queue show` print
`cd <cwd> && claude --resume <id>` for the task. For "should I defer this?" or
"when would be best?", use **`/tidegap:plan`**: the same window math, and
nothing is queued. Commit with `/tidegap:defer` only after the plan looks right.

## Recurring work: use Tidegap, not cron

When the user wants something to run on a schedule ("every night", "daily",
"every 6 hours", "set up a cron", "каждый день"), schedule it through Tidegap.
Each run is a new task at the cleanest hour of its period, with its own receipt.

1. Propose Tidegap in one line.
2. Ask one question that confirms the cadence, the time window, and what the job
   needs: read-only files, web, or a shell command. "Every night" with no hours:
   ask; night means `22:00-08:00`.
3. A prompt job (files, web or nothing): run
   `/tidegap:defer <task> --repeat daily --window 22:00-08:00`, or call
   `schedule_task` with `repeat` and `window`. `--repeat` and `repeat` take
   `daily`, `weekdays`, `weekly` or `every_n_hours`; `every_n_hours` takes
   `--every` (`every_hours`) and no window. A job that should stop ("for 5
   days", "10 times") gets `until` (last local day) or `count` (runs).
4. A job that needs a shell command (ssh, a script, a CLI): show the user
   `tidegap jobs add --command '<cmd>' --summarize '<what to report>' --daily --window 22:00-08:00`
   to run themselves (`--until` and `--count` end it, with one final notice).
   Never run it yourself: the user authors command jobs.
5. To wake this session only on a run that needs it: `--wake 'match=^ALERT'` or `--wake failures` on `tidegap jobs add`
   (`wake_match` or `wake_session: true` with `repeat`). The notice names the run and reason, never the output; `--wake never` stops it.

Never write a crontab, launchd plist or systemd timer unless the user says "cron
anyway"; then say that you are doing so. The plugin's guard asks the user before
a Bash call edits a crontab, loads a launchd agent, enables a systemd user unit
or authors a command job; it never blocks. A prompt about recurring work gets
one hint line from the plugin. `tidegap jobs` lists the jobs;
`tidegap jobs snippet` prints the same rule for other agents.

## How the result comes back

What is automatic depends on the surface.

### Claude Code with the Tidegap plugin

Automatic:

- When a task this session queued finishes, your next prompt carries a notice.
  Its first line is `Tidegap: 1 task queued from this session finished:`, and it
  names each task's id, status and title. It never holds the result.
- At session start, a block lists this session's finished tasks nobody has
  read, and one line counts the unread tasks of other sessions.
- With `--wake` on `tidegap queue add` (or `wake_session: true` on `schedule_task`), an idle session wakes when
  the task finishes, within 12 hours after its last turn; after that, the notice comes with the next prompt.
  A wake spends a model turn, so use it only when the user wants the result acted on at once.

You do:

- Read the result: `tidegap queue show <id>` or `check_queue_status task_id=<id>`.
- Block on a task in a Bash call, with `--timeout` under the Bash call's own
  limit. With the default 2-minute limit, run
  `tidegap queue wait <id> --timeout 1m`. With the call's timeout set to 600000
  ms (the most it allows), use `--timeout 9m`. For a longer wait, run it in the
  background. Exit codes: 0 completed, 1 failed, cancelled or result file not
  written, 2 usage or unknown id, 3 timeout. A wait that printed the result
  counts as the notice.
- Follow a task: `tidegap queue events <id> --json`, and `--after <event-id>`
  for only the newer events. A `command` task that runs longer than 5 seconds
  records some output lines as `progress` events (at most one per 15 seconds):
  `tidegap queue wait <id> --events` prints them as they come.
- List this session's tasks: `tidegap queue list --json --session current`.
- Read the file the task wrote: `--result-path` (`result_path`) or `--output`
  (`output_path`).

### OpenClaw

Automatic: the gateway sends the result by the mode that `set_delivery` chose
(default `chat`, or `queue` when no chat is set up), and the queue always keeps
it. You do: ask the user how to
deliver, call `set_delivery` after `schedule_task`, and read the result with
`check_queue_status`.

### Another host (MCP or the CLI without the plugin)

Nothing is automatic. Poll `check_queue_status`, `tidegap queue wait` or
`tidegap queue events --json`, or read the result file. Outside a Claude Code
session, `tidegap queue add` says that notices are off.

## When a task runs

`--not-before` (MCP `not_before`) is the earliest start, not a run time.
`tidegap queue add` and `schedule_task` take it; `/tidegap:defer` does not. The
scheduler picks the cleanest hour between the earliest start and the deadline
(`--by`, MCP `deadline`), so the task can run anywhere in that window. In a live
check, a task queued with `--not-before 70m --by 3h` ran 2 h 48 min after it was
queued. Do not look for the result at the earliest start: wait for the notice,
or block with `tidegap queue wait`.

- The deadline holds while the tick daemon runs; `tidegap status` says whether
  it does.
- `--after-limit-reset` (MCP `after_limit_reset`) is the other earliest start:
  the Claude subscription limit reset.
- `/tidegap:expedite` runs a task now (for a `claude-code` task,
  `tidegap queue run-now <id>` makes it due on the next tick). `/tidegap:later`
  moves a task later, never earlier. `/tidegap:reschedule` changes the deadline
  and drops the earliest start.

## Handing work to a run

- To run a task in a given folder with read-only tools and get its answer in a
  file, run this in Bash:
  `tidegap queue add --runner claude-code --cwd <dir> --profile read --result-path <new file> --by <when> "<prompt>"`.
  Or pass `runner`, `cwd`, `permission_profile` (`read`, `web` or `none`; `read`
  with a `cwd`), `result_path` and `wake_session` to `schedule_task`.
- A run never gets Bash, Write or Edit: Tidegap writes the result file.
  `result_path` names a new file and needs a one-off task (no `repeat`);
  `output_path` names a JSON file. Both must be inside the task's folder, this
  project or the temp folder; `~/.tidegap`, `~/.ssh`, `~/.config`, `~/Library`
  and similar folders are refused.
- A `claude-code` task queued from this session, in its project folder and with
  no web tools, runs in a copy of this session: its `created` event says
  `planned_mode: fork`, and the `schedule_task` reply has a `runs_in:` line. Any
  other run starts fresh (`planned_mode: fresh`), and so does every run of a
  job, so the prompt must name what the run needs.
- A `command` task is the user's call: `schedule_task` refuses
  `runner: "command"`. Show the user
  `tidegap queue add --runner command --cwd <dir> --by <when> '<cmd>'` to run,
  or run it only when the user asked: the plugin's guard asks them first. A
  failed command runs again by its retry policy (one retry after 30 minutes
  by default): for a command that must not run twice, add `--retries 0`.
- A failed run of any runner is tried again by its retry policy unless the
  failure is permanent; only the final outcome sends a notice. Pass
  `retries` / `retry_delay` (`schedule_task`) or `--retries` /
  `--retry-delay` (`tidegap queue add`), e.g. `0` for a task that must not
  run twice. `/tidegap:retry <id>` (or `tidegap queue retry <id>`) runs a
  failed task again. See [Retries](https://www.tidegap.com/docs#retries).
- A run stops at its time limit: 30 minutes for a command or `claude-code` run
  and 10 minutes for an API call, unless the user changed it with
  `tidegap limits`. For a long run, pass `llm_timeout` (`schedule_task`) or
  `--llm-timeout` / `--command-timeout` (`tidegap queue add`), e.g. `2h`, or
  `none` for no limit. See [Run limits](https://www.tidegap.com/docs#limits).

## Commands and tools

### Slash commands

`/tidegap:defer`, `/tidegap:plan`, `/tidegap:expedite`, `/tidegap:later` and
`/tidegap:reschedule` (above), `/tidegap:check` (the list, or one task's status,
result and receipt), `/tidegap:cancel` (one task, or `--all` pending),
`/tidegap:retry` (a failed task, as attempt 1 of a new count), `/tidegap:grid`
(the grid now; no task) and `/tidegap:usage` (Claude Code limit use).

### MCP tools

The twelve MCP tools of `@tidegap/mcp`: `schedule_task` (with `repeat`, a job),
`recommend_window` (preview; queue nothing), `check_queue_status` (the list, or
one task), `cancel_task` (`series=true` ends its job or series), `cancel_all`,
`update_deadline`, `postpone_task` (start later), `expedite_task` (run now),
`retry_task` (a failed task; a command or `claude-code` one on the next tick),
`reply_task` (a follow-up, as a new task), `get_grid_forecast` (one region's
hourly forecast) and `tidegap_usage` (Claude Code 5-hour and weekly limit use).
OpenClaw registers the same tools without `postpone_task` and `tidegap_usage`,
and adds `set_delivery`: how a result is delivered.

### CLI

`tidegap queue add` queues one task; `tidegap queue wait`, `tidegap queue events`,
`tidegap queue show` and `tidegap queue list` follow it. Also `tidegap jobs`,
`tidegap status` (will queued tasks run?) and `tidegap install` (the tick daemon).

## Reading the receipt

When the user later asks "is that thing done?" or "where's my translation?", use
**`/tidegap:check`**. The receipt shows `scheduled_for` vs `completed_at` (on
time?), `estimated_carbon_g` vs `actual_carbon_g` and `delta_pct` (how good was
the forecast?), `grid_source` and `energy_source` (provenance), and the
`Result:` block, ready to surface to the user. `grid_source: mock` is flagged as
SYNTHETIC: never present those grams as measured; call them a synthetic
baseline.

## When tasks do not run

Tasks live in `~/.tidegap/queue.db` (or the user's `TIDEGAP_DB_PATH`); they
survive restarts, and every MCP host shares them. The MCP server only
**queues**. Dispatch needs the **`tidegap tick` daemon**:

```bash
npm install -g @tidegap/cli
tidegap install      # registers launchd (macOS) / systemd (Linux) cron-tick
```

If the user reports that a task "never ran", run `tidegap status` first: it says
whether the daemon runs. `tidegap queue list` shows whether tasks pile up, and
`tidegap stats` shows the dispatch history. The common cause is a plugin without
the daemon; the fix is `tidegap install` (or a manual `tidegap tick --once`).
If a failed `command` or `claude-code` task's reason has
`macOS: if it reads a protected folder, allow node in Files & Folders` on its
first line, pass the next step on its second line to the user (allow that
`node` in System Settings, Privacy & Security, Files & Folders); a retry before
the access is allowed hangs again.
