# QA matrix checklist

Created: 2026-10-19 · Plan: `docs/plans/2026-10-19-qa-matrix-all-surfaces.md` (sections 2 and 7 are the rules).

Format: `- [ ] ID title — how — model`. Tick `- [x] … · ev:<evidence id>`. Failure: `- [!] … · <one line> · ev:<id>`. Flake: `- [~] … · flake · ev:<id>`. Evidence ids only: no local paths, tokens or log excerpts (public repo). Edit only your stream's rows.

How: `auto:` existing test · `iso` isolated CLI run · `pw` Playwright, serialized · `mcp` stdio call · `fake-tg` fake Bot API · `grep` · `script` · `manual` owner only.

## K. Known suspects (batch 1, stream B)

- [ ] K1 Reply shown to a client token, server 403 (history.ts:194, detail.js:306, server.ts:330) — grep, then S2.15/S3.9 — Haiku
- [ ] K2 "Connected apps" copy says apps can queue tasks (clients.js:63) — grep, then S2.20 — Haiku
- [ ] K3 tick --daemon keeps stale env secrets (env-file.ts:159, tick.ts:197) — grep, then S5.13/S9.8 — Haiku
- [ ] K4 reportedModel vs usage tokens in claude-code receipt (claude-code.ts:201) — grep, then S9.2/S9.3 — Haiku
- [ ] K5 MCP tool-count "ten" vs 12/11 (server.ts:5, README.md:331, plugin README:177, about:143, queue:207) — grep — Haiku
- [ ] K6 "1,423 tests" claim stale (README.md:183,187, about:48, proof.tsx:21) — grep + measurement — Haiku
- [ ] K7 Site CLI docs miss status, queue later, queue unread, usage, channels (03-cli.md) — grep — Haiku
- [ ] K8 Stale client token after revoke / forget (Connection.swift, WebPageWindow.swift) — see S3.11/S4.11/S2.4 — Haiku
- [ ] K9 Mac app has no launch at login — grep, record for D4 — Haiku
- [ ] K10 Plugin has no slash command for postpone/usage — grep, record for D5 — Haiku
- [ ] K11 Docs flags vs CLI options sweep stays clean — grep — Haiku

## S1. CLI (`packages/cli`)


