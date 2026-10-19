# QA matrix over all user-facing surfaces, and the fix loop

Created: 2026-10-19

Operational artifact: `docs/plans/2026-10-19-qa-matrix-checklist.md`. Execution agents tick it. The orchestrator reads only it.

## 1. Goal and scope

**Goal.** Every program a new user meets works before the launch posts and before the 0.20.0 release. The owner found a bug by hand today (Mac app, Journal → task detail → Conversation → Send: "Reply failed: forbidden"). This plan finds the rest in a planned pass, not by chance.

**In scope.** Test every user-facing surface. Record each failure as evidence. Fix real failures through the CE pipeline. Define "green" as the gate for the posts and for 0.20.0.

**Out of scope.** Code changes in this task. New features. Load or performance testing. Windows and Linux runs (except the generated unit files, which unit tests cover). Store submission of the extension and the Mac app.

**Baseline (measured 2026-10-19 on main 760c6d0, `pnpm -r test`, 22 s wall, all green).**

| Package | Tests |
|---|---|
| packages/core-ts | 761 (40 files) |
| packages/cli | 643 (49 files) |
| packages/mcp-server | 89 (13 files) |
| packages/openclaw-plugin | 85 (5 files) |
| apps/extension | 88 (node --test) |
| apps/web | 5 (1 file) |
| packages/core-py (pytest), apps/macos/TidegapKit (swift test) | not run here; CI runs them |

**Brief corrections found in the code.** These change how cases are written:

- No `tidegap init`, `setup`, `doctor`, `run` or `result` command exists. The "doctor" check is `tidegap status`. A result is `tidegap queue show <id>`. Setup is `tidegap install` plus the env file plus `tidegap channels add telegram`. `/run` and `/result` exist only as Telegram commands.
- No `TIDEGAP_HOME` variable exists. Every path comes from `os.homedir()` (`packages/core-ts/src/paths.ts:73`). Isolation is `HOME=<temp dir>`.
- The Mac app has no "launch at login" (no `SMAppService` in `apps/macos`). No doc claims it. See owner decision D4.

## 2. Isolation rules (every stream, no exceptions)

Tests never touch the real `~/.tidegap`, `~/.claude`, `~/.config/tidegap`, `~/Library/Application Support/Tidegap` or the real launchd jobs.

**The QA environment.** Each stream gets its own temp home and its own ports. The harness script `scripts/qa/env.mjs` (to add, see section 6) builds it:

| Setting | Value | Why |
|---|---|---|
| `HOME`, `USERPROFILE` | `$TMPDIR/tidegap-qa/<stream>-<rand>` | all ledger, env file, ui.json, clients, Claude settings paths follow `homedir()` |
| `TIDEGAP_USAGE` | `off` | the limit read uses the macOS Keychain, which `HOME` does not isolate |
| `TIDEGAP_NO_NOTIFY` / `tick --no-notify` | set | no OS notifications from a test tick |
| `TIDEGAP_TELEGRAM_API_BASE` | `http://127.0.0.1:<stream fake port>` | the fake Bot API, `packages/core-ts/test/fixtures/fake-telegram.ts` (runs as a script) |
| `TIDEGAP_CLAUDE_BIN` | `packages/cli/test/fixtures/fake-claude/claude` | no real `claude -p` (only S9.3 runs it, after decision D2) |
| Provider keys (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, …), `CLAUDECODE`, `CLAUDE_*` | removed | no real provider call, no session capture from the agent's own session |
| `tidegap install`, `tidegap channels add` | always `--no-load` | launchd labels (`com.tidegap.*`) are per user, not per `HOME`; a load replaces the real daemon |
| Integrations "Start listener", "Connect" with a load | never in an isolated run | same launchctl reason; the real-listener case is owner-only (S5.14) |
| `register-wake` | `--dry-run` only | `pmset` changes the real machine |
| Mac app | launch arguments `-home <temp> -port <p> -tidegapCommand "node packages/cli/dist/index.js"` | its token and ui.json go under the temp home (`apps/macos/README.md`, "Launch arguments") |
| "Start dispatcher" in the page | allowed; teardown kills the child pid from ledger meta `ui_dispatcher` | it spawns a detached `tick --daemon` |

**Isolation proof.** `env.mjs` refuses to start when the resolved home is the real one (`os.userInfo().homedir`). Before and after each stream it records the mtime and size of the real `~/.tidegap/queue.db`, `~/.config/tidegap/env`, `~/.claude/settings.json`, and the `launchctl print gui/$UID/com.tidegap.tick` and `com.tidegap.channels` state. A change fails the stream as a blocker. The stream returns this proof with its results.

**Ports per stream.** UI servers 47901–47904. Fake Telegram 47951–47954. Site `next start` 3100. No stream uses 47821 (the real default).

**Evidence.** Screenshots, logs and command output go to the executing session's scratchpad. The repo is public (`docs/solutions/workflow-issues/public-repo-hygiene.md`): the checklist gets only a short evidence id (file name or run id), never a local path, a token or a log excerpt with secrets.

**Browser rule.** Browser suites never run in a parallel stream. One browser agent at a time, its own tab, tabs closed at the end. Playwright MCP downloads land in `.playwright-mcp/`; move anything sensitive out.

## 3. Known-suspect list (run first, batch 1)

Each suspect was confirmed by reading the code on main 760c6d0. "Confirmed" means the code path exists; the case proves the user-visible effect.

