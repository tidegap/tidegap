<img src="https://www.tidegap.com/icon-192.png" alt="Tidegap" width="48" height="48">

# Claude Code plugin — Tidegap

A one-command install that turns any Claude Code session into a
carbon-aware AI scheduler. Defer non-urgent LLM tasks (overnight
summaries, batch analyses, scheduled compliance scans) to cheap
off-peak windows — ~50 % cost savings via Anthropic / OpenAI Batch
APIs (projected, provider list price), lower carbon than running
immediately (the saving depends on region and day — see
[docs/claims.md](../../docs/claims.md)), an auditable carbon receipt for every dispatch.

This package is **not** published to npm. It's the plugin tree that
Claude Code's marketplace clones into
`~/.claude/plugins/marketplaces/`. The marketplace listing at the repo
root (`.claude-plugin/marketplace.json`) points to this folder via
`"source": "./packages/claude-code-plugin/"`.

## Install

```bash
# 1. Add the marketplace (this repo).
/plugin marketplace add tidegap/tidegap

# 2. Install the plugin.
/plugin install tidegap
```

On Claude Code 2.1.275 or later, one step does both:
`/plugin install tidegap --marketplace tidegap/tidegap`.

Upgrading from the 0.17 `ebb-ai` plugin: there is no in-place update,
because the marketplace and plugin names changed. Run
`/plugin uninstall ebb-ai` and `/plugin marketplace remove ebb-ai` first,
then the steps above. The commands are now `/tidegap:*`.

Restart the Claude Code session — the plugin is live.

The plugin auto-wires the `tidegap` MCP server via `npx -y @tidegap/mcp`
on first invocation, so no separate `claude mcp add` step is needed.

## Slash commands (10)

