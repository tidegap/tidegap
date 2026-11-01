---
id: handoff
label: Agent handoff
---

<!-- source: packages/cli/src/commands/queue-watch.ts, packages/cli/src/handoff/notices.ts, packages/claude-code-plugin/hooks/session-notice.sh, packages/core-ts/src/storage/sqlite.ts (listSessionNotices, claimNotice, the tasks and task_events tables), packages/core-ts/src/task-events.ts (TASK_EVENT_KINDS) -->
A Claude Code session can hand a task to Tidegap and get the outcome back in the same session. Nobody has to relay it. This page covers how the session hears that a task finished, how it watches or waits for a task, and what it may read from the ledger.

### Notices {#handoff-notices}

When a task that a session queued finishes, the next prompt of that session carries a notice. The plugin's `UserPromptSubmit` hook (`hooks/session-notice.sh`) adds it:

```text
Tidegap: 2 tasks queued from this session finished:
- t-3f2a completed "Nightly test run"
- t-9b1c failed "Review the API change"
Read one with: tidegap queue show <id> (or check_queue_status task_id=<id>).
```

- Each line names the task id, the status (`completed`, `failed` or `cancelled`) and the title in quotes, cut to 60 characters. A task that asked for a result file adds `result_path: <path>`, or "result file not written".
- The notice never holds the result or the error text. Read those with `tidegap queue show <id>` or `check_queue_status`.
- At most 10 tasks get a line. The rest are counted, and the next prompt names them.
- A notice covers tasks that finished in the last 7 days, and only tasks whose session the MCP server or the CLI checked when the task was queued. Tasks that finished before the first notice was ever looked for are not replayed.
- After the hook prints a notice, Tidegap records a `notified` event on each task it named and marks the task read. Each finish of a task gets one notice: a retried task that finishes again gets a new one.
- A notice can repeat when the ledger is busy or the hook is slow. Tidegap records it only when there was time to deliver it.
- When you open a task first (the page, the Mac app, Telegram, `tidegap queue show`), the session still gets its notice.

The tick daemon keeps the file `~/.tidegap/sessions/notices/<session_id>` while a session has a notice to hear. Without that file the hook exits in a few milliseconds and starts no `tidegap` process. A task that the Python core finished gets its file at the next run of `tidegap tick`, within a minute when the daemon runs.

`tidegap queue notices --peek --session <id>` prints a session's notice and records nothing. `tidegap queue notices --hook` is the plugin hook's command, and it trusts the `session_id` in its input. Any process of your user can call it for another session, as it can read the ledger.

### Watch or wait for a task {#handoff-watch}

`tidegap queue events <task-id>` prints the task's events, oldest first, one line each, led by the event id:

```bash
tidegap queue events t-3f2a --json
tidegap queue events t-3f2a --json --after 41   # only the events after event 41
```

The JSON is one object: `task_id`, `status`, `scheduled_for`, `deadline`, `completed_at`, `result_path` and `events` (each with `id`, `at`, `kind`, `actor` and `details`). The event `id` grows with each new event, so the last `id` you read is the cursor for `--after`.

`tidegap queue wait <task-id>` blocks until the task is completed, failed or cancelled, then prints the result text (or `error: …`). It checks the ledger every 2 seconds.

| Exit code | Meaning |
| --- | --- |
| 0 | The task completed. |
| 1 | The task failed or was cancelled. |
| 2 | A usage error, no task has that id, or the ledger could not be read. |
| 3 | `--timeout` passed first. The task is not changed. |

- `--timeout <when>` takes a duration (`9m`, `2h`) or an ISO-8601 time. Without it, `wait` has no limit.
- `--events` prints each new event to stderr while it waits. `--json` prints one object: `task_id`, `status`, `result`, `error`, `result_path` and `completed_at`.
- A `wait` that printed the outcome counts as the task's notice: it records `notified` and marks the task read. `--no-mark-read` skips both.
- When no tick has ever run, `wait` first prints why tasks will not run, as `tidegap status` does.

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
| Progress | No event yet. The status stays `running` until the task ends. |
| Done | The `completed`, `failed` or `cancelled` event. |
| Session told | The `notified` event, with `via` (`prompt` from the hook, `wait`, or `cli` from `tidegap queue notices`), `session_id` and the `completed_at` of the finish it told about. |

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
failed deferred replied notified
```

- `details` is a JSON object with snake_case keys. Skip a kind you do not know.
- `body_json`, `result_json`, `receipt_json` and `routing_decision` are internal: read a task's prompt, result and receipt with `tidegap queue show <id> --json`.
- Write nothing. Every change goes through the CLI, the MCP tools or the page.

### Sandboxed Bash {#handoff-sandbox}

The commands on this page open `~/.tidegap/queue.db` with write access: `tidegap queue wait` and `tidegap queue notices` record notices, and a WAL ledger needs write access to its side files even to read. A Bash tool whose sandbox does not allow writes to `~/.tidegap` cannot use them. Allow that folder in the sandbox, or read the task with the `check_queue_status` MCP tool instead.