| ID | Suspect | Evidence (file:line) | Case |
|---|---|---|---|
| K1 | The page shows Reply to a caller that may not use it. `actions.reply` ignores the caller. The page renders the form on it. The server rejects a client token on reply. The Mac window uses a `macos` client token, so Send fails with "forbidden". The `R` shortcut button also shows. | `packages/core-ts/src/history.ts:194`; `packages/cli/ui/detail.js:229`, `:306`; `packages/cli/src/ui/server.ts:200`, `:330` | S2.15, S3.9 |
| K2 | "Connected apps" copy says apps "can see and queue tasks". A client token gets 403 on task creation. | `packages/cli/ui/clients.js:63` vs `packages/cli/src/ui/server.ts:330` | S2.20 |
| K3 | `tick --daemon` keeps stale secrets. `loadEnvFileIntoProcess` sets a key only when it is unset, so the first tick wins for the life of the process. (a) After "Remove token" (`forget_token`) the env file has no bot token, so tick falls back to `process.env`, which still holds the removed token: the daemon keeps sending. (b) A changed provider key in `~/.config/tidegap/env` is ignored until restart. Applies to the launchd daemon and to the page's "Start dispatcher" child. | `packages/cli/src/commands/env-file.ts:159`; `packages/cli/src/commands/tick.ts:197`, `:378`; `packages/cli/src/ui/dispatcher.ts:6` | S5.13, S9.8 |
| K4 | `reportedModel` in the claude-code receipt picks the `modelUsage` entry with the most output tokens, but the token counts come from the top-level `usage`. When `claude -p` uses a helper model (web fetch summaries, subagents), the receipt can name one model and count another's tokens; carbon is computed for the named model. | `packages/cli/src/providers/claude-code.ts:201`, `:598`; `packages/core-ts/src/scheduler.ts:2374`, `:2407` | S9.2, S9.3 |
| K5 | MCP tool-count drift. Code: 12 for MCP, 11 for OpenClaw (`toolsForHost`, test-backed). Docs still say "ten". | `packages/mcp-server/src/server.ts:5`; `README.md:331`; `packages/claude-code-plugin/README.md:177`; `apps/web/src/app/about/page.tsx:143`; `apps/web/src/app/queue/page.tsx:207`; truth: `packages/core-ts/src/tool-surface.ts:237-598`, `packages/mcp-server/test/server.real.test.ts:72` | S11.7 |
| K6 | Test-count claim is stale: "1,423 tests" (measured 2026-10-16). TypeScript alone is now 1,578 in the same four packages. | `README.md:183`, `:187`; `apps/web/src/app/about/page.tsx:48`; `apps/web/src/components/home/proof.tsx:21`; `docs/claims.md` row 13 | S11.10 |
| K7 | Site CLI docs miss commands that exist and that 0.20.0 announces: `tidegap status`, `queue later`, `queue unread`, `usage`, `channels` (only on the Telegram page). "Confirm it worked" does not mention `tidegap status`. | `apps/web/content/docs/03-cli.md:27-43`; `apps/web/content/docs/01-install.md:24`; `CHANGELOG.md` [Unreleased] | S1.2, S11.7 |
| K8 | Stale client token after revoke or "Forget token". The Mac app drops its token on 401 and waits for Reconnect; the page window was loaded with the old token in the fragment. Check that the window, the menu and the extension show one clear state, and that Reconnect reloads the window with the new token. | `apps/macos/TidegapKit/Sources/TidegapKit/Connection.swift:11`, `:105`; `apps/macos/Tidegap/WebPageWindow.swift:52`; `apps/macos/Tidegap/AppModel.swift:179` | S3.11, S4.11, S2.4 |
| K9 | No "launch at login" in the Mac app. | `apps/macos/Tidegap/*.swift` (no `SMAppService`) | S3.15 → D4 |
| K10 | Claude Code plugin has no slash command for `postpone_task` (Later) or `tidegap_usage`. Docs consistently say "eight", so this is a parity gap, not drift. | `packages/claude-code-plugin/commands/` (8 files) | S7.7 → D5 |
| K11 | A docs flag that no longer exists. The sweep (every `--flag` in README, QUICKSTART, site docs, plugin commands and skill vs `packages/cli/src/index.ts`) found none for `tidegap` itself; the remaining hits are `claude`, `openclaw`, pnpm or slash-command flags. Re-run it in the docs-drift gate so it stays true. | sweep result | S11.7 |

## 4. Surface matrix

Columns: **How** = `auto:<test>` (existing automated test, named), `iso` (CLI run in the QA environment), `pw` (Playwright against a local server, serialized), `mcp` (MCP stdio call), `fake-tg` (fake Telegram), `grep`, `script`, `manual` (owner only). **Model**: H = Haiku, S = Sonnet. Opus only fixes (section 7). A case with an `auto:` test still gets one isolated live run when it is a first-run path for a new user.

### S1. CLI (`packages/cli`)

