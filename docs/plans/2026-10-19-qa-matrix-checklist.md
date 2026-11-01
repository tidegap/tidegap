# QA matrix checklist

Created: 2026-10-19 · Plan: `docs/plans/2026-10-19-qa-matrix-all-surfaces.md` (sections 2 and 7 are the rules).

Format: `- [ ] ID title — how — model`. Tick `- [x] … · ev:<evidence id>`. Failure: `- [!] … · <one line> · ev:<id>`. Flake: `- [~] … · flake · ev:<id>`. Evidence ids only: no local paths, tokens or log excerpts (public repo). Edit only your stream's rows.

How: `auto:` existing test · `iso` isolated CLI run · `pw` Playwright, serialized · `mcp` stdio call · `fake-tg` fake Bot API · `grep` · `script` · `manual` owner only.

## Results (2026-10-19, main d697597)

Rows only; Gate rows G1-G5 stay open. Stream D (the harness) is PR #101.

| Surface | Pass | Fixed today | Open | Manual |
|---|---|---|---|---|
| K known suspects | 1 | 6 | 3 | 1 |
| S1 CLI | 29 | 2 | 0 | 0 |
| S2 Web UI | 25 | 2 | 0 | 0 |
| S3 Mac app | 8 | 1 | 0 | 8 |
| S4 Extension | 12 | 0 | 0 | 1 |
| S5 Telegram | 12 | 1 | 0 | 1 |
| S6 MCP | 17 | 0 | 0 | 0 |
| S7 Claude Code plugin | 5 | 1 | 0 | 2 |
| S8 OpenClaw plugin | 5 | 0 | 0 | 0 |
| S9 Providers | 7 | 0 | 0 | 1 |
| S10 Python core | 4 | 2 | 0 | 0 |
| S11 Site | 9 | 0 | 2 | 0 |
| S12 Release | 5 | 2 | 1 | 2 (+1 post-publish) |
| S rows total | 138 | 11 | 3 | 15 |

Open items:

- K6 / S11.10: test-count claim 1,578 vs 1,594 measured (D7).
- K9 / S3.15: launch at login added as a Settings option, default off (D4) · fixed #107; live check owner-manual.
- K10 / S7.7: no slash command for Later or usage (D5).
- S11.6: docs code blocks have no copy buttons (fix in flight).
- S12.4: cold `npx` of the mcp tarball alone fails until `@tidegap/cli` 0.20.0 is on the registry; recheck with S12.10 at G5.
- S9.3: real `claude -p` run waits for D2.

Owner-manual rows: S3.7, S3.10, S3.11, S3.12, S3.13, S3.14, S3.15, S3.17, S4.13, S5.14, S7.1, S7.8, S9.3, S12.8 (and K8, Mac side). S12.10 waits for the publish.

PRs: #98 pytest close; #99 K2 K5 K6 K7 S5.7 S7.3 docs; #100 K3 K4; #101 QA harness; #102 S1.9 S12.5 S2.7; #103 K7 subcommand rows and gate flags; #104 status readiness, README deadlines, tool-surface wording.

## K. Known suspects (batch 1, stream B)

- [x] K1 Reply shown to a client token, server 403 (history.ts:194, detail.js:306, server.ts:330) — grep, then S2.15/S3.9 — Haiku · ev:B-1, D1-S2.15-reply · fixed #109 (D1: macos replies, extension hidden)
- [x] K2 "Connected apps" copy says apps can queue tasks (clients.js:63) — grep, then S2.20 — Haiku · ev:B-2 · fixed #99
- [x] K3 tick --daemon keeps stale env secrets (env-file.ts:159, tick.ts:197) — grep, then S5.13/S9.8 — Haiku · ev:B-3, G-2 · fixed #100
- [x] K4 reportedModel vs usage tokens in claude-code receipt (claude-code.ts:201) — grep, then S9.2/S9.3 — Haiku · ev:B-4, E-1 · fixed #100
- [x] K5 MCP tool-count "ten" vs 12/11 (server.ts:5, README.md:331, plugin README:177, about:143, queue:207) — grep — Haiku · ev:B-5 · fixed #99
- [x] K6 "1,423 tests" claim stale (README.md:183,187, about:48, proof.tsx:21) — grep + measurement — Haiku · claim 1,423 vs measured 1,578 to 1,594; owner decision D7 · ev:B-6, L-10 · fixed #110
- [x] K7 Site CLI docs miss status, queue later, queue unread, usage, channels (03-cli.md) — grep — Haiku · ev:B-7 · fixed #99 #103
- [ ] K8 Stale client token after revoke / forget (Connection.swift, WebPageWindow.swift) — see S3.11/S4.11/S2.4 — Haiku · owner-manual · extension and page paths pass (S4.11, S2.4); Mac side is S3.11 · ev:B-8, J-11
- [x] K9 Mac app has no launch at login — grep, record for D4 — Haiku · confirmed absent; owner decision D4 · ev:B-9 · fixed #107
- [x] K10 Plugin has no slash command for postpone/usage — grep, record for D5 — Haiku · confirmed absent; owner decision D5 · ev:B-10, CLOSE-6 · fixed #108
- [x] K11 Docs flags vs CLI options sweep stays clean — grep — Haiku · ev:B-11