- [ ] S1.1 `tidegap --version` — auto:version.test.ts + iso — Haiku
- [ ] S1.2 `tidegap --help` and each subcommand `--help` — iso + grep — Haiku
- [ ] S1.3 `tidegap status` on a fresh home — auto:status.test.ts + iso — Haiku
- [ ] S1.4 `tidegap status --json` — auto:readiness.test.ts — Haiku
- [ ] S1.5 `tidegap install --no-load` — auto:install.test.ts + iso — Haiku
- [ ] S1.6 `install --laptop` / `--server` / no flag (with `--no-load`) — auto:install.test.ts — Haiku
- [ ] S1.7 First run creates `~/.config/tidegap/env` — auto:env-file.test.ts, env.test.ts — Haiku
- [ ] S1.8 Legacy `~/.ebb` names present — auto:legacy-names.test.ts — Haiku
- [ ] S1.9 `tick --once` on an empty ledger — iso — Sonnet
- [ ] S1.10 Queue a `claude-code` task (MCP, S6.5), `tick --once` with the fake claude — auto:tick-claude-code.test.ts + iso — Sonnet
- [ ] S1.11 Pending `anthropic` task, no key — auto:readiness.test.ts — Haiku
- [ ] S1.12 `tick --daemon --interval 2`, three cycles, SIGTERM — iso — Sonnet
- [ ] S1.13 `queue list` with `--json`, `--status`, `--kind`, `--unread`, `--series` on a seeded ledger (`scripts/ui-seed.mjs --db`) — auto:queue.test.ts + iso — Haiku
- [ ] S1.14 `queue list --hook` with good, empty and broken hook input — auto:session-capture-hook.test.ts — Haiku
- [ ] S1.15 `queue show <id>` / `--no-mark-read` / `--json` / `--raw` — auto:queue.test.ts — Haiku
- [ ] S1.16 `queue unread <id>` — auto:queue.test.ts — Haiku
- [ ] S1.17 `queue later` with `--until +2h`, `tonight`, `tomorrow`, `HH:MM`, `after-limit-reset`, `--preset`, `--delay`, `--reset-at` — auto:queue.test.ts, core postpone.test.ts + iso — Haiku
- [ ] S1.18 `queue reschedule --by/--at/--day/--after-limit-reset` — auto:queue.test.ts — Haiku
- [ ] S1.19 `queue run-now <id>`, then `tick --once` — iso — Sonnet
- [ ] S1.20 `queue cancel <id>` / `--series` — auto:queue.test.ts — Haiku
- [ ] S1.21 `queue reply <id> "<text>" --by 1h` — auto:queue.test.ts — Haiku
- [ ] S1.22 `receipts list --since`, `verify <id>`, `verify --file`, tampered file — auto:receipts.test.ts, verify.test.ts — Haiku
- [ ] S1.23 `stats` and `stats --json` on a seeded ledger — iso — Haiku
- [ ] S1.24 `usage`, `usage --json` (with `TIDEGAP_USAGE=off` and with fixture data), `usage --spend` — auto:usage-command.test.ts, usage-*.test.ts — Haiku
- [ ] S1.25 `usage hook` and the statusline offer — auto:statusline-setup.test.ts — Haiku
- [ ] S1.26 `register-wake <id> --dry-run` — iso — Haiku
- [ ] S1.27 `clients add --name x --kind extension --json`, `list`, `revoke <id>` — auto:ui-clients.test.ts + iso — Haiku
- [ ] S1.28 `channels add telegram --no-load`, `list --json`, `remove <id>` against fake Telegram — iso + fake-tg — Sonnet
- [ ] S1.29 Error paths: unknown id, bad `--until`, missing required option — iso — Haiku
- [ ] S1.30 `--db <path>` on every command that takes it — iso — Haiku
- [ ] S1.31 Legacy `ebb` bin alias — auto:bin-alias.test.ts — Haiku

## S2. Web UI (`tidegap ui`, `packages/cli/ui`)


- [ ] S2.1 `tidegap ui --no-open --port P` — auto:ui-discovery.test.ts + iso — Haiku
- [ ] S2.2 Port taken: default and `--port n` — auto:ui-server.test.ts — Haiku
- [ ] S2.3 Open the link; reload without the fragment — pw — Haiku
- [ ] S2.4 Restart the server; use the old tab (stale page token) — pw — Sonnet
- [ ] S2.5 Agenda with no daemon — pw — Haiku
- [ ] S2.6 Agenda row → Later — pw — Sonnet
- [ ] S2.7 Later → Pick a time earlier than planned — pw — Sonnet
- [ ] S2.8 Run now (confirm) — pw — Sonnet
- [ ] S2.9 Cancel and cancel series — pw — Sonnet
- [ ] S2.10 Reschedule dialog — pw — Haiku
- [ ] S2.11 Timeline: curve, task blocks, drag to another hour — pw — Sonnet
- [ ] S2.12 Journal filters All / Unread / Completed / Failed; open a task; Mark unread / Mark read — pw — Sonnet
- [ ] S2.13 Task detail — pw — Haiku
- [ ] S2.14 Detail → Conversation → Reply (page token) — pw — Sonnet
- [ ] S2.15 Same with a client token (K1) — pw — Sonnet
- [ ] S2.16 Keyboard: `R`, Esc, list navigation — pw — Haiku
- [ ] S2.17 A tick in another process (iso) while the page is open — pw + iso — Sonnet
- [ ] S2.18 Start dispatcher — pw — Sonnet
- [ ] S2.19 Usage panel — pw — Haiku
- [ ] S2.20 Connected apps: Connect an app, copy, list, revoke (K2) — pw — Sonnet
- [ ] S2.21 Settings → Integrations with fake Telegram: save token → Connect (pairing, QR, link) → pair from the fake chat → Send test → Disconnect → Remove token — pw + fake-tg — Sonnet
- [ ] S2.22 Integrations errors: bad format, refused, webhook, network, rate limit — auto:ui-integrations.test.ts + pw — Haiku
- [ ] S2.23 Foreign Origin, foreign Host, extension origin on static files, CORS — auto:ui-server.test.ts — Haiku
- [ ] S2.24 Empty ledger (`ui-seed --empty`) — pw — Haiku
- [ ] S2.25 390 px wide and dark mode — pw — Haiku
- [ ] S2.26 Seeded title with markup (`<img onerror>`) — pw — Haiku
- [ ] S2.27 Console across all views and dialogs — pw — Haiku