| Command                              | Purpose                                                |
|--------------------------------------|--------------------------------------------------------|
| `/tidegap:defer <task> --by <when>`   | Queue a deferrable LLM task at the cleanest grid hour. `--llm-timeout <duration\|none>` sets its time limit ([run limits](https://www.tidegap.com/docs#limits)). |
| `/tidegap:plan <task> --by <when>`    | Preview the chosen window without queueing.            |
| `/tidegap:check [<id>\|--all]`        | List all tasks or detail one (with carbon receipt).    |
| `/tidegap:cancel <id> \| --all`       | Cancel a queued/scheduled task. Idempotent.            |
| `/tidegap:expedite <id>`              | Dispatch immediately, bypass the chosen window.        |
| `/tidegap:reschedule <id> --by <new>` | Change the deadline and re-score the window.           |
| `/tidegap:retry <id>`                 | Re-dispatch a task currently in `failed` status.       |
| `/tidegap:grid <zone>`                | Show current intensity + 24-hour forecast, no task.    |
| `/tidegap:later <id> <preset\|time>`  | Run a queued task later: 1h, tonight, tomorrow_morning, after_limit_reset, or a time. |
| `/tidegap:usage [--spend]`            | Show Claude Code 5-hour and weekly limit use.          |

Recurring work runs as a job: `schedule_task` with `repeat` creates one, and the hooks below steer agents away from cron.

## Auto-invocation skill

`skills/tidegap/SKILL.md` is the agent contract: what a task is, when to
defer, recurring jobs, how results come back, when a task runs, hand-offs,
and every command and tool. Docs-drift K22 keeps its four core facts in
place.

The skill tells the agent **when** to reach for `/tidegap:defer`
automatically — for example when the user says any of: "do this later",
"by tomorrow", "tonight", "overnight", "by EOD", "sometime this week",
"when you have a moment", "remind me to", "queue this up", "schedule
this", "no rush", "not urgent". Convert that phrasing to a deadline and route the
task through Tidegap instead of dispatching synchronously.

## Session hooks

`hooks/hooks.json` registers six things:

- **At session start:** one line about finished tasks nobody has read. For
  the tasks this session queued, it names their ids, status, whether they
  ran in a copy of the session or fresh, and the command that opens the
  copy. It never prints a task's title, prompt or reply. Silent when nothing
  is unread or the `tidegap` CLI is not installed.
- **At session start and end:** `hooks/session-capture.sh` keeps
  `~/.tidegap/sessions/claude-<pid>.json` current for the running Claude
  Code process (`<pid>` is that process). The file (mode 0600, directory
  0700) holds the hook input Claude Code sends (`session_id`,
  `transcript_path`, `cwd`, `source`), `CLAUDE_PROJECT_DIR` and the time.
  The MCP server reads it when a task is queued, so the task runs later in
  a copy of this session, in its project directory. The script needs only
  `sh` and `ps`, prints nothing and always exits 0. At session end it
  deletes the file; a file left by a process that no longer runs is
  removed at the next session start.
- **When you send a prompt:** `hooks/prompt-hint.sh` checks the prompt for
  recurring-work phrases ("every night", "daily", "every 6 hours", "set up
  a cron", "crontab", "launchd", "systemd timer", "каждый день", "по
  расписанию", "крон"). On a match it adds one context line: propose
  Tidegap, ask one question (cadence, window, what the job needs), then
  `schedule_task` with `repeat` for a prompt job or show
  `tidegap jobs add --command ...` for a command job; no cron unless you
  say "cron anyway". It prints nothing otherwise.
- **When you send a prompt, after a task finished:** `hooks/session-notice.sh`
  adds one notice when tasks this session queued have finished, such as
  `Tidegap: 1 task queued from this session finished:` and a line per task
  with its id, status, quoted title and result file, never its result or
  error. It then records that the session saw the task (a `notified` event)
  and marks it read, so each finish is told once. A notice can repeat when
  the ledger is busy or the hook is slow, because it is recorded only when
  there was time to deliver it. A retried task that finishes again gets a
  new notice. The tidegap tick keeps
  `~/.tidegap/sessions/notices/<session_id>` while there is something to say;
  without that file the script exits without starting `tidegap`. With an
  older `tidegap` it prints nothing.
- **When a turn ends, for a task queued with a wake:** `hooks/session-wake.sh`
  (a `Stop` hook that runs in the background, `asyncRewake`, timeout 12
  hours) wakes this session when such a task finishes while the session
  sits idle. A task gets a wake from `tidegap queue add --wake` or
  `schedule_task` with `wake_session: true`, which also writes
  `~/.tidegap/sessions/wake/<session_id>`. Without that file the script
  exits at once without starting `tidegap`. With it, it runs
  `tidegap queue notices --wait --rewake`, which waits (while this
  session's `claude` process runs, at most 11 h 50 min) and, when a wake
  task finished, prints the notice to stderr, records it (`via: "rewake"`)
  and exits 2, so the session starts a turn with the notice. Every other
  outcome exits 0 without output, and the notice comes with the next
  prompt. A wake spends a model turn, so it is off unless asked for.
- **Before a Bash call:** `hooks/cron-guard.sh` asks you first (it never
  blocks) when the command edits a crontab (`crontab -e`, `-r`, a file or
  stdin), runs `launchctl load` or `bootstrap`, runs
  `systemctl --user enable`, or authors a Tidegap command job
  (`tidegap jobs add` or `edit` with `--command` or `--file`,
  `tidegap jobs secrets set`), or queues a one-off task with
  `tidegap queue add` and a `--runner` that is not plainly an LLM runner
  (`--runner command`, and also a quoted, variable or substituted value):
  shell commands are your decision, not the agent's, and they run
  unattended in the daemon. `crontab -l` and everything else pass
  untouched. Under `bypassPermissions` the question may not stop the
  call: the guard asks, it is not a sandbox.

The scripts are POSIX `sh`, read only the prompt, the command or the
session id from the hook input, use no network, write no files and exit
0, except a wake: `session-wake.sh` exits 2 to wake the session, and only
with a notice. The ledger write of a notice is the CLI's
(`tidegap queue notices --hook` or `--wait --rewake`), never the script's.

See "Run in the session that asked" in the main README.

## Persistence

Tasks queued via `/tidegap:defer` are persisted to `~/.tidegap/queue.db`
(SQLite) by default. The queue survives Claude Code restarts and is
shared across MCP hosts (Claude Code, Claude Desktop, Cursor,
OpenClaw, etc.) — defer on one host, check on another.

Inspect from the CLI:

```bash
npx -y @tidegap/cli stats
npx -y @tidegap/cli queue list
```

Override the path via `TIDEGAP_DB_PATH=/some/where/queue.db` in the
plugin's `.mcp.json` env block. Use `TIDEGAP_DB_PATH=:memory:` to opt out
of persistence (mainly for tests).

## Actually dispatching tasks

The MCP server **queues** tasks but does not run a clock. Actual
dispatch at the chosen window requires the **`tidegap tick` daemon**:

```bash
npm install -g @tidegap/cli
tidegap install      # registers launchd (macOS) / systemd (Linux) cron-tick
tidegap queue list   # confirm tasks are visible and dispatching
```

Until the daemon is installed, tasks sit queued and can be dispatched
manually with `tidegap tick --once`. The plugin-install path does not
auto-install the daemon (it would create system-level state without
explicit opt-in).

## Session start line

The plugin registers a `SessionStart` hook (`hooks/hooks.json`). When
finished tasks are waiting unread, a new session starts with one line
such as ``2 unread Tidegap tasks, run `tidegap ui` to read them.`` It prints
nothing when nothing is unread or when the `tidegap` CLI is not on `PATH`.
The line holds only the count, never task text.

## Result delivery

When a task this session queued finishes, the next prompt carries the
session notice (see "Session hooks"), and a task queued with `--wake`
(`wake_session: true`) wakes an idle session. The notice names the task,
never its result. Three options to get the result itself:

1. **Poll.** `/tidegap:check <task_id>` returns the LLM response under
   `result` once the receipt is written.
2. **File output.** Pass `--output <abs-path>` at defer time. The
   dispatcher writes `{ taskId, result, receipt }` as JSON to that
   path on completion. Pair with `tail -f` or a file-watcher. Or pass
   `--result-path <new file>` to `tidegap queue add` (`result_path` on
   `schedule_task`): Tidegap writes the result text to that new file.
3. **Watched folder.** Point `--output` at a file in this project or the
   temp folder (`~/.tidegap` and other protected folders are refused) and
   wire a tiny `fswatch` / `entr` loop to forward to Telegram, email,
   macOS notifications — your choice.

## Example

```
> /tidegap:defer "Summarize today's GitHub notifications" --by 4h --region US-CAL-CISO
Deferred ✓
  task id        7f3a2b9e
  scheduled for  in 3h, 22:15 UTC
  band           clean
  check status   /tidegap:check 7f3a2b9e
```

Three hours later:

```
> /tidegap:check 7f3a2b9e
status     completed
region     US-CAL-CISO
scheduled  22:15 UTC (4h ago)
completed  22:15:08 UTC
result     <the summary>
```

(Illustrative CLI output — carbon and savings figures are omitted
here; see a real captured run in
[`docs/examples/2026-09-30-GB-tick/`](../../docs/examples/2026-09-30-GB-tick/).)

## Without the plugin

If you only want the MCP server (no slash commands, no skill), wire it
directly into your MCP host. From Claude Code:

```bash
claude mcp add tidegap npx -- -y @tidegap/mcp
```

You get the twelve MCP tools (`schedule_task`, `recommend_window`,
`check_queue_status`, `cancel_task`, `cancel_all`, `update_deadline`,
`postpone_task`, `expedite_task`, `retry_task`, `reply_task`,
`get_grid_forecast`, `tidegap_usage`) and the server instructions, but not
the slash-command shortcuts or the `tidegap` auto-invocation skill.

## Files

- `.claude-plugin/plugin.json` — plugin manifest (name, description,
  version, auto-invocation trigger language)
- `.mcp.json` — MCP server wiring (runs `npx -y @tidegap/mcp`)
- `commands/*.md` — the ten slash commands
- `skills/tidegap/SKILL.md` — the agent contract and when-to-auto-invoke skill
- `hooks/hooks.json` — the SessionStart unread line, session capture, the
  recurring-work prompt hint, the session notice, the session wake and the
  cron guard

`/tidegap:defer` passes `origin_session_id: "${CLAUDE_SESSION_ID}"`, so a
deferred task remembers the conversation it came from; `tidegap ui` and
`tidegap queue show` print the `claude --resume` command for it. `--repeat
daily|weekdays|weekly|every_n_hours` makes a job (default: a one-off).

## Related packages

- `@tidegap/core` — scheduling logic, grid feeds, SQLite ledger
- `@tidegap/mcp` — MCP server (used by this plugin and any other host)
- `@tidegap/cli` — `tidegap stats`, `tidegap tick`, `tidegap install`, `tidegap queue`
- `@vitalini/tidegap` (OpenClaw plugin) — same surface, native OpenClaw tools

## License

Apache-2.0. See [`../../LICENSE`](../../LICENSE).