## S1. CLI (`packages/cli`)


- [x] S1.1 `tidegap --version` — auto:version.test.ts + iso — Haiku · ev:E-1
- [x] S1.2 `tidegap --help` and each subcommand `--help` — iso + grep — Haiku · ev:E-1 · fixed #99 #103
- [x] S1.3 `tidegap status` on a fresh home — auto:status.test.ts + iso — Haiku · ev:E-1
- [x] S1.4 `tidegap status --json` — auto:readiness.test.ts — Haiku · ev:E-2
- [x] S1.5 `tidegap install --no-load` — auto:install.test.ts + iso — Haiku · ev:E-1
- [x] S1.6 `install --laptop` / `--server` / no flag (with `--no-load`) — auto:install.test.ts — Haiku · ev:E-3
- [x] S1.7 First run creates `~/.config/tidegap/env` — auto:env-file.test.ts, env.test.ts — Haiku · ev:E-3
- [x] S1.8 Legacy `~/.ebb` names present — auto:legacy-names.test.ts — Haiku · ev:E-4
- [x] S1.9 `tick --once` on an empty ledger — iso — Sonnet · ev:E-1 · fixed #102
- [x] S1.10 Queue a `claude-code` task (MCP, S6.5), `tick --once` with the fake claude — auto:tick-claude-code.test.ts + iso — Sonnet · ev:E-1
- [x] S1.11 Pending `anthropic` task, no key — auto:readiness.test.ts — Haiku · ev:CLOSE-9
- [x] S1.12 `tick --daemon --interval 2`, three cycles, SIGTERM — iso — Sonnet · ev:E-1
- [x] S1.13 `queue list` with `--json`, `--status`, `--kind`, `--unread`, `--series` on a seeded ledger (`scripts/ui-seed.mjs --db`) — auto:queue.test.ts + iso — Haiku · ev:E-1
- [x] S1.14 `queue list --hook` with good, empty and broken hook input — auto:session-capture-hook.test.ts — Haiku · ev:E-6
- [x] S1.15 `queue show <id>` / `--no-mark-read` / `--json` / `--raw` — auto:queue.test.ts — Haiku · ev:E-6
- [x] S1.16 `queue unread <id>` — auto:queue.test.ts — Haiku · ev:E-6
- [x] S1.17 `queue later` with `--until +2h`, `tonight`, `tomorrow`, `HH:MM`, `after-limit-reset`, `--preset`, `--delay`, `--reset-at` — auto:queue.test.ts, core postpone.test.ts + iso — Haiku · ev:E-1
- [x] S1.18 `queue reschedule --by/--at/--day/--after-limit-reset` — auto:queue.test.ts — Haiku · ev:E-6
- [x] S1.19 `queue run-now <id>`, then `tick --once` — iso — Sonnet · ev:E-1
- [x] S1.20 `queue cancel <id>` / `--series` — auto:queue.test.ts — Haiku · ev:E-6
- [x] S1.21 `queue reply <id> "<text>" --by 1h` — auto:queue.test.ts — Haiku · ev:E-6
- [x] S1.22 `receipts list --since`, `verify <id>`, `verify --file`, tampered file — auto:receipts.test.ts, verify.test.ts — Haiku · ev:E-7
- [x] S1.23 `stats` and `stats --json` on a seeded ledger — iso — Haiku · ev:E-1
- [x] S1.24 `usage`, `usage --json` (with `TIDEGAP_USAGE=off` and with fixture data), `usage --spend` — auto:usage-command.test.ts, usage-*.test.ts — Haiku · ev:E-8
- [x] S1.25 `usage hook` and the statusline offer — auto:statusline-setup.test.ts — Haiku · ev:E-8
- [x] S1.26 `register-wake <id> --dry-run` — iso — Haiku · ev:E-1
- [x] S1.27 `clients add --name x --kind extension --json`, `list`, `revoke <id>` — auto:ui-clients.test.ts + iso — Haiku · ev:E-1
- [x] S1.28 `channels add telegram --no-load`, `list --json`, `remove <id>` against fake Telegram — iso + fake-tg — Sonnet · ev:G-2
- [x] S1.29 Error paths: unknown id, bad `--until`, missing required option — iso — Haiku · ev:E-1
- [x] S1.30 `--db <path>` on every command that takes it — iso — Haiku · ev:E-1
- [x] S1.31 Legacy `ebb` bin alias — auto:bin-alias.test.ts — Haiku · ev:E-9

