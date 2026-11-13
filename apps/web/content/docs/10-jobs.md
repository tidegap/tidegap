---
id: jobs
label: Jobs
---

<!-- source: packages/core-ts/src/jobs.ts, packages/core-ts/src/job-cadence.ts, packages/core-ts/src/tool-surface.ts (schedule_task), packages/cli/src/commands/jobs.ts, packages/cli/src/jobs/secrets.ts, packages/cli/src/jobs/run-shell.ts, packages/cli/src/providers/command.ts, docs/spec/ui-client-api.md (Jobs) -->
A job is a recurring task that floats. You give it a cadence and an optional window of hours. Each run goes to the cleanest grid hour inside its period, not to a fixed clock time. Cron cannot do this.

### What a job is {#jobs-what}

A job is one of two kinds:

- **Prompt job.** Each run sends the prompt to the provider, started fresh. Tools are `none` (default), `files` (Read, Grep, Glob) or `web` (WebSearch, WebFetch).
- **Command job.** Each run executes a shell command, with an optional LLM step over its output. The LLM step has no tools.

Each run is an ordinary task with a carbon receipt. `tidegap verify <run-id>` checks it. A job keeps one pending run at a time. When a run ends, the next one is planned. A job has no region of its own: each run uses the [default grid region](#region) of the computer that ticks it.

Create and edit jobs on the **Jobs** page (`tidegap ui`, then Jobs) or with [`tidegap jobs`](#cli-commands). Agents create prompt jobs only, through `schedule_task` with `repeat` (see [Agents](#jobs-agents)).

### Cadence and windows {#jobs-cadence}

| Cadence | Meaning |
| --- | --- |
| `daily` | Once a day. |
| `weekdays` | Once on each day from Monday to Friday. |
| `weekly` | Once on each listed day, for example `mon,thu`. |
| every N hours | At least every N hours, N from 2 to 168, counted from the last run. |

A window (`HH:MM-HH:MM`, local time in the job's time zone) limits the hours a run may use. It can cross midnight: `22:00-06:00`. A window works with `daily`, `weekdays` and `weekly`. "Every night" is `daily` with the window `22:00-08:00`. Without a window, a run may use any hour of its period.

Each job shows its guarantee in one sentence. These are the shapes:

- `runs every day between 22:00 and 08:00`
- `runs once every weekday (Mon-Fri), any time of day`
- `runs every Mon and Thu between 09:00 and 17:00`
- `runs at least every 6 h, never sooner than 3 h after the last run`

A job with a window, `weekdays` or `weekly` is tied to the calendar: it runs once in each slot. A job with `daily` or every N hours and no window is tied to its last run: the next run is due one period after the last started, and never sooner than half a period after it. Daylight saving time moves a local time that does not exist to the next valid minute. A repeated local time uses its first instant.

### Commands {#jobs-commands}

A command job runs with `/bin/sh -c`. Only you write the command, on the page or in the CLI. Agents cannot create command jobs.

- The command runs as you. It can read every file you can read, including Tidegap's own secrets files. Treat a command like a line in your crontab.
- The environment holds only `PATH`, `HOME`, `USER`, `LOGNAME`, `SHELL`, `LANG`, `LC_*`, `TMPDIR` and `TZ`, plus the secrets the job names.
- Output is capped (10 MiB); errors keep their last 4 KiB. The time limit is 30 minutes by default (see [Run limits](#limits)). At the limit, the command's process group is stopped.
- A stopped tick stops its commands. On SIGTERM or SIGINT, each command's process group gets SIGTERM, then SIGKILL after a short grace. A command the stop ended fails as `interrupted: the tick stopped during the run`, as a run a dead tick left does, and it gets a retry when its retries allow one (see [Caps and auto-pause](#jobs-caps)); a command that handles the SIGTERM and exits 0 counts as a success. At the time limit or a cancel, a command's group that is already empty gets no further signal: the runner checks it every 100 ms, so the run ends within a tenth of a second instead of after the grace. A cancel of a running task stops its command or `claude -p` run the same way within 15 seconds, and the tick goes on to the next due task. A tick that exits sends SIGKILL at once. `tidegap tick --daemon` then dispatches nothing more and exits; rows it did not reach stay queued for the next tick. A `claude -p` run in flight finishes first. A second SIGINT or SIGTERM, at least 1 second after the first, ends `tidegap tick --daemon` at once, and the row in flight ends by what it was doing. A provider call fails as interrupted, and its command or `claude -p` process group is killed. A Batch poll goes back to `submitted` with its batch id, and the next tick polls it again. A Batch submit fails with an error that says the provider may have accepted the batch. No retry runs that row again, the job's own retry included: check the provider's batch list, and enqueue the task again only if no batch exists.
- Some processes outlive the cap. A background child (`cmd &`) keeps running after the command exits normally. A child that leaves the process group with `setsid` is not stopped at the cap. A tick ended by SIGKILL or a crash runs no handler, so its running command goes on until it ends. The next tick that holds the tick lock frees a row that such a tick left `running`, a one-off task's row too, once that tick's process is gone (checked by its pid and start time). A job's row without that record (from an older version or another host), or whose tick's start time cannot be read, is freed by the job sweep once it is older than the time limits its run started with (a Batch row counts from its deadline, and `none` adds nothing there: no LLM time limit applies to a Batch run); any other run with no time limit (`none`) is freed only by the tick lock rule. A Batch row that has a batch id goes back to `submitted` and is polled again. Any other row fails as interrupted, a Batch submit included: the provider may have accepted that batch, so check its batch list before you enqueue the task again.
- Exit code 127 means the shell did not find the command. The daemon has a short `PATH`, so use an absolute path.
- The LLM step reads the scrubbed output (the last 200 KiB) with a prompt you write. If a usage limit defers that step, the run goes back to the queue and the command runs again on the deferred dispatch.

### Secrets {#jobs-secrets}

A command that needs a password gets it as an environment variable. Store the value once:

```
tidegap jobs secrets set IMAP_PASSWORD
```

The value is read from standard input (a hidden prompt in a terminal). It is never an argument and never printed. The page and the CLI list names only. A job names the secrets it needs with `--secret <NAME>`. Names start with an upper-case letter, then upper-case letters, digits and `_`.

Tidegap scrubs every secret value out of the output, the errors, the receipt and the messages. The scrub matches exact values (at least 4 characters). A command that prints a changed form of a secret, such as its base64 or URL-encoded text, is not scrubbed. Do not print secrets.

### Caps and auto-pause {#jobs-caps}

Each run has caps: a command time limit (30 minutes), an LLM time limit (30 minutes for `claude-code`, 10 minutes for an API provider), an LLM budget (1 USD) and an output cap. Change them for one job with `--command-timeout`, `--llm-timeout`, `--retries`, `--retry-delay` and `--budget`, or for every job and task with `tidegap limits` ([Run limits](#limits)). A time limit takes `none` for no limit. A job without its own time limit follows the setting at each run. The LLM budget is an estimate, not a bill. For Anthropic, OpenAI and Gemini, Tidegap estimates the input at 4 characters per token at list prices, refuses a call whose input alone costs more than the budget, and lets the answer use what the budget leaves. Text that takes more tokens than the estimate can go over the budget. A model with no price in the table runs with no budget cap, and the tick logs one line. A `claude-code` run passes the budget to Claude Code as `--max-budget-usd`.

By default a failed run gets one retry 30 minutes later, when its slot has time left. The job's retries and retry delay, or the settings, change that ([Run limits](#limits)): retry k waits the delay times 2^(k-1), so with `--retries 3` the slot gets runs `~1r`, `~1r2` and `~1r3`. A failed command runs again in a retry; `--retries 0` runs it once. A run whose LLM step fails after the command ran gets no retry, so that command does not run twice in one slot. Nor does a permanent failure: a missing secret, folder or key, a refused request. After three failed slots in a row, the job pauses. The notice that it paused replaces the failure alert of that run. Fix the cause, then resume the job.

### Ending a job {#jobs-end}

A job can end by itself. Give it an end date, a number of runs, or both:

- `--until 2026-11-17`: the last local day, in the job's zone, on which a run may start. The run that starts that day still runs; no later one is made. `--until` also takes an ISO instant with `Z` or an offset: a run must start before it.
- `--count 5`: 5 more runs from now, 1 to 1000. A retry is part of its run, and a skipped run does not count. `jobs edit --count N` sets the runs left again from now.

`--until none` and `--count none` remove the end on `jobs edit`. An end date already past is refused. When the end comes, the job's status is `ended`: it keeps its history, it has no next run, and it sends one notice on your channels and the system notification, whatever its `--notify` level. The notice replaces the message of the last run. A paused job whose end date passes ends too, with no run. An ended job cannot be edited, paused, resumed or run; remove it, or add a new job. `tidegap jobs list --all` shows ended jobs.

### Waking the session {#jobs-wake}

A job can wake the Claude Code session that set it up, but only on the runs that need attention. Run `jobs add` or `jobs edit` from inside that session with `--wake`:

- `--wake failures`: a run that failed for good (after its retries) wakes the session.
- `--wake match=<pattern>`: a completed run whose output matches the pattern wakes the session, for example `--wake 'match=^ALERT'`. The pattern is a JavaScript regular expression with the `m` flag, so `^` and `$` match at each line. It may have 200 characters, and a pattern that matches an empty output is refused. A run that failed for good is a notice for the next prompt, and does not wake.
- `--wake never` (the default) binds no session. On `jobs edit` it removes the binding.

Tidegap decides after each run, from the stored result. The notice names the run id, its status, the job title and the reason (`matched`, `failed` or `ended`), never the output: `- job-3f9a1c2e~5 completed "Deploy monitor" (job: matched)`. Other runs of the job never reach the session. When a bound job ends, its end is a notice that does not wake. The pattern reads the first 65,536 characters of the output and has 50 ms to answer. A pattern that runs longer counts as a match, so a broken pattern wakes once rather than missing an alert.

`--wake` needs a Claude Code session and the default ledger, as `queue add --wake` does. `jobs edit --wake` from another session moves the job to that session, and says so. A run that ends after `jobs pause` is a notice for the next prompt, not a wake. `jobs pause`, `jobs remove` and `--wake never` stop the wake at once; `jobs resume` starts it again. On MCP, `schedule_task` with a job `repeat` takes `wake_session: true` (wake on failures) and `wake_match: "<pattern>"` (wake on a match). The page shows which session a job wakes and on what, but cannot set it. A wake reaches a session that sits idle up to 11 h 50 min after its last turn; a later run reaches it with its next prompt. See [Wake an idle session](#handoff-wake).

### After sleep {#jobs-catchup}

A job needs `tidegap tick` to run. When the computer sleeps through a slot, the run is due at the next tick. The next run counts from that run's start. There is no backlog: a job that missed three days runs once. Resume starts a job again from now.

### Notifications {#jobs-notify}

A job's `--notify` level has three values:

- `every` (default): each run sends its result.
- `failures`: only a failed run sends a message.
- `summary`: results appear only in the [daily summary](#notifications).

Channels get the same events as for any task. Telegram also lists jobs with `/jobs`.

### Agents and schedule_task {#jobs-agents}

`schedule_task` with `repeat` creates a job. The agent sends the prompt, and each run starts fresh in the same project.

| Parameter | Meaning |
| --- | --- |
| `repeat` | `daily`, `weekdays`, `weekly` or `every_n_hours`. |
| `every_hours` | N for `every_n_hours`, 2 to 168. |
| `days` | Days for `weekly`: `mon` to `sun`. |
| `window` | Local hours, `HH:MM-HH:MM`. |
| `time_zone` | IANA zone. Default: this computer's. |
| `until` | End date: `YYYY-MM-DD` (the last local day a run may start) or an ISO instant. MCP hosts only. |
| `count` | Runs before the job ends, 1 to 1000. MCP hosts only. |
| `wake_session` | `true`: wake this session on a run that failed for good. MCP hosts only. |
| `wake_match` | A pattern: wake this session on a run whose output matches. MCP hosts only. |

A job rejects per-task options such as `region`, `carbon_budget_g` and `candidates`. End a job with `cancel_task` and `series: true`.

The older `repeat: quota_reset` (with `deadline_kind: quota_reset`) still starts a series that follows the quota reset. It is not a job.

To make your agent choose Tidegap instead of cron, open the **Agent rules** tab in the [install box](/#install) on the home page, or run `tidegap jobs snippet --host claude|opencode|codex|cursor|gemini`. The Claude Code plugin also asks before a command that edits the crontab, loads a launchd job or enables a systemd user unit, and hints at `schedule_task` when a prompt asks for recurring work.

### Surfaces {#jobs-surfaces}

The Jobs page, the Mac app, the browser extension and Telegram (`/jobs`) show jobs and can pause, resume and run them. Only the page and the CLI create and edit jobs. See [UI & apps](#apps) and [Telegram](#telegram).

The page's API takes at most 60 job writes (create, edit, remove, pause, resume, run now) and 20 previews per minute for each token. Over that, it answers 429 `rate_limited` with `retry_after_s`.

### macOS and `~/Documents` {#jobs-macos}

macOS asks once before a program reads `~/Documents`, `~/Desktop` or `~/Downloads`. The prompt belongs to the daemon's `node`. If nobody answers it, the command waits and then stops at its time limit. Tidegap never opens these folders to check. On macOS, a run that stops at its time limit gets a hint when it printed nothing for its final 2 minutes (or for the whole run, when the limit is shorter), or when it printed no stderr and its `--cwd` or command names one of these folders. The first line of the failure reason ends with `macOS: if it reads a protected folder, allow node in Files & Folders`. The second line names the daemon's `node` path. The hint is a condition, not a finding: a command can be quiet for other reasons. If the script reads one of these folders, open System Settings, Privacy & Security, Files & Folders, and allow that `node`. Or keep the folder the script reads outside these folders. A retry before you allow the access hangs again. `tidegap install` on macOS warns when the daemon's `node` or entry script (or `TIDEGAP_BINARY`) is in one of these folders or in iCloud Drive (`~/Library/Mobile Documents`): install the CLI with `npm install -g @tidegap/cli`, or keep the runtime outside these folders.

### SSH keys {#jobs-ssh}

The daemon runs under launchd or systemd and has no `SSH_AUTH_SOCK`. A command that needs `ssh` or `git` over SSH cannot reach your agent. Use a key without a passphrase that only this command uses, or point the command at the socket itself.

### Mixed versions and the Python ticker {#jobs-versions}

Upgrade every ticker that shares the ledger before you add command jobs. An older `tidegap tick`, or a Python ticker, cannot run a `command` row.

Both tickers leave a row they cannot serve queued for another ticker, but they hold different sets. The Python ticker (`tidegap` on PyPI) never runs a job: it holds every job run, whatever its provider, and every `command` or `claude-code` row it has no adapter for. `tidegap tick` holds a `command` row when it has no command runner, and any other row only when it has no LLM provider at all; with a provider, a row for a provider it lacks fails.

Each Python tick lists the rows it holds in `TickResult.held_for_node`, the active jobs in `TickResult.active_jobs` and the last Node tick in `TickResult.node_last_tick_at`, and logs one warning when it holds a row or a job is active. If it cannot read the ledger after its sweeps, `TickResult.node_report_error` names the error and `held_for_node` lists the rows it held at the start of the tick. Jobs run only on the Node daemon, with their limits: run `tidegap install`, then check `tidegap status`. Python `expedite_task` and `retry_task` refuse a job run. To run a queued or scheduled run now, use `tidegap queue run-now <id>`; to run the job again, `tidegap jobs run <job id>`. A job retries a failed run itself.