| ID | Flow | Expected | How | M |
|---|---|---|---|---|
| S1.1 | `tidegap --version` | prints the `packages/cli/package.json` version | auto:version.test.ts + iso | H |
| S1.2 | `tidegap --help` and each subcommand `--help` | every command in `src/index.ts` is listed; the site CLI table lists the same set (K7) | iso + grep | H |
| S1.3 | `tidegap status` on a fresh home | not-ready line "no tick daemon", fix `tidegap install`, non-zero exit | auto:status.test.ts + iso | H |
| S1.4 | `tidegap status --json` | the readiness object of `docs/spec/ui-client-api.md` | auto:readiness.test.ts | H |
| S1.5 | `tidegap install --no-load` | unit file written under the temp home, nothing loaded; a second run is idempotent | auto:install.test.ts + iso | H |
| S1.6 | `install --laptop` / `--server` / no flag (with `--no-load`) | mode message matches the flag; no flag picks laptop on a Mac with a battery | auto:install.test.ts | H |
| S1.7 | First run creates `~/.config/tidegap/env` | mode 0600, commented template; explicit env wins over the file | auto:env-file.test.ts, env.test.ts | H |
| S1.8 | Legacy `~/.ebb` names present | one notice, once | auto:legacy-names.test.ts | H |
| S1.9 | `tick --once` on an empty ledger | exit 0, one message; `status` then shows a recent tick | iso | S |
| S1.10 | Queue a `claude-code` task (MCP, S6.5), `tick --once` with the fake claude | task completed, receipt written, `queue show` prints the result | auto:tick-claude-code.test.ts + iso | S |
| S1.11 | Pending `anthropic` task, no key | readiness `no_runner` naming the env file; the task stays queued | auto:readiness.test.ts | H |
| S1.12 | `tick --daemon --interval 2`, three cycles, SIGTERM | three tick lines, clean exit 0 | iso | S |
| S1.13 | `queue list` with `--json`, `--status`, `--kind`, `--unread`, `--series` on a seeded ledger (`scripts/ui-seed.mjs --db`) | each filter returns the expected rows; bad value → one-line error | auto:queue.test.ts + iso | H |
| S1.14 | `queue list --hook` with good, empty and broken hook input | one line or nothing; exit 0 always | auto:session-capture-hook.test.ts | H |
| S1.15 | `queue show <id>` / `--no-mark-read` / `--json` / `--raw` | marks read unless `--no-mark-read`; JSON has record and history | auto:queue.test.ts | H |
| S1.16 | `queue unread <id>` | the task is unread again; `--unread` lists it | auto:queue.test.ts | H |
| S1.17 | `queue later` with `--until +2h`, `tonight`, `tomorrow`, `HH:MM`, `after-limit-reset`, `--preset`, `--delay`, `--reset-at` | moves later, never earlier; an earlier target gets "already planned for HH:MM" | auto:queue.test.ts, core postpone.test.ts + iso | H |
| S1.18 | `queue reschedule --by/--at/--day/--after-limit-reset` | `--by` behaves as `later --until`; others as documented | auto:queue.test.ts | H |
| S1.19 | `queue run-now <id>`, then `tick --once` | the task runs on that tick; event `expedited`, actor `cli` | iso | S |
| S1.20 | `queue cancel <id>` / `--series` | cancelled; `--series` ends the series | auto:queue.test.ts | H |
| S1.21 | `queue reply <id> "<text>" --by 1h` | child task with history, deadline in 1 h | auto:queue.test.ts | H |
| S1.22 | `receipts list --since`, `verify <id>`, `verify --file`, tampered file | valid signatures pass; a changed byte fails with a clear line | auto:receipts.test.ts, verify.test.ts | H |
| S1.23 | `stats` and `stats --json` on a seeded ledger | numbers match the seeded receipts; no network | iso | H |
| S1.24 | `usage`, `usage --json` (with `TIDEGAP_USAGE=off` and with fixture data), `usage --spend` | off → empty line, status disabled; fixture → `usage/v1` document | auto:usage-command.test.ts, usage-*.test.ts | H |
| S1.25 | `usage hook` and the statusline offer | writes only under the temp home; never edits a real settings file | auto:statusline-setup.test.ts | H |
| S1.26 | `register-wake <id> --dry-run` | prints the `pmset` command, runs nothing | iso | H |
| S1.27 | `clients add --name x --kind extension --json`, `list`, `revoke <id>` | `tgc_` token shown once; revoked token gets 401 next request | auto:ui-clients.test.ts + iso | H |
| S1.28 | `channels add telegram --no-load`, `list --json`, `remove <id>` against fake Telegram | 6-digit code; list shows the chat; remove unpairs | iso + fake-tg | S |
| S1.29 | Error paths: unknown id, bad `--until`, missing required option | one line on stderr, non-zero exit, no stack trace | iso | H |
| S1.30 | `--db <path>` on every command that takes it | that ledger only; the temp home ledger is untouched | iso | H |
| S1.31 | Legacy `ebb` bin alias | runs the same program | auto:bin-alias.test.ts | H |

### S2. Web UI (`tidegap ui`, `packages/cli/ui`)

Server: `node scripts/ui-seed.mjs --serve --port 4790x` (seeded ledger, temp home, no secrets). Client-token runs pass `#token=<tgc_…>` in the link.

