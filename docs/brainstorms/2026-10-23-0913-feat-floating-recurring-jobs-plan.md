---
title: Floating Recurring Jobs - Plan
type: feat
date: 2026-10-23
topic: floating-recurring-jobs
artifact_contract: ce-unified-plan/v1
product_contract_source: ce-brainstorm
execution: code
---

# Floating Recurring Jobs - Plan

## Goal Capsule

- **Objective:** A user can say "at least once a day, check my mail and tell me what matters" once, in the Tidegap page or to a coding agent, and from then on it happens by itself at the cleanest grid hour, unattended, with a receipt per run, and the user can see, pause and change it from any Tidegap surface. A coding agent that hears "schedule this" or "set up a cron" proposes Tidegap and schedules through it, never through `crontab` on its own.
- **Means:** a first-class job entity (rule + self-contained run template) that materializes one ordinary one-shot task per occurrence; a `command` runner for the fetch step so the LLM step needs no shell; host-side nudges (skill text, prompt hook, Bash guard) per agent.
- **Authority:** the owner's request (2026-10-23) decides what; the brainstorm decided every open point below because the owner was unavailable, and each decision carries its reason. Binding constraints: `docs/solutions/tooling-decisions/running-claude-p-from-a-daemon.md` (no `Bash`/`Write`/`Edit` for the LLM, never mix file and web tools, flags, env filter), `docs/solutions/logic-errors/repeat-series-and-replies.md` (rollover, forecast coverage), `docs/solutions/logic-errors/sleep-gap-is-not-a-dead-daemon.md`, `docs/solutions/logic-errors/daily-summary-fold-rule-and-partial-failure.md`, `docs/solutions/best-practices/channels-one-step-connect-secrets-file-and-atomic-lock.md`, `docs/spec/ui-client-api.md`, and the "tasks come from agents" rule (`docs/plans/2026-10-17-1533-feat-coherence-batch-plan.md` R20-R21), which this plan keeps for tasks and lifts for jobs (KD2).
- **Open blockers:** none that block planning. Four owner-only questions are listed under Outstanding Questions with the default this plan takes if he does not answer.

---

## Product Contract

### Summary

Tidegap gets jobs: a recurring rule ("daily", "weekdays", "weekly on Mon,Thu", "every 6 hours") with an optional local-time window, a run template that is complete without any agent session, and a history of runs. Each occurrence is an ordinary task, so the carbon window pick, the receipt, the channels and the daily summary all work as today. Jobs can be created and edited on the page and the CLI, and created by an agent through `schedule_task`. Claude Code, OpenCode, Codex and Cursor get text and hooks that make the agent propose Tidegap when the user asks to schedule something.

### Problem Frame

Today a repeating task exists only as a side effect of `schedule_task repeat: daily` from an agent. It copies the prompt of the first occurrence forever, cannot be paused or edited, has no window ("at night"), no view of its own, and no way to exist without an agent session that queued it. Its run is `claude -p` with read-only tools, so "check mail" or "look at the server logs" is impossible: the LLM has no shell by a hard rule, and nobody is there to answer a permission prompt. The owner's own examples (mail, server logs, nightly chores) are exactly what `cron` does, minus the clean hour and minus the receipts. And when he asks a coding agent to "schedule this", the agent writes a crontab entry, because nothing tells it Tidegap exists for that.

### Key Decisions