## S2. Web UI (`tidegap ui`, `packages/cli/ui`)


- [x] S2.1 `tidegap ui --no-open --port P` — auto:ui-discovery.test.ts + iso — Haiku · ev:I-auto.log
- [x] S2.2 Port taken: default and `--port n` — auto:ui-server.test.ts — Haiku · ev:I-auto.log
- [x] S2.3 Open the link; reload without the fragment — pw — Haiku · ev:I.log
- [x] S2.4 Restart the server; use the old tab (stale page token) — pw — Sonnet · ev:I.log
- [x] S2.5 Agenda with no daemon — pw — Haiku · ev:I-agenda.png
- [x] S2.6 Agenda row → Later — pw — Sonnet · ev:I-later.png
- [x] S2.7 Later → Pick a time earlier than planned — pw — Sonnet · ev:I.log · fixed #102
- [x] S2.8 Run now (confirm) — pw — Sonnet · ev:I.log
- [x] S2.9 Cancel and cancel series — pw — Sonnet · ev:I.log
- [x] S2.10 Reschedule dialog — pw — Haiku · ev:I.log
- [x] S2.11 Timeline: curve, task blocks, drag an Agenda row onto a day dock (Run now + next 7 days) — pw — Sonnet · ev:I.log
- [x] S2.12 Journal filters All / Unread / Completed / Failed; open a task; Mark unread / Mark read — pw — Sonnet · ev:I.log
- [x] S2.13 Task detail — pw — Haiku · ev:I-detail.png
- [x] S2.14 Detail → Conversation → Reply (page token) — pw — Sonnet · ev:I.log
- [x] S2.15 Same with a client token (K1) — pw — Sonnet · ev:D1-S2.15-reply.png · fixed #109
- [x] S2.16 Keyboard: `R`, Esc, list navigation — pw — Haiku · ev:I.log
- [x] S2.17 A tick in another process (iso) while the page is open — pw + iso — Sonnet · ev:I.log
- [x] S2.18 Start dispatcher — pw — Sonnet · ev:I.log
- [x] S2.19 Usage panel — pw — Haiku · ev:I.log
- [x] S2.20 Connected apps: Connect an app, copy, list, revoke (K2) — pw — Sonnet · ev:I.log
- [x] S2.21 Settings → Integrations with fake Telegram: save token → Connect (pairing, QR, link) → pair from the fake chat → Send test → Disconnect → Remove token — pw + fake-tg — Sonnet · ev:I-pairing.png
- [x] S2.22 Integrations errors: bad format, refused, webhook, network, rate limit — auto:ui-integrations.test.ts + pw — Haiku · ev:I-auto.log · browser drove bad format only; refused, webhook, network and rate-limit states are covered by unit tests
- [x] S2.23 Foreign Origin, foreign Host, extension origin on static files, CORS — auto:ui-server.test.ts — Haiku · ev:I-auto.log
- [x] S2.24 Empty ledger (`ui-seed --empty`) — pw — Haiku · ev:I.log
- [x] S2.25 390 px wide and dark mode — pw — Haiku · ev:I-narrow-dark-agenda.png
- [x] S2.26 Seeded title with markup (`<img onerror>`) — pw — Haiku · ev:I.log
- [x] S2.27 Console across all views and dialogs — pw — Haiku · ev:I.log
- [ ] S2.32 Usage popover: spend grid with one header row and one line per row at 1280 px, stacked rows at 390 px, light and dark; a Codex reading older than both windows reads "No reading for 162 days." — pw:ui-flows.mjs — Haiku