| ID | Flow | Expected | How | M |
|---|---|---|---|---|
| S2.1 | `tidegap ui --no-open --port P` | prints a link with `#token=`; `ui.json` 0600 with the pid; removed on SIGTERM | auto:ui-discovery.test.ts + iso | H |
| S2.2 | Port taken: default and `--port n` | default falls back with a warning; `--port n` fails, no fallback | auto:ui-server.test.ts | H |
| S2.3 | Open the link; reload without the fragment | token leaves the address bar; reload shows the "open the link again" state | pw | H |
| S2.4 | Restart the server; use the old tab (stale page token) | one clear session-expired state, no error toasts loop | pw | S |
| S2.5 | Agenda with no daemon | amber "Tasks will not run" banner with the fix line; overdue and today groups | pw | H |
| S2.6 | Agenda row → Later | four presets with times; unavailable ones disabled with the reason; pick 1h → row moves, toast | pw | S |
| S2.7 | Later → Pick a time earlier than planned | the 409 line ("already planned for HH:MM"), not a generic error | pw | S |
| S2.8 | Run now (confirm) | toast "runs on the next tick"; detail shows `expedited`, actor `page` | pw | S |
| S2.9 | Cancel and cancel series | state cancelled; series ended | pw | S |
| S2.10 | Reschedule dialog | new time saved; never earlier than allowed | pw | H |
| S2.11 | Timeline: curve, task blocks, drag to another hour | blocks at `scheduled_for`; drag earlier is refused, later saves | pw | S |
| S2.12 | Journal filters All / Unread / Completed / Failed; open a task; Mark unread / Mark read | counts right; unread count drops on open and comes back on Mark unread | pw | S |
| S2.13 | Task detail | prompt, result, receipt, events timeline, resume command for a session task | pw | H |
| S2.14 | Detail → Conversation → Reply (page token) | child task queued, toast, "Reply to" link on the child | pw | S |
| S2.15 | Same with a client token (K1) | per D1: the form is hidden, or Send works for `macos`; never "Reply failed: forbidden" | pw | S |
| S2.16 | Keyboard: `R`, Esc, list navigation | `R` only when reply is allowed; Esc closes dialogs | pw | H |
| S2.17 | A tick in another process (iso) while the page is open | SSE `tasks` updates the row without reload | pw + iso | S |
| S2.18 | Start dispatcher | shows only with no recent tick; starts a child; a second click gets 409; teardown kills the pid | pw | S |
| S2.19 | Usage panel | `TIDEGAP_USAGE=off` → no line; spend only on click | pw | H |
| S2.20 | Connected apps: Connect an app, copy, list, revoke (K2) | token shown once; revoked client gets 401; copy says apps cannot create tasks | pw | S |
| S2.21 | Settings → Integrations with fake Telegram: save token → Connect (pairing, QR, link) → pair from the fake chat → Send test → Disconnect → Remove token | each card state and action list as in `packages/cli/ui/integrations.js`; no listener load (isolation) | pw + fake-tg | S |
| S2.22 | Integrations errors: bad format, refused, webhook, network, rate limit | the one-sentence error with the next step; 429 shows the wait | auto:ui-integrations.test.ts + pw | H |
| S2.23 | Foreign Origin, foreign Host, extension origin on static files, CORS | 403, 403, 403, no CORS headers | auto:ui-server.test.ts | H |
| S2.24 | Empty ledger (`ui-seed --empty`) | every view shows its empty message; no console error | pw | H |
| S2.25 | 390 px wide and dark mode | no horizontal scroll; readable contrast; screenshots | pw | H |
| S2.26 | Seeded title with markup (`<img onerror>`) | rendered as text everywhere, incl. toasts | pw | H |
| S2.27 | Console across all views and dialogs | zero uncaught errors | pw | H |

### S3. Mac menu bar app (`apps/macos`)

Launch: `apps/macos/scripts/install.sh -- -home <temp> -port 47903 -tidegapCommand "node <repo>/packages/cli/dist/index.js" --show-window`. Menu clicks need a person or a computer-use agent; they are owner-manual and kept short.

| ID | Flow | Expected | How | M |
|---|---|---|---|---|
| S3.1 | TidegapKit unit tests | green | auto:`swift test --package-path apps/macos/TidegapKit` | H |
| S3.2 | Release build | `apps/macos/scripts/build.sh` succeeds; the app starts with `-home` | script | H |
| S3.3 | First launch | mints a `macos` token under the temp home; `clients list` shows "Tidegap for Mac" | script + iso | H |
| S3.4 | Server found vs started | a live `ui.json` server is reused and not stopped on quit; with none, the app starts a child and stops only it | auto:ServerLauncherTests, DiscoveryTests | H |
| S3.5 | Stale `ui.json` (dead pid), port taken | the app ignores the dead pid and starts its own server | auto:DiscoveryTests, ConnectionTests | H |
| S3.6 | Badge rules (`?`, `off`, count, `now`, clock, `!`) | as KTD6 in the spec | auto:FormatTests | H |
| S3.7 | Menu row: Later presets, Cancel…, Run now… | enabled per `actions`; each works once | manual | – |
| S3.8 | Open Tidegap window (page with the `macos` token) | Apps button hidden; Settings visible | pw (same URL and token) | H |
| S3.9 | Window: Journal → task → Conversation → Send (K1) | per D1; never "Reply failed: forbidden" | pw + manual confirm | S |
| S3.10 | Integrations… | opens Settings → Integrations in the window | manual | – |
| S3.11 | Revoke the Mac client from a browser page (K8) | menu shows `?` and Reconnect; window shows "Not connected"; Reconnect mints and reloads the window | auto:ConnectionTests + manual | S |
| S3.12 | Settings → Forget token, then Reconnect | `?`, then connected with a new token | manual | – |
| S3.13 | Settings: command, port, notification toggles, Apply and retry | applied without restart | manual | – |
| S3.14 | Notifications: a task finishes; a clean window starts | one notification each; off when toggled off | manual | – |
| S3.15 | Launch at login (K9) | record: absent; D4 decides | manual | – |
| S3.16 | Quit | stops only its own child server; `ui.json` removed | auto:ServerLauncherTests | H |
| S3.17 | Safari extension inside the app | enabled in Safari, pairs like S4.4 | manual | – |

