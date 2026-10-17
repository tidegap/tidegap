<img src="https://www.tidegap.com/icon-192.png" alt="Tidegap" width="48" height="48">

# @tidegap/cli

> Renamed from `@ebb-ai/cli` in 0.18.0. The `ebb` command and the `EBB_*` variables were removed in 0.19; use `tidegap` and `TIDEGAP_*`. If npm reports `EEXIST` on install, run `npm uninstall -g @ebb-ai/cli` first. See [Renamed from Ebb AI](https://github.com/tidegap/tidegap#renamed-from-ebb-ai).

**The `tidegap` command: runs your queued Tidegap tasks when their cleanest grid hour arrives.**

`tidegap` drains the Tidegap task queue on a timer. A task that your agent deferred runs at the lowest-carbon hour before its deadline, also when no agent session is open.

- `tidegap tick` dispatches every task that is due. `tidegap install` writes and loads it as a launchd agent (macOS) or systemd timer (Linux); `tidegap status` says whether queued tasks will run.
- `tidegap queue list` and `tidegap receipts list` show queued tasks and their carbon receipts.
- `tidegap verify <task-id>` checks a receipt's Ed25519 signature offline.

```bash
npm install -g @tidegap/cli
```

```bash
tidegap install                   # run `tidegap tick` on a schedule (picks --laptop on a Mac with a battery)
tidegap status                    # will queued tasks run? exit 1 when not
tidegap queue list                # what is waiting, and for which hour
tidegap tick --region GB          # dispatch what is due now
tidegap receipts list             # one carbon receipt per completed task
tidegap verify <task-id>          # check the receipt signature
```

Proof: one real GB run, 2026-09-30 (`tidegap tick` + `tidegap verify`). Forecast peak 183 gCO2/kWh vs recommended window 88 gCO2/kWh, about 52 % lower for this run only (forecast, projected). The task had a 5-minute deadline and ran at once; its receipt records 158 gCO2/kWh (measured). Raw output: https://github.com/tidegap/tidegap/tree/main/docs/examples/2026-09-30-GB-tick

## Commands

```text
tidegap tick           — drain due tasks via provider adapters; one OS notification per finished task (--no-notify, or TIDEGAP_NO_NOTIFY=1)
tidegap install        — write and load the daemon: launchd (macOS), systemd (Linux); print a schtasks template (Windows). --laptop | --server (default: by battery), --no-load
tidegap status         — will queued tasks run? daemon, last tick, runners, pending tasks; exit 0 ready, 1 not (--json)
tidegap queue list     — print tasks (--unread, --kind absolute|quota_reset, --json, --hook)
tidegap queue show     — print one task's prompt, result and receipt; marks it read
tidegap queue unread   — mark a task unread again
tidegap queue cancel   — cancel a pending task (--series ends a repeating series)
tidegap queue later    — push a task later, never earlier: --until <+2h|tonight|tomorrow|tomorrow HH:MM|HH:MM|ISO|after-limit-reset>, --preset <1h|tonight|tomorrow_morning|after_limit_reset>, or --delay <minutes>; --reset-at <HH:MM|ISO>
tidegap queue reschedule — move a task: --at <ISO>, --day <yyyy-mm-dd>, or --after-limit-reset; --by <2h|ISO> is an alias of `later --until`
tidegap queue run-now  — mark a task due; the next tick runs it
tidegap queue reply    — continue a completed task as a new task (--by, default 1h)
tidegap receipts list  — print carbon receipts for completed tasks
tidegap stats          — local-only personal-impact stats from the queue ledger
tidegap usage          — Claude Code 5-hour and weekly limits and their resets (--json)
tidegap usage hook     — Claude Code statusLine command that records the limits (-- <your statusline command>)
tidegap verify         — verify the Ed25519 signature on a carbon receipt
tidegap register-wake  — schedule a macOS wake event 30s before a task
tidegap ui             — local task page: agenda, journal, timeline, task detail and actions (127.0.0.1 only; port 47821 by default)
tidegap clients add    — mint a token for the browser extension or the Mac app (--name, --kind extension|macos, --json)
tidegap clients list   — list client ids, kinds and names (never tokens)
tidegap clients revoke — remove a client; its token stops working on the next request
tidegap channels add   — pair a Telegram chat (`add telegram`, one-time code) and load the listener unit (--no-load)
tidegap channels list  — list the paired channels (--json)
tidegap channels remove — remove a channel; the last telegram channel unloads the listener
tidegap channels serve — the Telegram listener the unit runs (--once: one poll cycle)
```

Run `tidegap <command> --help` for flags.

`tidegap clients add` prints a `tgc_…` token once; store it then. The registry
`~/.tidegap/ui-clients.json` (mode 0600) keeps only the token's SHA-256.
A client token works only against `tidegap ui` on 127.0.0.1, survives restarts
and is never accepted on the client-management routes. The contract the
extension and the Mac app code against is `docs/spec/ui-client-api.md`.

The write commands and `tidegap ui` change the ledger only; `tidegap tick` (or the
OpenClaw loop) runs the task, and each command prints when the last tick ran.
`--day` and a repeating task's next occurrence can lie beyond the 72-hour
forecast. Such a task waits at a fallback hour (its current time of day, in
the new day) until a tick re-plans it once the forecast covers the day. If no
tick runs in that time, it runs at the fallback hour without a carbon choice.

## Quickstart — keep tasks alive across laptop sleep

```bash
tidegap install --laptop
# writes and loads the agent, then prints the `tidegap status` lines
```

`tidegap install` resolves the daemon's invocation at install time to the exact
node interpreter plus the real `tidegap` entry (`[process.execPath,
realpath(argv[1])]`), so the launchd job / systemd unit does not depend on a
bare `PATH` or a `#!/usr/bin/env node` shebang. Set `TIDEGAP_BINARY` to override
with a single wrapper executable.

## Secrets

> **Scope:** the environment variables below configure **this CLI** (and the
> `@tidegap/mcp` server, which reads the same set). The CLI reads them at its own
> entry point and injects them into `@tidegap/core`, which is environment-pure.
> The `@vitalini/tidegap` **OpenClaw plugin reads no environment variables at all** —
> configure it under `plugins.entries.tidegap.config` in your gateway config
> (`anthropicApiKey`, `openaiApiKey`, `geminiApiKey`/`googleApiKey`,
> `ollamaHost`, `ollamaModels`, `eiaApiKey`, `electricityMapsApiKey`,
> `entsoeSecurityToken`, `wattTimeUsername`/`wattTimePassword`, `carbonBudgetG`,
> `carbonBudgetWindow`). OpenClaw resolves the `"${ENV_VAR}"` shorthand in those
> fields, so you can keep exporting the same variables and let the gateway read
> them on the plugin's behalf.

Provider (and grid-feed) API keys live in `~/.config/tidegap/env` — `KEY=VALUE`
lines, created `0600` with a commented template on first `tidegap install`. Both
`tidegap tick` (loads it at startup) and the systemd unit (`EnvironmentFile=`)
read it, so launchd, systemd, and manual cron all pick up keys the same way:

```
ANTHROPIC_API_KEY=sk-...
OPENAI_API_KEY=sk-...
GEMINI_API_KEY=...        # or GOOGLE_API_KEY — Gemini (generativelanguage.googleapis.com)
OLLAMA_HOST=http://localhost:11434   # local Ollama; presence opts the ollama provider in
TIDEGAP_TELEGRAM_BOT_TOKEN=123:abc   # a bot used only by Tidegap; TELEGRAM_BOT_TOKEN is the fallback
```

Providers: `anthropic` and `openai` are batch-capable (their tasks can
auto-route through a 50%-cheaper Batch API — projected, provider list
price); `gemini` and `ollama` are
sync-only. Gemini reads `GEMINI_API_KEY`, falling back to `GOOGLE_API_KEY`.
Ollama is local and keyless — set `OLLAMA_HOST` (default `http://localhost:11434`)
to enable it; optionally list local model ids in `OLLAMA_MODELS` (comma-separated)
so `schedule_task` can infer the `ollama` provider from a bare model name.

`tidegap tick` prints a loud warning when pending tasks need a provider key that
is not set. (Ollama is keyless, so a pending Ollama task is never flagged.)

## Platform support

| Platform | Daemon install | Wake-from-sleep |
| --- | --- | --- |
| macOS | launchd plist (`tidegap install`) | `pmset schedule wake` via `tidegap register-wake` / the `--laptop` helper |
| Linux | systemd user `.service` + `.timer` (`tidegap install`) | `rtcwake` via `tidegap register-wake` / the `--laptop` helper |
| Windows | not auto-installed — `tidegap install` prints a ready-to-paste `schtasks` command; run `tidegap tick` under Task Scheduler or nssm yourself | not supported (use Task Scheduler's "wake the computer" option) |

Wake events (`pmset` / `rtcwake`) need root. When not running as root,
`tidegap register-wake` prints the exact `sudoers` line to pre-authorize the
command without a password prompt.

## Develop

From the root of a clone of https://github.com/tidegap/tidegap:

```bash
pnpm install
pnpm --filter @tidegap/core build
pnpm --filter @tidegap/cli build
node packages/cli/dist/index.js --help
```