## S3. Mac menu bar app (`apps/macos`)


- [x] S3.1 TidegapKit unit tests — auto:`swift test --package-path apps/macos/TidegapKit` — Haiku · ev:K-1
- [x] S3.2 Release build — script — Haiku · ev:K-2
- [x] S3.3 First launch — script + iso — Haiku · ev:K-3
- [x] S3.4 Server found vs started — auto:ServerLauncherTests, DiscoveryTests — Haiku · ev:K-1
- [x] S3.5 Stale `ui.json` (dead pid), port taken — auto:DiscoveryTests, ConnectionTests — Haiku · ev:K-1
- [x] S3.6 Badge rules (`?`, `off`, count, `now`, clock, `!`) — auto:FormatTests — Haiku · ev:K-1
- [ ] S3.7 Menu row: Later presets, Cancel…, Run now… — manual — owner · owner-manual
- [x] S3.8 Open Tidegap window (page with the `macos` token) — pw (same URL and token) — Haiku · ev:K-4
- [x] S3.9 Window: Journal → task → Conversation → Send (K1) — pw + manual confirm — Sonnet · ev:D1-S3.9-reply.png · fixed #109
- [ ] S3.10 Integrations… — manual — owner · owner-manual
- [ ] S3.11 Revoke the Mac client from a browser page (K8) — auto:ConnectionTests + manual — Sonnet · owner-manual
- [ ] S3.12 Settings → Forget token, then Reconnect — manual — owner · owner-manual
- [ ] S3.13 Settings: command, port, notification toggles, Apply and retry — manual — owner · owner-manual
- [ ] S3.14 Notifications: a task finishes; a clean window starts — manual — owner · owner-manual
- [ ] S3.15 Launch at login (K9) — manual — owner · owner-manual · option added #107 (Settings > App, default off)
- [x] S3.16 Quit — auto:ServerLauncherTests — Haiku · ev:K-1
- [ ] S3.17 Safari extension inside the app — manual — owner · owner-manual

## S4. Browser extension (`apps/extension`)


- [x] S4.1 Unit tests — auto:`pnpm --filter @tidegap/extension test` — Haiku · ev:J-1
- [x] S4.2 Build and lint — auto:build.test.js + lint — Haiku · ev:J-2
- [x] S4.3 Existing smoke — script (browser) — Haiku · ev:J-3
- [x] S4.4 Pair: options → paste token, port 47902, Save, Test connection — pw — Haiku · ev:J-4
- [x] S4.5 Wrong token — pw — Haiku · ev:J-5
- [x] S4.6 Server stopped — pw — Haiku · ev:J-6
- [x] S4.7 Popup with no daemon — pw — Haiku · ev:J-7
- [x] S4.8 Later in the popup — pw — Sonnet · ev:J-8
- [x] S4.9 Cancel, Run now — pw — Haiku · ev:J-9
- [x] S4.10 Popup has no create or reply; extension token on `/api/clients*`, `/api/integrations*` — auto:api.test.js + script (curl) — Haiku · ev:J-10
- [x] S4.11 Revoke while the popup is open (K8) — pw — Haiku · ev:J-11
- [x] S4.12 Notifications — auto:poller.test.js, notify.test.js — Haiku · ev:J-12
- [ ] S4.13 Firefox and Safari install — manual — owner · owner-manual

## S5. Telegram channel


- [x] S5.1 Unit tests — auto:core channels-*.test.ts, cli channels-*.test.ts, telegram-setup.test.ts — Haiku · ev:G-1
- [x] S5.2 `channels add telegram --no-load`, fake chat sends `/pair <code>`; wrong code; code after 10 min — iso + fake-tg — Sonnet · ev:G-2 · pairing code expiry is covered by unit tests only
- [x] S5.3 Deep link `/start <code>` — fake-tg — Sonnet · ev:G-2
- [x] S5.4 `channels serve --once`, `/queue` — fake-tg — Sonnet · ev:G-2
- [x] S5.5 `/later <n>` with `1h`, `tonight`, `tomorrow`, `reset HH:MM`, `HH:MM`; bad grammar — fake-tg — Sonnet · ev:G-2
- [x] S5.6 `/run n`, `/cancel n`, `/result n` (finished and pending); a number older than 10 min — fake-tg — Sonnet · ev:G-2 · the 10-minute listing expiry is covered by unit tests only
- [x] S5.7 `/help` text — grep — Haiku · ev:G-3 · fixed #99
- [x] S5.8 Message from an unpaired chat — auto:channels-serve.test.ts — Haiku · ev:G-1
- [x] S5.9 Tick finishes a task — auto:tick-channels.test.ts + fake-tg — Sonnet · ev:G-1
- [x] S5.10 Logs and errors — auto + grep of stream logs — Haiku · ev:G-2
- [x] S5.11 Listener unit (generated with `--no-load`) — auto:platform-macos.test.ts — Haiku · ev:G-1
- [x] S5.12 Two pollers — auto:channels-serve.test.ts — Haiku · ev:G-1
- [x] S5.13 `tick --daemon` running; Integrations → Remove token (K3a) — iso + fake-tg — Sonnet · ev:G-2
- [ ] S5.14 Real bot, real phone, real listener — manual (D3) — owner · owner-manual