### S4. Browser extension (`apps/extension`)

| ID | Flow | Expected | How | M |
|---|---|---|---|---|
| S4.1 | Unit tests | 88 pass | auto:`pnpm --filter @tidegap/extension test` | H |
| S4.2 | Build and lint | `dist/chrome`, `dist/firefox`, `dist/safari`, zips; addons-linter clean | auto:build.test.js + lint | H |
| S4.3 | Existing smoke | `apps/extension/scripts/smoke-chrome.mjs --out <scratch>` prints PASS | script (browser) | H |
| S4.4 | Pair: options → paste token, port 47902, Save, Test connection | "Connected" and the task count | pw | H |
| S4.5 | Wrong token | badge `?`, options say the token is refused | pw | H |
| S4.6 | Server stopped | badge `off` | pw | H |
| S4.7 | Popup with no daemon | active tasks, clean-window line, readiness line; badge `!n` amber | pw | H |
| S4.8 | Later in the popup | presets with times, disabled ones with reason; pick → task moves | pw | S |
| S4.9 | Cancel, Run now | each asks once, then acts; result line shown | pw | H |
| S4.10 | Popup has no create or reply; extension token on `/api/clients*`, `/api/integrations*` | not offered; 403 | auto:api.test.js + script (curl) | H |
| S4.11 | Revoke while the popup is open (K8) | `?` on the next poll | pw | H |
| S4.12 | Notifications | one per finished task (cursor), one per clean window start | auto:poller.test.js, notify.test.js | H |
| S4.13 | Firefox and Safari install | loads, pairs, popup works | manual | – |

### S5. Telegram channel

| ID | Flow | Expected | How | M |
|---|---|---|---|---|
| S5.1 | Unit tests | green | auto:core channels-*.test.ts, cli channels-*.test.ts, telegram-setup.test.ts | H |
| S5.2 | `channels add telegram --no-load`, fake chat sends `/pair <code>`; wrong code; code after 10 min | "Paired…" reply; wrong code refused; expired code refused | iso + fake-tg | S |
| S5.3 | Deep link `/start <code>` | pairs the same way | fake-tg | S |
| S5.4 | `channels serve --once`, `/queue` | numbered list of the next 10 tasks | fake-tg | S |
| S5.5 | `/later <n>` with `1h`, `tonight`, `tomorrow`, `reset HH:MM`, `HH:MM`; bad grammar | task moves; bad grammar gets the usage line | fake-tg | S |
| S5.6 | `/run n`, `/cancel n`, `/result n` (finished and pending); a number older than 10 min | act or explain; old number refused | fake-tg | S |
| S5.7 | `/help` text | equals the table in `apps/web/content/docs/06-telegram.md` | grep | H |
| S5.8 | Message from an unpaired chat | ignored, no reply | auto:channels-serve.test.ts | H |
| S5.9 | Tick finishes a task | done message with a Result button; the button returns the result | auto:tick-channels.test.ts + fake-tg | S |
| S5.10 | Logs and errors | never contain the bot token | auto + grep of stream logs | H |
| S5.11 | Listener unit (generated with `--no-load`) | LaunchAgent `com.tidegap.channels` runs `tidegap channels serve`, restarts on exit | auto:platform-macos.test.ts | H |
| S5.12 | Two pollers | status `conflict` | auto:channels-serve.test.ts | H |
| S5.13 | `tick --daemon` running; Integrations → Remove token (K3a) | the next tick sends nothing to Telegram | iso + fake-tg | S |
| S5.14 | Real bot, real phone, real listener | pair, `/queue`, done message, Result | manual (D3) | – |

### S6. MCP server (`packages/mcp-server`)

Calls go over stdio to `packages/mcp-server/dist/server.js` with `HOME=<temp>` and `TIDEGAP_DB_PATH=<temp>/queue.db`.

| ID | Flow | Expected | How | M |
|---|---|---|---|---|
| S6.1 | Unit tests | 89 pass | auto:`pnpm --filter @tidegap/mcp test` | H |
| S6.2 | `tools/list` | exactly the 12 names of `toolsForHost("mcp")` | script:`packages/mcp-server/scripts/smoke-stdio.mjs` | H |
| S6.3 | `get_grid_forecast` (region FR, hours 24) | 24 points, source named (mock without keys) | mcp | H |
| S6.4 | `recommend_window` | a window inside the deadline; nothing saved | mcp | H |
| S6.5 | `schedule_task` `dry_run: true`, then real | dry run saves nothing; real reply ends with the readiness line or "Runs at …" | mcp | S |
| S6.6 | `check_queue_status` all and one | lists the task; one shows status and receipt when done | mcp | H |
| S6.7 | `tidegap_usage` with `TIDEGAP_USAGE=off` | status disabled, no Keychain read | mcp | H |
| S6.8 | `cancel_task` | cancelled; a finished task stays unchanged | mcp | H |
| S6.9 | `expedite_task` | due on the next tick | mcp | H |
| S6.10 | `update_deadline` | rescored against the new deadline | mcp | H |
| S6.11 | `postpone_task` presets, and an earlier target | moves later; earlier target refused with the line | mcp | H |
| S6.12 | `reply_task` on a completed task | child task with history | mcp | H |
| S6.13 | `retry_task` on a failed and on a completed task | failed requeued; completed refused | mcp | H |
| S6.14 | `cancel_all` | every pending task cancelled; count returned | mcp | H |
| S6.15 | `schedule_task` from a Claude Code session env | provider defaults to `claude-code`, origin session recorded | auto:server.origin.test.ts | H |
| S6.16 | Bad arguments to each tool | an error text, no stack, nothing saved | mcp | H |
| S6.17 | Registry metadata | `server.json` version equals the package version | auto:registry-metadata.test.ts | H |

