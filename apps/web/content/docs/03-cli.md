---
id: cli
label: CLI
---

<!-- source: packages/cli/src/index.ts (command descriptions), packages/claude-code-plugin/commands/*.md -->
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
| `/tidegap:retry` | `<task_id>` | Send a failed task again. |
| `/tidegap:grid` | `<zone> [--hours N]` | Show the carbon intensity now and the forecast for a region. |
| `/tidegap:later` | `<task_id> <preset or time>` | Run a queued task later: `1h`, `tonight`, `tomorrow_morning`, `after_limit_reset`, or an exact time. |
| `/tidegap:usage` | `[--spend]` | Show the Claude Code 5-hour and weekly limit use. |

### Commands {#cli-commands}

| Command | What it does |
| --- | --- |
| `tidegap tick` | Send due tasks to their provider. `--once` (default) or `--daemon --interval <sec>`. |
| `tidegap install` | Add the OS tick job. `--laptop` adds wake events, `--server` does not. |
| `tidegap status` | Will queued tasks run? Daemon, last tick, runners and pending tasks; exit 1 when not. `--json` prints the readiness object. |
| `tidegap queue list` | List tasks. Filter with `--status`, `--unread`, `--series <id>`; `--json` for scripts. |
| `tidegap queue show <task-id>` | Show the prompt, the result and the receipt. Marks a finished task read. |
| `tidegap queue cancel <task-id>` | Cancel a pending task. `--series` also ends a repeating series. |
| `tidegap queue reschedule <task-id>` | Move a task: `--by <when>`, `--at <when>` or `--day <yyyy-mm-dd>`. |
| `tidegap queue later <task-id>` | Push a queued or scheduled task later; it never runs earlier than its planned start. `--until <when>` or `--preset <id>`. |
| `tidegap queue run-now <task-id>` | Mark a task due now. The next tick sends it. |
| `tidegap queue reply <task-id> <text>` | Queue a follow-up with the earlier conversation plus your text. |
| `tidegap queue unread <task-id>` | Mark a task unread again, so it shows in the inbox. |
| `tidegap receipts list` | List the receipts of completed tasks. `--since <iso>` filters. |
| `tidegap usage` | Claude subscription limits: 5-hour and weekly percent used and their resets; Codex limits. `--json`, `--spend` adds the current 5-hour window's tokens and cost estimate. |
| `tidegap usage hook [command...]` | Claude Code statusLine command: records `rate_limits` to `~/.tidegap/usage.json`. After `--`, it runs your own statusline command. |
| `tidegap region show` / `set <zone>` / `detect` / `list` | The grid region every surface uses. `show` prints the zone, where it came from and its data source; `set` stores a supported zone in `~/.tidegap/config` (`set auto` clears it); `detect` prints the time-zone guess and stores nothing; `list` prints the supported zones. `--json` on each. |
| `tidegap stats` | Show local impact stats from the ledger. |
| `tidegap verify [task-id]` | Check a receipt signature. `--file <path>` for a receipt file. |
| `tidegap register-wake <task-id>` | Add a macOS wake event 30 s before a task's window. |
| `tidegap ui` | Open the local task page on 127.0.0.1. See [UI & apps](#apps). |
| `tidegap channels add <kind>` | Set up a notification channel in one step: it checks the values, sends a test message, then saves. Kinds: `webhook`, `slack`, `discord`, `ntfy`, `pushover`, `email`, `shortcuts` (macOS), `command`, and `telegram` (pairs a chat; see [Telegram](/docs#telegram)). Flags mirror the card's fields; secrets come from `--secrets-stdin` (one JSON object) or a hidden prompt, never from flags. |
| `tidegap channels kinds` | List each kind's flags, secrets and presets on this computer. `--json` for JSON. |
| `tidegap channels connect <id>` / `test <id>` / `disconnect <id>` | Connect again with the stored settings, send a test message, or stop sending and keep the settings. |
| `tidegap channels set <id>` | Change the events (`--events task_done,task_failed`) and quiet hours (`--quiet night` or `off`). No test message. |
| `tidegap channels list` / `remove <id>` | List the channels with state, last delivery and target (secrets as hints only; `--json`), or remove one with its secrets. |
| `tidegap channels serve` | Run the Telegram listener (the listener unit runs this). `--once` polls one cycle. |
| `tidegap clients add` / `list` / `revoke <id>` | Manage the tokens of the browser extension and the Mac app. |

Every queue command takes `--db <path>` to use a ledger other than `~/.tidegap/queue.db`.