## S3. Mac menu bar app (`apps/macos`)


- [ ] S3.1 TidegapKit unit tests — auto:`swift test --package-path apps/macos/TidegapKit` — Haiku
- [ ] S3.2 Release build — script — Haiku
- [ ] S3.3 First launch — script + iso — Haiku
- [ ] S3.4 Server found vs started — auto:ServerLauncherTests, DiscoveryTests — Haiku
- [ ] S3.5 Stale `ui.json` (dead pid), port taken — auto:DiscoveryTests, ConnectionTests — Haiku
- [ ] S3.6 Badge rules (`?`, `off`, count, `now`, clock, `!`) — auto:FormatTests — Haiku
- [ ] S3.7 Menu row: Later presets, Cancel…, Run now… — manual — owner
- [ ] S3.8 Open Tidegap window (page with the `macos` token) — pw (same URL and token) — Haiku
- [ ] S3.9 Window: Journal → task → Conversation → Send (K1) — pw + manual confirm — Sonnet
- [ ] S3.10 Integrations… — manual — owner
- [ ] S3.11 Revoke the Mac client from a browser page (K8) — auto:ConnectionTests + manual — Sonnet
- [ ] S3.12 Settings → Forget token, then Reconnect — manual — owner
- [ ] S3.13 Settings: command, port, notification toggles, Apply and retry — manual — owner
- [ ] S3.14 Notifications: a task finishes; a clean window starts — manual — owner
- [ ] S3.15 Launch at login (K9) — manual — owner
- [ ] S3.16 Quit — auto:ServerLauncherTests — Haiku
- [ ] S3.17 Safari extension inside the app — manual — owner

## S4. Browser extension (`apps/extension`)


- [ ] S4.1 Unit tests — auto:`pnpm --filter @tidegap/extension test` — Haiku
- [ ] S4.2 Build and lint — auto:build.test.js + lint — Haiku
- [ ] S4.3 Existing smoke — script (browser) — Haiku
- [ ] S4.4 Pair: options → paste token, port 47902, Save, Test connection — pw — Haiku
- [ ] S4.5 Wrong token — pw — Haiku
- [ ] S4.6 Server stopped — pw — Haiku
- [ ] S4.7 Popup with no daemon — pw — Haiku
- [ ] S4.8 Later in the popup — pw — Sonnet
- [ ] S4.9 Cancel, Run now — pw — Haiku
- [ ] S4.10 Popup has no create or reply; extension token on `/api/clients*`, `/api/integrations*` — auto:api.test.js + script (curl) — Haiku
- [ ] S4.11 Revoke while the popup is open (K8) — pw — Haiku
- [ ] S4.12 Notifications — auto:poller.test.js, notify.test.js — Haiku
- [ ] S4.13 Firefox and Safari install — manual — owner

## S5. Telegram channel