### S7. Claude Code plugin (`packages/claude-code-plugin`, `.claude-plugin/marketplace.json`)

| ID | Flow | Expected | How | M |
|---|---|---|---|---|
| S7.1 | `/plugin marketplace add tidegap/tidegap`, `/plugin install tidegap`, restart | 8 `/tidegap:*` commands and the MCP server appear | manual | – |
| S7.2 | Versions | marketplace and plugin versions match the packages | auto:`pnpm check:versions` | H |
| S7.3 | Each `commands/*.md` | names only tools and arguments that exist in `tool-surface.ts` | grep | H |
| S7.4 | `skills/tidegap/SKILL.md` | every `tidegap` command and flag exists in `packages/cli/src/index.ts` | grep | H |
| S7.5 | SessionStart hook, `tidegap queue list --hook` | exit 0 with and without the CLI installed | auto:session-capture-hook.test.ts + script | H |
| S7.6 | `hooks/session-capture.sh` with bad input or no `tidegap` | never fails the session | script | H |
| S7.7 | Slash commands for Later and usage (K10) | record: absent; D5 decides | grep | H |
| S7.8 | `/tidegap:defer "ping" --by tomorrow` in a real session | task queued with the origin session; `/tidegap:check` shows it | manual | – |

### S8. OpenClaw plugin (`packages/openclaw-plugin`)

| ID | Flow | Expected | How | M |
|---|---|---|---|---|
| S8.1 | Unit tests | 85 pass | auto:`pnpm --filter @vitalini/tidegap test` | H |
| S8.2 | Smoke | `node packages/openclaw-plugin/scripts/smoke.mjs` PASS | script | H |
| S8.3 | Tool set | exactly 11; has `set_delivery`; no `tidegap_usage`, no `postpone_task` | auto:plugin.test.ts | H |
| S8.4 | Install text | README command `openclaw plugins install clawhub:@vitalini/tidegap` and `openclaw.plugin.json` version match the release | grep | H |
| S8.5 | Telegram delivery | delivered through the store, no ambient env | auto:delivery-telegram.test.ts | H |

### S9. Providers

| ID | Flow | Expected | How | M |
|---|---|---|---|---|
| S9.1 | claude-code adapter fixtures: success, limit, logged-out, refusal, budget, fork | each maps to completed / deferred / failed with a clear line | auto:claude-code-adapter.test.ts, claude-code.test.ts | H |
| S9.2 | `modelUsage` with two models (K4) | receipt model and token counts describe the same run; record what the code does today | iso (fixture variant) | S |
| S9.3 | Real `claude -p` under the subscription: one task "Reply with the word pong", provider `claude-code`, `tick --once` | completed; receipt model is the model that answered; tokens > 0 | manual or owner-approved run (D2) | S |
| S9.4 | Limit result | deferred to the reset plus margin, requeued | auto:claude-code-adapter.test.ts | H |
| S9.5 | anthropic, openai, gemini, ollama with mocks | dispatch and receipt per provider | auto:core providers.test.ts, providers-gemini-ollama.test.ts | H |
| S9.6 | Missing key | `no_runner` with the env-file fix line | auto:readiness.test.ts | H |
| S9.7 | Timeout | the process group is killed; the error says where it hung | auto:claude-code.test.ts | H |
| S9.8 | Change a provider key in the env file while `tick --daemon` runs (K3b) | record whether the next tick uses the new key | iso | S |

### S10. Python core parity (`packages/core-py`)

| ID | Flow | Expected | How | M |
|---|---|---|---|---|
| S10.1 | `pytest -q` in a fresh venv | green | auto:`pnpm lint:py` (venv per `docs/solutions/developer-experience/worktree-environment-setup.md`) | H |
| S10.2 | `ruff check .` | clean | auto | H |
| S10.3 | Shared fixtures: select-window, receipt sign vectors, energy, sampling | TS and Python agree | auto:core sampling-parity, sign-vectors, energy-parity tests + pytest twins | H |
| S10.4 | A Python-queued task is visible to `tidegap queue list`, and the reverse | same rows, migrations idempotent | script (temp ledger) | S |
| S10.5 | Wheel install in a temp venv; README `from tidegap import defer` snippet | runs | script | H |
| S10.6 | `ebb-ai` shim | re-exports and warns once | auto:CI step `ci.yml` python job | H |

### S11. Site (www.tidegap.com, `apps/web`)