- KD1. **One recurrence concept for the user: a job.** `schedule_task repeat:` becomes sugar that creates a job; the series code path (`rollSeries`) is the implementation detail it rides on until planning decides whether to migrate it. Reason: two visible recurrence mechanisms (series and jobs) would diverge. Governs R1, R23.
- KD2. **Jobs may be created on the page and the CLI; tasks still may not.** The "tasks come from agents" rule exists because a task typed into the app has no execution context. A job carries its full context in the template (R7), so the reason does not apply. Reason: the owner asked for jobs "configurable inside the product (UI)". Governs R7, R24, R27.
- KD3. **Two cadence anchors, chosen by whether a window is set.** No window: run-anchored, next deadline = last run start + period, so "at least once per period" is exact. With a window: calendar-anchored, one occurrence per slot. Reason: the owner's words were "at least once per day, the program picks the time"; a night window needs a calendar, an "any time" job needs a guarantee. Governs R2, R3, R4.
- KD4. **The LLM never gets a shell; the job gets a `command` step instead.** A job's fetch step is a user-written command run by the daemon (ssh, mail fetch, a script); its output feeds an optional LLM step that has zero tools. Reason: this is the only shape that serves "check logs over ssh" and keeps `running-claude-p-from-a-daemon.md` intact; the LLM cannot act on injected text because it has nothing to act with. Governs R10, R11, R12, R13.
- KD5. **Secrets are referenced by name, never stored on the job.** The command step receives named entries from the Tidegap secrets file as environment variables. Reason: the channels secrets-file pattern already exists and is audited; the job row and the receipt stay printable. Governs R14.
- KD6. **A job auto-pauses after three consecutive failures and says so.** Reason: an unattended job that fails nightly burns budget and sends noise; the owner cannot be assumed to read every failure. Governs R16.
- KD7. **Native clients show, pause, resume and run; only the page and the CLI create and edit.** Reason: one form to keep correct; the Mac app opens the page in one click; parity cost of a second editor is not earned by v1. Governs R27, R28.
- KD8. **Agent-created jobs run fresh in the origin directory, not as a session fork.** Reason: the conversation that created a nightly job is not the context of its 30th run, and a growing session forked nightly costs tokens and hits the 150k cap. Governs R9.
- KD9. **Nudging is three layers per host: discoverable text, a prompt-time hint, and a guard on the cron command.** Reason: text alone is skipped by agents, a guard alone is too late (the agent already decided on cron); together they catch the request at each step. Governs R30-R36.
- KD10. **Agents create prompt jobs only; command jobs are authored by the user.** Reason: an agent writing a shell command that runs unattended forever is the risk the whole safety model avoids. Governs R23, R24.

### Actors

- A1. The owner (user) on the page, the CLI, the Mac app, the extension or Telegram.
- A2. A coding agent (Claude Code, OpenCode, Codex, Cursor, OpenClaw) that hears a scheduling request and calls Tidegap tools.
- A3. The tick daemon (launchd or systemd), which materializes occurrences, picks the hour, runs the steps and emits results.
- A4. The LLM runner (`claude -p` on the subscription login, or an API provider).

### Requirements

**Job model**

- R1. A job has an id, a title, a status (`active` or `paused`), a cadence, an optional window, a timezone, a run template, a notify level, caps, and a history of occurrences; one job is the only recurrence object the user sees.
- R2. Cadence vocabulary is `every N hours` (N from 2 to 168), `daily`, `weekdays`, and `weekly` on one or more weekdays; no cron expressions.
- R3. A window is an optional local-time span (for example `00:00-08:00`, which may cross midnight) in the job's timezone; it applies to `daily`, `weekdays` and `weekly`. Without a window the job may run at any time in its period.
- R4. The next occurrence's deadline follows KD3: without a window, `last run start + period`, with the earliest start at `last run start + period / 2`; with a window, the next calendar slot's end, with the earliest start at that slot's start. The page states the resulting guarantee in words ("runs every day between 00:00 and 08:00" or "runs at least every 24 h, never sooner than 12 h after the last run").
- R5. Exactly one pending occurrence exists per active job at any time; it is materialized when the job is created, resumed, edited, or when the previous occurrence ends. An occurrence is an ordinary task with the job's id on it, so it gets the existing window pick, receipt, events and channels.
- R6. Catch-up: when the daemon finds a job whose pending occurrence's deadline passed while the machine was off or asleep, it runs that occurrence once as soon as it can and re-anchors from that run; several missed slots give one run, never a burst.
- R7. The run template is complete without any live agent session: runner kind (`prompt` or `command`), prompt text, provider and model, working directory, tool policy, caps, and secret names; a job created from the page runs exactly like a job created by an agent.
- R8. Pause cancels the pending occurrence as a skip and stops materializing; resume materializes a new occurrence from now, never a backlog. Run now creates an occurrence that runs on the next tick and counts as the last run for anchoring. Remove ends the job and cancels its pending occurrence; history stays in the ledger.
- R9. A job created by an agent stores the origin directory and runs fresh in it with the existing read-only tool policy; it does not fork the origin session.

**Runners and safety**