- [ ] S5.1 Unit tests — auto:core channels-*.test.ts, cli channels-*.test.ts, telegram-setup.test.ts — Haiku
- [ ] S5.2 `channels add telegram --no-load`, fake chat sends `/pair <code>`; wrong code; code after 10 min — iso + fake-tg — Sonnet
- [ ] S5.3 Deep link `/start <code>` — fake-tg — Sonnet
- [ ] S5.4 `channels serve --once`, `/queue` — fake-tg — Sonnet
- [ ] S5.5 `/later <n>` with `1h`, `tonight`, `tomorrow`, `reset HH:MM`, `HH:MM`; bad grammar — fake-tg — Sonnet
- [ ] S5.6 `/run n`, `/cancel n`, `/result n` (finished and pending); a number older than 10 min — fake-tg — Sonnet
- [ ] S5.7 `/help` text — grep — Haiku
- [ ] S5.8 Message from an unpaired chat — auto:channels-serve.test.ts — Haiku
- [ ] S5.9 Tick finishes a task — auto:tick-channels.test.ts + fake-tg — Sonnet
- [ ] S5.10 Logs and errors — auto + grep of stream logs — Haiku
- [ ] S5.11 Listener unit (generated with `--no-load`) — auto:platform-macos.test.ts — Haiku
- [ ] S5.12 Two pollers — auto:channels-serve.test.ts — Haiku
- [ ] S5.13 `tick --daemon` running; Integrations → Remove token (K3a) — iso + fake-tg — Sonnet
- [ ] S5.14 Real bot, real phone, real listener — manual (D3) — owner

## S6. MCP server (`packages/mcp-server`)


- [ ] S6.1 Unit tests — auto:`pnpm --filter @tidegap/mcp test` — Haiku
- [ ] S6.2 `tools/list` — script:`packages/mcp-server/scripts/smoke-stdio.mjs` — Haiku
- [ ] S6.3 `get_grid_forecast` (region FR, hours 24) — mcp — Haiku
- [ ] S6.4 `recommend_window` — mcp — Haiku
- [ ] S6.5 `schedule_task` `dry_run: true`, then real — mcp — Sonnet
- [ ] S6.6 `check_queue_status` all and one — mcp — Haiku
- [ ] S6.7 `tidegap_usage` with `TIDEGAP_USAGE=off` — mcp — Haiku
- [ ] S6.8 `cancel_task` — mcp — Haiku
- [ ] S6.9 `expedite_task` — mcp — Haiku
- [ ] S6.10 `update_deadline` — mcp — Haiku
- [ ] S6.11 `postpone_task` presets, and an earlier target — mcp — Haiku
- [ ] S6.12 `reply_task` on a completed task — mcp — Haiku
- [ ] S6.13 `retry_task` on a failed and on a completed task — mcp — Haiku
- [ ] S6.14 `cancel_all` — mcp — Haiku
- [ ] S6.15 `schedule_task` from a Claude Code session env — auto:server.origin.test.ts — Haiku
- [ ] S6.16 Bad arguments to each tool — mcp — Haiku
- [ ] S6.17 Registry metadata — auto:registry-metadata.test.ts — Haiku

## S7. Claude Code plugin (`packages/claude-code-plugin`, `.claude-plugin/marketplace.json`)


- [ ] S7.1 `/plugin marketplace add tidegap/tidegap`, `/plugin install tidegap`, restart — manual — owner
- [ ] S7.2 Versions — auto:`pnpm check:versions` — Haiku
- [ ] S7.3 Each `commands/*.md` — grep — Haiku
- [ ] S7.4 `skills/tidegap/SKILL.md` — grep — Haiku
- [ ] S7.5 SessionStart hook, `tidegap queue list --hook` — auto:session-capture-hook.test.ts + script — Haiku
- [ ] S7.6 `hooks/session-capture.sh` with bad input or no `tidegap` — script — Haiku
- [ ] S7.7 Slash commands for Later and usage (K10) — grep — Haiku
- [ ] S7.8 `/tidegap:defer "ping" --by tomorrow` in a real session — manual — owner

## S8. OpenClaw plugin (`packages/openclaw-plugin`)


- [ ] S8.1 Unit tests — auto:`pnpm --filter @vitalini/tidegap test` — Haiku
- [ ] S8.2 Smoke — script — Haiku
- [ ] S8.3 Tool set — auto:plugin.test.ts — Haiku
- [ ] S8.4 Install text — grep — Haiku
- [ ] S8.5 Telegram delivery — auto:delivery-telegram.test.ts — Haiku

## S9. Providers


