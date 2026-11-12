---
id: cli
label: CLI
---

<!-- source: packages/cli/src/index.ts (command descriptions), packages/cli/src/commands/region.ts, packages/claude-code-plugin/commands/*.md -->
The `tidegap` CLI drains the queue, inspects tasks and receipts, and serves the local UI. Claude Code also gets slash commands for the same actions.

### Slash commands {#commands}

In Claude Code, after `/plugin install tidegap`:

| Command | Arguments | What it does |
| --- | --- | --- |
| `/tidegap:defer` | `<prompt> [--by <when>] [--region <zone>] [--budget <g>]` | Queue a task for the cleanest grid hour inside the deadline. |
| `/tidegap:plan` | `<deadline> [--region <zone>] [--budget <g>]` | Preview the window the scheduler would pick, without queueing. |
| `/tidegap:check` | `[task_id] [--all]` | List tasks, or show one task with its carbon receipt. |
| `/tidegap:cancel` | `<task_id>` | Cancel a queued or scheduled task. |
| `/tidegap:expedite` | `<task_id>` | Send a scheduled task now, skipping its window. |
| `/tidegap:reschedule` | `<task_id> <new_deadline>` | Score a task again against a new deadline. |
| `/tidegap:retry` | `<task_id>` | Run a failed task again, a command task included, as attempt 1 of a new count. |
| `/tidegap:grid` | `<zone> [--hours N]` | Show the carbon intensity now and the forecast for a region. |
| `/tidegap:later` | `<task_id> <preset or time>` | Run a queued task later: `1h`, `tonight`, `tomorrow_morning`, `after_limit_reset`, or an exact time. |
| `/tidegap:usage` | `[--spend]` | Show the Claude Code 5-hour and weekly limit use. |

### Commands {#cli-commands}

| Command | What it does |
| --- | --- |
| `tidegap tick` | Send due tasks to their provider. `--once` (default) or `--daemon --interval <sec>`. |
| `tidegap install` | Add the OS tick job. `--laptop` adds wake events, `--server` does not. |
| `tidegap status` | Will queued tasks run? Daemon, last tick, runners and pending tasks; exit 1 when not. `--json` prints the readiness object. |
| `tidegap queue list` | List tasks. Filter with `--status`, `--unread`, `--series <id>`, `--session <id\|current>` (the tasks one Claude Code session queued); `--json` for scripts. |
| `tidegap queue add <text>` | Queue one task and print its id on the first line: a prompt (`--runner claude-code\|anthropic\|openai\|gemini\|ollama`), or a shell command with `--runner command`. `--by <when>` is required (a duration, an ISO-8601 time or `quota-reset`). Also `--cwd`, `--profile read\|web\|none`, `--model`, `--result-path`, `--not-before`, `--after-limit-reset`, `--command-timeout`, `--llm-timeout` (the run's time limit, or `none`; see [Run limits](#limits)), `--retries` and `--retry-delay` (automatic retries of a failed run; `--retries 0` runs it once), `--wake` (wake this idle session when the task finishes; it needs the default ledger, so `--db` with another file exits 2), `--json`; `-` reads the text from stdin. Exit 2 on a usage error or a refused folder or path. See [Agent handoff](#handoff-queue). |
| `tidegap queue show <task-id>` | Show the prompt (or a one-off's command), the runner, folder, profile, tools, result file, the result and the receipt. Marks a finished task read. |
| `tidegap queue events <task-id>` | Print a task's events, oldest first, each with its id. `--after <event-id>` prints only newer ones; `--json` adds the task's status and timing. See [Agent handoff](#handoff-watch). |
| `tidegap queue wait <task-id>` | Block until the task ends, and its result file is written when it asked for one, and print its result. Exit 0 completed, 1 failed, cancelled or result file not written, 2 usage, unknown id, unreadable ledger or outcome not written to stdout, 3 at `--timeout <when>`. `--events` prints each new event to stderr. |
| `tidegap queue notices` | Print the notice of this session's finished tasks and record that the session saw them. The plugin's prompt hook runs it with `--hook`; `--peek` only prints. The plugin's Stop hook runs `--wait --rewake`, which waits for a task queued with `--wake` and exits 2 with the notice on stderr. See [Wake an idle session](#handoff-wake). |
| `tidegap queue cancel <task-id>` | Cancel a pending task. `--series` also ends a repeating series. |
| `tidegap queue reschedule <task-id>` | Move a task: `--by <when>`, `--at <when>` or `--day <yyyy-mm-dd>`. |
| `tidegap queue later <task-id>` | Push a queued or scheduled task later; it never runs earlier than its planned start. `--until <when>` or `--preset <id>`. |
| `tidegap queue run-now <task-id>` | Mark a task due now. The next tick sends it. |
| `tidegap queue retry <task-id>` | Retry a failed task, a command task included: it is due now, the next tick runs it as attempt 1 of a new count, and its deadline does not hold it back. A job run is refused: the job retries its runs itself. |
| `tidegap queue reply <task-id> <text>` | Queue a follow-up with the earlier conversation plus your text. |
| `tidegap queue unread <task-id>` | Mark a task unread again, so it shows in the inbox. |
| `tidegap receipts list` | List the receipts of completed tasks. `--since <iso>` filters. |
| `tidegap usage` | Claude subscription limits: 5-hour and weekly percent used and their resets; Codex limits. `--json`, `--spend` adds the current 5-hour window's tokens and cost estimate. |
| `tidegap usage hook [command...]` | Claude Code statusLine command: records `rate_limits` to `~/.tidegap/usage.json`. After `--`, it runs your own statusline command. `usage install-hook` stores it guarded: the guard runs your own command itself with the same input, so a Tidegap that fails, moves or is removed never changes your status line, one that hangs is stopped within 3 seconds, and an input left open is cut after 2 seconds. |
| `tidegap usage install-hook` | Register the usage hook as the Claude Code statusLine in `~/.claude/settings.json`. Your own statusLine is wrapped and keeps working; the old file is kept as `settings.json.tidegap.bak`. `--dry-run` prints the state and the command it would store and writes nothing; `--remove` restores your own command. |
| `tidegap limits show` / `set <setting> <value>` / `reset <setting>` | `tidegap limits` alone shows too. The run limits in `~/.tidegap/config`: `command-timeout`, `llm-timeout`, `retries` and `retry-delay` (`--runner <runner>` for one runner), with each value and its source, and the lines that are ignored. A time limit is a duration from 1s to 7d or `none`; retries are 0 to 10; a retry delay is a duration. See [Run limits](#limits). `--json` on `show`, `set` and `reset`. |
| `tidegap region show` / `set <zone>` / `detect` / `list` | The grid region every surface uses. `show` prints the zone, where it came from and its data source; `set` stores a supported zone in `~/.tidegap/config` (`set auto` clears it); `detect` prints the time-zone guess and stores nothing; `list` prints the supported zones. `--json` on each. |
| `tidegap stats` | Show local impact stats from the ledger. |
| `tidegap verify [task-id]` | Check a receipt signature. `--file <path>` for a receipt file. |
| `tidegap register-wake <task-id>` | Add a macOS wake event 30 s before a task's window. |
| `tidegap ui` | Open the local task page on 127.0.0.1. See [UI & apps](#apps). |
| `tidegap channels add <kind>` | Set up a notification channel in one step: it checks the values, sends a test message, then saves. Kinds: `webhook`, `slack`, `discord`, `ntfy`, `pushover`, `email`, `shortcuts` (macOS), `command`, and `telegram` (pairs a chat; see [Telegram](/docs#telegram)). Steps and fields per kind: [Notifications](/docs#notifications). Flags mirror the card's fields; secrets come from `--secrets-stdin` (one JSON object) or a hidden prompt, never from flags. |
| `tidegap channels kinds` | List each kind's flags, secrets and presets on this computer. `--json` for JSON. |
| `tidegap channels connect <id>` / `test <id>` / `disconnect <id>` | Connect again with the stored settings, send a test message, or stop sending and keep the settings. |
| `tidegap channels set <id>` | Change the events (`--events task_done,task_failed,digest`; `digest` is the daily summary) and quiet hours (`--quiet night` or `off`). No test message. |
| `tidegap channels digest` | Show the daily summary's send time and the channels that get it. `--at HH:MM` sets the local send time (default `09:00`, the end of quiet hours). |
| `tidegap channels list` / `remove <id>` | List the channels with state, last delivery and target (secrets as hints only; `--json`), or remove one with its secrets. |
| `tidegap channels serve` | Run the Telegram listener (the listener unit runs this). `--once` polls one cycle. |
| `tidegap jobs list` / `show <job-id>` | Recurring jobs: list active and paused jobs (`--all` adds removed ones; `tidegap jobs` alone lists them too), or show one with its guarantee, next and last run. `--json` on each. |
| `tidegap jobs add` / `edit <job-id>` | Create or change a job: a cadence (`--daily`, `--weekdays`, `--weekly mon,thu` or `--every 6h`), an optional `--window 00:00-08:00`, and `--prompt <text>` or `--command <shell>` (with `--summarize <prompt>` for a tool-less LLM step and `--secret <NAME>` per secret). `--file <job.json>` reads the job from JSON. `edit` changes only the flags given. |
| `tidegap jobs pause` / `resume` / `run` / `remove <job-id>` | Stop a job, start it again from now, run its next occurrence on the next tick, or end it (history stays). |
| `tidegap jobs history <job-id>` | Past runs with their receipt ids, newest first. `--limit N`. |
| `tidegap jobs secrets list` / `set <NAME>` / `remove <NAME>` | Secrets for command jobs, by name. `set` reads the value from stdin (a hidden prompt in a terminal); values are never printed. |
| `tidegap jobs snippet [--host <name>]` | Print the block that makes a coding agent schedule recurring work through Tidegap instead of cron: the generic `AGENTS.md` block, or with `--host` (`claude`, `opencode`, `codex`, `cursor`, `gemini`) the files that host reads. `tidegap install` prints the generic block too. |
| `tidegap clients add` / `list` / `revoke <id>` | Manage the tokens of the browser extension and the Mac app. |

Every queue command takes `--db <path>` to use a ledger other than `~/.tidegap/queue.db`.

### Grid region {#cli-region}

`tidegap region` shows and sets the grid region that every surface uses. The rules and the zone list are in [Config](#region).

| Command | What it does |
| --- | --- |
| `tidegap region show` | The zone, its name, where it came from (`flag`, `env`, `setting`, `timezone` or `fallback`) and its data source. A stored setting that an override hides is named too. |
| `tidegap region set <zone>` | Store a supported zone in `~/.tidegap/config` as `TIDEGAP_DEFAULT_REGION`. Any case; `UK` stores `GB`. The other lines of the file stay as they are. An unknown zone exits 2 with the closest zones and a request link. |
| `tidegap region set auto` | Remove the stored zone, so the time-zone guess applies again. |
| `tidegap region detect` | The time-zone guess alone. Stores nothing. |
| `tidegap region list` | The supported zones with country, grid operator and data source. |

Each command takes `--json`. `show --json` prints the same object as `GET /api/settings/region`, without `catalog`.

```text
$ tidegap region set ua
Unknown zone ua. Closest: PL. Request a region: https://github.com/tidegap/tidegap/issues/new?template=region_request.md&title=Region+request:+ua
$ tidegap region set fr
Region set to France (FR).
FR France — stored setting (tidegap region set)
Data: ENTSO-E (sample curve: add TIDEGAP_ENTSOE_SECURITY_TOKEN)
```

A running `tidegap ui`, tick daemon or Telegram listener uses the new zone on its next request or tick, with no restart.
