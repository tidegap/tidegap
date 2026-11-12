---
id: handoff
label: Agent handoff
---

<!-- source: packages/cli/src/commands/queue-add.ts, packages/cli/src/commands/queue-watch.ts, packages/cli/src/handoff/notices.ts, packages/cli/src/handoff/results.ts, packages/core-ts/src/handoff.ts, packages/cli/src/handoff/waiter.ts, packages/claude-code-plugin/hooks/session-notice.sh, packages/claude-code-plugin/hooks/session-wake.sh, packages/claude-code-plugin/hooks/cron-guard.sh, packages/core-ts/src/storage/sqlite.ts (listSessionNotices, claimNotice, the tasks and task_events tables), packages/core-ts/src/task-events.ts (TASK_EVENT_KINDS, createProgressRecorder) -->
A Claude Code session can hand a task to Tidegap and get the outcome back in the same session. Nobody has to relay it. This page covers how the session queues the work, how it hears that a task finished, how it watches or waits for a task, and what it may read from the ledger.

### Queue a task {#handoff-queue}

`tidegap queue add` queues one task from a shell or the session's Bash tool and prints the task id alone on the first line:

```bash
tidegap queue add --runner claude-code --cwd . --profile read --result-path ./review.md --by 2h "Review the diff on this branch"
tidegap queue add --runner command --cwd /tmp --by 10m "echo hello > /tmp/tg-hello.txt"
```