- [ ] S9.1 claude-code adapter fixtures: success, limit, logged-out, refusal, budget, fork — auto:claude-code-adapter.test.ts, claude-code.test.ts — Haiku
- [ ] S9.2 `modelUsage` with two models (K4) — iso (fixture variant) — Sonnet
- [ ] S9.3 Real `claude -p` under the subscription: one task "Reply with the word pong", provider `claude-code`, `tick --once` — manual or owner-approved run (D2) — Sonnet
- [ ] S9.4 Limit result — auto:claude-code-adapter.test.ts — Haiku
- [ ] S9.5 anthropic, openai, gemini, ollama with mocks — auto:core providers.test.ts, providers-gemini-ollama.test.ts — Haiku
- [ ] S9.6 Missing key — auto:readiness.test.ts — Haiku
- [ ] S9.7 Timeout — auto:claude-code.test.ts — Haiku
- [ ] S9.8 Change a provider key in the env file while `tick --daemon` runs (K3b) — iso — Sonnet

## S10. Python core parity (`packages/core-py`)


- [ ] S10.1 `pytest -q` in a fresh venv — auto:`pnpm lint:py` (venv per `docs/solutions/developer-experience/worktree-environment-setup.md`) — Haiku
- [ ] S10.2 `ruff check .` — auto — Haiku
- [ ] S10.3 Shared fixtures: select-window, receipt sign vectors, energy, sampling — auto:core sampling-parity, sign-vectors, energy-parity tests + pytest twins — Haiku
- [ ] S10.4 A Python-queued task is visible to `tidegap queue list`, and the reverse — script (temp ledger) — Sonnet
- [ ] S10.5 Wheel install in a temp venv; README `from tidegap import defer` snippet — script — Haiku
- [ ] S10.6 `ebb-ai` shim — auto:CI step `ci.yml` python job — Haiku

## S11. Site (www.tidegap.com, `apps/web`)


- [ ] S11.1 Unit tests — auto:`pnpm --filter @tidegap/web test` — Haiku
- [ ] S11.2 Generated docs — auto — Haiku
- [ ] S11.3 Agent path on local `next start` (port 3100) — script — Haiku
- [ ] S11.4 Agent path on production — script — Haiku
- [ ] S11.5 Homepage install box — pw — Haiku
- [ ] S11.6 Docs page — pw — Haiku
- [ ] S11.7 Docs vs code (K5, K7, K11) — grep (docs-drift gate) — Haiku
- [ ] S11.8 `llms.txt`, `llms-full.txt` — script (check-agent-files `llms`, `docs`) — Haiku
- [ ] S11.9 `/about`, `/plan`, `/queue`, `/stats`, `/forecast`, `/map` — pw — Haiku
- [ ] S11.10 Claims (K6) — grep + measurement — Haiku
- [ ] S11.11 Images and brand — auto — Haiku

## S12. Release artifacts


- [ ] S12.1 Version lockstep — auto — Haiku
- [ ] S12.2 `npm pack --dry-run` for `@tidegap/core`, `@tidegap/cli`, `@tidegap/mcp` — script — Haiku
- [ ] S12.3 Cold start from the packed tarballs: temp prefix, temp HOME, empty npm cache — script — Haiku
- [ ] S12.4 Cold `npx -y <mcp tarball>` — script — Haiku
- [ ] S12.5 `tidegap ui` from the packed install — script — Haiku
- [ ] S12.6 Python sdist and wheel — script — Haiku
- [ ] S12.7 `pnpm preflight` on the release branch — auto — Haiku
- [ ] S12.8 Mac app zip from CI — manual — owner
- [ ] S12.9 Extension zips — auto:build.test.js — Haiku
- [ ] S12.10 After publish: `npx @tidegap/cli --version` and `npx -y @tidegap/mcp` from the registry, cold — script — Haiku

## Gate

- [ ] G1 Fix PRs merged; affected cases re-ticked — orchestrator — Haiku
- [ ] G2 `node scripts/qa/gate.mjs all` PASS on main, nothing else running — script — Haiku
- [ ] G3 Owner manual list (plan section 5) ticked — manual — owner
- [ ] G4 Owner decisions D1–D7 recorded — manual — owner
- [ ] G5 After 0.20.0 publish: S11.4 and S12.10 PASS — script — Haiku