## S6. MCP server (`packages/mcp-server`)


- [x] S6.1 Unit tests — auto:`pnpm --filter @tidegap/mcp test` — Haiku · ev:F-3
- [x] S6.2 `tools/list` — script:`packages/mcp-server/scripts/smoke-stdio.mjs` — Haiku · ev:F-2
- [x] S6.3 `get_grid_forecast` (region FR, hours 24) — mcp — Haiku · ev:F-1
- [x] S6.4 `recommend_window` — mcp — Haiku · ev:F-1
- [x] S6.5 `schedule_task` `dry_run: true`, then real — mcp — Sonnet · ev:F-1
- [x] S6.6 `check_queue_status` all and one — mcp — Haiku · ev:F-1
- [x] S6.7 `tidegap_usage` with `TIDEGAP_USAGE=off` — mcp — Haiku · ev:F-1
- [x] S6.8 `cancel_task` — mcp — Haiku · ev:F-1
- [x] S6.9 `expedite_task` — mcp — Haiku · ev:F-1
- [x] S6.10 `update_deadline` — mcp — Haiku · ev:F-1
- [x] S6.11 `postpone_task` presets, and an earlier target — mcp — Haiku · ev:F-1
- [x] S6.12 `reply_task` on a completed task — mcp — Haiku · ev:F-1
- [x] S6.13 `retry_task` on a failed and on a completed task — mcp — Haiku · ev:F-1
- [x] S6.14 `cancel_all` — mcp — Haiku · ev:F-1
- [x] S6.15 `schedule_task` from a Claude Code session env — auto:server.origin.test.ts — Haiku · ev:F-4
- [x] S6.16 Bad arguments to each tool — mcp — Haiku · ev:F-1
- [x] S6.17 Registry metadata — auto:registry-metadata.test.ts — Haiku · ev:F-4

## S7. Claude Code plugin (`packages/claude-code-plugin`, `.claude-plugin/marketplace.json`)


- [ ] S7.1 `/plugin marketplace add tidegap/tidegap`, `/plugin install tidegap`, restart — manual — owner · owner-manual
- [x] S7.2 Versions — auto:`pnpm check:versions` — Haiku · ev:CLOSE-1
- [x] S7.3 Each `commands/*.md` — grep — Haiku · ev:CLOSE-2, B-13 · fixed #99
- [x] S7.4 `skills/tidegap/SKILL.md` — grep — Haiku · ev:CLOSE-3
- [x] S7.5 SessionStart hook, `tidegap queue list --hook` — auto:session-capture-hook.test.ts + script — Haiku · ev:CLOSE-4
- [x] S7.6 `hooks/session-capture.sh` with bad input or no `tidegap` — script — Haiku · ev:CLOSE-5
- [x] S7.7 Slash commands for Later and usage (K10) — grep — Haiku · ev:CLOSE-6 · fixed #108
- [ ] S7.8 `/tidegap:defer "ping" --by tomorrow` in a real session — manual — owner · owner-manual

## S8. OpenClaw plugin (`packages/openclaw-plugin`)


- [x] S8.1 Unit tests — auto:`pnpm --filter @vitalini/tidegap test` — Haiku · ev:CLOSE-7
- [x] S8.2 Smoke — script — Haiku · ev:CLOSE-8
- [x] S8.3 Tool set — auto:plugin.test.ts — Haiku · ev:CLOSE-7
- [x] S8.4 Install text — grep — Haiku · ev:B-15
- [x] S8.5 Telegram delivery — auto:delivery-telegram.test.ts — Haiku · ev:CLOSE-7