- The text is the prompt, or the shell command of `--runner command`. `-` reads it from stdin (at most 1 MiB; a command at most 32,000 characters). A command is kept like a prompt: when the task completes or is cancelled, key-shaped secrets in it are redacted in the ledger.
- Runners: `claude-code`, `anthropic`, `openai`, `gemini`, `ollama` and `command`. Without `--runner` it is `claude-code` inside a Claude Code session, else `anthropic`.
- `--by` is required: a duration (`30m`, `2h`, `3d`, `1w`), an ISO-8601 time, or `quota-reset` (with `--quota-provider <label>` when more than one reset is set). `--not-before <when>` or `--after-limit-reset` set the earliest start.
- `--cwd <dir>` is the folder a `claude-code` or `command` run works in; a command runs in the current folder without it. `--command-timeout` sets a command's time limit and `--llm-timeout` an LLM run's (from 1s to 7d, or `none`); without them the [run limits](#limits) setting or the built-in default applies. The text output prints the limit as `time limit: 30m (default)`. `--retries` (0 to 10) and `--retry-delay` set how a failed run is tried again ([Retries](#retries)); the output prints `retries: 1 after 30m (default)`, and for a command `; --retries 0 runs it once`, since a command may run twice. `--model` and `--title` work as on the other commands.
- An option the runner does not take, a refused folder or result path, and a `--session` that does not name this session exit 2.
- Inside a Claude Code session the task records that session, so its notice comes back to this session's next prompt. Outside one the output says that notices are off; follow the task with `tidegap queue wait`.
- `--wake` also wakes this session when the task finishes while the session sits idle (see [Wake an idle session](#handoff-wake)). Outside a Claude Code session it exits 2, and so it does with `--db` naming another ledger than `~/.tidegap/queue.db`: the plugin's hooks read only that one. When the wake file cannot be written, the output says `wake: not armed` (`--json`: `wake_armed` is `false`), and the notice comes with the next prompt.
- `--json` prints one object: `task_id`, `status`, `runner`, `scheduled_for`, `deadline`, `origin_session_id`, `result_path`, `wake`, `wake_armed` and `notes` (the notice lines, such as an LLM time limit a Batch run would not apply; empty when none).

The `schedule_task` MCP tool takes the same work shape: `runner` (another name for `provider`), `cwd`, `permission_profile` and `result_path`. It never queues a shell command: `runner` or `provider` `command` is refused, and the reply names the `tidegap queue add --runner command` line for the user to run.

#### Tool profiles {#handoff-profiles}

A `claude-code` run never gets `Bash`, `Write` or `Edit`. A profile names one of the existing tool sets:

| Profile | Tools | Where the run works |
| --- | --- | --- |
| `read` | Read, Grep, Glob | The run's folder; reads elsewhere are not approved. The default when `--cwd` is given. |
| `web` | WebSearch, WebFetch | A fresh temporary folder. It takes no `--cwd`. |
| `none` | No tools | The run's folder. |

A run in this session's project folder keeps the session's context (a copy of the session). A `--cwd` elsewhere, for example a worktree, runs fresh there; the run is told which session queued it, and its result still comes back to this session. A `claude-code` folder may not be `/`, the home folder, a folder another user owns, a dot folder of the home folder (such as `~/.ssh` or `~/.config`), `~/Library` or a `.git` folder. `<repo>/.worktrees/<branch>` is fine. These names match in any letter case, and another name of the same folder (such as the home folder seen through `/System/Volumes/Data` on macOS) counts as that folder. A reply to a handed-off task works in the same folder with the same profile; it writes no result file.

#### Result files {#handoff-results}

`--result-path <file>` (`result_path` on `schedule_task`) asks for the result text in a new file. Tidegap writes it, never the run, when the task completes:

- The file must be new, inside the task's folder, this session's project folder or the temp folder, with no name below that folder starting with `.`, and every folder below that folder must be yours. The home folder and `/` never count as a project folder. `~/.tidegap`, `~/.config`, `~/.claude`, `~/.ssh`, `~/.gnupg`, `~/.aws`, `~/Library` and every `.git` folder are refused, in any letter case and under any other name. Its folder must exist.
- A repeating task cannot ask for a result file: each run would write the same new file.
- The rules are checked when the task is queued and again before the write. Tidegap never replaces a file and never follows a link: when something appeared at the path in the meantime, it writes nothing.
- The file gets mode 0600. The tick writes it after the task completes, also for a task the Python core completed, and records a `result_file` event. A failed or cancelled task gets no file. A file that could not be written never fails the task.
- The notice names the path, or says "result file not written". `queue wait` waits for the file and exits 1 when it was not written.

`output_path` on `schedule_task` (a JSON copy of the result and receipt) follows the same folder rules. It may replace a regular file you own that has no second name (hard link).

#### The guard {#handoff-guard}

A shell command task runs unattended in the daemon, outside the session's sandbox, so it is the user's decision. The plugin's `cron-guard.sh` hook asks the user before a Bash call runs `tidegap queue add` with a `--runner` that is not plainly one of the LLM runners; a quoted, variable or substituted value asks too, and so does a quoted, split or variable `queue add`. Under `bypassPermissions` that question may not stop the call: the guard asks, it is not a sandbox.

### Notices {#handoff-notices}

When a task that a session queued finishes, the next prompt of that session carries a notice. The plugin's `UserPromptSubmit` hook (`hooks/session-notice.sh`) adds it:

```text
Tidegap: 2 tasks queued from this session finished:
- t-3f2a completed "Nightly test run"
- t-9b1c failed "Review the API change"
Read one with: tidegap queue show <id> (or check_queue_status task_id=<id>).
```

- Each line names the task id, the status (`completed`, `failed` or `cancelled`) and the title in quotes, cut to 60 characters. A task that asked for a result file adds `result_path: <path>`, or "result file not written". A completed task with a result file gets its notice once the file is written or failed. The path is never cut: a long one shortens the title first.
- The notice never holds the result or the error text. Read those with `tidegap queue show <id>` or `check_queue_status`.
- At most 10 tasks get a line. The rest are counted, and the next prompt names them.
- A notice covers tasks that finished in the last 7 days, and only tasks whose session the MCP server or the CLI checked when the task was queued. Tasks that finished before the first notice was ever looked for are not replayed.
- After the hook prints a notice, Tidegap records a `notified` event on each task it named and marks the task read. Each finish of a task gets one notice: a retried task that finishes again gets a new one.
- A notice can repeat when the ledger is busy or the hook is slow. Tidegap records it only when there was time to deliver it.
- When you open a task first (the page, the Mac app, Telegram, `tidegap queue show`), the session still gets its notice.

The tick daemon keeps the file `~/.tidegap/sessions/notices/<session_id>` while a session has a notice to hear. Without that file the hook exits in a few milliseconds and starts no `tidegap` process. A task that the Python core finished gets its file at the next run of `tidegap tick`, within a minute when the daemon runs.

`tidegap queue notices --peek --session <id>` prints a session's notice and records nothing. `tidegap queue notices --hook` is the plugin hook's command, and it trusts the `session_id` in its input. Any process of your user can call it for another session, as it can read the ledger.

### Wake an idle session {#handoff-wake}

A task queued with `--wake` (`wake_session: true` on `schedule_task`) wakes the session that queued it when the task finishes, if the session sits idle: the session starts a turn by itself, and that turn's context holds the notice. A wake spends a model turn while nobody may be watching, so it is off unless you ask for it.

- The enqueue writes `~/.tidegap/sessions/wake/<session_id>`. When a turn of that session ends, the plugin's `Stop` hook (`hooks/session-wake.sh`, a Claude Code background hook with `asyncRewake`) sees the file and starts `tidegap queue notices --wait --rewake`. Without the file the hook exits in a few milliseconds and starts no `tidegap` process.
- The waiter checks the ledger every 5 seconds. When a wake task of the session completed or failed, it prints the session's notice to stderr. Once the hook has it, the waiter records a `notified` event with `via` `rewake`, marks the tasks read and exits 2, which wakes the session. The notice is the same as the prompt hook's, with the wake tasks first. A cancelled wake task wakes nobody.
- A wake needs the default ledger, `~/.tidegap/queue.db`. `--wake` with `--db` naming another file, and `wake_session` on an MCP server whose `TIDEGAP_DB_PATH` names another file or `:memory:` (or that keeps its tasks in memory), are refused before anything is queued. A waiter started with `--db` on another ledger can wake, but it never removes a wake file or a notice file.
- One waiter per session: each turn's end starts a new one, and the older one stops within 5 seconds. The waiter's pid file in `~/.tidegap/sessions/waiters/` alone tells which one is newest. A waiter that finds the file gone writes it again and waits on, so a new wake task never stops a waiting waiter. A waiter stops when the session's `claude` process ends, when the shell of the hook that started it ends, when that process starts another session (`/clear`, `/resume`), and 11 h 50 min after the turn ended (the hook's limit is 12 hours). Each of these stops comes within 5 seconds, claims nothing and keeps the wake file. The wake file goes when no wake task of the session is left to wait for. The waiter and the tick look at the ledger once more after they remove it, and write it again when a wake task was queued in the meantime. The tick also writes it back for a session whose wake task of the last 7 days is still to come and whose file is gone. While one is left, the file stays, so a later turn of the session starts a waiter for it again; after 7 days it goes in any case.
- Every other way out leaves the notice to the next prompt: no wake when the session is gone, when the 12 hours passed, when you sent a prompt first (the prompt hook delivers it), when the hook is gone, when the ledger is busy, or with an older `tidegap`. The first to record a notice wins, so the waiter and the prompt hook never both deliver a wake task's finish. In a rare race, the woken turn can repeat another task's line that a prompt just delivered.

### Watch or wait for a task {#handoff-watch}

`tidegap queue events <task-id>` prints the task's events, oldest first, one line each, led by the event id:

```bash
tidegap queue events t-3f2a --json
tidegap queue events t-3f2a --json --after 41   # only the events after event 41
```

The JSON is one object: `task_id`, `status`, `scheduled_for`, `deadline`, `completed_at`, `result_path` and `events` (each with `id`, `at`, `kind`, `actor` and `details`). The event `id` grows with each new event, so the last `id` you read is the cursor for `--after`.

`tidegap queue wait <task-id>` blocks until the task is completed, failed or cancelled, then prints the result text (or `error: …`) and, for a task with a result file, a `result_path:` line. A completed task with a result file is done once the tick wrote the file or failed to. It checks the ledger every 2 seconds.

| Exit code | Meaning |
| --- | --- |
| 0 | The task completed, and its result file is written when it asked for one. |
| 1 | The task failed or was cancelled, or its result file was not written. |
| 2 | A usage error, no task has that id, the ledger could not be read, or the outcome could not be written to stdout (a closed pipe). Nothing is recorded as read. |
| 3 | `--timeout` passed first. The task is not changed. |

- `--timeout <when>` takes a duration (`9m`, `2h`) or an ISO-8601 time. Without it, `wait` has no limit.
- `--events` prints each new event to stderr while it waits, `progress` lines included. `--json` prints one object: `task_id`, `status`, `result`, `error`, `result_path`, `result_file` (the `result_file` event's details) and `completed_at`.
- A `wait` that printed the outcome counts as the task's notice: it records `notified` and marks the task read. `--no-mark-read` skips both. It records only after the outcome is written, so a `wait` stopped right after it printed can show the same outcome once more with the next prompt.
- When no tick has ever run, `wait` first prints why tasks will not run, as `tidegap status` does.
- When the task completed and its result file is still not written one tick interval later (5 minutes with the tick daemon's unit file on disk, else 1 minute) and no Node tick is running, `wait` prints one line on stderr that says how to run a Node tick, and goes on waiting. Only the Node tick writes result files, also for a task the Python core completed.

A Bash call in Claude Code stops after 2 minutes by default, and after at most 10 minutes when the call sets its own timeout (600000 ms). Give `wait` a `--timeout` under that limit, or run it in the background. With the default limit, use `--timeout 1m`; with the call's timeout at 600000 ms:

```bash
tidegap queue wait t-3f2a --timeout 9m; echo "wait exit=$?"
```

### This session's tasks {#handoff-session}

`tidegap queue list --json --session current` lists only the tasks that this Claude Code session queued, each with its `status` and `scheduled_for`, and names the session in `session_id`. `current` is the session of the nearest `claude` process (from the plugin's file `~/.tidegap/sessions/claude-<pid>.json`), else `CLAUDE_CODE_SESSION_ID`. Outside a Claude Code session, `current` is a usage error (exit 2): pass `--session <id>`.

### Event names {#handoff-events}

| Stage | What the ledger stores |
| --- | --- |
| Created | The `created` event. |
| Scheduled | The task's `scheduled_for`, then a `rescheduled`, `postponed` or `expedited` event for each move. |
| Dispatched, running | The `dispatched` event; the status is `running`. |
| Progress | The `progress` event of a `command` run that lasts longer than 5 seconds: `line` (a line of its output) and `seq` (1, 2, …). At most one per 15 seconds and 24 per task; each line is cut to 200 characters, with terminal codes and control characters removed, and the job's secret values and key-shaped strings redacted. A blank line is skipped; a `summarize` step after the command reports none. A `claude-code` run reports none. The status stays `running` until the task ends. |
| Done | The `completed`, `failed` or `cancelled` event. |
| Result file | The `result_file` event, with `path`, `written`, then `bytes` or `error`. One per task. |
| Session told | The `notified` event, with `via` (`prompt` from the hook, `wait`, `rewake` from a wake, or `cli` from `tidegap queue notices`), `session_id` and the `completed_at` of the finish it told about. |

`deferred` (a usage limit moved the run) and `replied` (a follow-up task was queued) complete the list.

### The ledger {#handoff-ledger}

The ledger is `~/.tidegap/queue.db`, a SQLite file in WAL mode. Open it read-only, so a reader never blocks the daemon:

```bash
sqlite3 -readonly ~/.tidegap/queue.db "SELECT task_id, status, scheduled_for FROM tasks WHERE origin_session_id = '<session id>'"
```

These names are stable. A new column, status or kind can come in any release. A removed or renamed one is a "Changed" entry in the changelog.

```text
-- tasks columns
task_id status enqueued_at scheduled_for deadline completed_at title
origin_session_id origin_cwd read_at error parent_task_id job_id
```

```text
-- task_events columns
id task_id at kind actor details
```

```text
-- status values
queued scheduled running submitted completed failed cancelled
```

```text
-- event kinds
created rescheduled postponed expedited cancelled dispatched completed
failed attempt_failed deferred replied notified result_file progress
```

- `details` is a JSON object with snake_case keys. Skip a kind you do not know.
- `attempt_failed` is a failed run the retry policy queued again (`attempt`, `failure_class`, `error`, `retry_at`); the task is `scheduled` again, so it is not an outcome. The final `failed` event carries `attempts` and `failure_class`. See [Retries](#retries).
- `body_json`, `result_json`, `receipt_json` and `routing_decision` are internal: read a task's prompt, result and receipt with `tidegap queue show <id> --json`.
- Write nothing. Every change goes through the CLI, the MCP tools or the page.

### Sandboxed Bash {#handoff-sandbox}

The commands on this page open `~/.tidegap/queue.db` with write access: `tidegap queue add` writes the task, `tidegap queue wait` and `tidegap queue notices` record notices, and a WAL ledger needs write access to its side files even to read. A Bash tool whose sandbox does not allow writes to `~/.tidegap` cannot use them. Allow that folder in the sandbox, or queue with `schedule_task` and read the task with the `check_queue_status` MCP tool instead.