| ID | Flow | Expected | How | M |
|---|---|---|---|---|
| S11.1 | Unit tests | green | auto:`pnpm --filter @tidegap/web test` | H |
| S11.2 | Generated docs | `pnpm gen:docs:check` clean (`docs.generated.ts`, `llms-full.txt`) | auto | H |
| S11.3 | Agent path on local `next start` (port 3100) | `node scripts/check-agent-files.mjs --base http://localhost:3100` PASS | script | H |
| S11.4 | Agent path on production | same against `https://www.tidegap.com` PASS | script | H |
| S11.5 | Homepage install box | six tabs; keyboard switches tabs; "Copy prompt" copies the exact prompt; no layout shift; 1280 px and 390 px screenshots | pw | H |
| S11.6 | Docs page | every section anchor works; sticky nav; copy buttons copy the code | pw | H |
| S11.7 | Docs vs code (K5, K7, K11) | tool counts, CLI table, flags all match code | grep (docs-drift gate) | H |
| S11.8 | `llms.txt`, `llms-full.txt` | every docs category; every link 200 | script (check-agent-files `llms`, `docs`) | H |
| S11.9 | `/about`, `/plan`, `/queue`, `/stats`, `/forecast`, `/map` | render, no console error, no broken link | pw | H |
| S11.10 | Claims (K6) | every number in `docs/claims.md` scope matches a fresh measurement | grep + measurement | H |
| S11.11 | Images and brand | `pnpm gen:images:check`, `pnpm gen:brand:check` clean | auto | H |

### S12. Release artifacts

| ID | Flow | Expected | How | M |
|---|---|---|---|---|
| S12.1 | Version lockstep | `pnpm check:versions` PASS | auto | H |
| S12.2 | `npm pack --dry-run` for `@tidegap/core`, `@tidegap/cli`, `@tidegap/mcp` | has `dist`, README, LICENSE, and `ui/` for the CLI; no tests, no env files, no local paths | script | H |
| S12.3 | Cold start from the packed tarballs: temp prefix, temp HOME, empty npm cache | `npx <cli tarball> --version` and `tidegap status` work; no missing dependency | script | H |
| S12.4 | Cold `npx -y <mcp tarball>` | stdio handshake and 12 tools | script | H |
| S12.5 | `tidegap ui` from the packed install | page and every static file load | script | H |
| S12.6 | Python sdist and wheel | build; install in a temp venv | script | H |
| S12.7 | `pnpm preflight` on the release branch | green | auto | H |
| S12.8 | Mac app zip from CI | opens after `xattr -dr com.apple.quarantine` | manual | – |
| S12.9 | Extension zips | manifest version equals the core version | auto:build.test.js | H |
| S12.10 | After publish: `npx @tidegap/cli --version` and `npx -y @tidegap/mcp` from the registry, cold | the new version; works | script | H |

## 5. Manual-only cases for the owner (one sitting, about 45 min)

S3.7, S3.10, S3.11, S3.12, S3.13, S3.14, S3.15, S3.17, S4.13, S5.14, S7.1, S7.8, S9.3 (unless D2 allows an agent run), S12.8. Plus the manual confirm of S3.9 once the K1 fix lands (D1), and the Mac side of K8 (covered by S3.11). S12.10 is not manual: it waits for the publish. The orchestrator sends this list as one message after batch 3, with the build to install and the exact launch line.

## 6. Quiet gate scripts to add

The repo has quiet checks for some areas (`smoke-chrome.mjs`, `smoke-stdio.mjs`, `openclaw smoke.mjs`, `check-agent-files.mjs`). It has none for isolated CLI flows, MCP tool calls, Telegram flows, UI flows, release packing or docs drift. Add these under `scripts/qa/`. Each prints `PASS` or the failed case IDs with a log path, nothing else. Each takes `--stream <name>` and `--port-base <n>` and uses `env.mjs`.

| Script | Covers | Browser |
|---|---|---|
| `scripts/qa/env.mjs` | builds the QA environment of section 2; isolation proof before and after | no |
| `scripts/qa/gate.mjs <area>` | runs one area or `all`; prints PASS or case IDs | no |
| `scripts/qa/cli-flows.mjs` | S1 iso cases, S9.2, S9.8 | no |
| `scripts/qa/telegram-flows.mjs` | S5.2–S5.6, S5.13, S1.28 with the fake Bot API | no |
| `scripts/qa/mcp-tools.mjs` | S6.3–S6.16 | no |
| `scripts/qa/release-pack.mjs` | S12.2–S12.6, S12.10 | no |
| `scripts/qa/docs-drift.mjs` | K5, K6, K7, K11, S5.7, S7.3, S7.4, S8.4, S11.7, S11.10 | no |
| `scripts/qa/ui-flows.mjs` | S2 pw cases, S3.8, S3.9, built on `playwright-core` as `smoke-chrome.mjs` is | yes, never in parallel |

Tests for the harness: `scripts/qa/env.test.mjs` (refuses the real home; proof detects a touched file). Wire `docs-drift.mjs` into `pnpm preflight` and CI after this program, so K5/K6/K7 cannot come back.

The harness is shared infrastructure. It lands first, as its own PR (foundation first).

## 7. Execution plan

**Before the first dispatch.** The orchestrator writes the batch journal outside the repo (public repo rule): budget, concurrency cap 4, and each dispatch's token count.