## S9. Providers


- [x] S9.1 claude-code adapter fixtures: success, limit, logged-out, refusal, budget, fork — auto:claude-code-adapter.test.ts, claude-code.test.ts — Haiku · ev:CLOSE-9
- [x] S9.2 `modelUsage` with two models (K4) — iso (fixture variant) — Sonnet · ev:E-1
- [ ] S9.3 Real `claude -p` under the subscription: one task "Reply with the word pong", provider `claude-code`, `tick --once` — manual or owner-approved run (D2) — Sonnet · owner-manual · skipped, owner decision D2
- [x] S9.4 Limit result — auto:claude-code-adapter.test.ts — Haiku · ev:CLOSE-9
- [x] S9.5 anthropic, openai, gemini, ollama with mocks — auto:core providers.test.ts, providers-gemini-ollama.test.ts — Haiku · ev:CLOSE-10
- [x] S9.6 Missing key — auto:readiness.test.ts — Haiku · ev:CLOSE-9
- [x] S9.7 Timeout — auto:claude-code.test.ts — Haiku · ev:CLOSE-9
- [x] S9.8 Change a provider key in the env file while `tick --daemon` runs (K3b) — iso — Sonnet · ev:E-1

## S10. Python core parity (`packages/core-py`)


- [x] S10.1 `pytest -q` in a fresh venv — auto:`pnpm lint:py` (venv per `docs/solutions/developer-experience/worktree-environment-setup.md`) — Haiku · ev:H-1 · fixed #98
- [x] S10.2 `ruff check .` — auto — Haiku · ev:H-2
- [x] S10.3 Shared fixtures: select-window, receipt sign vectors, energy, sampling — auto:core sampling-parity, sign-vectors, energy-parity tests + pytest twins — Haiku · ev:H-3
- [x] S10.4 A Python-queued task is visible to `tidegap queue list`, and the reverse — script (temp ledger) — Sonnet · ev:H-4
- [x] S10.5 Wheel install in a temp venv; README `from tidegap import defer` snippet — script — Haiku · ev:H-5 · fixed #104
- [x] S10.6 `ebb-ai` shim — auto:CI step `ci.yml` python job — Haiku · ev:H-6

## S11. Site (www.tidegap.com, `apps/web`)


- [x] S11.1 Unit tests — auto:`pnpm --filter @tidegap/web test` — Haiku · ev:L-1
- [x] S11.2 Generated docs — auto — Haiku · ev:L-2
- [x] S11.3 Agent path on local `next start` (port 3100) — script — Haiku · ev:L-3
- [x] S11.4 Agent path on production — script — Haiku · ev:L-4
- [x] S11.5 Homepage install box — pw — Haiku · ev:L-5
- [!] S11.6 Docs page — pw — Haiku · docs code blocks have no copy buttons; fix in flight · ev:L-6
- [x] S11.7 Docs vs code (K5, K7, K11) — grep (docs-drift gate) — Haiku · ev:L-7
- [x] S11.8 `llms.txt`, `llms-full.txt` — script (check-agent-files `llms`, `docs`) — Haiku · ev:L-8
- [x] S11.9 `/about`, `/plan`, `/queue`, `/stats`, `/forecast`, `/map` — pw — Haiku · ev:L-9
- [x] S11.10 Claims (K6) — grep + measurement — Haiku · measured 1,594 vs claimed 1,578; owner decision D7 · ev:L-10 · fixed #110
- [x] S11.11 Images and brand — auto — Haiku · ev:L-11

## S12. Release artifacts


- [x] S12.1 Version lockstep — auto — Haiku · ev:C-1
- [x] S12.2 `npm pack --dry-run` for `@tidegap/core`, `@tidegap/cli`, `@tidegap/mcp` — script — Haiku · ev:C-2
- [x] S12.3 Cold start from the packed tarballs: temp prefix, temp HOME, empty npm cache — script — Haiku · ev:C-3
- [!] S12.4 Cold `npx -y <mcp tarball>` — script — Haiku · cold npx of the mcp tarball alone crashes (registry @tidegap/cli 0.19.0 has no usage export); resolves at the 0.20.0 publish, recheck at G5 · ev:C-4
- [x] S12.5 `tidegap ui` from the packed install — script — Haiku · ev:C-5 · fixed #102
- [x] S12.6 Python sdist and wheel — script — Haiku · ev:C-6
- [x] S12.7 `pnpm preflight` on the release branch — auto — Haiku · ev:C-7 · fixed #98
- [ ] S12.8 Mac app zip from CI — manual — owner · owner-manual
- [x] S12.9 Extension zips — auto:build.test.js — Haiku · ev:C-9
- [ ] S12.10 After publish: `npx @tidegap/cli --version` and `npx -y @tidegap/mcp` from the registry, cold — script — Haiku · post-publish, recheck at G5 · ev:C-10

