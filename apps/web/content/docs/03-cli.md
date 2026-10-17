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

### Commands {#cli-commands}

| Command | What it does |
| --- | --- |
| `tidegap tick` | Send due tasks to their provider. `--once` (default) or `--daemon --interval <sec>`. |
| `tidegap install` | Add the OS tick job. `--laptop` adds wake events, `--server` does not. |
| `tidegap queue list` | List tasks. Filter with `--status`, `--unread`, `--series <id>`; `--json` for scripts. |
| `tidegap queue show <task-id>` | Show the prompt, the result and the receipt. Marks a finished task read. |
| `tidegap queue cancel <task-id>` | Cancel a pending task. `--series` also ends a repeating series. |
| `tidegap queue reschedule <task-id>` | Move a task: `--by <when>`, `--at <when>` or `--day <yyyy-mm-dd>`. |
| `tidegap queue run-now <task-id>` | Mark a task due now. The next tick sends it. |
| `tidegap queue reply <task-id> <text>` | Queue a follow-up with the earlier conversation plus your text. |
| `tidegap receipts list` | List the receipts of completed tasks. `--since <iso>` filters. |
| `tidegap stats` | Show local impact stats from the ledger. |
| `tidegap verify [task-id]` | Check a receipt signature. `--file <path>` for a receipt file. |
| `tidegap register-wake <task-id>` | Add a macOS wake event 30 s before a task's window. |
| `tidegap ui` | Open the local task page on 127.0.0.1. See [UI & apps](#apps). |
| `tidegap clients add` / `list` / `revoke <id>` | Manage the tokens of the browser extension and the Mac app. |

Every queue command takes `--db <path>` to use a ledger other than `~/.tidegap/queue.db`.