- R10. `prompt` jobs run through the existing providers with the existing tool rules (`claude-code` allowlist `WebSearch, WebFetch, Read, Grep, Glob`, never mixed with file tools; API providers with no tools). Nothing in this plan loosens those rules.
- R11. `command` jobs run a user-written shell command (one string, POSIX `sh -c`) from the daemon in the job's working directory, with the daemon's filtered environment plus the secret names in R14, a timeout, an output cap, and an own process group that is killed as a group on timeout.
- R12. A `command` job may have a second step: an LLM prompt that receives the command's output as text and has no tools of any kind; its answer is the occurrence result. Without the second step the command's output is the result.
- R13. Caps live on the job and apply to every occurrence: LLM time limit (default 10 min), command time limit (default 5 min), LLM budget in USD for API and `claude-code` runs (default the adapter's current 1 USD), output cap 10 MB. The receipt records which cap stopped a run.
- R14. A job lists secret names; at run time the daemon reads those entries from the Tidegap secrets file and passes them to the command step as environment variables. The job row, the page, the CLI, logs and receipts never show a value; the result text is redacted for any value that appears in it.
- R15. A failed occurrence retries once after 30 minutes if time remains before its deadline; otherwise the job moves on to its next occurrence.
- R16. After three consecutive failed occurrences the job pauses itself, and a `task_failed`-class event says the job is paused and why; a resume clears the counter.
- R17. A job never has two occurrences running at once; if the previous occurrence is still running when the next window opens, the next waits.

**Carbon selection**

- R18. An occurrence's hour is chosen with the existing window pick (`selectWindow`), restricted to `[earliest start, deadline]` from R4; a flat or missing forecast behaves as today (equal-band random pick, or the earliest hour when no forecast covers the window).
- R19. An occurrence whose window starts beyond the forecast horizon stays unplanned until coverage exists, as a series successor does today.
- R20. Batch routing keeps its existing rule: an API-provider occurrence with more than 24 h left and no future earliest-start may go to the provider's Batch API; `claude-code` and `command` jobs never batch. The page shows "via Batch" when that happens.

**Results and notifications**

- R21. A job's notify level is `every run`, `failures only` or `summary only`; the default is `every run`. Results go through the existing channel events, so quiet hours and the daily summary fold rule apply unchanged.
- R22. The daily summary groups a job's occurrence under the job title (one line per job: last result, next run), not as an anonymous task.

**Surfaces**

- R23. MCP and OpenClaw `schedule_task` accept `repeat` with the R2 vocabulary plus an optional `window`, and create a prompt job (KD1, KD10); the reply names the job, its guarantee in words, and the time of the first run. `cancel_task series: true` ends the job. `check_queue_status` lists active jobs with next run and last result.
- R24. The CLI gets `tidegap jobs` with `list`, `show`, `add`, `edit`, `pause`, `resume`, `run`, `remove` and `history`; `add` and `edit` take flags and a JSON file, and `command` jobs can be created here.
- R25. The page gets a Jobs view beside Agenda, Timeline and Journal: a list (title, cadence and window in words, next run, last result, status) and a create/edit form (sketch below). The Agenda keeps showing occurrences as rows with the repeat badge.
- R26. The client API (`docs/spec/ui-client-api.md`) gains job routes for the page and the clients: list, get, create, update, pause, resume, run now, remove, and history; `GET /api/summary` gains a `jobs` count and the next job run.
- R27. The Mac app and the extension show the job list with next run and last result, and offer pause, resume and run now; "Edit" opens the page's form.
- R28. Telegram gains `/jobs` (list) and reacts to a job result like a task result; pause and resume from Telegram are not in scope.
- R29. Receipts and `tidegap verify` work per occurrence unchanged; `tidegap jobs history <id>` lists occurrences with their receipt ids.

**Agent-side nudging**

- R30. Trigger phrases, used by every host's text and hook: "schedule this", "every day", "every night", "every morning", "daily", "weekly", "every N hours", "once a day", "at least once a", "recurring", "cron", "crontab", "launchd", "launchctl", "systemd timer", "set up a job", and the Russian "каждый день", "каждую ночь", "по расписанию", "крон", "раз в день".
- R31. On a trigger, the agent proposes Tidegap in one line, asks one question that confirms cadence, window and what the job needs (read-only files, web, or a user-written command), then calls `schedule_task` with `repeat` for a prompt job, or shows the `tidegap jobs add` command for a command job. It never writes a crontab, launchd plist or systemd timer unless the user says "cron anyway", and then it says it is doing so.
- R32. Claude Code: the plugin skill description carries the R30 phrases; a `UserPromptSubmit` hook matches the prompt against R30 with a shell regex and injects a short context line that names Tidegap and the R31 steps; a `PreToolUse` hook on `Bash` with `crontab`, `launchctl load|bootstrap`, or `systemctl --user enable` returns `ask` with a reason that names Tidegap.
- R33. OpenCode: a skill (`~/.config/opencode/skills/tidegap/SKILL.md`) with the same description, an `opencode.json` MCP entry, and a `permission.shell` entry that asks on `crontab`; a plugin that injects the hint at prompt time is deferred (Scope Boundaries).
- R34. Codex: an `AGENTS.md` block and a `config.toml` MCP entry; Cursor: `.cursor/rules/tidegap.mdc` with a description and `mcp.json`; Gemini CLI: the same block for `GEMINI.md` and `settings.json`.
- R35. The site's install box gains a tab "Make your agent prefer Tidegap over cron" with a copyable, generic `AGENTS.md` block of at most 12 lines and the per-host snippets of R32-R34; the Tidegap docs page for jobs links it.
- R36. `tidegap install` prints the same block after installing the daemon, and `tidegap jobs` with no arguments prints the one-line way to get it.

### Key Flows

- F1. Create a job on the page
  - **Trigger:** A1 opens Jobs and presses New job.
  - **Steps:** fills title, cadence, window, runner, prompt or command, secret names, caps, notify level; the form shows the guarantee in words and the first planned run; Save stores the job and materializes the first occurrence (R5); the Agenda shows it.
  - **Covered by:** R1-R5, R7, R25, R26.
- F2. Nightly run of a `command` job
  - **Trigger:** A3 ticks; the pending occurrence's hour has arrived.
  - **Steps:** the daemon reads secret names from the secrets file (R14), runs the command in its own process group with the timeout (R11), feeds the output to the tool-less LLM step (R12), writes the receipt, emits `task_done` per the notify level (R21), materializes the next occurrence (R5), and the morning summary lists it under the job title (R22).
  - **Covered by:** R5, R11-R14, R21, R22.
- F3. An agent hears "schedule this"
  - **Trigger:** A1 types "every night check the deploy logs and tell me if anything broke" in Claude Code.
  - **Steps:** the prompt hook injects the hint (R32); the agent proposes Tidegap, asks the one confirming question (R31); because the job needs ssh, the agent shows `tidegap jobs add --command 'ssh deploy tail -n 500 /var/log/app.log' --summarize "..." --daily --window 00:00-08:00` for the user to run (KD10); if the job only needs read-only files or web, the agent calls `schedule_task` with `repeat: daily` and `window` (R23).
  - **Covered by:** R23, R24, R30-R32.
- F4. Machine asleep through the window
  - **Trigger:** the laptop is closed from 22:00 to 10:00; the window was 00:00-08:00.
  - **Steps:** the first tick after wake finds the deadline passed (R6), runs the occurrence once, re-anchors the next slot to the next night, and the daily summary says "ran late at 10:03".
  - **Covered by:** R6, R22.
- F5. Three failures in a row
  - **Trigger:** the ssh host is down for three nights.
  - **Steps:** each occurrence retries once (R15) and fails; after the third, the job pauses itself and the channel event says "job 'deploy logs' paused after 3 failures: ssh: connect timed out" (R16); the page shows the job as Paused with the reason; Resume clears the counter.
  - **Covered by:** R15, R16.

### Acceptance Examples

- AE1. **Covers R4.** Given a `daily` job with no window whose last run started at 03:10, when the next occurrence is materialized, then its earliest start is 15:10 the same day and its deadline is 03:10 the next day.
- AE2. **Covers R4.** Given a `weekdays` job with window `00:00-08:00` in `Europe/Berlin` whose last run was Friday 02:00, when the next occurrence is materialized, then it is Monday with earliest start Monday 00:00 and deadline Monday 08:00, both Berlin wall time.
- AE3. **Covers R3, R4.** Given a window `22:00-06:00`, when the slot for a day is computed, then it starts at 22:00 that day and ends at 06:00 the next day.
- AE4. **Covers R6.** Given a `daily` job whose pending occurrence's deadline passed 14 hours ago and whose next two slots also passed, when the daemon ticks, then exactly one occurrence runs now and the next pending occurrence is anchored from that run.
- AE5. **Covers R8.** Given a paused job, when the user presses Resume at 14:00, then one pending occurrence is materialized with earliest start 14:00 and no occurrence for the missed period.
- AE6. **Covers R10, R12.** Given a `command` job with a summarize step, when the LLM step runs, then the `claude -p` invocation has `--tools ""` and no `--allowedTools`, and the receipt records `tools: []`.
- AE7. **Covers R14.** Given a job with secret names `IMAP_PASSWORD`, when the occurrence runs, then the command's environment has `IMAP_PASSWORD` set from the secrets file, `tidegap jobs show` prints only the name, and a result containing the value shows `[redacted]`.
- AE8. **Covers R16.** Given two consecutive failed occurrences, when the third fails, then the job's status is `paused`, the reason is stored, and one failure event names the job and the reason.
- AE9. **Covers R17.** Given an occurrence still running when the next window opens, when the daemon ticks, then no second occurrence is dispatched until the first ends.
- AE10. **Covers R20.** Given a `weekly` job on provider `anthropic` with a 7-day window and no future earliest start, when the daemon ticks, then the occurrence may be submitted to the Batch API; given the same job on `claude-code`, then it never is.
- AE11. **Covers R23.** Given a Claude Code session calls `schedule_task` with `repeat: "daily"` and `window: "00:00-08:00"`, when the call returns, then the reply names the job id, says "runs every day between 00:00 and 08:00", and gives the first run's planned hour; the job's working directory is the session's project directory.
- AE12. **Covers R23, KD10.** Given an agent calls `schedule_task` with a `command` field, when the call is validated, then it is rejected with a message that names `tidegap jobs add`.
- AE13. **Covers R32.** Given the prompt "set up a cron that runs the tests every night", when the `UserPromptSubmit` hook runs, then it exits 0 within 100 ms and its context line names Tidegap and the three R31 steps; given the prompt "fix the typo in README", then it emits nothing.
- AE14. **Covers R32.** Given Claude runs `Bash` with `crontab -e`, when the `PreToolUse` hook runs, then the decision is `ask` and the reason names Tidegap; given `crontab -l`, then the decision is `allow`.
- AE15. **Covers R21, R22.** Given a job at notify level `every run` and a channel that receives the daily summary, when an occurrence finishes at 03:00 inside quiet hours, then the result arrives once, inside the 09:00 summary, under the job's title.

### UI sketch

Jobs view (page, fourth tab):

```
 Agenda   Timeline   Journal   Jobs                              [ New job ]

 ┌──────────────────────────────────────────────────────────────────────────┐
 │ ● Mail triage                                                 active     │
 │   every day, 00:00-08:00 · next Fri 02:00 (FR 41 g) · last: ok, 03:12   │
 │   "3 messages need a reply; invoice from Hetzner due Monday"            │
 │   [ Pause ] [ Run now ] [ Edit ] [ History ]                            │
 ├──────────────────────────────────────────────────────────────────────────┤
 │ ● Deploy logs                                                 active     │
 │   every day, any time · at least every 24 h · next ~Thu 22:00           │
 │   last: ok, Wed 21:40 · command + summary                                │
 ├──────────────────────────────────────────────────────────────────────────┤
 │ ○ Weekly dependency audit                                     paused     │
 │   weekly Mon · paused after 3 failures: ssh: connect timed out          │
 │   [ Resume ] [ Edit ] [ History ] [ Remove ]                            │
 └──────────────────────────────────────────────────────────────────────────┘
```

Create/edit form (drawer, same component the task drawer uses):

```
 New job                                                          [ × ]

 Title        [ Mail triage                          ]

 Cadence      (•) daily  ( ) weekdays  ( ) weekly  [Mon][Tue][Wed][Thu][Fri][Sat][Sun]
              ( ) every [ 6 ] hours
 Window       [x] only between [ 00:00 ] and [ 08:00 ]   Timezone [ Europe/Berlin ▾ ]
              → runs every day between 00:00 and 08:00, at the cleanest hour

 Runner       (•) command + summary   ( ) prompt only
 Command      [ himalaya envelope list --page-size 50 --output json ]
 Secrets      [ IMAP_PASSWORD ] [+]        (names from the Tidegap secrets file)
 Directory    [ ~                                    ]
 Summary      [ Read the JSON. Say which messages need a reply today and why. ]
   Provider   [ claude-code ▾ ]  Model [ default ▾ ]   (no tools in this step)

 Caps         command [ 5 ] min · LLM [ 10 ] min · budget [ 1.00 ] USD
 Notify       (•) every run  ( ) failures only  ( ) summary only

 First run    Fri 02:00, FR 41 g CO2/kWh (cleanest hour in the window)

                                                     [ Cancel ]  [ Save ]
```

For `prompt only`: the Command, Secrets and Summary rows are replaced by Prompt, Tools (`none` / `read-only files` / `web`), Directory.

### Surfaces matrix

| Surface | See jobs | Create | Edit | Pause / resume | Run now | Remove | History | Nudge |
|---|---|---|---|---|---|---|---|---|
| Page (`tidegap ui`) | yes | yes (prompt and command) | yes | yes | yes | yes | yes | - |
| CLI `tidegap jobs` | yes | yes (prompt and command) | yes | yes | yes | yes | yes | prints the snippet |
| MCP `schedule_task` / `check_queue_status` / `cancel_task` | list | prompt jobs only | no | no (v2) | no (v2) | end via `cancel_task series` | no | tool descriptions |
| OpenClaw plugin | list | prompt jobs only | no | no | no | end via `cancel_task series` | no | tool descriptions |
| Mac app | yes | no (opens page) | no (opens page) | yes | yes | no | last result | - |
| Extension | yes | no (opens page) | no (opens page) | yes | yes | no | last result | - |
| Telegram | `/jobs` | no | no | no | no | no | result messages | - |
| Claude Code plugin | - | via MCP | - | - | - | - | - | skill text, prompt hook, Bash guard |
| OpenCode | - | via MCP | - | - | - | - | - | skill, MCP config, shell permission |
| Codex, Cursor, Gemini | - | via MCP | - | - | - | - | - | AGENTS.md / rules block, MCP config |
| Site install box | - | - | - | - | - | - | - | generic block + per-host snippets |

### Scope Boundaries

**v1 (ship first, in this order)**

1. Job model, cadence, window, timezone, anchoring, catch-up, pause, resume, run now, remove, history; occurrences as tasks (R1-R9, R17-R20).
2. `command` runner with the tool-less summarize step, secret names, caps, retry, auto-pause (R10-R16).
3. CLI `tidegap jobs` and the client API routes (R24, R26); page Jobs view and form (R25); summary grouping and notify level (R21, R22, R29).
4. `schedule_task repeat` + `window` on MCP and OpenClaw (R23); Mac app and extension list and pause/run (R27); Telegram `/jobs` (R28).
5. Nudging: Claude Code plugin skill text and two hooks (R32); OpenCode skill and config snippets (R33); Codex, Cursor, Gemini blocks (R34); site tab and `tidegap install` print (R35, R36).

**Deferred for later (v2)**

- Per-job MCP servers for the LLM step (a mail MCP, an ssh MCP) with an explicit per-job grant and a warning when a write-capable server meets an untrusted-input server.
- Per-job channel choice (today channels subscribe globally).
- macOS Keychain references for secrets, in addition to the secrets file.
- "Skip if missed" catch-up policy as a per-job toggle; end date and occurrence count.
- MCP tools `pause_job`, `resume_job`, `run_job_now`; an OpenCode plugin that injects the hint at prompt time (`experimental.chat.system.transform`) and asks on `crontab` (`tool.execute.before`).
- Full job editor in the Mac app and the extension.
- Python core parity for materializing occurrences (today it stores series columns and does not roll).
- Migrating pre-existing series rows to jobs; retiring `rollSeries` once no live series remain.
- Import from an existing crontab ("paste your crontab, get jobs").
- Pause and resume from Telegram.

**Non-goals (outside this feature)**

- Cron expressions as the job model: a job floats; a user who needs an exact minute uses a one-hour window.
- `Bash`, `Write` or `Edit` for the LLM step in any job.
- Jobs that run on another machine, or a central job server.
- Job chains, dependencies between jobs, or passing one job's output to another.
- Interactive jobs that wait for a human answer mid-run.

### Dependencies / Assumptions

- The daemon is installed and ticking (`tidegap install`); readiness already warns when it is not. A job cannot run otherwise, and the Jobs view shows the readiness warning at the top when the daemon is missing.
- On macOS the daemon's `node` has Files & Folders access when a job's directory or `~/.claude/skills` points under `~/Documents` (`running-claude-p-from-a-daemon.md`); the Jobs form shows the hint once when a chosen directory is under `~/Documents`, `~/Desktop` or `~/Downloads`.
- A `command` job that uses ssh relies on the user's `~/.ssh/config` and a key the daemon can read without an agent socket (launchd gives no `SSH_AUTH_SOCK`); the docs page for jobs says so.
- The LLM step uses the subscription login as today; a usage-limit deferral moves the occurrence as it moves a task.
- The 72-hour forecast horizon and the existing replan sweep are enough for daily and weekly windows; longer `every N hours` values (up to 168) stay unplanned until coverage, as series successors do today.

### Risks

| Risk | Mitigation in this plan |
|---|---|
| launchd TCC prompt hangs `claude -p` silently | R13 time cap; the form hint and the existing first-line Files & Folders hint on timeout; a `command`-only job needs no `claude` start |
| Cost runaway from a job that fails or loops nightly | R13 per-occurrence budget, R15 one retry, R16 auto-pause after three failures, R17 no overlap; the usage pill already shows spend |
| Duplicate runs around sleep or two ticks after wake | R5 exactly one pending occurrence; the existing compare-and-set on `running`; R6 one catch-up run; `sleep-gap-is-not-a-dead-daemon.md` keeps readiness quiet |
| DST and clock changes | windows are computed in the job's timezone wall time; a non-existent local hour (spring forward) clamps to the next valid minute, a repeated hour (fall back) is one slot; tests follow `time-of-day-bugs-and-fake-time-sweeps.md` |
| Prompt injection through command output (mail bodies, logs) | R12 tool-less LLM step; the only exit is the result text on the user's own channels |
| A secret leaks through the result or a log line | R14 redaction of known values; the secrets file is 0600 with the atomic lock; names only in the row |
| A stale origin directory (repo moved or deleted) | the occurrence fails with the path in the reason; R16 pauses the job after three |
| Hook latency or noise in Claude Code | R32 hooks are shell regex, exit 0 in milliseconds, emit nothing on no match; the Bash guard uses `ask`, never `deny` |
| Forecast missing or feed down | R18 falls back to the existing behaviour; receipts mark `gridSource: mock` as today |

### Outstanding Questions

**Resolve Before Planning** — owner-only; each has the default this plan takes if unanswered.

1. Default notify level for a job: `every run` (this plan) or `summary only`? Default: `every run`, because "check mail and tell me" expects the result.
2. May an agent create `command` jobs after a confirmation step, or never (KD10)? Default: never; the agent shows the CLI line.
3. Should `every N hours` allow N below 2 (hourly polling)? Default: no; each run is a provider call and the carbon pick has no room inside one hour.
4. Window for "every night" when the agent is not told one: `00:00-08:00` local, or any time? Default: the agent asks (R31); if the user says "night", the agent uses `22:00-08:00`.

**Deferred to Planning**

- Whether `rollSeries` becomes the job materializer or jobs get their own materializer that reuses `nextPeriod`, and whether existing series rows are migrated in v1 or left to finish.
- The job table shape and the ledger migration (`shared-sqlite-ledger-migrations.md`).
- Exact JSON shape of the client API job routes and the `jobs` field in `/api/summary`.
- Whether the `command` step runs through the existing adapter contract (`providers/base.ts`) as a new provider or as a pre-step owned by the scheduler.
- How the summarize step is spelled in the MCP reply and the receipt (`steps: [command, prompt]`).
- Whether the hooks ship as scripts in the plugin's `bin/` or inline in `hooks.json`.
- Docs-drift claims for the new README lines and the jobs docs page.

### Sources / Research

- Existing repeat series: `packages/core-ts/src/scheduler.ts` (`rollSeries` ~1040, `nextPeriod` ~2975, `isBatchCandidate` ~874, `cancelTask` series ~1160), `packages/core-ts/src/select-window.ts:88`, `docs/solutions/logic-errors/repeat-series-and-replies.md`, CHANGELOG 0.17.0 "Repeating tasks".
- Task model and origin: `packages/core-ts/src/types.ts` (`repeat` ~85, `originCwd` ~316, `originSessionId` ~333, `ProviderCallSpec.tools` ~409), `docs/plans/2026-10-17-1953-feat-origin-session-plan.md`, `packages/mcp-server/src/origin.ts`.
- Runner rules: `docs/solutions/tooling-decisions/running-claude-p-from-a-daemon.md`, `packages/cli/src/providers/claude-code.ts`, `packages/core-ts/src/claude-tools.ts`, `packages/cli/src/session/plan.ts`.
- Tool surface: `packages/core-ts/src/tool-surface.ts` (`schedule_task` 333-504, `repeat` 465), `docs/solutions/tooling-decisions/tool-surface-shared-descriptions.md`.
- UI and clients: `packages/cli/ui/{agenda,timeline,journal,detail,row}.js`, `packages/cli/src/ui/api.ts` (`/api/series/:id` 354-380, `POST /api/tasks` 559), `docs/spec/ui-client-api.md`, `docs/plans/2026-10-17-1533-feat-coherence-batch-plan.md` (R20-R21, no task creation on the page).
- Channels and summary: `packages/core-ts/src/channels/types.ts`, `packages/core-ts/src/channels/digest.ts`, `docs/solutions/logic-errors/daily-summary-fold-rule-and-partial-failure.md`, `docs/solutions/best-practices/channels-one-step-connect-secrets-file-and-atomic-lock.md`.
- Daemon: `packages/cli/src/commands/tick.ts`, `packages/cli/src/commands/install.ts` (300 s interval), `docs/solutions/logic-errors/sleep-gap-is-not-a-dead-daemon.md`, `docs/solutions/tooling-decisions/claude-usage-limits-source-and-deferral.md`.
- Claude Code plugin: `packages/claude-code-plugin/{commands/defer.md,hooks/hooks.json,skills/tidegap/SKILL.md}`; hooks reference https://code.claude.com/docs/en/hooks (`UserPromptSubmit` gets `prompt`, injects `additionalContext`; `PreToolUse` `permissionDecision: ask` with an `if: Bash(crontab *)` filter); a plugin cannot ship `CLAUDE.md` (https://code.claude.com/docs/en/plugins-reference).
- OpenCode: https://opencode.ai/docs/mcp-servers/ (`mcp.<name>.type: local`, `command: []`), https://opencode.ai/docs/rules/ (`AGENTS.md`, global `~/.config/opencode/AGENTS.md`), https://opencode.ai/docs/skills/ (`~/.config/opencode/skills/<name>/SKILL.md`, `name` + `description`), https://opencode.ai/docs/permissions/ (`permission.shell`, bare and `*` patterns both needed), https://opencode.ai/docs/plugins/ (`tool.execute.before`; `experimental.chat.system.transform` only in `@opencode-ai/plugin` typings).
- Codex: https://learn.chatgpt.com/docs/agent-configuration/agents-md (`~/.codex/AGENTS.md`, 32 KiB cap), https://learn.chatgpt.com/docs/extend/mcp?surface=cli (`[mcp_servers.<name>]` in `config.toml`), https://learn.chatgpt.com/docs/hooks (`UserPromptSubmit`, `PreToolUse` with `permissionDecision`).
- Cursor: https://cursor.com/docs/context/rules (`.cursor/rules/*.mdc`, `description`, `alwaysApply`; reads `AGENTS.md`), https://cursor.com/docs/context/mcp (`mcpServers` in `.cursor/mcp.json`). Gemini CLI: https://geminicli.com/docs/cli/gemini-md/, https://geminicli.com/docs/tools/mcp-server/. AGENTS.md support list: https://agents.md.