## S13. Notification channels (all-channels plan U5–U15)

- [x] S13.1 Webhook: one signed POST the harness verifies, with the custom header — script:channels-flows.mjs — Haiku · ev:U15-channels
- [x] S13.2 Webhook: 503 twice, then 200: three requests with one delivery id — script:channels-flows.mjs — Haiku · ev:U15-channels
- [x] S13.3 Slack: text plus one mrkdwn block — script:channels-flows.mjs — Haiku · ev:U15-channels
- [x] S13.4 Discord: one embed, `wait=true`, no allowed mentions — script:channels-flows.mjs — Haiku · ev:U15-channels
- [x] S13.5 ntfy: `<server>/<topic>` with Title, Priority, Tags and the Bearer token — script:channels-flows.mjs — Haiku · ev:U15-channels
- [x] S13.6 Pushover: form POST to `/1/messages.json` — script:channels-flows.mjs — Haiku · ev:U15-channels
- [x] S13.7 Email: one mail through the fake SMTP server — script:channels-flows.mjs — Haiku · ev:U15-channels
- [ ] S13.7m Email: one real Gmail and one real iCloud mail — manual — owner · owner-manual
- [ ] S13.8 Shortcuts: a real Shortcut from the launchd tick — manual — owner · owner-manual
- [x] S13.8f Shortcuts: `shortcuts run <name> --input-path <file>` with the fake bin; the file is removed — script:channels-flows.mjs — Haiku · ev:U15-channels
- [x] S13.10 `channels add webhook --secrets-stdin`, `add slack --url` exit 2, `list --json` hints only — script:cli-flows.mjs — Haiku · ev:#126
- [x] S13.12 Command: the program gets the JSON on stdin, argv as typed, a minimal env — script:channels-flows.mjs — Haiku · ev:U15-channels
- [x] S13.14 Daily summary: one digest through `tick --once`, the done alert folds into it, a second tick sends nothing — script:channels-flows.mjs — Haiku · ev:U15-channels
- [x] S13.15 Notifications docs vs code: kinds, quoted error codes, `channels` subcommands and `--help` blocks (K13) — script:docs-drift.mjs — Haiku · ev:U14-docs-drift
- [ ] S13.16 Settings → Integrations "Daily summary at": Save stores the time at once; `POST /api/integrations/digest` 400 `field: at` for a bad value; the `macos` token can set it — pw:ui-flows.mjs — Haiku
- [x] S2.28–S2.31 Integrations cards: webhook one-step connect, every ready kind, settings persist, 390 px and dark — pw:ui-flows.mjs — Haiku · ev:U15-ui

## S14. Grid region setting (CLI, API, Settings card)


- [x] S14.1 (cli) `tidegap region show / set / detect` under `TZ=Europe/Kyiv`; `set UA` exits 2 — script:cli-flows.mjs — Haiku · ev:RS3-cli.log
- [x] S14.1 (ui) Grid region card under `--region FR`: source Flag, the override named, Save and the select off — pw:ui-flows.mjs — Haiku · ev:RS3-ui.log
- [x] S14.2 (ui) Card without `--region`, `TZ=Europe/Kyiv`: PL + UA note; save DE in one step (live region, `/api/summary`, timeline follow); unknown UA alert keeps focus on the search; Auto returns to PL; 390 px dark — pw:ui-flows.mjs — Haiku · ev:RS3-ui.log

## Gate

- [ ] G1 Fix PRs merged; affected cases re-ticked — orchestrator — Haiku
- [ ] G2 `node scripts/qa/gate.mjs all` PASS on main, nothing else running — script — Haiku
- [ ] G3 Owner manual list (plan section 5) ticked — manual — owner
- [ ] G4 Owner decisions D1–D7 recorded — manual — owner
- [ ] G5 After 0.20.0 publish: S11.4 and S12.10 PASS — script — Haiku