| Batch | Streams (max 4 at once) | Home / ports | Model, effort |
|---|---|---|---|
| 1 | A: unit gate — `pnpm -r test`, `pnpm lint:py`, `swift test`, `pnpm check:versions`, `gen:*:check` (S*.auto rows) | none | Haiku, low |
| 1 | B: suspects by grep and docs drift by hand — K1–K11, S5.7, S7.3, S7.4, S8.4, S11.7, S11.10 | none | Haiku, low |
| 1 | C: release pack and cold start, by hand — S12.2–S12.6 | home-C, own npm cache | Haiku, low |
| 1 | D: QA harness PR (`scripts/qa/*`, section 6) through ce-work → simplify → review | its worktree | Opus, medium |
| 2 (after D) | E: CLI flows — S1 iso, S9.2, S9.8 | home-E | Sonnet, medium |
| 2 | F: MCP tools — S6 | home-F | Haiku, low |
| 2 | G: Telegram flows — S5, S1.28 | home-G, fake TG 47951 | Sonnet, medium |
| 2 | H: Python parity and cross-ledger — S10 | home-H, own venv | Haiku, low |
| 3 (serial, one at a time) | I: web UI — S2 (Haiku for H rows, Sonnet for S rows) | home-I, UI 47901, fake TG 47952 | Haiku / Sonnet |
| 3 | J: extension — S4 | home-J, UI 47902 | Haiku |
| 3 | K: Mac window by Playwright — S3.8, S3.9; build — S3.2, S3.3 | home-K, UI 47903 | Haiku |
| 3 | L: site — S11.3–S11.9 local then production | port 3100 | Haiku |
| 4 | Owner manual list (section 5) | owner's choice | owner |

Rules for every stream:

- The stream reads this plan's section 2 and its rows in the checklist only.
- It ticks `- [x]` with an evidence id, or marks `- [!]` with a one-line failure and the evidence id. It never edits other rows.
- A failing case is re-run alone once. Passes alone → `flake`, noted, not fixed now. Fails twice → `real`.
- Stop loss: a stream that fails its isolation proof, returns nothing, or exceeds its budget is stopped and reported. One retry with a changed brief or model.

## 8. Fix loop

1. **Triage (Haiku, low).** Collect `[!]` rows. Dedupe by code location. Classify: blocker (data loss, isolation breach, security, a first-run path broken), major (a documented flow fails), minor (copy, layout, docs drift).
2. **One brief per real failure (Opus, medium).** `ce-work` brief names the case ID, the evidence id, the expected result from this plan, and the file:line when known. The fix adds a regression test unless the case is manual-only. K1 waits for D1.
3. **Batch the small ones.** All minor UI-copy and docs-drift findings (K2, K5, K6, K7, K10 text, …) go into one PR: one `ce-work` brief, simplify skipped (docs and copy only).
4. **Per PR:** `ce-work` → `ce-simplify-code` (Sonnet; skip for docs-only) → `ce-code-review` (Opus, high; one pass per PR, at the end) → PR. A blocker finding stops the PR.
5. **Re-check.** After a fix PR lands, re-run only the affected cases (Haiku). Tick them again with the new evidence.
6. **Merge** follows the standing tidegap merge rule. Publishing and the 0.20.0 release need the owner.
7. **Capture.** `ce-compound` after the PRs, for non-obvious lessons only (for example the launchd-label isolation trap).

Expected first fixes, by the evidence in section 3: K1 (after D1), K3a and K3b (re-read the env file each tick and let file values replace values that the file set earlier), K4 (receipt model and tokens from one source), K5/K6/K7 docs batch.

## 9. Exit criterion: "green"

The launch posts and the 0.20.0 release wait for all of these:

1. Every non-manual checklist row is `[x]` with an evidence id.
2. No open blocker or major. Each open minor is fixed, or the owner accepts it as a known issue in the 0.20.0 notes (D6).
3. `node scripts/qa/gate.mjs all` prints PASS once on main after the last fix, with nothing else running (Haiku runs it).
4. The isolation proof of every stream is clean.
5. The owner ticked the manual list in section 5.
6. After the release: S11.4 (production agent path) and S12.10 (registry cold start) PASS on the published 0.20.0.

## 10. Decisions needed from the owner (not decided here)

- **D1. Mac-app reply.** (a) Hide the reply form and the `R` button for every client token: the server computes `actions.reply` per caller, so the Mac window shows no Send. Or (b) allow `POST /api/tasks/<id>/reply` for the `macos` token kind; the extension stays 403. Option (b) changes the rule "a client token never creates a task" in `docs/spec/ui-client-api.md`, because a reply creates a child task.
- **D2. Real `claude -p` run (S9.3).** Allow one agent run with the real Claude login. It writes one session transcript under `~/.claude/projects` and uses a little of the subscription. Or keep S9.3 owner-manual.
- **D3. Real Telegram (S5.14).** Which bot and chat to use. Whether the test may restart the real listener LaunchAgent `com.tidegap.channels`.
- **D4. Launch at login for the Mac app (K9).** Add it for 0.20.0, or leave it out.
- **D5. Claude Code plugin parity (K10).** Add `/tidegap:later` and `/tidegap:usage` before the posts, or keep eight commands.
- **D6. Minor bugs at the gate.** May minors ship as known issues in the 0.20.0 notes, or must all be fixed before the posts?
- **D7. Test-count claim (K6).** Keep a number on the site and README (re-measured each release, Python included), or remove it.
