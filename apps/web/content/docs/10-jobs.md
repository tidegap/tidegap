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
- Output is capped (10 MiB); errors keep their last 4 KiB. The time limit is 5 minutes by default. At the limit, the command's process group is stopped.
- A stopped tick stops its commands. On SIGTERM or SIGINT, each command's process group gets SIGTERM, then SIGKILL after a short grace. A tick that exits sends SIGKILL at once. `tidegap tick --daemon` then dispatches nothing more and exits; rows it did not reach stay queued for the next tick. A `claude -p` run in flight finishes first. A second SIGINT or SIGTERM, at least 1 second after the first, ends `tidegap tick --daemon` at once: the run in flight fails as interrupted, and its command or `claude -p` process group is killed.
- Some processes outlive the cap. A background child (`cmd &`) keeps running after the command exits normally. A child that leaves the process group with `setsid` is not stopped at the cap. A tick ended by SIGKILL or a crash runs no handler, so its running command goes on until it ends.
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

Each run has caps: a command time limit (5 minutes), an LLM time limit (10 minutes), an LLM budget (1 USD) and an output cap. Change them with `--command-timeout`, `--llm-timeout` and `--budget`. The summarize budget is an estimated ceiling: the cost is estimated from tokens, so a model with costly output can go a little over it.

A failed run gets one retry 30 minutes later, when its slot has time left. A failed command runs again in the retry. A run whose LLM step fails after the command ran gets no retry, so that command does not run twice in one slot. After three failed slots in a row, the job pauses. The notice that it paused replaces the failure alert of that run. Fix the cause, then resume the job.

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

A job rejects per-task options such as `region`, `carbon_budget_g` and `candidates`. End a job with `cancel_task` and `series: true`.

The older `repeat: quota_reset` (with `deadline_kind: quota_reset`) still starts a series that follows the quota reset. It is not a job.

To make your agent choose Tidegap instead of cron, open the **Agent rules** tab in the [install box](/#install) on the home page, or run `tidegap jobs snippet --host claude|opencode|codex|cursor|gemini`. The Claude Code plugin also asks before a command that edits the crontab, loads a launchd job or enables a systemd user unit, and hints at `schedule_task` when a prompt asks for recurring work.

### Surfaces {#jobs-surfaces}

The Jobs page, the Mac app, the browser extension and Telegram (`/jobs`) show jobs and can pause, resume and run them. Only the page and the CLI create and edit jobs. See [UI & apps](#apps) and [Telegram](#telegram).

The page's API takes at most 60 job writes (create, edit, remove) and 20 previews per minute for each token. Over that, it answers 429 `rate_limited` with `retry_after_s`.

### macOS and `~/Documents` {#jobs-macos}

macOS asks once before a program reads `~/Documents`, `~/Desktop` or `~/Downloads`. The prompt belongs to the daemon's `node`. If nobody answers it, the command waits and then stops at its time limit. A failed run names this cause. Open System Settings, Privacy & Security, Files & Folders, and allow the daemon. Or keep the job's `--cwd` outside these folders.

### SSH keys {#jobs-ssh}

The daemon runs under launchd or systemd and has no `SSH_AUTH_SOCK`. A command that needs `ssh` or `git` over SSH cannot reach your agent. Use a key without a passphrase that only this command uses, or point the command at the socket itself.

### Mixed versions and the Python ticker {#jobs-versions}

Upgrade every ticker that shares the ledger before you add command jobs. An older `tidegap tick`, or a Python ticker, cannot run a `command` row.

Both tickers leave a row they cannot serve queued for another ticker, but they hold different sets. The Python ticker (`tidegap` on PyPI) holds every `command` and `claude-code` row, job or not. `tidegap tick` holds a `command` row when it has no command runner, and any other row only when it has no LLM provider at all; with a provider, a row for a provider it lacks fails.
