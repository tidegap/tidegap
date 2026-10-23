# Changelog

All notable changes to Tidegap (called Ebb AI until 0.17) will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Security

- **Dev dependency `vite` 8.1.5 → 8.1.6** (pnpm override `vite@<8.1.6`), for three Dependabot alerts (GHSA-587h-7wmj-h5pm, GHSA-698v-4r3x-3vcv, GHSA-r825-w8mm-5pxw). `vite` comes in only as a peer of `vitest`, so it never ships in a package.

### Added

- **Daily summary time in Settings → Integrations.** A "Daily summary at" field above the channel cards: type the time, press Save, and it applies at once. `POST /api/integrations/digest {"at": "HH:MM"}` (page token or `macos` client token) checks the value like `tidegap channels digest --at` and answers `{"digest": {at, last?}}`; 400 `invalid` with `field: "at"` otherwise.
- **Daily summary (`digest`).** A channel subscribed to the "Daily summary" event gets one message a day at 09:00 local time (the end of the quiet hours; `tidegap channels digest --at HH:MM` changes it, `tidegap channels digest` shows it). The summary lists the tasks done, failed and postponed since the previous summary (at most 10 titles per section, then "and N more"), the carbon of the done tasks, the readiness problems still open, and the queued count with the next clean window. A day with nothing to report sends nothing. A machine that was asleep sends one summary when it wakes, covering at most 48 hours. Quiet hours never hold the summary. On a channel that gets the summary, an alert it lists (a task finished in the window, an open problem, the named clean window) is not sent separately: an alert held overnight arrives once, inside the summary; an alert for something the summary does not list still goes out after 09:00. When every send fails, the next tick tries again. If the summary fails on one channel and reaches another, the failed channel gets its alerts on their own. `GET /api/integrations` returns `digest: {at, last?}`, which turns on the card's "Daily summary" chip; `last` is the time a summary last reached a channel; `tidegap channels set --events` takes `digest`. Core: `buildDigest`, `digestDue`, `foldIntoDigest`, `TaskStore.listFinishedSince` and `listEventsSince`.
- **Pushover, email, Shortcuts and Command channels, and `tidegap channels` for every kind.** **Pushover:** your user key and an application API token. **Email:** your own SMTP account with an app password; presets for Gmail, iCloud, Fastmail and Microsoft 365 (work, only where the admin allows SMTP AUTH); Outlook.com and Hotmail personal accounts are not supported. Tidegap always checks the server certificate and signs in only over TLS or to a server on this computer. **Shortcuts (macOS):** runs a named Shortcut with the message as its input. **Command (macOS, Linux):** runs a program you own, with no shell, the Tidegap JSON on its standard input and only `PATH`, `HOME`, `LANG` and `TMPDIR` set; a program that you do not own or that others can write to is refused (`unsafe_path`), so wrap a system program such as `/usr/bin/say` in your own script. Both stop after 20 seconds. The CLI gains `tidegap channels add <kind>` for every kind (flags for the non-secret fields, `--preset`, `--events`, `--quiet`, `--clear`; secrets from a hidden prompt or `--secrets-stdin`, never from flags), `kinds`, `connect`, `test`, `disconnect` and `set <id>`. `tidegap channels list` shows the columns ID, KIND, STATE, EVENTS, LAST and TARGET (secrets as hints only). An unknown kind exits 2; an unknown flag on a kind (such as `--url`) exits 2 and never prints its value; `channels add telegram` takes no kind fields and ignores other flags. `remove` deletes the channel's secrets too.
- **Settings → Grid region, and the region docs.** The page and the Mac app get a "Grid region" card: the zone in use, where it came from and its data source; a search over the 31 zones (code, name, country, grid operator, data source); one Save; "Auto (time zone)" to clear the setting. A `--region` flag or `TIDEGAP_DEFAULT_REGION` turns Save off and the card names the override. An approximate guess (Kyiv → PL) or the GB default shows a note and a "Request your region" link, which opens the new region request issue template. The site docs gain Config → Grid region (the precedence, which surfaces read `~/.config/tidegap/env` live and that the MCP server reads only its process environment, the Ukraine note, and a zone table generated from the catalog by `pnpm gen:docs`), the `tidegap region` section of the CLI page, the card on the UI page and region rules for tool calls; the plugin's `/tidegap:grid` and `/tidegap:plan` take the default zone from `tidegap region show --json`. `docs-drift` checks the region docs against the resolver (K12).
- **`tidegap region` and `/api/settings/region`.** `tidegap region show [--json]` prints the zone, where it came from (flag, env, stored setting, time zone or the GB default) and its data source; `set <zone>` stores a supported zone (any case, `UK` for GB) as `TIDEGAP_DEFAULT_REGION` in `~/.tidegap/config` with an atomic write that keeps the other lines (`set auto` removes it; an unknown zone exits 2 with the closest zones and a region request link); `detect` prints the time-zone guess and stores nothing; `list` prints the 31 zones. `tidegap ui` gains `GET|POST /api/settings/region` (page token or `macos` client token, never an extension; 30 writes per minute) and `region_source` in `/api/summary` and `/api/status`. A time zone in Kyiv resolves to PL with the note "No Ukrainian grid data yet". See `docs/spec/ui-client-api.md`.
- **Grid region foundation (core).** `@tidegap/core` gains the region catalog (`REGION_CATALOG`: name, country, country name and grid operator for each of the 31 supported zones, from `regions.json` through `pnpm gen:data`, so the Python core has it too), `resolveRegion({requested, configured, setting, timeZone})` with the precedence flag > `TIDEGAP_DEFAULT_REGION` (env) or host config > the setting in `~/.tidegap/config` > time-zone guess > `GB`, `loadRegionSetting()`, `closestRegions()` for an unknown zone (UA → PL first), and `regionDataSource(zone, credentials)` (the feed a zone routes to and whether it is live). A stored zone outside the catalog is ignored and reported (`ignored`). `SchedulerOptions.defaultRegion` also accepts a getter, read on every schedule. `gen-data` now checks that the catalog zones equal the curve zones and the website's zone list. The CLI, MCP server and OpenClaw plugin do not read the setting yet.
- **One-step Connect in Settings → Integrations → Telegram.** The token field has one **Connect** button (Enter works too): it tests the token, saves it, sets the bot profile and starts pairing, and the card shows the code, QR and copy chips with no second click. A refused token says "Token not accepted by Telegram. Copy it again from @BotFather." under the field. Send test message, Disconnect and Remove token are small buttons.
- **Click-to-copy in Settings → Integrations → Telegram.** The bot username (`@name`, shown as soon as the token is saved), the 6-digit pairing code, the `/pair <code>` command and the `https://t.me/<bot>?start=<code>` link are buttons: one click copies the value and the label reads "Copied" for 1.5 s. The link has an Open in Telegram button next to it. The card also has a Download avatar link (`/tidegap-avatar.png`, 512×512) with the `/setuserpic` hint, and the `@BotFather` name copies too. Saving a token (and Connect, when it had not worked) sets the bot's short description, description and command menu (from `HELP_TEXT`) through the Bot API, best effort; the status gains `profile_set` and `profile_error`.
- **Webhook, Slack, Discord and ntfy channels.** Settings → Integrations shows four more cards, each with its "where to get this" steps and one Connect (save, test message, enable). **Webhook:** any http(s) URL your network allows; body format Tidegap JSON (`{"version": 1, "event", "level", "title", "text", "at", "task"}`; the Connect and Send test message has `"event": "test"`), plain `{"text"}` (Google Chat, Mattermost, Matrix hookshot) or a Microsoft Teams Adaptive Card; optional HMAC-SHA256 signing (`X-Tidegap-Timestamp`, `X-Tidegap-Signature: sha256=…` over `"<timestamp>.<body>"`) and up to 10 custom header lines. **Slack:** an Incoming Webhook URL on `hooks.slack.com/services/`; `text` plus one mrkdwn block. **Discord:** a channel webhook URL on `discord.com` (`discordapp.com`, `canary.`, `ptb.`); one embed per message with no allowed mentions. **ntfy:** server (default `https://ntfy.sh`, any server the URL policy allows), a random topic you copy into the app, an optional access token and a priority override; a POST to `<server>/<topic>` with `Title`, `Priority` and `Tags` headers. Task titles cannot link or ping in Slack, Discord, Teams or the plain format. Provider refusals become one sentence under the field at fault (for example "Slack removed this webhook…"). A stored ntfy token, webhook signing secret or header set is reused on Edit only while the server or URL host stays the same: a new host asks for it again.
- **Channel registry foundation (internal).** `@tidegap/core` describes every notification channel kind as data (`KIND_DESCRIPTORS`: fields, steps, default events, docs anchor, `format`), validates field values (`validateFields`), builds one `NotificationPayload` per event (`payloadFor`) and skips events in a channel's quiet hours (22:00–09:00, `config.quiet: "night"`; the daily summary event `digest` is never skipped). Webhook (Tidegap JSON, `version: 1`) is the reference kind; the other new kinds are not ready yet. The ledger now lists rows of every registry kind. Nothing user-visible changes yet.
- **Plugin commands `/tidegap:later` and `/tidegap:usage`.** `/tidegap:later <id> <preset|time>` calls MCP `postpone_task` (`1h`, `tonight`, `tomorrow_morning`, `after_limit_reset`, an exact time or a delay in minutes). `/tidegap:usage [--spend]` calls MCP `tidegap_usage`. The plugin now has ten commands.
- **Task events (audit trail).** The ledger gains a `task_events` table (both cores, `CREATE TABLE IF NOT EXISTS`): every change of a task writes one row in the same transaction as the change, with `kind` (`created`, `rescheduled`, `postponed`, `expedited`, `cancelled`, `dispatched`, `completed`, `failed`, `deferred`, `replied`), `actor` (`page`, `client:<name>`, `agent:mcp`, `cli`, `tick`, `telegram`, `openclaw`, `system`) and `details` (old and new `scheduled_for` / `not_before` / `deadline`, preset, reason, provider, model, error). Run now now keeps the `not_before` it cleared. The Python core writes `dispatched`, `completed`, `failed` and `cancelled`. Events are deleted with their task row. `tidegap queue show <id>` prints an `Events:` list (`--json`: `events`), `GET /api/tasks/<id>` returns `events[]` (newest 50), the page's task drawer has an Events section, and MCP `check_queue_status` with a `task_id` shows the last five. Core: `TaskStore.listTaskEvents` / `recordEvent`, `Scheduler.listTaskEvents`, `SchedulerOptions.actor` and an `{ actor }` option on the task actions.
- **Run a task in the session that queued it.** A task that `schedule_task` queues from a Claude Code session records that session (from the plugin's new session hook, which keeps `~/.tidegap/sessions/claude-<pid>.json` current also after `/clear` and `/resume`; else the `origin_session_id` argument or the server's environment). At the clean hour `tidegap tick` runs it in a copy of the session (`claude -p --resume <id> --fork-session`) in the session's project directory, with `Read`, `Grep` and `Glob` allowed inside that directory only and a $3 budget cap (`TIDEGAP_CLAUDE_CODE_RESUME_MAX_BUDGET_USD`). A passed `origin_session_id` counts only when it names the current session, and a `reply_task` from another session (or OpenClaw) runs fresh. A task with web tools, a session that is gone, a project directory that is `/`, the home directory or not the user's, a session above `TIDEGAP_RESUME_MAX_TOKENS` (default 150 000) or `TIDEGAP_RESUME=off` runs fresh, with a header built from the task. The `schedule_task` reply and dry run say where the task is expected to run (`runs_in:`); the receipt records what ran (`session`, inside the signature); `tidegap queue show`, the `tidegap ui` task detail and the Telegram done message show it, with the command that opens the fork. At the next start of the origin session, the plugin hook names its finished tasks (ids, status, how they ran; never their text) through `tidegap queue list --unread --hook --hook-input -`. See "Run in the session that asked" in the README.
- **Run tasks through your Claude Code subscription.** New provider `claude-code`: `tidegap tick` runs the local `claude` CLI headless (`claude -p`, prompt on stdin, no tools, `--safe-mode`, a temporary directory, a `--max-budget-usd` cap and a 10-minute timeout), so a task uses your Claude Code subscription quota and needs no API key. The tick finds `claude` through `TIDEGAP_CLAUDE_BIN`, `PATH`, the usual install locations and, on macOS, the login shell; `TIDEGAP_CLAUDE_CODE=0` turns this off and `TIDEGAP_CLAUDE_CODE_MAX_BUDGET_USD` sets the cap. Without `ANTHROPIC_API_KEY`, `anthropic` tasks also run through Claude Code. MCP `schedule_task` and `tidegap ui` quick add accept the provider; OpenClaw does not. A "not logged in" result fails the task once with the reason. A usage-limit result puts the task back in the queue until the limit resets (from the limit state below, else from Claude Code's message), and the other due tasks of that tick wait too; past 8 days after queuing it fails. MCP `retry_task` / `expedite_task` do not run `claude-code` tasks yet. See "Run through your Claude Code subscription" in the README.
- **Claude Code usage limits.** `tidegap usage [--json]` shows the 5-hour and weekly limits of your Claude Code login (percent used, reset time, age of the reading) and the MCP tool `tidegap_usage` returns the same `usage/v1` document. The limits come from Claude Code's status line input: `tidegap usage hook` is a status line command that writes them to `~/.tidegap/usage.json` (0600, no token), and `tidegap install` offers to register it in `~/.claude/settings.json` (only on yes). `TIDEGAP_USAGE_OAUTH=1` also reads Anthropic's undocumented usage endpoint with the Claude Code login; it is off by default because it uses that token outside Claude Code (see the README). `TIDEGAP_USAGE=off` turns every limit read off.
- **Usage spend, Codex limits and the limit on every surface.** `tidegap usage --spend` (and MCP `tidegap_usage` `include_spend: true`) adds the current 5-hour window's Claude Code spend from the local session logs: input, output, cache-write and cache-read tokens with an API list-price cost estimate, as a total, by model and for the five most recent sessions. The scan runs only on request, reads only the logs written in the window, keeps only token counts and model names, and stops at 2,000 files, 4 GiB or 15 seconds (`truncated` then says which). The `usage/v1` document gains `claude_spend` and `codex` (the Codex 5-hour and weekly limits from the newest `~/.codex/sessions` log, read-only, never `auth.json`). `tidegap ui` gains `GET /api/usage[?spend=1]` (page or client token), a `limits` object in `/api/summary` (`line`, `status`, `window`, `pct`, `resets_at`; the server waits at most 2 seconds for the limit read, else answers with its last reading, and reuses a reading for 10 minutes), and a header pill ("Claude 5h 72% · resets 16:30") that opens a dialog with every window, the Codex windows and a "Show spend" button. The Mac menu bar tooltip and the extension popup show the line (`Claude 5h: 72%, resets 16:30`), and the extension tooltip ends with it; nothing shows when there is no reading. Later → "After limit reset" is available on Claude Code tasks as soon as the server has a reset time. See `docs/spec/ui-client-api.md`.
- **Run after the limit resets.** `tidegap queue reschedule <id> --after-limit-reset` and MCP `schedule_task` `after_limit_reset: true` make a task start after the Claude limit reset, at the cleanest hour after it. Core: `DeferOptions.notBefore`, the `{notBefore, deadline?}` reschedule target, `ProviderDeferError` for providers, and `TickResult.deferred`. `@tidegap/mcp` now depends on `@tidegap/cli` (for `@tidegap/cli/usage`).
- **`tidegap queue later`.** Pushes a queued or scheduled task later and never earlier than its planned start: `--until <+2h|tonight|tomorrow|tomorrow HH:MM|HH:MM|ISO|after-limit-reset>`, `--preset <1h|tonight|tomorrow_morning|after_limit_reset>` or `--delay <minutes>`, plus `--reset-at <HH:MM|ISO>` for after-limit-reset. After-limit-reset uses `--reset-at`, else the Claude limit reset from `tidegap usage`, else a still-future reset given before; with none it is refused with "needs the reset time". A target at or before the planned start is refused with the planned time.
- **`tidegap status`.** Answers "will queued tasks run?": one line each for the tick daemon, the last tick, the runners and the pending tasks, then one sentence with the fix (for example "Tasks will not run: no tick daemon. Run `tidegap install`."). Exit 0 when ready, 1 when not; `--json` prints the readiness object. Works with no `~/.tidegap` and creates nothing. Every `tidegap tick` now records `last_tick_at` and the providers it can serve (ledger meta `tick_runners`), also when no runner is configured, so other surfaces report a missing runner instead of a missing daemon.
- **MCP `postpone_task` ("Later").** Move a pending task later, never earlier: `preset` `1h`, `tonight`, `tomorrow_morning` or `after_limit_reset` (with optional `reset_at`), an exact `until`, or `delay_minutes`. A target at or before the planned start is refused with the planned time. `schedule_task` accepts `not_before` (an earliest start inside the deadline).
- **`tidegap ui` API: readiness and Later.** `GET /api/status` and `GET /api/summary` carry `readiness` (will queued tasks run, and the fix when not). `POST /api/tasks/<id>/postpone` moves a task later (`preset`, `until` or `delay_minutes`, plus `reset_at` for `after_limit_reset`; 409 when the target is not later than the planned start). Every task item carries `not_before` and `later_options` (the four presets with their resolved start, or the reason one is unavailable). See `docs/spec/ui-client-api.md`.
- **`tidegap ui` page: "Tasks will not run" banner and a Later menu.** When readiness is not ready, an amber banner shows the server's sentence and its fix, and the dispatcher pill is never green (a running dispatcher with a readiness problem reads "Running · nothing can run"). The task menu's "Move to…" becomes "Later…": One hour later, Tonight, Tomorrow morning and After limit reset with their start times, an unavailable one disabled with its reason (for a missing reset time, how to give it), and "Pick a time…" (the reschedule dialog). Later has Undo, like Cancel. Drag to a day stays. The page has no task-creation form; the Reply box stays.
- **Telegram channel.** Core gains a channel registry (`os` and `telegram`, ledger table `channels`), a Telegram Bot API client that takes the token, base URL and `fetch` as arguments and never puts the token in an error, bot commands (`/queue`, `/later <n|id> <1h|tonight|tomorrow|reset [HH:MM]|HH:MM>`, `/run`, `/cancel`, `/result`, `/help`) and buttons that run through the same scheduler methods as the page, and the message texts (a done message previews 600 characters of the result, none for a task with `redactInReceipt`). The CLI gains the pairing flow (a one-time 6-digit code; the private chat that sends `/pair <code>` or `/start <code>` pairs), `channels list` and `remove`, and the long-poll listener. `tidegap channels add telegram [--no-load] | list [--json] | remove <id> | serve [--once]` are registered; pairing installs and loads the listener unit (`com.tidegap.channels` LaunchAgent with `KeepAlive`, or `tidegap-channels.service` on Linux, both running `tidegap channels serve`), and removing the last telegram channel unloads it. `tidegap tick` sends done, failed, clean-window and no-runner events to the paired chat; the desktop notification is now the built-in `os` channel, with the same text and switches, and a Telegram failure is one warning line in the tick output. `tidegap status` shows a `Channels:` line when a chat is paired. The env file template has a commented `TIDEGAP_TELEGRAM_BOT_TOKEN=` line. See "Telegram" in the README. The bot token is read from `TIDEGAP_TELEGRAM_BOT_TOKEN` (else `TELEGRAM_BOT_TOKEN`); `TIDEGAP_TELEGRAM_API_BASE` is honoured only on loopback. OpenClaw's Telegram delivery now uses the core client, with the same messages and outcome details.
- **Mac app: Launch at login.** A toggle in Settings > App, off by default. It registers the app with `SMAppService.mainApp`, reads the state again each time Settings opens (so a change in System Settings > General > Login Items shows), goes back on failure with the reason, and shows a hint and an Open Login Items button when the item is turned off in System Settings.

### Changed

- **Tool text for `recommend_window`, `postpone_task`, `cancel_task`, `expedite_task` and OpenClaw `set_delivery`** now states the carbon-budget rejection, the exact `until` time, that cancel also stops running and submitted tasks, that expedite drops the earliest start, and the delivery privacy rules.
- **MCP tool descriptions follow one template, and the tools declare MCP annotations.** Each of the 12 MCP tools now reads: purpose, `Use when:`, `Do not use` (naming the tool to use instead), `Behavior:` (what it writes, repeat-call effect, provider key) and `Returns:` (reply fields and rejections), in at most 600 characters (`schedule_task` 900). `tools/list` advertises `annotations` per tool: a title plus `readOnlyHint`, `destructiveHint`, `idempotentHint` and `openWorldHint`. Every parameter description now gives an example, where the value comes from, its default or what omitting it does, and the parameters it interacts with, instead of restating the schema. OpenClaw gets its own text where its handler differs (structured replies, thrown errors, keys from the plugin config). Core: `ToolAnnotations`, `CanonicalToolDef.annotations` and `descriptionPerHost`, `descriptionForHost`. Tool names, parameters and behavior are unchanged.
- **A failing channel backs off.** After a failed send a channel waits 1 minute, then 2, 4 and so on, at most 1 hour, before the next try; a successful send, Connect or Send test ends the wait. While it waits, the tick builds no daily summary and fetches no forecast for it, and the Telegram listener skips it for the "tasks cannot run" alert; an alert that no other channel got goes out after the wait. Before, a channel whose sends always failed retried the summary and the forecast fetch on every tick. The channel's `last` gains `fails` and `retry_at`, and the card says "Retrying in N min".
- **Email accepts a relay login.** The SMTP login may be a user name, not only an address (SendGrid `apikey`, an Amazon SES SMTP user): any value up to 255 characters with no spaces or line breaks. With such a login, From must hold the sender address.
- **The CLI honours the region setting and `TIDEGAP_DEFAULT_REGION`.** `tidegap tick`, queue writes, `tidegap ui` and the Telegram listener resolve the region as `--region` > `TIDEGAP_DEFAULT_REGION` (environment or `~/.config/tidegap/env`) > `~/.tidegap/config` > time-zone guess > GB, on every tick, request or task, so a change applies without a restart. Before, they used only `--region` or the time-zone guess. A user who set `TIDEGAP_DEFAULT_REGION` for the MCP server now sees the CLI follow it. Tasks already queued keep their region. Writing the setting makes `~/.tidegap/config` 0600.
- **Region source names.** `RegionSource` is now `flag | env | config | setting | timezone | fallback` (was `request | config | timezone | default`). OpenClaw `schedule_task` reports `region_source: "flag"` for a tool argument (was `"request"`) and `"fallback"` for GB (was `"default"`).
- **MCP server and OpenClaw plugin follow the stored region setting.** Each tool call resolves its region again, so a setting changed with `tidegap region set` (or the page) applies on the next call with no restart. MCP order: tool argument > `TIDEGAP_DEFAULT_REGION` env > stored setting > time zone > GB. OpenClaw order: tool argument > plugin `defaultRegion` > stored setting > time zone > GB. MCP `schedule_task` replies gain a `region_source:` line. A stored value that is not a supported zone is ignored with one warning per file change. A `region` argument outside the 31 supported zones is now rejected with the closest zones and a region-request link (`Unknown zone UA. Closest: PL. Request a region: …`); a zone that a configured key serves live still passes (any zone but `IT` with an Electricity Maps key, `IT` only with an ENTSO-E token). A catalog zone argument is matched in any case (`fr` → `FR`). Core: `regionSettingReader`, `checkRequestedRegion`, `unknownRegionMessage`, `regionRequestUrl`; `closestRegions` offers only edit-distance-1 matches for inputs of up to 3 characters, so `XX` no longer suggests `GB, FR, DE`, and `UK` suggests `GB`.
- **OpenClaw `provider_source: "flag"`.** `schedule_task` reports `provider_source: "flag"` for an explicit `provider` argument (was `"request"`), the same name `region_source` uses.
- **More time zones map to a region.** Europe/Warsaw → PL, Vienna → AT, Madrid → ES, Amsterdam → NL, Brussels → BE, Dublin → IE, Helsinki → FI, Asia/Seoul → KR, Singapore → SG, Dubai → AE, Australia/Sydney → AU-NSW, Africa/Johannesburg → ZA, Pacific/Auckland → NZ. Europe/Kyiv (and Kiev, Uzhgorod, Zaporozhye) maps to PL as an approximation, with the note "No Ukrainian grid data yet; using Poland (PL), the nearest grid in the same synchronous area." Without the zone's grid key (ENTSO-E or Electricity Maps) these zones use the sample curve instead of live GB data; set `TIDEGAP_DEFAULT_REGION=GB` to keep the old behavior.
- **Mac app: a left click opens the window.** A left click (or the keyboard activation) on the menu bar item opens the Tidegap window and a second click hides it; a right click or ⌃-click opens a menu with Open Tidegap, Integrations…, Settings…, Launch at login and Quit Tidegap. The popover with the task list is gone; Later, Cancel and Run now are on the page. The title next to the icon no longer shows the start time of the next clean window: it is empty when nothing is queued or running, the queued count (`3`) otherwise, and `●` (`● 2`) while a task runs. The clean window and region moved to the tooltip and the window subtitle.
- **The test count is generated.** `pnpm gen:tests` counts the tests of seven packages and writes `apps/web/src/lib/tests.generated.ts` and the README blocks; the site (`/about`, homepage) reads it, and `pnpm gen:tests:check` plus `scripts/qa/docs-drift.mjs` now run in CI and `pnpm preflight`.
- **A task queued from a Claude Code session defaults to `claude-code`.** When `schedule_task` finds the queuing Claude Code session and the call names no provider, the task now uses provider `claude-code` (the Claude Code subscription), also when `ANTHROPIC_API_KEY` is set. Before, such a task used `anthropic` (the API key when set). Pass `provider: "anthropic"` to keep the API path; an `anthropic` task never resumes a session. A Python `tidegap tick` on a shared ledger fails these rows with "no adapter configured". MCP `retry_task` and `expedite_task` now refuse a `claude-code` task without touching it and name `tidegap queue run-now <id>`.
- **`tidegap queue reschedule --by` is an alias of `queue later --until`.** A duration counts from the task's planned start (`--by 2h` = `--until +2h`), it never moves a task earlier or lowers its deadline, and the command prints a one-line notice on stderr.
- **`tidegap install` picks the mode and loads the daemon.** With no flag it picks `--laptop` on a Mac with a battery (`pmset -g batt`) and `--server` elsewhere, and prints which and why. It then loads what it wrote: `launchctl bootout` + `launchctl bootstrap gui/<uid>` on macOS, `systemctl --user daemon-reload` + `enable --now tidegap-tick.timer` on Linux. An agent already loaded with the same plist is left alone; a changed plist is not reloaded while a task is running (the output prints the reload command). A failed load exits 1 with the error and the manual command. `--no-load` writes the files only. The output ends with the `tidegap status` lines, and no longer says to run `launchctl load`.
- **Mac app and browser extension act on tasks, and never create them.** Each task row in the Mac menu and the extension popup (Chrome, Firefox, Safari) offers **Later** (one hour later, tonight, tomorrow morning, after limit reset, with the time each one picks; a preset that does not apply is greyed out with the reason), **Cancel** and **Run now**, each enabled per the task. Cancel and Run now ask once. Quick add ("Queue a task") is gone from both: agents create tasks. When `tidegap ui` reports that tasks will not run, the menu and the popup show the reason and the fix in one line, and the menu bar text and the toolbar badge get a `!` in front (`!3`; the badge also turns amber). Against a 0.19.0 server the clients hide Later and the readiness line.
- **`claude-code` runs can search the web.** A run now gets `WebSearch` and `WebFetch` (`--tools` and `--allowedTools`, still under `--permission-mode dontAsk`) instead of no tools, so a task like "the weather forecast for Kyiv tomorrow" gets a real answer instead of "I have no web access". MCP `schedule_task` and `POST /api/tasks` accept `tools` (an array; `[]` means none) for one task, and `TIDEGAP_CLAUDE_TOOLS` sets the default. Only `WebSearch`, `WebFetch`, `Read`, `Grep` and `Glob` are allowed; any other name, or a set that combines a file tool with a web tool, is rejected when the task is queued. Tools that run commands or write files are never allowed, because web content is untrusted. The receipt records the tool set (`tools`, inside the signature), and `tidegap queue show` prints it.
- **Homepage shows the install prompt.** The first screen shows the short prompt for your agent, with a "Copy prompt" button under it. How it works moved up, and the "what it is" block moved to `/about`. The header wave and the tagline underline animate, and stay still under reduced motion. `install.md` covers Codex, the libraries and connecting the Mac app and the browser extension.
- **Site metadata for search and agents.** One site description for the meta, Open Graph and Twitter tags, with no test count. `/architecture` gets a description and a canonical link; the sitemap lists `/architecture`, `/install.md` and `/llms.txt`; `robots.txt` drops the invalid `Host:` line; `llms.txt` links `install.md` first, counts 12 MCP tools and names 0.19.0, Codex, the Mac app and the extensions; the JSON-LD adds `alternateName`, `sameAs` and `downloadUrl`.
- **Site redesign: homepage v3, one-page docs, `/about` and the agent path.** The homepage is rebuilt on shared design tokens: a hero tide wave drawn from the brand geometry, a three-step "How it works" timeline, a "Why it matters" section with the live grid intensity curve and the real GB dispatch receipt, the hosts that can install Tidegap (counted from `lib/hosts.ts`), preview apps and real product views, and a proof section with measured numbers and public listings only. `/docs` is one page with a sticky category nav and scroll-spy; its content and `/llms-full.txt` are generated from markdown by `pnpm gen:docs` (CI checks the output with `gen:docs:check`), and the page has FAQPage JSON-LD and text/markdown alternates. `/about` holds the full story. For agents: `install.md` covers every host in `lib/hosts.ts` (Zed in the flat `command`/`args` form), the homepage sends a `Link` header and an alternate link to `/install.md`, the JSON-LD has `installUrl`, the sitemap lists `/llms-full.txt`, and `scripts/check-agent-files.mjs` (`pnpm --filter ./apps/web check:agent-files -- --base <url>`) checks all of this on a running site.
- **MCP `schedule_task` says whether the task will run.** The reply ends with `Runs at <time> local.` when a tick ran recently and the provider has a runner, else with the readiness sentence and its fix (for example ``Tasks will not run: no tick daemon. Run `tidegap install`.``), instead of the fixed "run the daemon" text.
- **Client tokens cannot create tasks.** A `tidegap ui` client token (Mac app, browser extension) gets 403 on `POST /api/tasks` and `POST /api/tasks/<id>/reply`; only agents create tasks. The page token keeps both. `GET /api/tasks`, `/postpone`, `/cancel` and `/run-now` are now part of the documented client contract.
- **The Mac app can reply to a task.** A `macos` client token may `POST /api/tasks/<id>/reply` again (owner decision D1); an `extension` client token, and any token from an extension origin, still gets 403, and `POST /api/tasks` stays page-only. Task `actions.reply` now depends on the caller: `false` for an extension token, so the popup hides the reply form instead of failing with "forbidden". The "Connected apps" panel says so.
- Docs: compound batch 6 solution notes (trusted publishing limits, stacked PRs, client tokens, `claude -p` from a daemon, homepage motion, run-now audit gap, public-repo hygiene).
- Docs: internal submission log and marketing notes moved out of the public repo; local paths and token names removed from plan documents.

### Fixed

- **The dispatcher pill and the "last tick" row no longer count time the machine slept** (UI `ticker.slept_s`). The sleep-counter read check is one core helper, `sleepReadNeeded`.
- **No "tick daemon is not running" alert after the Mac sleeps.** Readiness now counts missed ticks on awake time only. Each tick stores the machine's sleep counter in ledger meta `last_tick_sleep` (macOS: `sysctl kern.boottime kern.waketime kern.wake_abs_time hw.tbfrequency`; Linux: boot clock minus the monotonic clock). A gap the machine slept through raises no problem: `tidegap status` says "Tasks will run" and notes "the tick daemon paused while the Mac slept (HH:MM–HH:MM)". The daemon is stale only after more than two intervals awake (three right after a sleep, because launchd may restart its interval at the wake). The advice now follows the cause: a missing or unloaded unit says Run `tidegap install`; a loaded unit that stopped ticking says Run `tidegap tick --once` and check the error, with the launchd last exit code when it is not 0. The listener probes the unit only when its ledger check finds a ticker problem. After a sent daemon alert, the next tick the unit starts (or the listener check after it) sends one "Tidegap: the tick daemon is running again." (quiet hours apply; the daily summary never folds it; nothing is sent if the alert never went out). A `tidegap tick --once` run from a shell does not count: each tick stores who started it in ledger meta `last_tick_by` (launchd sets `XPC_SERVICE_NAME` to the job label, systemd sets `INVOCATION_ID`). The stored sleep reading carries its tick time and is ignored when another ticker moved `last_tick_at`. Webhook and command bodies of the recovery carry `"recovered": true`, and ntfy sends it at the `task_done` priority. The readiness JSON `ticker` gains `slept_s` and `last_exit`.
- **Two ticks at once no longer send the same messages twice.** `tidegap tick` from launchd and a manual `tidegap tick` could overlap and both send the daily summary and the same alerts. A tick now holds `<ledger>.tick.lock`; a second tick prints "tick: another tick is running; skipped" and exits 0. A lock left by a crashed tick is taken over after 60 seconds (a running tick refreshes it every 10 seconds).
- **The Mac app no longer reuses a `tidegap ui` server with old code.** Before it attaches to the server named in `~/.tidegap/ui.json`, the app checks that the process runs `tidegap ui` (`index.js ui` or the `tidegap` bin), that its `cli_version` equals `tidegap --version` of the command the app would launch, and that it is not an orphan (parent launchd) started before the app. A server that fails the version or orphan check gets SIGTERM, then SIGKILL after 3 seconds, and the app starts its own; a pid that now belongs to another program is never signalled. The same check runs when the app reconnects after two failed polls, and the app's own child is restarted when `tidegap --version` changed since it was started. Settings now refreshes the "Launch at login" toggle each time it opens.
- **The Mac app keeps port 47821 across a runtime update.** When the app replaces a `tidegap ui` server or restarts its own child, it waits for the old process to exit (SIGKILL after 3 seconds) and, when no port is set in Settings, for 47821 to be free before it starts the new server, so the browser extension still finds it. A successful poll compares the server's `cli_version` with `tidegap --version` at most once every 5 minutes and restarts the server when they differ, without waiting for a Reconnect or two failed polls; the app restarts once per new version and at most once per 30 minutes. `tidegap --version` now has its own 5-second limit.
- **A fresh home no longer crashes on the first command.** `tidegap tick --once`, `tidegap ui` and `tidegap status` run before `tidegap install` exited 1 with "unable to open database file" and a stack trace, because nothing created `~/.tidegap`. The ledger store (TypeScript and Python) now creates its directory (0700) on first open; an existing directory is left as it is.
- **Later → "Pick a time…" no longer moves a task earlier.** The page sent the picked time as a reschedule, so a time before the planned start moved the task earlier and said "Rescheduled". It now sends it as a postpone (`until`), as the UI client API says: a time at or before the planned start is refused with "already planned for HH:MM" and the task stays. The dialog offers an exact time only and starts one hour after the planned start; Reschedule still moves a task anywhere.
- **The Python ticker no longer runs a postponed task early.** `tidegap.Scheduler.tick` (Python) skips a scheduled row whose `not_before` is in the future, in both the due sweep and the Batch API sweep, and logs one warning per tick. It still does not plan around `not_before`; run `tidegap tick` for that.
- **US grid data was always the mock.** EIA publishes hourly fuel-type data up to a day late (19 hours on 2026-10-17), and the EIA feed asked for only the last 30 hours, so it got 11 to 15 of the 24 hours of the day and fell back to the mock for every US ISO (`/api/grid/US-MIDA-PJM`, `US-CAL-CISO`, and the CLI, MCP and Python feeds). The request now covers the last 72 hours.
- **ClawHub release from GitHub Actions.** ClawHub mints a trusted-publishing token only for a `workflow_dispatch` OIDC token, so the 0.19.0 tag push failed with "Not logged in. Run: clawhub login". A tag push now publishes npm, PyPI and the MCP Registry; ClawHub publishes from `gh workflow run release.yml --ref vX.Y.Z -f dry_run=false -f clawhub_only=true`, and the tag-push run prints that command. The command needs a tag from 0.19.1 on; ClawHub 0.19.0 was not published.
- **A stored webhook secret no longer follows a new path on a shared webhook host.** On hosts where the path names the receiver (`*.logic.azure.com`, `*.webhook.office.com`, `hooks.zapier.com`, `hooks.slack.com`, `discord.com`, `chat.googleapis.com`, `maker.ifttt.com`, `*.make.com`), the stored signing secret and headers are kept only while the webhook URL is left as stored; a typed URL on such a host asks for them again. Elsewhere the origin still decides. The card's "Stored"/"Not kept" uses the same rule (core `keepsSecret`; the URL field's `keepPathHosts`).
- **ntfy with a query or fragment in the server URL.** The topic is now a path segment of the server URL; a `?…` or `#…` on the server is dropped instead of swallowing the topic.
- **ntfy 401/403 says what is wrong.** With no token: "This topic needs a token…" (`ntfy_token_needed`); with a token: "The token was refused…" (`auth`).
- **Slack refusals by Slack's error word.** `invalid_payload`, `channel_not_found`, `channel_is_archived`, `action_prohibited`, `no_service`, `invalid_token` and the like pick the sentence (`slack_payload`, `slack_channel_not_found`, `slack_channel_archived`, `slack_action_prohibited`, `slack_webhook_gone`); the HTTP status decides only when the body names nothing known.
- **Python `_TaskStore.connect` closes the handle on failure.** A schema step that raised (a corrupt or locked file, a failed migration) left the SQLite handle and its worker thread open, which kept the process from exiting. It now closes the handle and re-raises. `_TaskStore` also works as `async with`.
- **No source maps in the npm tarballs.** `@tidegap/core`, `@tidegap/cli` and `@tidegap/mcp` no longer ship `dist/**/*.map` (`.d.ts` stay). The tarballs are about 25% smaller. The `sourceMappingURL` comments in `dist/*.js` and `dist/*.d.ts` still name the dropped files: stack traces show `dist` lines, and go-to-definition opens the `.d.ts`.
- **Rate limit on `POST /api/tasks/<id>/reply`.** 30 replies per minute per token; over that, 429 `{"code": "rate_limited", "retry_after_s": N}`. Who may reply is unchanged (the page and a `macos` client token). The integrations, settings and reply routes now share one limiter, which drops idle keys.
- **`apps/macos/scripts/install.sh` picks the tidegap command.** With no `-tidegapCommand` argument and no stored default, it uses `node ~/.tidegap/runtime/cli/dist/index.js` when that file exists, else the repo build when no `tidegap` is on `PATH`, and prints which.

### Docs

- New learning `docs/solutions/logic-errors/sleep-gap-is-not-a-dead-daemon.md`.
- `docs-drift` finds the docs pages by their frontmatter `id`, not their number, and K13 reads the known delivery codes from core `DELIVERY_CODES` (the type of `DeliveryError`), failing when the list is empty.
- **Notifications page.** The site docs gain Notifications (`/docs#notifications`): events, quiet hours, the daily summary and the `"event": "test"` message; one section per channel kind in the card's order, whose steps, fields, presets and error sentences `pnpm gen:docs` writes from the kind descriptors (`<!-- embed:channel-<kind> -->`), so the page and the card cannot drift; the webhook body and a Node and a Python signature check; the `tidegap channels` reference with the real `--help` output; and the security rules (the secrets file, the URL policy, public ntfy topics, the Command and Shortcuts rules and the launchd `PATH`). Telegram, Receipts, Config and FAQ move one place down the sidebar; Config lists `channel-secrets.json` and `TIDEGAP_PUSHOVER_API_BASE`. `docs-drift` K13 checks the page against the registry, the delivery codes and the CLI.
- Solution notes for usage limits, readiness, Later presets, the Telegram channel, the docs generator, the EIA lag and process-kill tests (`docs/solutions/`), and a ClawHub scan-verdict note in the release workflow.

### Known issues

- A claude-code run that uses several models is billed for the dominant model's tokens only; per-model carbon needs a receipt schema change.
- `tidegap ui` reads the env file at start; a key removed from the file stays in that process until the UI restarts (the tick daemon re-reads every tick).
- Quitting the Mac app with SIGTERM (not the menu Quit) leaves its child `tidegap ui` running.
- No rate limit on `POST /api/tasks/<id>/reply` (loopback only).
- npm tarballs include source maps (`.map`).
- The pop-up of the browser extension does not redraw its status line when its token is revoked while open; the badge updates on the next poll.

## [0.19.0] — 2026-10-17

### Added

- **Tidegap logo.** Vector lockups, mark and icon tile under `assets/brand/`, generated by `scripts/build-brand.mjs` from the wave geometry and an outlined Poppins Medium wordmark (OFL, vendored). The logo now appears in the README, the package READMEs, the site header, favicon and app icons, the `tidegap ui` header, the social preview, README hero and Open Graph cards, and the MCP Registry `server.json` icons (from the next publish). Usage rules: `docs/brand.md`.
- **Native client foundation in `tidegap ui`.** `tidegap clients add | list | revoke` mints long-lived `tgc_` tokens for the browser extension and the Mac app; the registry `~/.tidegap/ui-clients.json` keeps only their SHA-256, and a revoke applies without a restart. The server accepts extension origins (`chrome-extension://`, `moz-extension://`, `safari-web-extension://`) on `/api/*` with a client token only; foreign origins still get 403 and no CORS header is sent. New routes: `GET /api/summary` (queue counts, unread, next run, the next clean grid window, tasks finished since a cursor) and `POST /api/tasks` (quick add; schedules, never dispatches). `tidegap ui` now defaults to port 47821 (a free port when it is taken, with a warning) and writes `~/.tidegap/ui.json` (pid and port, no token) while it runs. The page gains a "Connected apps" panel. Contract: `docs/spec/ui-client-api.md`. Icons for the clients render from the brand with `scripts/render-app-icons.mjs`.
- **Browser extension for Chrome, Edge and Firefox** (`apps/extension`). The toolbar badge shows the active task count or the time to the next clean grid window; the popup lists the active tasks and queues a new one; notifications say when a task finishes and when a clean window starts. It talks only to `tidegap ui` on 127.0.0.1 with a client token from `tidegap clients add`. Not in a store yet: load `dist/chrome` unpacked, or `dist/firefox` as a temporary add-on (see `apps/extension/README.md`).
- **Tidegap for Mac (`apps/macos`).** A menu bar app for `tidegap ui`: the label shows the active task count or the next clean window, the menu lists up to 10 active tasks with quick add, macOS notifications announce finished tasks and clean windows, and a window shows the full page. It connects to a running `tidegap ui` through `~/.tidegap/ui.json`, or starts one and stops it on quit, and mints its own client token through `tidegap clients add`. Ad-hoc signed; `apps/macos/scripts/install.sh` builds and installs it to `~/Applications`. `.github/workflows/macos.yml` runs the Kit tests and the Release build and uploads the zipped app. `check:versions` now also checks the app's `MARKETING_VERSION`.
- **Safari extension inside Tidegap for Mac.** The extension gains a `safari` build target (no notifications permission; the Mac app sends the notifications), and `Tidegap.app` embeds it as "Tidegap Safari Extension". `apps/macos/scripts/build.sh` builds and syncs it, so `macos.yml` now sets up Node. Ad-hoc signed: Safari lists it only while Develop > "Allow unsigned extensions" is on (see `apps/macos/README.md`).
- **ClawHub pointer release `@vitalini/ebb` 0.17.1** (`compat/clawhub/ebb`). It keeps the plugin id `ebb`, registers no tools, accepts the existing `plugins.entries.ebb` block, and logs one warning per gateway start: install `clawhub:@vitalini/tidegap` and move the config block to `plugins.entries.tidegap`. Its description points the old ClawHub listing at the new plugin.

### Removed

- **The 0.18 compatibility names (breaking).** As the 0.18 notes announced:
  - the `ebb` bin of `@tidegap/cli` and the `ebb-mcp` bin of `@tidegap/mcp`;
  - every `EBB_*` environment variable in the CLI, the MCP server and the Python package, and every `EBB_*` key in `~/.tidegap/config` (TypeScript and Python cores);
  - the `~/.ebb-ai` → `~/.tidegap` move and the `~/.ebb-ai` back-link;
  - the `~/.config/ebb/env` secrets-file fallback, and the copy `tidegap install` made of it;
  - from `@tidegap/core`: `withTidegapKeys`, `LEGACY_KEY_PREFIX`, `LEGACY_HOME_DIR`, the `HomeFs` type, the `EBB_*` fields of `CarbonBudgetEnv`, and the `fs` and `platform` options of `resolveTidegapHome`; from `tidegap` (Python): `LEGACY_HOME_DIR`, `with_tidegap_keys` and the `fs` argument of `resolve_tidegap_home`; the `binAliasDeprecation` exports of the CLI and MCP entry modules; from the CLI `commands/env-file` module: `legacyEnvFilePath`, `resolveEnvFilePath`, the second argument of `ensureEnvFile` and `EnsureEnvFileResult.copiedFrom`.

  tidegap.com still reads its `EBB_*` Vercel variables until they are renamed.

  **Upgrading from 0.17: upgrade through 0.18 once before 0.19, or move `~/.ebb-ai` to `~/.tidegap` by hand.** 0.19 does not move the old data directory, so a 0.17 install that skips 0.18 starts with an empty ledger, and once 0.19 has written to `~/.tidegap` the 0.18 move no longer runs. If that happened: stop tidegap (unload the daemon, quit MCP hosts), move `~/.tidegap` aside, then rename `~/.ebb-ai` to `~/.tidegap`. Then rename every `EBB_*` name to `TIDEGAP_*` in your shell, your MCP host config, `~/.tidegap/config` and the secrets file `~/.config/tidegap/env`; move a left-over `~/.config/ebb/env` to `~/.config/tidegap/env`; run `tidegap` and `tidegap-mcp`.

### Changed

- **A left-over 0.17 name prints a "no longer read" line and is never used.** The CLI and the MCP server print one stderr line per process naming every `EBB_*` variable (set while its `TIDEGAP_*` twin is not) and every `EBB_*` key in `~/.tidegap/config`, with the new name; the Python package prints one line per name. A `~/.ebb-ai` that still holds data (a real directory, or a link to a directory other than `~/.tidegap`) and a `~/.config/ebb/env` whose keys `~/.config/tidegap/env` lacks each get one line too. stdout stays clean for the MCP protocol.
- **The homepage first screen is the tagline and one "Copy the prompt for your agent" button.** The description, claims note, live grid banner and install options moved one scroll below; "Other ways to install" jumps to the full install section.
- **Releases publish from GitHub Actions (`release.yml`) by OIDC trusted publishing, with npm provenance; no long-lived registry tokens.**

### Fixed

- **A task moved to a day beyond the forecast is planned once the forecast reaches it, also when its time of day was the day's start.** The fallback time landed exactly on the day's start, which reads as an exact-time pin, so the re-plan sweep skipped the row and it ran at the day's start with no carbon window. The fallback now moves one minute into the day. Rows already moved this way by 0.17 or 0.18 keep their day-start time, because they cannot be told apart from an exact-time pin.
- **`tidegap tick --daemon` follows the env file on every tick.** It read `~/.config/tidegap/env` once at start, so after Settings → Integrations → Remove token it kept sending with the old Telegram token, and a changed provider key waited for a restart. Each tick now re-reads the file: a key the file set is replaced when the file changes it and removed when the file drops it; a key from the real environment still wins. Which keys came from the file is passed to child processes in `TIDEGAP_ENV_FILE_KEYS` (names only), so the page's dispatcher behaves the same.
- **Claude Code receipts name the model whose tokens they bill.** The receipt took the model with the most output tokens from `modelUsage` but the token counts from the top-level `usage`, so a run with a Haiku subagent could bill one model's tokens at another's energy rate. The model and its tokens now both come from that `modelUsage` entry; without `modelUsage`, the top-level usage and the requested model.
- **Grid feeds floor "now" to the UTC hour.** The mock, UK, EIA and ENTSO-E feeds floored it in local time, which starts the forecast an hour early in a DST fall-back hour and off the UTC hour (:30 or :45) in time zones with a fractional offset.

### Security

- **Release tools are pinned.** The ClawHub CLI installs from a committed lockfile (`.github/release-tools/clawhub`) with `npm ci --ignore-scripts`, and `mcp-publisher` runs only after its SHA-256 matches the value in `scripts/install-mcp-publisher.sh`. Every action in `release.yml` and `mcp-registry.yml` is pinned to a commit SHA. Still resolved at run time in jobs that hold an OIDC publish token: npm's own `npm@11.19.1` install in the npm job, the Node 24 patch release, and the container image of the PyPI publish action.
- **The ENTSO-E parser runs in linear time on hostile input.** `parseEntsoeXml` (TS) and `parse_entsoe_xml` (Python) cut `<text>`, `<TimeSeries>` and `<Period>` blocks with a plain scan instead of lazy regexes, so unclosed tags in the feed text no longer cost quadratic time. Results on valid documents are unchanged.
- **Lint and build tooling dependencies updated** by pnpm overrides: `brace-expansion` 1.1.21, `js-yaml` 4.3.2, `source-map-js` 1.2.2. None of them ships in a published package.
- ClawHub release tool: pin undici 7.29.1 (15 Dependabot alerts in the release job's lockfile).

## [0.18.0] — 2026-10-16

Ebb AI is now **Tidegap**. "Ebb" conflicts with an existing software
trademark, so every public name changes: packages, commands, paths,
environment variables, the plugin and MCP identities, and the site. A 0.17
install keeps its queue, receipts, signing key and daemon, and the old names
keep working for this release.

### Changed

- **Renamed to Tidegap.** npm `@ebb-ai/{core,cli,mcp}` → `@tidegap/{core,cli,mcp}`;
  PyPI `ebb-ai` / `import ebb_ai` → `tidegap` / `import tidegap`; OpenClaw
  `@vitalini/ebb` (plugin id `ebb`) → `@vitalini/tidegap` (plugin id
  `tidegap`); commands `ebb` → `tidegap` and `ebb-mcp` → `tidegap-mcp`;
  Claude Code marketplace and plugin `ebb-ai` → `tidegap`, commands
  `/ebb-ai:*` → `/tidegap:*`; MCP host config key `ebb-ai` → `tidegap` (tools
  `mcp__tidegap__*`); MCP Registry `io.github.Vitalini/ebb-ai` →
  `io.github.tidegap/tidegap`, `serverInfo.name` `tidegap`; repository
  `github.com/tidegap/tidegap`; site `https://www.tidegap.com`.
- **Data directory `~/.tidegap`.** The first 0.18 process moves `~/.ebb-ai`
  there and leaves `~/.ebb-ai` as a link, so a 0.17 process still reads the
  same ledger. It never deletes anything; when the move or the link fails it
  keeps using `~/.ebb-ai` and prints one line. A `~/.ebb-ai` that is already
  your own link to another directory is followed, not moved. On Windows the
  back-link is a junction. Both cores apply the same rules.
- **Environment variables and config keys `TIDEGAP_*`** (`TIDEGAP_EIA_API_KEY`,
  `TIDEGAP_DB_PATH`, `TIDEGAP_CARBON_BUDGET_G`, `TIDEGAP_QUOTA_RESET_<LABEL>`,
  `TIDEGAP_NOTIFY` and the rest).
- **Secrets file `~/.config/tidegap/env`.** `tidegap install` copies a 0.17
  `~/.config/ebb/env` there (0600) and leaves the old file in place.
- **Daemon** `com.tidegap.tick` / `tidegap-tick.{service,timer}` / schtasks
  `tidegap-tick`, log `~/.tidegap/logs/tick.log`, wake helper
  `~/.tidegap/laptop-wake.sh`. `tidegap install` creates the log directory
  before it writes the unit.
- Images re-rendered from the same forecast with the Tidegap wordmark.

### Added

- `paths` module in `@tidegap/core` (`resolveTidegapHome`, `tidegapPath`) and
  `tidegap.paths` in Python: one home resolver for every file under the data
  directory.
- `withTidegapKeys`, `KEY_PREFIX` and `LEGACY_KEY_PREFIX` in `@tidegap/core`;
  `CarbonBudgetEnv` gains `TIDEGAP_CARBON_BUDGET_G` and
  `TIDEGAP_CARBON_BUDGET_WINDOW`.
- `@tidegap/mcp` exports `main`.
- Shims under the old names, version 0.17.1 (`compat/`): `@ebb-ai/core`
  re-exports `@tidegap/core`; `@ebb-ai/cli` keeps the `ebb` bin and the
  `dist/index.js` path 0.17 daemon units pin; `@ebb-ai/mcp` keeps
  `npx -y @ebb-ai/mcp` working; PyPI `ebb-ai` installs `tidegap` and keeps
  `import ebb_ai` working. Each prints one deprecation line.
- `tidegap install` detects a 0.17 unit and prints the commands that unload
  and remove it. Run through the `@ebb-ai/cli` shim, it warns that the unit
  would point inside `@ebb-ai/cli` and asks for `@tidegap/cli`.
- `TIDEGAP_NO_NOTIFY=1` turns off the OS notification `tidegap tick` posts
  per finished task; the OpenClaw plugin's counterpart is the config field
  `disableOsNotifications`.

### Deprecated

Removed in 0.19:

- The `ebb` and `ebb-mcp` bins (each prints one deprecation line on stderr).
- `EBB_*` environment variables and config-file keys: read when the
  `TIDEGAP_*` name is unset, with one stderr line per process naming them.
- The `~/.ebb-ai` back-link and the `~/.config/ebb/env` fallback.
- The `EBB_*` fields of `CarbonBudgetEnv`.

### Fixed

- Test runs no longer post real desktop notifications: under a test runner
  the default notifier spawns nothing, and the tick suite fails if any child
  process is spawned.

### Upgrade notes

- Data in `~/.ebb-ai`: nothing to do; it moves on first run.
- `EBB_*` in your shell, MCP host config or Vercel: rename to `TIDEGAP_*`
  before 0.19.
- CLI and daemon: `npm i -g @tidegap/cli` (run `npm uninstall -g @ebb-ai/cli`
  first if npm reports `EEXIST`), `tidegap install`, run the unload commands
  it prints, then `npm uninstall -g @ebb-ai/cli`. Uninstalling the old
  package before the old unit is unloaded makes every old tick fail.
- MCP host config: `npx -y @tidegap/mcp` under the key `tidegap`; prompts or
  allowlists naming `mcp__ebb-ai__*` must change to `mcp__tidegap__*`.
- Claude Code: `claude plugin uninstall ebb-ai`,
  `claude plugin marketplace remove ebb-ai`,
  `claude plugin marketplace add tidegap/tidegap`,
  `claude plugin install tidegap`.
- OpenClaw: `openclaw plugins install clawhub:@vitalini/tidegap`, move your
  config block from `plugins.entries.ebb` to `plugins.entries.tidegap`,
  remove the old plugin.
- Python: `pip install tidegap`, `import tidegap`.
- Links to `github.com/Vitalini/ebb-ai` and `www.ebb-ai.com` redirect.

## [0.17.0] — 2026-10-15

Deferred tasks become something you can see and steer: `ebb ui` is a local
task manager, every surface can cancel, reschedule, run now or reply, tasks
can repeat, and a deadline can be "before my weekly quota resets".

### Added

- **`ebb ui`, a local task manager.** `ebb ui` serves a page with three
  views and a detail drawer. **Agenda** (the default) lists pending tasks by
  day (Today, Tomorrow, weekday, Later) with the carbon band of each run
  hour and each day's cleanest hour; overdue tasks and unread failures sit in
  "Needs attention"; repeating series show their next projected runs.
  **Journal** lists finished tasks newest first with status, provider and
  kind filters and rows that expand to the result, receipt and gCO2e.
  **Timeline** is the forecast curve coloured by band with tasks at their
  scheduled hour. The drawer shows result, conversation with a reply box,
  receipt, origin with a copyable `claude --resume` line, chain and series,
  and the actions the task's state allows. Cancel (5 s Undo), reschedule,
  move to a day (drag a row onto a day header or "Run now", or the move-to
  list on touch and keyboard), run now, mark read or unread, stop series and
  Start dispatcher all write optimistically and are confirmed by the change
  stream. Keyboard: j/k, Enter, Esc, c, C, r, m, n, u, R, 1-3, /, ?. Light
  and dark, 400 px wide screens, reduced motion. The header shows when the
  dispatcher last ran, and a banner warns when no tick daemon is installed.
  No dependency, no build step, no remote resource. The server listens on
  127.0.0.1 only, refuses a foreign `Host` or `Origin` header, and requires a
  random per-run token on every API request; live updates come over
  server-sent events.
- **`ebb ui` write API.** `POST /api/tasks/:id/{cancel,reschedule,run-now,reply}`,
  `GET /api/series/:id`, and `POST /api/dispatcher/start`, which starts
  `ebb tick --daemon --interval 60` detached (log in
  `~/.ebb-ai/logs/ui-tick.log`) when no dispatcher runs; it returns 409 while
  the child it started is alive or while any ticker ticked recently. A
  refused action returns 409 with the rule; any other error returns 500 with a
  generic body. `/api/status` reports the dispatcher as `running`, `stale` or
  `never`. The server writes the ledger only; it never dispatches.
- **Task actions from any process.** Core gains `Scheduler.runNow` (marks a
  task due for the next tick, `intensitySource: "expedited"`, never
  batch-routed), `Scheduler.rescheduleTask` (a new deadline, an exact time,
  or a day given as two instants), `Scheduler.replyToTask` and
  `cancelTask(id, { series })`. Every write re-reads the row and writes with
  a status compare-and-set (`TaskStore.transitionIf`). `taskActions` and
  `displayTitle` compute allowed actions and titles once for every surface.
- **Repeating tasks.** `repeat: "none" | "daily" | "weekly" | "quota_reset"`
  on a provider-call task starts a series (`series_id` = the first task id).
  When an occurrence completes, fails, or is cancelled as a skip, core
  inserts exactly one next occurrence (`<series_id>~<n>`, insert-once) with
  the same prompt; `cancel` with `series: true` stops the series and cancels
  any pending occurrence. A next occurrence that fails at planning (no hour
  under its carbon budget) ends the series, and a "no adapter configured"
  failure does not roll (a retry that completes rolls it). A next occurrence,
  or a day target, is held at a fallback hour until the forecast covers its
  first 24 hours; the new `replanSweep` (run by `prepareTick`) then gives it a
  carbon window. MCP `schedule_task` takes `repeat`; `/ebb-ai:defer` takes
  `--repeat`.
- **Reply.** `reply_task` (MCP and OpenClaw), `ebb queue reply` and the
  `ebb ui` API create a child task that sends the parent's conversation plus
  the new text to the same provider and model. All four adapters (Anthropic,
  OpenAI, Gemini, Ollama) send prior turns on the sync path; Anthropic and
  OpenAI also on the batch path. The history is capped at 200,000
  characters; the oldest turns are dropped first.
- **`quota_reset` deadlines.** MCP `schedule_task` accepts
  `deadline_kind: "quota_reset"` and an optional `quota_provider`; `deadline`
  is then not needed. Configure the weekly reset per label in
  `~/.ebb-ai/config`:

  ```
  EBB_QUOTA_RESET_CLAUDE=mon 10:00 Europe/Berlin
  EBB_QUOTA_MARGIN_H_CLAUDE=2
  ```

  The zone is optional (system zone by default) and the margin defaults to
  2 hours. The deadline is the next reset minus the margin. If that reset
  passes before the task runs (machine asleep, daemon down), `ebb tick` and
  the OpenClaw dispatch loop re-resolve it to the following reset and
  reschedule the task through the normal window picker, writing only while
  the task is still queued or scheduled. A quota deadline is often days
  away, and any deadline more than 24 hours out lets an `anthropic` or
  `openai` task route through the provider Batch API, so its result can
  arrive up to the provider's 24-hour batch SLA after the chosen window.
- **Task titles, origin and read state.** Every task now stores a title (given
  at enqueue, else the first line of the prompt cut to 80 characters, with
  API-key-looking strings redacted), the host that enqueued it (`mcp`,
  `openclaw`, `cli`) and its working directory, a parent task id, and a
  `read_at` marker. A finished task counts as unread until a surface shows
  its result. Prior conversation turns are stored in `body_json.messages`
  and are redacted with the prompt.
- **Desktop notifications from `ebb tick`.** One notification per task that
  completed or failed, with the title, a redacted preview or the error, the
  grams and `ebb queue show <id>`. Off with `--no-notify` or `EBB_NOTIFY=0`
  in `~/.ebb-ai/config`.
- **Claude Code SessionStart hook.** The plugin prints one line at session
  start when finished tasks are unread (`ebb queue list --unread --hook`);
  silent when nothing is unread or the CLI is not installed.
- **Return to the session.** `/ebb-ai:defer` passes `${CLAUDE_SESSION_ID}` as
  `origin_session_id`; `ebb queue show`, `check_queue_status` and the
  `ebb ui` drawer show `cd <cwd> && claude --resume <id>`.
- **New `ebb queue` commands.** `ebb queue cancel | reschedule | run-now |
  reply`, `ebb queue list --series <id>`, `ebb queue show <id>` (title,
  origin, deadline with the quota label, prompt, history, result, receipt
  and routing; `--raw` adds the vendor payload, `--json` prints the record
  and its history, `--no-mark-read` leaves the read marker alone) and
  `ebb queue unread <id>` (clears the read marker again). `ebb queue list`
  gains title, deadline and kind columns, `--unread`,
  `--kind <absolute|quota_reset>`, `--json`, and a `last tick` line.
- **`last_tick_at`.** `ebb tick` and the OpenClaw dispatch loop record when
  they last ran (ledger `meta` table); `ebb queue list` and MCP
  `check_queue_status` show it.
- **Repo and site images.** `pnpm gen:images` renders the GitHub social
  preview, the README hero and the site Open Graph card from one real GB
  forecast (`docs/examples/2026-09-30-GB-tick/`); `pnpm gen:images:check`
  guards drift in `pnpm preflight` and CI.
- `scripts/ui-seed.mjs` writes a throwaway ledger with a realistic mix of
  tasks for trying the page (`--serve` runs `ebb ui` on it with the mock
  forecast and provider secrets removed from the environment). `--db` takes
  only a new file outside `~/.ebb-ai`, so a seed never lands in a real ledger.

### Changed

- **Brand name.** The display name is "Ebb AI": the README, the site, and
  the core-py and Claude Code plugin README headings. Package names,
  commands and URLs keep `ebb-ai`.
- **Tool counts.** The MCP server exposes 10 tools and OpenClaw 11
  (`reply_task` is new); the READMEs and the site say so.
- **README.** It opens with the rendered hero image and describes `ebb ui`
  and the task actions.
- **`check_queue_status`** (MCP and OpenClaw) shows the title, origin,
  deadline kind and stored prompt of a task, and viewing a completed or
  failed task marks it read. The list view shows titles and quota markers.
  The detail view also shows series, repeat, session, resume command,
  parent and children.
- **`cancel_task`** on a repeating task skips that occurrence and queues the
  next one; pass `series: true` to end the series.
- **`update_deadline`** with an explicit deadline turns a `quota_reset` task
  into an `absolute` one.
- **Ledger schema.** New nullable columns `title`, `origin_host`,
  `origin_cwd`, `read_at`, `parent_task_id`, `deadline_kind`,
  `quota_provider`, `series_id`, `repeat`, `origin_session_id` and
  `not_before`, indexes on `parent_task_id` and `series_id`, and a `meta`
  table. They are added on first open by the TS and Python cores. Tasks that
  finished before the upgrade are marked read once, so the inbox starts
  empty.
- Task text that the CLI prints (titles, prompts, results, errors) is
  stripped of terminal control characters.
- The OS notification command builder moved from the OpenClaw plugin to
  `@ebb-ai/core` (`osNotifyCommand`).
- The site's Open Graph and Twitter card is `/og-image.png`; the stale v0.5
  `og.png` is removed, and `/about` now carries the card too.

### Fixed

- **A cancel is no longer overwritten by a ticker.** Every dispatcher
  terminal write (completed, failed, submitted, the batch poll) is
  conditional on the row still being `running`, so a cancel from `ebb ui`,
  the CLI or an MCP host that lands during dispatch stands.
- **Notification text no longer reaches script source.** The OpenClaw `os`
  delivery embedded the escaped text in an AppleScript string. macOS and
  Linux now pass it as argv after `--`, Windows reads it from environment
  variables (OpenClaw: from inert base64 literals).

### Upgrade notes

- The tick daemon runs the globally installed `@ebb-ai/cli`. After upgrading,
  reinstall it (`npm install -g @ebb-ai/cli`), or the quota-reset sweep and
  `last_tick_at` do not run.
- The Python core migrates and stores the new columns but does not act on
  them: its ticker sends no reply history, rolls no series, ignores
  `not_before` and does not run the quota-reset sweep. Run `ebb tick` or the
  OpenClaw loop on a ledger with reply children, repeating tasks or
  `quota_reset` deadlines.
- `repeat` defaults to `none` for every task, `deadline_kind: "quota_reset"`
  included: a quota task runs once unless `repeat` (or `--repeat weekly`) is
  given.

## [0.16.1] — 2026-10-15

### Docs

- **Ten-second README head.** The README opens with what ebb-ai does,
  install lines for npm, PyPI, the Claude Code plugin and any MCP host,
  and TS and Python snippets that pass a pinned `rng` (an `rng` that
  returns 0 gives the strict minimum; without it the pick is random
  inside the cleanest band of near-equal hours). The body lists all nine
  MCP tools and uses the published `pip install`.
- **npm and PyPI package heads.** `@ebb-ai/cli`, `@ebb-ai/mcp` and
  `ebb-ai` (PyPI) READMEs open with commands that work from a published
  install; monorepo build steps move to "Develop". The PyPI README no
  longer says "pre-PyPI" and has no relative links. Package descriptions
  match the new heads.

### Fixed

- **Labelled cost claim.** The Claude Code plugin manifest, marketplace
  entry, skill and the `schedule_task` tool description say "50% of sync
  list price (projected)" instead of an unlabelled "50% cheaper"
  (`docs/claims.md` row 4).
- **Unbacked claims removed.** The `schedule_task` tool description no
  longer claims "faster sync calls", and the plugin skill no longer says
  grids vary "30–60%" or that a 4-hour delay "cuts its footprint in
  half"; it cites the one GB run instead (`docs/claims.md` row 31). The
  README plugin section lists the real eight slash commands.
- **Site hero.** The h1 reads "Run your agent's non-urgent LLM tasks at
  the cleanest grid hour." and the hero no longer claims "faster".

### Added

- **MCP Registry metadata.** `@ebb-ai/mcp` carries
  `"mcpName": "io.github.Vitalini/ebb-ai"`, and
  `packages/mcp-server/server.json` describes the server for the MCP
  Registry. `scripts/check-versions.mjs` checks both of its version
  fields.
- **Cross-language window-selection fixture.**
  `packages/core-ts/test/fixtures/select-window-vectors.json` drives
  `selectWindow` (TS) and `select_window` (Python) with a pinned `rng`,
  so the two selection policies cannot drift apart unnoticed.

## [0.16.0] — 2026-09-30

### Release

- **npm goes from 0.13.0 straight to 0.16.0.** 0.14.0, 0.14.1, 0.15.0 and
  0.15.1 shipped to PyPI and as git tags only, never to npm; npm users
  upgrading from 0.13.0 get every change in
  [0.14.0](#0140--2026-07-24), [0.14.1](#0141--2026-07-25),
  [0.15.0](#0150--2026-07-25) and [0.15.1](#0151--2026-07-25) as well as
  this section.

### Changed

- **Model catalogue refreshed for September 2026.** Added the current
  Claude (`claude-fable-5-1`, `claude-fable-5`, `claude-opus-5-5`,
  `claude-opus-5`, `claude-sonnet-5`), GPT-6 (`gpt-6-astra`, `gpt-6-sol`,
  `gpt-6-luna`) and Gemini 3 (`gemini-3-1-pro`, `gemini-3-8-flash`,
  `gemini-3-5-flash-lite`) rows to `energy.json`/`prices.json`, and marked
  every retired or deprecated id (`claude-opus-4-1`, `claude-opus-3-5`,
  `claude-opus-3`, `claude-sonnet-3-7`, `claude-sonnet-3-5`,
  `claude-sonnet-3`, `claude-haiku-3-5`, `claude-haiku-3`,
  `gemini-2-0-flash`, `gemini-2-0-pro`, `gemini-1-5-pro`,
  `gemini-1-5-flash`, `o1-mini`, `gpt-4`, `gpt-4-turbo`, `o3-mini`) with a
  `status` flag instead of leaving it silently current. Family
  representatives now point at current models (`claude-opus` ->
  `claude-opus-5`, `claude-sonnet` -> `claude-sonnet-5`, `gpt-6` ->
  `gpt-6-sol`, `gemini-pro` -> `gemini-3-1-pro`, `gemini-flash` ->
  `gemini-3-8-flash`), and new `gpt-4-1`/`gpt-5` families are added.
- **`DEFAULT_MODEL_BY_PROVIDER`** is exported from `@ebb-ai/core`, giving
  each provider its own current default (`anthropic: claude-sonnet-5`,
  `openai: gpt-6-sol`, `gemini: gemini-3.8-flash`, `ollama: llama3.1`);
  the MCP server and the OpenClaw plugin both resolve a missing `model`
  from it instead of a single shared default.
- **Anthropic adapters (TS and Python) default `max_tokens` to 16000**
  (was 1024) so current Claude models are not truncated at the old
  ceiling.
- **CI's build-test matrix adds Node 24** alongside 20 and 22.

### Fixed

- **`ebb tick` receipts now use the region's grid feed.** The CLI built its
  `Scheduler` without a feed, so every receipt's dispatch-time intensity
  came from the synthetic mock curve (`grid_source=mock`) even for GB,
  which has a live keyless feed. It now uses `buildDefaultGridFeed()`,
  like the MCP server; the mock remains the fallback when a feed fails.
- **Corrected an inaccurate privacy claim in 0.15.1's own documentation.**
  0.15.1 stated that `chat` delivery "stays inside OpenClaw". That is
  wrong on a Telegram-backed gateway: `chat` and `telegram` take the
  *same* Telegram Bot-API path in `delivery.ts`, so on such a gateway a
  "chat" result does leave for a third party. ClawHub's review caught the
  contradiction (`E1`). The `set_delivery` tool description and the plugin
  README now say so plainly, and both name **`queue`** — not `chat` — as
  the only mode that transmits nothing. Documentation-only; delivery
  behaviour is unchanged.
- **`claude-opus-4-6` / `claude-opus-4-7` pricing corrected** from
  15/75 to 5/25 per million tokens, matching the current price list.
- **The Gemini default no longer points at a shut-down model.**
  `gemini-2-0-flash` was retired 2026-06-01; the MCP server and OpenClaw
  plugin now default keyless Gemini dispatch to `gemini-3-8-flash`.
- **A task no longer defaults to a foreign vendor's model id.** The MCP
  server and OpenClaw plugin previously fell back to one shared default
  regardless of the requested provider; each provider now resolves its
  own entry from `DEFAULT_MODEL_BY_PROVIDER`.
- **`temperature` is no longer sent to models that reject sampling
  parameters** (Opus 4.7/4.8/5/5.5, Sonnet 5, Fable, Mythos), which
  previously made the request fail.
- **A `stop_reason: "refusal"` response now raises `ProviderRefusalError`**
  with the `stop_details.category`, instead of being returned as if it
  were a normal (empty or partial) answer.
- **Batch results keep `stop_reason`.** A Batch API answer cut off by
  `max_tokens` was stored without its `stop_reason`, so the truncation was
  invisible in the result. The TS and Python schedulers now carry
  `stop_reason` through to the stored batch result (aad933f).

### Security

- **`@modelcontextprotocol/sdk` bumped to `^1.30.1`**, plus root
  `pnpm.overrides` for the patched `fast-uri`, `hono`, `qs`, `sharp` and
  `nanoid` ranges, closing the advisories reachable from the monorepo
  other than `next` (tracked separately).
- **`next` 16.2.11 → 16.3.6 in `apps/web`, closing two critical
  unauthenticated-RCE advisories:** `GHSA-p293-qw3h-jr36` and
  `GHSA-2xp9-vwfh-vxw4` (the second via the Image Optimization API when
  AVIF files are used), both fixed upstream in `next@16.3.3`.
  `eslint-config-next` bumped to match. `pnpm audit --prod` no longer
  reports either advisory.

## [0.15.1] — 2026-07-25

**Theme:** "Clean supply chain, loud privacy boundary." Housekeeping
driven by the ClawHub security review of 0.15.0 — no feature changes.

> **Operator note:** run `openclaw plugins update @vitalini/ebb` to pull
> 0.15.1.

### Security

- **Dependency hygiene, waves A–D.** `pnpm audit --prod` went **27
  vulnerabilities (9 high) → 0**; the full audit went **39 → 1**
  (dev-only). Highlights: `vitest` 2 → 4, clearing a *critical* advisory
  (Vitest UI server arbitrary file read) and pulling `vite` 5 → 8;
  `next` 15 → 16, clearing three high advisories (App-Router DoS, SSRF in
  Server Actions, SSRF in rewrites); `sharp`, `postcss`, `hono`,
  `form-data`, `fast-uri`, `js-yaml` to patched versions; `esbuild`
  0.28.1. This clears ClawScan's `SC4` — the one finding in its review of
  0.15.0 marked *unexpected*.
  - The single remaining advisory is `brace-expansion@1.1.16`, reachable
    only through ESLint's `minimatch@3.x`. It is dev-only, absent from
    `--prod`, and unfixable from here: the patch exists only in 5.x, whose
    changed export breaks `minimatch` 3. It needs ESLint to move off
    `minimatch` 3.x.
  - Next 16 renamed the middleware convention: `apps/web/src/middleware.ts`
    → `proxy.ts` exporting `proxy`. The nonce-based CSP is byte-identical
    and was re-verified live — fresh nonce per request, matching every
    emitted `<script>` — as was the 300 s grid-feed cache.

### Changed

- **The delivery privacy boundary is now stated where it is acted on.**
  ClawScan's `SQP-2`/`E1` observed that webhook and Telegram delivery move
  full task content outside OpenClaw without the docs foregrounding it.
  The `set_delivery` tool description (shared surface, so both the MCP
  server and the OpenClaw plugin inherit it) now says plainly that `chat`
  and `queue` keep the result inside OpenClaw while `webhook` POSTs the
  full result to an unrestricted URL, `telegram` sends it to a third
  party, and `file` writes it anywhere on the host — and instructs the
  agent never to choose one of those three on the user's behalf. The
  plugin README leads its delivery section with the same table. Parameter
  names and shapes are unchanged; the divergence-canary snapshot was
  updated deliberately.

## [0.15.0] — 2026-07-25

**Theme:** "No ambient state." The library stops reading the environment;
the hosts inject configuration.

> **Operator note:** the OpenClaw plugin does not auto-update. Run
> `openclaw plugins update @vitalini/ebb` to pull 0.15.0. **Plugin users:**
> credentials move from environment variables to plugin config under
> `plugins.entries.ebb.config`. Migration is lossless — every credential
> field accepts OpenClaw's `${ENV_VAR}` shorthand, e.g.
> `"anthropicApiKey": "${ANTHROPIC_API_KEY}"`, so the gateway reads the
> variable you already export. The `ebb` CLI and `@ebb-ai/mcp` server are
> unaffected: they still read the same environment variables directly.

### Changed

- **`@ebb-ai/core` is environment-pure — it reads no environment variables.**
  0.14.1 narrowed the reads to named keys; that was not enough. ClawScan's
  `suspicious.env_credential_access` rule fires on *any* ambient-environment
  read inside a bundle that also makes network calls — the remaining finding
  was `EBB_CARBON_BUDGET_G`, a non-secret numeric threshold. The only way to
  clear it is to have zero such reads in the published bundle, so the reads are
  gone rather than narrowed. Independently it is the right shape: a library
  that reaches into ambient state is untestable and surprising to callers.

  - `grid.ts`: `electricityMapsFeed` / `eiaFeed` / `entsoeFeed` / `wattTimeFeed`
    take their credentials only as arguments. New `GridFeedCredentials` shape;
    `buildDefaultGridFeed(credentials)` threads it to each leaf feed.
    `buildDefaultGridFeed()` with no argument behaves exactly as before with no
    variables exported: free UK feed for GB, deterministic mock elsewhere.
  - `providers/{anthropic,openai,gemini,ollama}.ts`: `apiKey` / `host` come only
    from the constructor. The `GEMINI_API_KEY`-then-`GOOGLE_API_KEY` precedence
    moved to the hosts, unchanged.
  - `budget.ts`: `loadCarbonBudgetConfig` still reads the `~/.ebb-ai/config`
    FILE (filesystem I/O against a path the project owns, not ambient state)
    but takes its overrides solely from `opts.env`.

- **The OpenClaw plugin (`@vitalini/ebb`) reads no environment variables at
  all.** Its bundle now contains **zero** environment accesses. Everything it
  used to take from the environment is an OpenClaw plugin-config field under
  `plugins.entries.ebb.config`, declared in `openclaw.plugin.json`'s
  `configSchema` with a description naming the variable it replaces:
  `electricityMapsApiKey`, `eiaApiKey`, `entsoeSecurityToken`,
  `wattTimeUsername`, `wattTimePassword`, `anthropicApiKey`, `openaiApiKey`,
  `geminiApiKey`, `googleApiKey`, `ollamaHost`, `ollamaModels`,
  `carbonBudgetG`, `carbonBudgetWindow`, `deliveryStorePath`,
  `disableStartupDispatch` (`defaultRegion` and `dbPath` already existed).

  **Migration is lossless.** The nine credential fields are declared in the
  manifest's `configContracts.secretInputs.paths`, which is what makes OpenClaw
  resolve its `"${ENV_VAR}"` / `"$ENV_VAR"` SecretRef shorthand for them and
  write the plaintext back into the config the plugin receives. Users who
  already export `ANTHROPIC_API_KEY` keep exporting it and write
  `"anthropicApiKey": "${ANTHROPIC_API_KEY}"` — the **gateway** performs the
  environment read, never the plugin. `uiHints` marks the same fields sensitive
  so the gateway UI masks them.

- **No user-visible change for the `ebb` CLI or the `@ebb-ai/mcp` server.** They
  are hosts: each reads the same variables it always did, at its own entry
  point, through a small local `readEnvCredentials()` helper
  (`packages/cli/src/env.ts`, `packages/mcp-server/src/env.ts`), and injects
  them into core. The web dashboard does the same for the grid feeds.

- **Python (`core-py`) is deliberately unchanged and stays environment-aware.**
  It is never bundled into a third-party plugin — it is used directly as its own
  host — so its `os.environ` fallbacks remain for ergonomics. The asymmetry is
  documented in `packages/core-py/README.md` and in `core-ts/src/index.ts`.

### Docs

- Every environment-variable table now states that the variables configure the
  **CLI and MCP server** (and the dashboard), and names the **plugin-config
  field** that replaces each one for the OpenClaw plugin: root `README.md`,
  `packages/cli/README.md`, `packages/mcp-server/README.md`,
  `packages/core-py/README.md`, `packages/openclaw-plugin/README.md` (with a
  full migration table), the web docs env table, `apps/web/.env.example`, and
  `apps/web/public/llms.txt`.

## [0.14.1] — 2026-07-25

**Theme:** "Narrow reads." A security-hygiene patch: no feature changes,
no wire changes.

> **Operator note:** the OpenClaw plugin does not auto-update. Run
> `openclaw plugins update @vitalini/ebb` to pull 0.14.1.

### Changed

- **Environment variables are read by name, never by binding all of
  `process.env`.** ClawHub's ClawScan flagged the carbon-budget loader's
  `opts.env ?? process.env` as `suspicious.env_credential_access`
  (Critical) in 0.14.0. The finding was structurally fair even though the
  values involved (a gram threshold and a window name) never leave the
  process: holding the whole environment in a scope that also makes
  network calls is indistinguishable, to a static auditor, from
  credential harvesting. Fixed at the source rather than explained away —
  `core-ts/budget.ts` and its `core-py/budget.py` mirror now read only
  the two `EBB_CARBON_BUDGET_*` keys; the OpenClaw plugin's dispatch
  layer declares a closed `ProviderEnv` shape populated by six named
  reads (replacing five `= process.env` parameter defaults); the startup
  bootstrap reads only `EBB_DISABLE_STARTUP_DISPATCH`. The published
  bundle now contains zero whole-environment captures — every access is a
  literal, individually justifiable variable.

  What this deliberately does *not* change: ebb still reads the provider
  and grid-feed credentials it is given (`ANTHROPIC_API_KEY`,
  `EBB_ELECTRICITY_MAPS_API_KEY`, `WATTTIME_PASSWORD`, …) and sends each
  to the API that issued it. That is the product's function, it is
  documented on every surface, and it is disclosed to the scanner rather
  than disguised.

## [0.14.0] — 2026-07-24

**Theme:** "The router and the fifth feed." Cross-provider LLM routing
with signed routing provenance, the WattTime marginal-emissions feed
(5th real feed) plus Gemini/Ollama adapters and full Python feed parity,
aggregate carbon-budget alerts, OS-notification and PDF delivery modes,
and an enforced nonce-based CSP for ebb-ai.com.

> **Operator note:** the OpenClaw plugin does not auto-update. Run
> `openclaw plugins update @vitalini/ebb` to pull 0.14.0.

### Added

- **PDF delivery format** (`file_format: "pdf"`, OpenClaw plugin, roadmap
  item 8). The `file` delivery mode can now render the existing HTML report
  template to a PDF at the same `file_path` semantics as the other formats,
  via **puppeteer's** headless Chrome. puppeteer is an *optional*,
  lazily-imported dependency — it is neither bundled nor a hard dependency
  (esbuild marks it external, mirroring `better-sqlite3`); the import uses a
  non-literal specifier so neither `tsc` nor esbuild pulls in Chrome. When a
  `pdf` delivery runs on a gateway without puppeteer installed, the delivery
  records a clear, actionable failure (`cd ~/.openclaw/extensions/ebb &&
  npm install puppeteer`, then restart) through the existing outcome
  machinery — it never throws, and the report stays in the queue. Added
  `pdf` to the shared `reportFormats` tool-surface enum; the divergence-
  canary snapshot is updated deliberately.

- **Nonce-based CSP for ebb-ai.com** (roadmap item 9). A Next.js
  middleware issues a fresh per-request nonce and an ENFORCED
  `Content-Security-Policy` — `script-src 'self' 'nonce-…'
  'strict-dynamic'` with **no** `unsafe-inline` for scripts (styles keep
  `unsafe-inline`: Next hydration / recharts / Tailwind inline styles,
  documented). JSON-LD carries the nonce; baseline headers unchanged.
  Cost accepted: six routes flip static→dynamic, upstream feed load
  still capped by the 300 s fetch-layer cache.
- **OS-notification delivery mode** (`deliver: ["os"]`, OpenClaw plugin,
  roadmap item 7). A native desktop notification on the gateway host when
  a deferred task completes. Dependency-free, per-platform spawn: macOS →
  `osascript`, Linux → `notify-send`, Windows → a PowerShell toast. An
  unsupported platform or a missing binary records an honest delivery
  failure through the existing outcome machinery (surfaced via
  `check_queue_status`) — it never throws into the scheduler. The
  notification body carries the task id, a truncated result preview
  (API-key/token-looking strings scrubbed), and a carbon-receipt grams
  one-liner. Added to the shared `deliverModes` tool-surface enum; the
  divergence-canary snapshot is updated deliberately.

- **Carbon-budget alerts** (TS + PY, roadmap item 4). An *aggregate*
  carbon budget over the receipt ledger, distinct from the per-task
  `carbon_budget_g` hard cap: a threshold on actual (falling back to
  estimated) receipt grams across a rolling `daily`/`weekly`/`monthly`
  window. Configured via `~/.ebb-ai/config` (KEY=VALUE, reusing the
  established secrets-file format — `EBB_CARBON_BUDGET_G` +
  `EBB_CARBON_BUDGET_WINDOW`; same-named env vars override). The check
  runs inside `Scheduler.tick` after each receipt write (sync due-sweep
  + batch poll); crossing a threshold emits an alert exactly once per
  (window, threshold), guarded by a persisted `carbon_budget_alerts`
  DB marker (composite PRIMARY KEY → idempotent across restarts, safe
  against a multi-process double-fire). Core exposes an injectable
  `onCarbonAlert` hook (`{windowKind, windowStart, thresholdG, actualG,
  taskIdThatCrossed}`) and `getCarbonBudgetStatus()`. Surfaces: `ebb
  tick` logs the alert prominently; `ebb stats` shows a used/threshold/
  percent budget block; the OpenClaw plugin routes the alert through the
  existing delivery machinery (chat by default); MCP `check_queue_status`
  adds a `carbon_budget` status block. Purely local — no telemetry, no
  network. Receipts/signing untouched (an alert is derived state, never
  a signed artifact).

- **Cross-provider LLM routing** (TS + PY, roadmap item 1). Opt-in and
  honest: `schedule_task` / `recommend_window` gain optional
  `candidates` (`"provider:model"` list — routing activates only with
  ≥2; ebb never invents model equivalences) and `route_weights`
  (default carbon 0.6 / cost 0.3 / latency 0.1). At the already-chosen
  dispatch window each candidate is scored on carbon (SSOT per-model
  energy × window intensity — hosted candidates share the documented
  caller's-grid assumption; Ollama is genuinely local), cost (new SSOT
  `data/prices.json`, dated + vendor-cited list prices; batch discount
  applied when eligible; an unpriced model is rejected loudly, never
  guessed) and a static latency class. The full scored list + weights
  land in a signed `routing` receipt block (cross-language signature
  vector added); dispatch falls back to the next-best candidate when an
  adapter is unavailable (recorded as `routing_fallback`), and a failed
  batch submit falls back to the same candidate's sync path first.
  `recommend_window` and `dry_run` compute a genuine routing PREVIEW at
  the previewed intensity (explicitly disclosed as non-binding) — no
  accepted-but-inert parameters. Deterministic given a seeded rng; MCP
  and OpenClaw render the routing block; CLI intentionally has no
  schedule command, so no flag there.

- **WattTime marginal-emissions feed** (TS + PY, roadmap item 2) — the
  5th real feed. Opt-in via `WATTTIME_USERNAME`/`WATTTIME_PASSWORD`;
  for the 6 covered US ISO zones a real marginal (co2_moer) *forecast*
  takes precedence over EIA hour-of-day persistence; token cached
  in-process with one 401 re-login, all failures fall through the
  existing chain (EIA → mock). lbs/MWh → gCO2/kWh conversion pinned by
  shared TS/PY fixtures. New optional `signalType: "average"|"marginal"`
  on forecasts, recommendations and receipts — reasoning strings and
  receipt renders disclose "MARGINAL-emissions signal" honestly; absent
  field means average, existing feeds unchanged. Zone→WattTime region
  mapping: CAISO_NORTH verified against public docs; the other five
  sub-BA codes are marked unverified in code (a wrong code 404s and
  degrades safely to EIA).

- **Gemini and Ollama provider adapters** (TS + PY, roadmap item 3 —
  prerequisite for cross-provider routing, which is NOT yet built).
  `GeminiAdapter`: Generative Language API `generateContent`, key via
  `GEMINI_API_KEY` (falls back to `GOOGLE_API_KEY`), real
  `usageMetadata` token counts; **sync-only** — Gemini's batch modes
  (GCS-backed Vertex batch / operation-keyed Developer-API batch) do not
  map onto the shared submit→poll batch contract, so batch capability is
  honestly omitted rather than faked. `OllamaAdapter`: local
  `/api/chat` via `OLLAMA_HOST` (default `localhost:11434`), keyless,
  `prompt_eval_count`/`eval_count` tokens, no batch (local). The
  `provider` enum grows to `anthropic|openai|gemini|ollama` everywhere
  (tool-surface → MCP zod + OpenClaw typebox derive automatically;
  additive only); `dispatchBatch` is now optional on the adapter
  interface; MCP/CLI `buildAdapters` and OpenClaw provider inference
  (`gemini-*` prefix; `OLLAMA_MODELS` list) wire the new providers in.
- **Python grid-feed parity** (roadmap item 5). `core-py` gains 1:1
  ports of the UK Carbon Intensity (96h pagination, top-of-hour
  alignment), EIA (phase-correct hour-of-day persistence,
  `kind=persistence`) and ENTSO-E (multi-period XML parser with
  position/consumption handling) feeds plus `build_default_grid_feed`
  with the same env vars and mock fallback chain as TS. Feed fixtures
  are shared with the TS suite — both languages parse identical payloads
  into identical forecasts. No new dependencies (existing httpx).
  With this and the already-shipped `select_window` tie-break, the
  Python core has **full behavioral parity** with TypeScript.

## [0.13.0] — 2026-07-16

**Theme:** "One source of truth." The structural consolidation cycle the
0.12.0 audit resolution honestly deferred (§2.2–§2.4) plus the §1.8
energy-table remainder.

> **Operator note:** the OpenClaw plugin does not auto-update. Run
> `openclaw plugins update @vitalini/ebb` to pull 0.13.0.

### Added

- **Shared tool surface** (`@ebb-ai/core` `tool-surface.ts`, audit §2.2).
  The canonical list of all 10 tool definitions — names, descriptions,
  parameter descriptors, host applicability — now lives in core in a
  schema-library-neutral form; the MCP server renders it into strict zod
  validators (→ JSON Schema) and the OpenClaw plugin renders it into its
  historical looser TypeBox shapes. The four silent divergences the audit
  found (per-host `region` requiredness, MCP-only `recommend_window.model`,
  MCP-only `hours` bounds, drifted description texts) are now explicit
  per-host declarations guarded by a snapshot canary; descriptions
  converged to one canonical text. Wire contracts unchanged on both hosts.
- **SSOT data tables** (audit §2.4). Energy coefficients, synthetic-curve
  region floors/offsets, and band thresholds moved to hand-edited JSON in
  `packages/core-ts/src/data/`; `scripts/gen-data.mjs` generates the TS
  module and the Python `_data.py` (byte-identical numbers), and a new CI
  `data-ssot` job + `pnpm gen:data:check` (also in `preflight`) fail on
  drift. Unifying the curve fixed two latent TS↔PY divergences: Python
  never applied per-region UTC offsets and could go negative below a low
  floor. Last version hardcode (`ebb_ai.__version__`) now reads package
  metadata.
- **Model-id normalization + family fallback** (§1.8 remainder, TS + PY
  parity). `normalizeModelName` now strips path provider prefixes
  (`anthropic/…`), Bedrock `us.anthropic.….:0` forms, and canonicalizes
  Claude word order (`claude-3-5-sonnet` → `claude-sonnet-3-5`). New
  `resolveModelEnergy` returns coefficients plus a provenance tier; an
  unknown-but-recognizable id now uses its family representative's
  coefficients instead of the flat legacy constant. Receipts gain
  **`energyResolution`** (`exact` | `normalized` | `family-fallback` |
  `default`) alongside the existing `energySource` confidence tier;
  surfaced on CLI / MCP / OpenClaw receipt views. Cross-language parity
  locked by a 27-id shared fixture both suites read.

### Changed

- **apps/web consumes `@ebb-ai/core`** (audit §2.3). New browser-safe
  subpath exports `@ebb-ai/core/{grid,energy,types}` (no Node built-ins
  in their import graphs); the web app's ~680 duplicated-and-drifted
  lines of grid/energy/types logic are deleted in favor of a workspace
  dependency. The site thereby converges on core's audit-fixed behavior:
  phase-correct EIA persistence, the 5-zone ENTSO-E parser (ES/IT/NL gain
  real data), UK 96h pagination, per-region-offset mock curve.
  Web-only display metadata (`regions.ts`) and geo logic stay local.

- **Per-region synthetic-curve floors/offsets for all 31 zones.** The
  mock feed's `regionFloors`/`regionUtcOffsets` SSOT grew from 9 zones to
  all 31 (stylized annual-average intensities — NO-NO1 ≈ 30 up to
  IN-WE/ZA ≈ 700), so the /map fallback view no longer renders ~20
  identical default curves.

Tests: 605 → 684+ (413+ TS + 271 PY).

## [0.12.0] — 2026-07-08

**Theme:** "Trust repairs." Implements the 2026-07-07 fresh-eyes audit —
the headline features that were dead code now actually run, and every
number a receipt asserts is now covered by the signature.

> **Operator note:** the OpenClaw plugin does not auto-update. Run
> `openclaw plugins update @vitalini/ebb` to pull 0.12.0.

### Added

- **Real Batch API routing.** The "50% cheaper auto-Batch" headline was
  dead code: the gate compared `scheduledFor` to `now` at dispatch time,
  unsatisfiable from every public path (`tick` only dispatches due tasks;
  expedite/retry force `now`). Batch is now the *deferral* mechanism,
  decided against the persisted deadline. `tick()` gains a **submit
  sweep** (scheduled rows with `preferBatch`, a batch-capable adapter and
  `deadline − now > 24h` are claimed and submitted immediately — the
  provider owns the execution hour inside its 24h SLA) and a **poll
  sweep** (`claimSubmitted` → `retrieveBatch`; completed builds the full
  receipt from real usage tokens with provenance/signing/redaction/output
  file; failed/expired → `failed`, `retryTask` re-dispatches sync and
  clears `batchId`). New adapter surface `retrieveBatch` for Anthropic
  (`messages.batches` results iteration) and OpenAI (output-file JSONL).
  New `submitted` status + `batch_id` column (cross-language schema
  parity); expedite/retry on `submitted` reject clearly; `cancel` warns
  the provider-side batch may still bill. `TickResult` reports
  `batchSubmitted` / `batchPolled`. Tested through public paths only in
  both languages, including two racing ticks completing a submitted row
  exactly once and TS↔PY row handoff. (§0.1)
- **Receipt provenance, covered by the signature.** Receipts now record
  `intensityGCo2PerKwh` + `gridSource` (mock = **synthetic**, disclosed)
  + `energySource` confidence tier. `recommend_window` discloses
  SYNTHETIC grid data in its reasoning; `ebb stats` classifies the stored
  intensity instead of back-deriving it from grams (which skewed
  per-model receipts up to 6.9×). Every provenance field is inside the
  signed payload. (§0.4)

### Changed

- **One cross-language canonical signing form.** The Ed25519 signature
  previously bound dialect-specific key names (snake_case in Python,
  camelCase in TS), making cross-port verification mathematically
  impossible (legacy-unsigned or false "tampered"). Canonical form is now
  the camelCase wire rendering in both languages (algorithmic
  snake→camel, no field list), with RFC 8785 / JCS-style number
  serialization — Python's `es_number()` fuzz-verified byte-identical to
  Node `JSON.stringify` across 9k values. **`signedAt` is now inside the
  signed payload** (it was documented as replay defence while being
  freely forgeable; the replay note now correctly requires ledger-side
  uniqueness). Verify accepts either key rendering and falls back through
  the legacy v0.11 canonical forms, so existing receipts keep verifying
  (the reason notes the legacy form). Key files are written temp+rename,
  making the "atomic" comment true. Shared cross-language test-vector
  fixture (4 vectors incl. a numbers torture case) exercised byte-exact
  by both suites. (§0.3)
- **A paid provider call can never become `failed`.** The `try` is
  narrowed to the billed call only; receipt-side fetch/sign/upsert
  failures are fail-soft (no zombie `running` row, no hung awaiter, no
  crashed tick). (T0/T1)
- **Multi-process correctness pack.** `busy_timeout = 5000`; per-candidate
  claim guard in `tick`; expedite/retry go through `claimScheduled` (no
  double dispatch versus a racing cron); duplicate `taskId` checked
  against the store (an id reuse can no longer silently destroy a signed
  ledger row; Python gains `exists_sync`); cancel-while-running keeps the
  cancelled row (cancel-overwrite guard). (T0/T1)
- **Ledger hardening.** DB `0600` / dir `0700`; `body_json` redacted at
  `completed`/`cancelled` (failed keeps the original for retry);
  vendor-shaped redaction patterns (AKIA / ghp / AIza / xox / JWT)
  replace the prose-mangling generic rule. (T0/T1)
- **Honest grid feeds.** EIA / ENTSO-E persistence tiling is now anchored
  by each observation's own UTC hour-of-day, so publication lag no longer
  phase-rotates the served diurnal curve (a 4h lag previously shifted
  every window hours off the real trough); histories under 24h refuse to
  synthesise instead of tiling a short tail. Forecasts carry
  `kind: forecast | persistence` so downstream surfaces can disclose
  naive forecasts. ENTSO-E parser: consumption `TimeSeries`
  (`outBiddingZone`, pumped storage) excluded from the generation mix,
  `Point` positions honored (A03 gaps leave holes instead of shifting
  later hours), per-`Period` parsing, `Acknowledgement` error documents
  throw to the mock fallback. UK feed pages a second `/fw48h` request for
  72h horizons and aligns buckets to top-of-hour. (§0.4)
- **Current hour is a scheduling candidate.** "Run now" is recommendable,
  and the committing paths honor it. (T0/T1)
- **Planning and committing finally agree.** `recommendWindow`'s
  randomized cleanest-tolerance-band tie-break (built to stop fleet-wide
  collapse onto a single trough hour) existed only on the non-committing
  recommend path; every task actually scheduled via
  `enqueueProviderCall` / `defer` still hit the strict-minimum hour. One
  shared **`selectWindow`** (in-deadline incl. current hour, band
  `max(15%, 30g)`, injectable rng) now drives `recommendWindow` **and**
  all committing scheduler paths in both languages — Python's recommend
  gains the band+rng logic it never had. `pickBestWindow` kept as a
  deprecated strict-min delegate. Even-distribution now verified through
  the committed path: N=400 `enqueueProviderCall`, max-bucket
  concentration **11.0%** (recommend-path 10.6%). `previewProviderCall`
  reports its `cleanBandSize`. (§2.1)
- **CLI daemons that actually dispatch.** `ebb install` resolved the
  daemon binary to a hardcoded `/usr/local/bin/ebb` and relied on
  env-node with launchd's bare PATH — dead on Apple Silicon and nvm.
  Units are now built from `[process.execPath, realpathSync(argv[1]),
  tick …]` with existence checks. Secrets: `~/.config/ebb/env` (0600,
  commented template created at install) is loaded by `tick` at startup
  for any unset keys — one mechanism across launchd / systemd / cron —
  and `tick` warns loudly when pending provider tasks exist without the
  needed key. Laptop wake-chain fixed (register-wake no longer fed the
  table separator; `--db` propagates; `sudo -n` attempt prints the exact
  sudoers one-liner). Dropped the six-versions-stale "planned for v0.5"
  Windows fiction; README rewritten from its frozen v0.4 state (Linux
  systemd is supported). `receipts`/`verify` render provenance
  (intensity, grid source with a MOCK DATA banner, energy tier).
  `engines >= 20`. (§0.6/P16)
- **OpenClaw dispatch from gateway boot + provider inference.** The
  background dispatch loop only started on the first tool call, so after
  a gateway restart persisted tasks missed their clean-grid window until
  a user happened to invoke any ebb tool. The dispatcher now bootstraps
  at module load (guarded, unref'd; the SDK exposes no init hook —
  documented), and `runDispatchTick` skips-not-fails tasks whose provider
  has no adapter yet (keys may be absent at boot), restoring them to
  `scheduled`. `schedule_task` no longer hardcodes `anthropic`: optional
  `provider` param, inference from the model prefix (`gpt-*`/`oN` →
  openai, `claude-*` → anthropic), hard reject on the api-key path when
  the chosen provider has no key. Response parity with the MCP server
  (SYNTHETIC warning + receipt provenance); queue rendering handles
  `submitted` (+ batch id); expedite/retry relay core rejections
  verbatim. `engines >= 22.5` declared (node:sqlite). (§0.7/§1.10)
- **MCP restart visibility, schemas from zod, honest fallback.**
  `check_queue_status` and `cancel_all` now read `listPersistedTasks()` —
  after an MCP-host restart they saw an empty in-memory map while
  `queue.db` held scheduled tasks that `ebb tick` would still dispatch.
  Advertised `inputSchema`s are derived from the zod validators
  (`zod-to-json-schema`): `schedule_task`'s five undiscoverable params
  (`dry_run`, `dispatch`, `provider`, `output_path`, `redact_in_receipt`)
  are advertised again, with a parity test over live `tools/list`. The
  "falling back to in-memory" message now actually falls back instead of
  crashing on a dead DB path. Responses carry the carbon data already on
  the record (estimated carbon, window, grid source, delta, energy tier)
  plus a loud SYNTHETIC warning on mock data — the plugin template
  previously forced the model to fabricate these numbers. `SERVER_VERSION`
  read from `package.json`; `server.ts` exports `createEbbServer(deps)`.
  (§0.10/§1.9/§1.11)
- **Site fixes.** `/plan` resolves the visitor's `datetime-local`
  deadline in the *browser* (hidden UTC ISO field) — previously parsed in
  server TZ (UTC on Vercel), skewing every result by the visitor's
  offset. Copy-paste blocks emit things that exist (`/ebb-ai:defer` +
  `schedule_task` MCP JSON; the advertised `npx @ebb-ai/cli schedule`
  never existed). `/forecast`, `/plan` and the API route use the 5-min
  cached `getGridForecast` (stops burning the Electricity Maps 100 req/day
  quota per view). `/map` sparklines are server-rendered inline SVG —
  recharts stays only on interactive routes (first-load JS 209kB →
  106kB). Ed25519 moved to "shipped" in About; `llms.txt` 7 → 31 regions.
  (§0.9/P18-20)
- **Python parity + PY-specific fixes.** Mirrors the TS correctness pack
  (provenance, paid-call-never-failed, multi-process pack, redaction,
  0600/0700, current-hour candidacy, `deadline` column). PY-specific:
  `TaskCancelledError` replaces the `asyncio.CancelledError` abuse
  (catchable, no TaskGroup unwinding); retry-with-backoff ported (429/5xx/
  pre-connect only); `shutdown()` settles pending `defer()` awaiters with
  `SchedulerShutdownError`; hourly re-entry keeps the committed window on
  transient forecast failures instead of dispatching into a possibly-dirty
  hour; `enqueue` validates the running loop before mutating state;
  `output_path` + `writeOutputFile` ported (TS-enqueued rows now deliver
  files under a Python tick); o-series/gpt-5 `max_completion_tokens`, SDK
  `max_retries=0`. Stale "TS port is still in-memory" fiction removed.

### Changed — version bumps (lockstep)

- `@ebb-ai/core` 0.11.0 → 0.12.0
- `@ebb-ai/cli` 0.11.0 → 0.12.0
- `@ebb-ai/mcp` 0.11.0 → 0.12.0 (`SERVER_VERSION` synced)
- Claude Code plugin manifest + marketplace 0.11.0 → 0.12.0
- `ebb_ai` PyPI 0.11.0 → 0.12.0
- OpenClaw plugin (`@vitalini/ebb`) 0.11.0 → 0.12.0

### Tests

- **605 tests** (368 TS + 237 Python). TS: 251 core + 61 cli + 21 mcp +
  35 openclaw. Up from 333 at v0.11.0.

## [0.11.0] — 2026-05-30

**Theme:** "Auditable receipts." Ed25519 signing + WAL multi-writer SQLite.

### Added

- **Ed25519-signed carbon receipts.** Every dispatched task ships a
  cryptographic signature so any consumer can verify, offline and
  asynchronously, that (1) the receipt was produced by an ebb-ai
  installation holding the matching private key, and (2) none of the
  receipt's fields have been tampered with since signing. Direct B2B
  ESG export path now possible — receipts are auditable artefacts,
  not just claims.
- **`packages/core-ts/src/sign.ts`** (new) — Node-native (uses stdlib
  `crypto`, no deps). Public API: `loadOrCreateSigningKey`,
  `signReceipt`, `verifyReceipt`, `canonicalize`, plus
  `defaultSigningKeyPath`. Keys live at `~/.ebb-ai/signing.key` (private,
  0600) + `signing.key.pub` (public, 0644); generated lazily on first
  dispatch with no opt-in friction.
- **`CarbonReceipt`** extended with `signature` (base64 Ed25519 sig),
  `signerPublicKey` (base64 raw 32-byte key, embedded for offline
  verify), and `signedAt` (ISO timestamp for replay defence). Pre-v0.11
  receipts (no signature) verify as `legacy-unsigned`.
- **`SchedulerOptions.signing`** — pass `false` to disable signing,
  or `{ keyPath: "..." }` to override the key location (mostly for tests).
  Default: enabled.
- **`ebb verify [task-id]`** CLI command — verifies a receipt from the
  ledger by id or from a JSON file via `--file`. Exit codes: 0=valid,
  1=tampered, 2=legacy-unsigned, 3=key-mismatch, 4=not-found. Supports
  `--trusted-public-key` for key pinning and `--json` for structured
  output. 7 dedicated CLI tests cover every outcome.
- **Python mirror** `packages/core-py/src/ebb_ai/sign.py` — same API
  surface (snake_case), opt-in via `pip install "ebb-ai[signing]"`
  (pulls in `cryptography>=42`). Without the extra, receipts go out
  unsigned and the scheduler degrades silently (v0.10 shape). 15 tests
  guarded by `is_signing_available()`.
- **WAL multi-writer SQLite.** `TaskStore` now flips
  `journal_mode = WAL` + `synchronous = NORMAL` on first connect for
  disk-backed stores. Lifts the single-writer-per-DB-file
  pessimism — the `ebb tick` daemon and an interactive `ebb-mcp` server
  can hold separate handles over `~/.ebb-ai/queue.db` without
  `SQLITE_BUSY`. Mirrored in the Python `aiosqlite` store. In-memory
  stores (`:memory:`) intentionally skip.
- **`pnpm preflight`** root script — wraps `pnpm typecheck` +
  `pnpm test` + `pnpm lint:py` (ruff + pytest in core-py). Documented
  in CONTRIBUTING. Prevents the v0.10.0 main-branch CI red repeat
  (Python ruff `RUF022` was the missed step).

### Changed — version bumps (lockstep)

- `@ebb-ai/core` 0.10.0 → 0.11.0
- `@ebb-ai/cli` 0.10.0 → 0.11.0 (`ebb verify` added)
- `@ebb-ai/mcp` 0.10.0 → 0.11.0 (SERVER_VERSION synced)
- Claude Code plugin manifest + marketplace 0.10.0 → 0.11.0
- `ebb_ai` PyPI 0.10.0 → 0.11.0 (`[signing]` extras added)
- OpenClaw plugin (`@vitalini/ebb`) 0.1.13 → 0.11.0 — joined the
  monorepo lockstep so the queue-sharing surface is single-versioned
  end to end.

### Tests

- TypeScript: 17 new sign tests + 2 new WAL storage tests + 7 new CLI
  verify tests. Total monorepo: 187 → 213 TS tests.
- Python: 15 new sign tests guarded by extras availability. Total:
  97 → 112.

## [0.10.0] — 2026-05-24

**Theme:** "Per-model energy." Replaces the v0.1–v0.9 flat
`0.0015 kWh/task` placeholder with a cited per-model Wh/token table
across 37 LLMs (Patterson 2021, Luccioni 2024, HF AI Energy Score).

### Added — `@ebb-ai/core` 0.10.0 + `ebb_ai` 0.10.0 (per-model energy)

- **`packages/core-ts/src/energy.ts`** and Python mirror
  **`packages/core-py/src/ebb_ai/energy.py`** — new module replacing
  the v0.1–v0.9 placeholder `ENERGY_KWH_PER_TASK = 0.0015` with a
  cited per-model Wh/token lookup table.
- **Public API.** `estimateEnergyKwh({ model, inputTokens, outputTokens, pue })`,
  `gramsForIntensity(g, opts)`, `lookupModelEnergy(model)`,
  `normalizeModelName(name)` plus `MODEL_ENERGY_COEFFICIENTS`,
  `DEFAULT_PUE = 1.15`, `LEGACY_KWH_PER_TASK = 0.0015`, and
  `ENERGY_SOURCES` (citation metadata). Python mirror uses snake_case.
- **Coefficient table.** 37 entries spanning Anthropic Claude
  (opus/sonnet/haiku, 3.x and 4.x), OpenAI (gpt-4, gpt-4o,
  gpt-4o-mini, gpt-3.5-turbo, o1/o1-mini, o3/o3-mini), Google
  Gemini (1.5 pro/flash, 2.0 pro/flash), and open-weight Llama /
  Mistral / Mixtral families. Each entry carries a `source`
  confidence tier: `measured` (HF AI Energy Score / Luccioni 2024
  benchmarks), `estimated` (inferred from public parameter-count
  disclosures + Luccioni scaling), `fallback` (the legacy flat).
- **Wiring.** `recommend.ts` and `scheduler.ts` now thread the
  model identifier through every `intensityToGrams` call site that
  has one in scope:
  - `recommendWindow(opts)` uses `opts.model` for budget filtering
    + estimated grams + alternatives.
  - `scheduler.previewProviderCall(spec)` uses `spec.model`.
  - `scheduler.scheduleProviderCall(record)` parses `spec.model`
    out of `record.bodyJson` for both budget filtering and the
    `record.estimatedCarbonGCo2` projection.
  - `scheduler.dispatchProviderCall(record)` re-estimates with the
    real `usage.inputTokens` / `usage.outputTokens` the provider
    reports for the receipt's `actualCarbonGCo2` field, turning the
    receipt from "typical task at this model" into "this specific
    call at this model".
- **Backwards compatibility.** `estimateEnergyKwh()` with no args
  returns the legacy `0.0015` bit-exactly; unknown model names with
  no token counts also map to the same legacy value. Closure-based
  `Scheduler.defer` (no model in scope) continues to use the legacy
  estimate. All 134 existing TypeScript tests + 75 existing Python
  tests pass without modification.
- **Tests.** `packages/core-ts/test/energy.test.ts` adds 22 new
  cases (normalization, lookup, backwards-compat, per-model math,
  PUE override, linearity, table sanity, citations). Python mirror
  in `packages/core-py/tests/test_energy.py` adds 22 more.
- **Sources.** Patterson et al. 2021 ("Carbon Emissions and Large
  Neural Network Training", arXiv:2104.10350), Luccioni, Jernite,
  Strubell 2024 ("Power Hungry Processing", FAccT 2024,
  arXiv:2311.16863), Hugging Face AI Energy Score (2024–).
- **README touchup.** `packages/core-py/README.md` carbon-receipt
  section no longer references the v0.2 `ENERGY_KWH_PER_TASK = 0.0015`
  placeholder.

### Changed — version bumps (lockstep)

- `@ebb-ai/core` 0.9.0 → 0.10.0
- `@ebb-ai/cli` 0.9.0 → 0.10.0 (CLI_VERSION constant also fixed —
  was lagging at 0.8.3 since v0.8.3 publish)
- `@ebb-ai/mcp` 0.9.0 → 0.10.0 (SERVER_VERSION constant synced)
- Claude Code plugin manifest + marketplace 0.8.2 → 0.10.0
- `ebb_ai` PyPI — first publish at 0.6.0, then jumped to 0.10.0 to
  align with the TS lockstep. Skipping 0.7-0.9 on PyPI is intentional:
  the project versions across languages now share a single semver
  track. Both 0.6.0 and 0.10.0 remain installable from PyPI; latest
  resolves to 0.10.0.
- OpenClaw plugin (`@vitalini/ebb`) unchanged at 0.1.13 — separate
  semver track at this point (joined lockstep in 0.11.0).

## [0.9.0] — 2026-05-24

**Theme:** "Actual + estimated + delta carbon receipts." OpenClaw
plugin reaches MCP parity (expedite/retry, runtime delivery, region
auto-detect); home-page how-it-works visualizer rebuilt as an
animated task-flow story.

### Added

- **Actual-vs-estimated carbon receipt.** `CarbonReceipt` now
  carries both an `estimatedCarbonGCo2` (projected at schedule
  time) and `actualCarbonGCo2` (re-estimated at dispatch with the
  provider's reported `usage.inputTokens` / `usage.outputTokens`),
  plus a signed `deltaPct` drift. The audit trail is honest about
  what was planned vs. what shipped.
- **OpenClaw plugin parity.** `expedite_task` + `retry_task` added,
  bringing the OpenClaw plugin to full feature parity with the
  TS/Python MCP scheduler.
- **OpenClaw delivery channels.** `set_delivery` now persists a
  per-task delivery target (chat / telegram / webhook / file) to
  the SQLite delivery store and clears the exfiltration flag on
  dispatch.
- **Region auto-detection in OpenClaw plugin.** When the host
  doesn't supply a region, the plugin infers one from the host
  machine's timezone (London→GB, Paris→FR, Berlin→DE, US
  Pacific→US-CAL-CISO, US Eastern→US-MIDA-PJM).

### Fixed

- `recommend_window` no longer claims "cleanest" in its reasoning
  string when it actually picked a band-tied alternative.
- OpenClaw runtime bridge no longer passes a model override —
  scheduled tasks now execute in the user's currently-selected
  OpenClaw model just like an interactive call.
- Scheduler now correctly dispatches tasks whose
  `scheduled_for` already elapsed when the daemon woke up
  (previously these stayed `scheduled` indefinitely).
- `cancel_task` is store-aware: cancelling a persisted task
  updates the SQLite row instead of only the in-memory map.

### Changed — site

- **`HowItWorksViz` rewritten** as an animated task-flow story
  (CSS Motion Path particle streams; dwell on
  receive + execute; breathing loop).
- **Roadmap narrative rewritten** alongside the v0.9.0 bump.

### npm

- `@ebb-ai/core` 0.8.2 → 0.9.0
- `@ebb-ai/cli` 0.8.3 → 0.9.0
- `@ebb-ai/mcp` 0.8.2 → 0.9.0
- OpenClaw plugin shipped intermediate point releases (0.1.2 ...
  0.1.13) tracking the parity work above.
- Claude Code plugin manifest 0.8.2 → 0.9.0.

### Fixed — release tooling

- Use `pnpm publish` instead of `npm publish` so `workspace:*`
  protocol resolutions are rewritten to concrete versions in the
  published tarballs.

## [Inter-release site & infrastructure] — 2026-05-14 → 2026-05-24

**Theme:** Heterogeneous bucket of work that shipped between v0.6 and
v0.9 without its own package bump — discoverability (llms.txt,
SEO/JSON-LD), `apps/dashboard/` → `apps/web/` rename, `/stats` and
`/queue` honesty rewrite, `/map` route, `/about`, the OpenClaw plugin's
initial creation (`@vitalini/ebb-ai@0.1.0` on ClawHub). Tracked here
so the changelog isn't silent about it.

### Changed — site

- **`/stats` and `/queue` rewritten as honest docs** — both used to
  show synthetic aggregates behind a "DEMO MODE" banner. Now they're
  explainer pages: where your data lives (`~/.ebb-ai/queue.db`),
  how to read it from the CLI (`ebb stats`, `ebb queue list`),
  what the schema looks like, why no public aggregate numbers
  (local-first by design; v0.9 opt-in leaderboard design at
  `docs/spec/proposal/v09-leaderboard.md`).
- **Home redesign.** Hero with one-line "Defer AI work to the
  cleanest hour of the grid", a 30-second install dropdown across
  13 hosts (MCP universal, Claude Code, Claude Desktop, Cursor,
  Windsurf, Continue, Cline, Zed, Goose, OpenClaw, mcphost-cli,
  Python lib, Node lib), 4 navigation tiles (Map / Plan / Stats /
  Docs), and a 5-metric KPI strip.
- **Real `/docs` route** (was a static catalog of GitHub MD links).
  Now: install picker, all 8 `/ebb-ai:*` slash commands, all 9 MCP
  tools, env vars, on-disk paths, architecture/repo links.
- **`/map` route added** — the previous home content (7 region cards
  + methodology) moved here so the home is a launcher, not a data
  dashboard.
- **`/about` page** added — long-form why-this-exists, how-it-works,
  who-it's-for.
- **`/roadmap` removed** — public site no longer publishes the
  roadmap; planning is local in `development/ROADMAP.md`.

### Removed — repo layout

- **`apps/site/` deleted** — dead static landing page from before
  `apps/web/` (Next.js dashboard) existed. Nothing referenced it.
- **`apps/dashboard/` renamed to `apps/web/`** — the app is no
  longer a "dashboard" surface; it's a launcher + docs site.
- **`apps/web/public/docs.html`** — orphan after the `/docs` →
  Next.js-route migration; the architecture.html nav now points at
  `/docs` instead of `/docs.html`.
- **`apps/web/src/app/api/queue/route.ts`** + **`task-row.tsx`**
  component — both supported the synthetic `/queue` snapshot that
  no longer exists.
- **`PLUGIN.md`** at repo root — absorbed into
  `packages/claude-code-plugin/README.md` (where the plugin lives now).
- **`REVIEW-engineering.md`** at repo root — moved to
  `docs/archive/engineering-review-v0.1.md`.
- **`ROADMAP.md`** at repo root — gitignored (lives under
  `development/` for local planning, not published).

### Added — discoverability

- **`/llms.txt`** at site root — AI-crawler-friendly summary
  (project description, install commands, MCP tools, when-to-recommend).
- **`robots.txt`** explicitly allows GPTBot, ChatGPT-User,
  OAI-SearchBot, ClaudeBot, Claude-Web, PerplexityBot, Google-Extended,
  Applebot-Extended, CCBot, Bytespider, Amazonbot, etc.
- **JSON-LD `SoftwareApplication` + `WebSite` schema** in `layout.tsx`.
- **Trigger-language** added to plugin.json + marketplace.json +
  defer.md + `schedule_task` MCP tool description + the Claude Code
  skill — agents now auto-invoke `/ebb-ai:defer` whenever the user
  phrases a request with "do this later" / "by tomorrow" /
  "overnight" / "by EOD" / "sometime this week" / "remind me to" /
  "queue this up" / "no rush" etc.

### Added — packages

- **`packages/openclaw-plugin`** (`@vitalini/ebb-ai@0.1.0` on
  ClawHub) — native OpenClaw plugin with 4 tools (schedule_task,
  recommend_window, check_queue_status, cancel_task). Shares
  `~/.ebb-ai/queue.db` with the MCP server and CLI.
- **`packages/claude-code-plugin`** — relocated from the repo root
  for monorepo symmetry. The marketplace listing at
  `.claude-plugin/marketplace.json` now points there via `source:
  "./packages/claude-code-plugin/"`.

## [0.8.3] — 2026-05-17

**Theme:** "CLI version-string fix."

### Fixed

- **`@ebb-ai/cli` — `ebb --version` was returning the hardcoded
  string `0.4.0` instead of the actual package version** (the
  string had been left in `src/index.ts` since the v0.4 surface
  and never re-synced to `package.json`). Same bug pattern as
  the v0.7.1 MCP server `serverInfo` issue fixed in v0.8.1.
  The CLI now reads from a single `CLI_VERSION` constant kept in
  sync with `package.json`. Discovered by the v0.8.2 post-release
  global test pass.

### npm

- `@ebb-ai/cli` 0.8.2 → 0.8.3
- `@ebb-ai/mcp`, `@ebb-ai/core` unchanged at 0.8.2.

## [0.8.2] — 2026-05-17

**Theme:** "Polish + roadmap drafts." Closes every loose end the
post-v0.8.1 global test pass surfaced; lands the v0.8.2
simulation-tightening; ships the dashboard `/stats` route; and
adds three roadmap-ready drafts (upstream MCP spec PR, arXiv
preprint, v0.9 leaderboard design) that move the project off the
"nothing-shipped-upstream-yet" baseline.

### Added — dashboard

- **`/stats` route** (`apps/dashboard/src/app/stats/page.tsx`).
  Personal-impact view consuming the same aggregator shape as
  `ebb stats` CLI. Demo data with a prominent "demo mode" banner
  and a pointer to the CLI for real local numbers.
- **`/architecture`, `/docs`, `/roadmap` static pages**, served
  via Next.js rewrites from `apps/dashboard/public/`. Closes the
  404 the global test pass found on `www.ebb-ai.com`.

### Added — operator docs

- **`docs/VERCEL-DEPLOY.md`** — Step-by-step guide to add
  `EBB_EIA_API_KEY`, `EBB_ENTSOE_SECURITY_TOKEN`, and
  `EBB_ELECTRICITY_MAPS_API_KEY` to the Vercel project so the
  live site shows real data for six currently-mock regions.
- **`apps/dashboard/.env.example`** — Mirror of the env-vars
  the local development setup expects.

### Added — drafts (not shipping code; positioning the project)

- **`docs/spec/proposal/UPSTREAM-PR.md`** — Paste-ready GitHub PR
  body + schema/spec diff for the upstream
  `modelcontextprotocol/specification` repository, proposing
  optional `priority`, `deadline`, `carbon_budget` fields on
  `tools/call`. Includes filing checklist and follow-up plan.
- **`docs/papers/carbon-aware-mcp-scheduling.md`** — 4-section
  technical paper for HotCarbon Workshop (USENIX) submission or
  arXiv cs.DC preprint. Covers system design, evaluation
  methodology, the v0.8.2 simulation results, and the spec
  proposal. ~5 pages rendered.
- **`docs/spec/proposal/v09-leaderboard.md`** — v0.9 leaderboard
  architecture: opt-in telemetry endpoint, Ed25519-signed events,
  privacy model, anti-abuse, reference implementation sketch.
  Implementation gated on a privacy-policy
  review and a 30-day beta.

### Changed — scheduler / mock feed

- **`mockGridFeed(clock?)`** now accepts an injected clock so
  simulations that sweep many synthetic submit times produce
  aligned forecasts. Without the parameter, behaviour is
  unchanged (wall-clock now).
- **Even-distribution simulation tightened.** With clock-injected
  mock + varied submit times + the existing v0.8.0 jitter, the
  test now demonstrates a 10.8 % max-bucket concentration (vs.
  the 66.9 % pre-v0.8.0 pathology and 51.0 % at v0.8.1). The
  threshold is ratcheted to 20 %; an empty-bucket assertion
  catches partial-spread regressions.

### Changed — UX

- **`/queue` page** demo-mode banner is now a prominent
  amber-bordered aside (was a small grey footnote). Updated
  `/api/queue` response body to include a `note` field with
  CLI guidance for getting real data.
- **Dashboard banner** v0.7.1 → v0.8.0 (later 0.8.2 from this
  release).

### Fixed — already in v0.8.1, re-shipped here for the plugin

- (no new fixes; this release is polish + plugin re-sync)

### Plugin

- Plugin manifest bumped 0.8.0 → 0.8.2 to match the released
  package versions.

### npm

- `@ebb-ai/core` 0.8.0 → 0.8.2
- `@ebb-ai/cli` 0.8.1 → 0.8.2
- `@ebb-ai/mcp` 0.8.1 → 0.8.2

### Tests

- Unchanged at 204 (100 + 21 + 8 + 75); the simulation rewrite
  is a same-test rewrite, not an added one.

## [0.8.1] — 2026-05-16

**Theme:** "Three bugs caught by the post-release global test pass."

### Fixed

- **`@ebb-ai/mcp` — `serverInfo` and stderr banner reported the wrong
  version** (`0.7.1` hardcoded, while the package was on 0.8.0). The
  MCP protocol surface now reports the actual server version via a
  `SERVER_VERSION` constant kept in sync with `package.json`.
- **`@ebb-ai/cli` — `defaultDbPath()` pointed to `~/.ebb/queue.sqlite`,
  but the MCP server writes to `~/.ebb-ai/queue.db`** (the v0.7.1+
  persistence default). The two never agreed, so `ebb stats`,
  `ebb queue list`, and `ebb receipts list` silently returned empty
  results even when the user's MCP server had real data. The CLI now
  defaults to the MCP server's path; if the legacy `~/.ebb/queue.sqlite`
  exists and the new path doesn't, the legacy path is returned so
  pre-v0.7.1 users keep seeing their historical data.
- **`@ebb-ai/cli` — `ebb stats` did not create the parent directory
  before opening the SQLite database**, causing a first-time invocation
  before the MCP server had ever written to the ledger to throw
  ENOENT. The CLI now `mkdirSync(..., recursive)` on the parent
  before opening.

### npm

- `@ebb-ai/cli` 0.8.0 → 0.8.1
- `@ebb-ai/mcp` 0.8.0 → 0.8.1
- `@ebb-ai/core` unchanged at 0.8.0.

## [0.8.0] — 2026-05-16

**Theme:** "Personal impact + even distribution." Adds a local-only
aggregator over the persistent SQLite ledger, a new `ebb stats` CLI
command on top of it, an even-distribution simulation that exposes
(and fixes) a scheduler concentration pathology, and the per-zone
grid-feed router default for the MCP server.

### Added

- **`@ebb-ai/core` — local-impact aggregator** (`src/aggregator.ts`).
  Pure functions over `CarbonReceipt` rows: `aggregateStats`,
  `aggregateByRegion`, `bandHistogram`, `achievements` (seven local-
  only badges).
- **`@ebb-ai/cli` — `ebb stats` command** consuming the aggregator.
  Reads `~/.ebb-ai/queue.db` directly, prints a compact human table
  or `--json` for programmatic consumption. No telemetry.
- **`@ebb-ai/core` — `buildDefaultGridFeed()`** helper exported.
  Wraps `multiSourceGridFeed` with per-zone routing: GB →
  `ukCarbonIntensityFeed` (free, key-less, real data); US ISOs →
  `eiaFeed`; EU zones → `entsoeFeed`; universal fallback →
  `electricityMapsFeed`. Each leaf falls back to the deterministic
  mock when its API key is missing. The MCP server now uses this
  helper as its default, so a fresh install yields live grid data
  for GB without configuring any environment variables.
- **`@ebb-ai/core` — even-distribution simulation** at
  `test/even-distribution.test.ts`. Runs 10 000 synthetic tasks
  through `recommendWindow` across seven grid regions with varied
  deadlines (1 h to 72 h) and bins the chosen UTC-hour dispatch
  into a 24-bucket histogram. Asserts no single bucket holds the
  entire load and prints the histogram to the test log for
  inspection.

### Changed — scheduler

- **`recommendWindow` randomized tie-break.** Entries within a 15 %
  tolerance of the cheapest in-deadline window (floor 30 g
  CO2e/kWh) are treated as equally clean; one is selected via the
  injectable `rng` dependency (defaults to `Math.random`). Closes
  the "everyone runs at 03:00 UTC" pathology revealed by the new
  simulation: pre-fix concentration was 66.9 % in a single hour;
  post-fix the chosen-hour distribution spreads across the full
  forecast window.
- **`mockGridFeed` per-region phase offsets.** Each region's
  synthetic curve is now phase-shifted by its canonical UTC offset
  so different regions exhibit different trough hours, more
  faithfully modelling real-grid per-region timing variance.

### Fixed

- `mockGridFeed` no longer produces negative carbon-intensity
  values. Previously, FR's `regionFloor` (60 g/kWh) plus the
  amplitude (220) at trough yielded a -160 g/kWh value; the
  returned curve now clamps at zero.
- `multiSourceGridFeed({ feeds: undefined, fallback })` no longer
  throws. The `feeds` parameter is optional; the router degenerates
  to the fallback feed when omitted.
- Dashboard version banner updated to track the released version.

### npm

- `@ebb-ai/core` 0.7.0 → 0.8.0
- `@ebb-ai/cli` 0.7.0 → 0.8.0
- `@ebb-ai/mcp` 0.7.1 → 0.8.0

### Tests

- Core TypeScript: 100 (aggregator + even-distribution simulation
  added).
- CLI: 21 (`ebb stats` paths covered).
- MCP server: 8 (unchanged).
- Python parity: 75 (unchanged).
- **Total: 204 passing tests** across all packages.

## [0.5.0] — 2026-05-13

**Theme:** "Control and reliability." Answers the four product
questions raised in review: how to make sure the user gives a clear
request, what form the result takes, what to do if the user changes
their mind, and how to mitigate the operational failure modes
(rate-limits, concurrent ticks, secrets in receipts).

### Added — control surface

- **`cancel_task` (MCP) + `Scheduler.cancelTask` (TS) + `Scheduler.cancel_task` (Python).**
  Idempotent cancellation. If the task is queued/scheduled, status
  transitions to `cancelled`. Already-terminal tasks return
  unchanged. Throws only on unknown task id.
- **`expedite_task` (MCP) + `Scheduler.expediteTask` + `Scheduler.expedite_task` (Python).**
  Dispatch a queued provider-call task immediately, bypassing its
  carbon window. Receipt records `intensitySource: "expedited"` to
  preserve the audit trail's honesty.
- **`update_deadline` (MCP) + `Scheduler.updateDeadline` + `Scheduler.update_deadline` (Python).**
  Re-score and reschedule a queued task against a new deadline.
  Throws if the task is already running or in a terminal state.
- **`retry_task` (MCP) + `Scheduler.retryTask` + `Scheduler.retry_task` (Python).**
  Re-dispatch a `failed` task. Receipt overwrites the previous.

### Added — task-clarity layer

- **`schedule_task` `dry_run: true` (MCP) + `Scheduler.previewProviderCall` (TS).**
  Returns the planned dispatch — chosen window, estimated carbon,
  band, batch eligibility — **without** persisting anything. Useful
  for confirmation flows before the agent commits to schedule a
  task.
- **Prompt validation.** `schedule_task` rejects empty / whitespace
  prompts at the boundary instead of dispatching garbage hours later.

### Added — result delivery

- **`output_path` field on `ProviderCallSpec`.** When set, the
  dispatcher writes `{ taskId, result, receipt }` as JSON to that
  path on success. Useful for inbox patterns and file-watchers.
- **`prompt` on `CarbonReceipt`.** The receipt now retains the
  prompt (redacted by default — see below) so the audit ledger is
  complete.
- **`totalTokens` on `CarbonReceipt`.** Total token count reported
  by the provider, when available.

### Added — failure-mode mitigation

- **Retry with exponential backoff.** Provider-adapter dispatches
  retry 3 times at 1 s / 4 s / 16 s on transient errors (429
  rate-limit, 5xx, network errors). Non-retryable errors (4xx
  other than 429) fail fast.
- **Row-level claim in `tick`.** Two concurrent `ebb tick` processes
  pointing at the same SQLite file no longer race-dispatch the same
  task — only the process whose `UPDATE tasks SET status='running'
  WHERE task_id=? AND status='scheduled'` changed exactly one row
  owns the dispatch. Concurrency test verified deterministic at
  10/10 reruns.
- **Receipt redaction.** `redactInReceipt` field on
  `ProviderCallSpec` controls regex redaction of secrets in the
  stored prompt. Omitted = default patterns (API-key shapes,
  bearer tokens). `[]` = no redaction. The dispatched call uses the
  original prompt; only the receipt is redacted.

### Added — Linux daemonization (was templates-only in v0.4)

- **Real systemd `.service` + `.timer` generation** in
  `@ebb-ai/cli` (`platform/linux.ts`). `ebb install --laptop`
  writes `~/.config/systemd/user/ebb-tick.service` and
  `ebb-tick.timer` plus the laptop-wake helper script; emits the
  exact `systemctl --user daemon-reload && systemctl --user enable
  --now ebb-tick.timer` next-step line.
- **`rtcwake` wake-event support** on Linux mirroring the macOS
  `pmset schedule wake` path. `ebb register-wake <task-id>` is
  now cross-platform.

### Added — Python parity

- **`Scheduler.tick(adapters)`** Python — drains due provider-call
  tasks via the matching adapter, identical semantics to TS.
- **`Scheduler.cancel_task / expedite_task / update_deadline / retry_task`** Python.
- **`ProviderCallSpec`, `TickResult`, `TickResultEntry`** dataclasses
  in `ebb_ai.types`.
- **Row-level claim** in the Python `_TaskStore` matches TS.
- **`body_json` column migration** in the Python SQLite store
  matches TS.

### Changed

- `@ebb-ai/core` 0.4.0 → **0.5.0**.
- `@ebb-ai/mcp` 0.4.0 → **0.5.0**.
- `@ebb-ai/cli` 0.4.0 → **0.5.0**.
- `ebb-ai` (Python) 0.3.0 → **0.5.0** (skips 0.4 to align).
- MCP server now exposes **8 tools** (was 4): the four v0.3
  tools plus `cancel_task`, `expedite_task`, `update_deadline`,
  `retry_task`.
- `TaskStatus` union gains `"cancelled"`. `IntensitySource` gains
  `"expedited"`.

### Tests

- TS core: **65 passed** (was 48; +17 for v0.5 — preview,
  redact, output_path, retry/backoff, cancel/expedite/update/retry,
  row-level claim).
- MCP server: **8 passed** (unchanged at the protocol-stub level;
  the new tools' wire shape is covered by the underlying scheduler
  tests).
- `@ebb-ai/cli`: **21 passed** (was 13; +8 for Linux platform).
- Python: **75 passed** (was 56; +19 for v0.5 tick / cancel /
  expedite / update / retry / concurrency).
- **Total across the project: 169 passing.**

### Known limitations (planned for v0.6)

- Single-writer SQLite holds. WAL multi-writer is queued.
- Lenient deadline parser ("tomorrow 8am") not yet shipped; only
  ISO-8601 datetimes with timezone offset are accepted.
- Stuck-running detection is documented but not yet auto-recoverable;
  tasks stuck in `running > 1h` are reported but not auto-failed.
- Webhook delivery (`output: { webhook: "..." }`) deferred — file
  output and pull-by-id remain the v0.5 delivery modes.
- Python `pyebb` CLI deferred — operators use the TS `ebb` CLI.

## [0.4.0] — 2026-05-12

### Added
- **`@ebb-ai/cli`** — new package shipping the `ebb` binary. Five
  subcommands: `tick`, `install`, `queue list`, `receipts list`,
  `register-wake`. Cross-platform shell entrypoint for the v0.4
  always-on story.
- **`ebb tick`** — one-shot or `--daemon` mode. Opens the SQLite
  ledger, finds tasks whose `scheduled_for` has elapsed, dispatches
  via Anthropic/OpenAI adapters, writes the receipt. This closes the
  v0.3 gap where deferred tasks died with the MCP host process.
- **`ebb install --laptop | --server`** — macOS launchd plist
  generator. `--laptop` additionally drops a `laptop-wake.sh` helper
  that registers `pmset schedule wake` events 30s before each
  scheduled task. `--server` skips the wake step.
- **`ebb register-wake <task-id>`** — schedules a macOS wake event
  via `pmset` for a specific task. `--dry-run` prints the exact
  command without running it. Sudoers entry required for non-root
  invocation; the command shape is printed every time so it can be
  pre-authorized.
- **`@ebb-ai/core` v0.4:**
  - New `Scheduler.enqueueProviderCall(spec, opts)` method — persists
    a JSON-serializable provider-call task body. Closures still work
    via `defer()` but are still in-process-only; provider-calls
    survive restart.
  - New `Scheduler.tick(adapters)` method — drains due tasks
    persistently. Returns `{ inspected, dispatched, failed }`.
  - New types `ProviderCallSpec`, `TickResult`, `TickResultEntry`.
  - SQLite schema migration: added `body_json` column via idempotent
    `ALTER TABLE` so v0.3 DB files are picked up without manual
    intervention.
- **Platform abstractions** — `packages/cli/src/platform/macos.ts`
  ships `caffeinateWhilePending`, `pmsetScheduleWake`,
  `pmsetCommand`, `formatPmsetDate`, `launchdPlist`. `linux.ts` and
  `windows.ts` ship template generators (systemd / schtasks) as
  stubs; full Linux + Windows runtimes land in v0.5.
- **Five new example folders** — `examples/cline/`,
  `examples/continue/`, `examples/zed/`, `examples/windsurf/`,
  `examples/pi/`. Each ships a README + the host's native MCP-config
  shape (`mcp_settings.json` / `config.yaml` / native
  `context_servers` block / `mcp_config.json` / AGENTS.md skill
  stanza). Brings supported MCP-host count from 5 → 10.

### Fixed
- TypeScript SQLite store crashed at runtime with
  `ERR_AMBIGUOUS_MODULE_SYNTAX` because the `better-sqlite3` loader
  used CJS-style `require()` inside an ESM emit. Replaced with
  `import { createRequire } from "node:module"; const requireFn =
  createRequire(import.meta.url);`. Vitest tests passed (vite
  polyfills `require`); the production `dist/` binary did not until
  this fix.
- Wrong dashboard pnpm filter in `README.md` and `QUICKSTART.md`:
  `pnpm --filter ebb-dashboard dev` corrected to `pnpm --filter
  @ebb-ai/dashboard dev`.

### Changed
- `@ebb-ai/core` 0.3.0 → **0.4.0**.
- `@ebb-ai/mcp` 0.3.0 → **0.4.0**.
- `@ebb-ai/cli` initial release at **0.4.0**.
- Python `ebb_ai` stays at 0.3.0 in this drop; Python parity for the
  CLI and `tick()` method lands in v0.5 (see roadmap).

### Tests
- TypeScript core: **48 passed** (was 41; +7 for the tick / persisted
  provider-call path).
- MCP server: **8 passed** (unchanged from v0.3).
- CLI: **13 passed** (new package: 8 platform-macos snapshots, 4
  install dry-run / template, 1 tick env handling).
- Python: **56 passed** (unchanged in v0.4 per scope; v0.5 brings
  Python `tick` parity).
- Total across the project: **125 passing**.

### Known limitations (planned for v0.5)
- Linux + Windows install paths only emit a template; no live
  daemonization. Use the printed systemd unit / schtasks command
  as a starting point.
- `pmset schedule wake` requires sudo per call. Users must add a
  sudoers entry for the `ebb` binary or run `ebb register-wake`
  manually.
- Closure-based `defer()` tasks are still in-process only. v0.4
  intentionally only persists `provider_call` task bodies.
- Python port does not yet have a `tick()` method or a `pyebb` CLI.

## [0.3.0] — 2026-05-12

### Added
- **`recommend_window` — planning endpoint.** New MCP tool +
  `recommendWindow()` (TS) / `recommend_window()` (Python) library
  functions. Returns the optimal execution time for a task **without**
  committing to schedule it. Output includes the chosen window's
  intensity, carbon estimate, percent savings vs. running now, batch
  eligibility, three alternative windows, and a one-line
  human-readable reasoning string. Pure read-only — does not touch
  the queue.
- **Cursor example.** `examples/cursor/` with `mcp.json` stanza and
  install README. Cursor ≥ 0.45 speaks MCP natively.
- **Claude Desktop example.** `examples/claude-desktop/` with config
  template and troubleshooting guide.
- **`QUICKSTART.md`** — four steps, five minutes. Linked from README.
- **Copy buttons** on every code block on the marketing site
  (`apps/site/copy-buttons.js`).
- **Launch hero** in `README.md`: a single-glance `recommend_window`
  example showing the canonical JSON output.

### Changed
- `@ebb-ai/core` 0.2.0 → **0.3.0**, `@ebb-ai/mcp` 0.2.0 → **0.3.0**,
  `ebb-ai` (Python) 0.2.0 → **0.3.0**.
- MCP server now exposes **4 tools** (was 3): `get_grid_forecast`,
  `recommend_window`, `schedule_task`, `check_queue_status`.
- Site `architecture.html` system diagram: text overflow fix on
  SCHEDULER CORE and MCP SERVER boxes; updated tool count.
- Site `index.html` "Why it matters" section: corrected Batch API
  framing. **Batch is not faster** — it trades latency (24h SLA) for
  the 50% discount. Carbon and dollars are the primary pitch; latency
  is a third-tier side effect. Same correction applied in `README.md`
  and `packages/core-py/README.md`.
- Inline `<code>` now wraps long file-paths via `word-break:
  break-all` (was overflowing `.int-card` content).

### Tests
- TypeScript core: **41 passed** (was 26; +15 for `recommend`).
- MCP server: **8 passed** (was 6; +2 for `recommend_window` over the
  real MCP protocol).
- Python: **56 passed** (was 41; +15 for `recommend`).
- Total across the project: **105 passing**.

## [0.2.0] — 2026-05-12

### Added
- **Provider adapters.** `AnthropicAdapter` and `OpenAIAdapter` in
  `@ebb-ai/core/providers`. Each adapter exposes `dispatch()` for
  sync calls and `dispatchBatch()` for the vendor Batch API (50%
  discount, 24h SLA). SDKs are peer dependencies and imported lazily,
  so missing-SDK callers still get a clear error rather than a
  module-load crash.
- **SQLite-backed durable queue.** Opt-in via `new Scheduler({ dbPath })`.
  Every state transition writes through to an on-disk audit ledger;
  records survive process restart and can be reloaded with
  `Scheduler.listPersistedTasks()` / `Scheduler.loadPersistedTask()`.
- **Python port.** `packages/core-py/` ships a complete Python 3.11+
  package (`ebb_ai`) with `asyncio` scheduler, `aiosqlite` persistence
  from day one, and `AnthropicAdapter` + `OpenAIAdapter` mirrors. 41/41
  pytest cases passing.
- **Dashboard MVP.** `apps/dashboard/` is a Next.js 15 app router
  application with four pages (Home, Forecast, Plan, Queue), 6 grid
  regions, recharts visualizations, and live `/api/grid/[region]` +
  `/api/queue` endpoints. Mock fallback when no Electricity Maps key
  is set.
- **Site expansion.** `apps/site/` now ships `architecture.html` (SVG
  diagram + 8-step data flow), `roadmap.html` (v0.1 → v1.0 with
  versioned status pills), and `docs.html` (categorized GitHub-linked
  index).
- Real MCP-protocol smoke test using `InMemoryTransport`.
- `CHANGELOG.md`, `CONTRIBUTING.md`, `CODE_OF_CONDUCT.md`, `CODEOWNERS`.
- `docs/spec/01-priority-and-deadline-fields.md` — draft proposal for
  upstream MCP spec engagement.

### Changed
- `@ebb-ai/core` bumped to **0.2.0**, `@ebb-ai/mcp` bumped to **0.2.0**.
- Public surface expanded with `AnthropicAdapter`, `OpenAIAdapter`,
  `TaskStore`, and the supporting types `BatchHandle`,
  `DispatchOptions`, `DispatchResult`, `ProviderAdapter`,
  `TaskStoreOptions`.

### Known limitations (planned for v0.3)
- Scheduler does not yet auto-route between sync and Batch paths based
  on deadline distance — adapters expose both, but the v0.2 scheduler
  still treats the task body as opaque. Wiring the routing decision
  into the scheduler is the lead v0.3 item.
- WattTime marginal-emissions feed is still pending.
- Multi-writer (multiple schedulers pointed at one DB) requires WAL
  mode; v0.2 SQLite store assumes single writer.

## [0.1.0] — 2026-05-12

### Added
- `@ebb-ai/core` — TypeScript core library: `Scheduler` class,
  `defer()` function, `pickBestWindow` helper.
- `@ebb-ai/mcp` — Model Context Protocol server exposing
  `get_grid_forecast`, `schedule_task`, and `check_queue_status`
  tools over stdio.
- Mock and Electricity Maps grid feeds with automatic fallback when
  no API key is configured.
- Carbon budget enforcement: `carbonBudgetG` in `DeferOptions` is now
  honored; tasks fail with `CarbonBudgetExceededError` when no
  in-deadline window meets the budget.
- ISO-8601 deadline validation: invalid or past deadlines throw
  `InvalidDeadlineError` at the scheduler boundary and the MCP
  request validator.
- Reference integrations for Claude Desktop, Claude Code, OpenClaw,
  and OpenAI Codex CLI in `examples/`.
- Static landing site under `apps/site/` (no JS, no framework).
- 24-week project plan in `ROADMAP.md`.

### Fixed
- (Pre-v0.1.0 engineering review.) Carbon budget was previously
  captured but unenforced; `schedule_task` accepted unparseable and
  past deadlines silently; Electricity Maps fetch had no timeout;
  README and landing page used a non-existent region code
  `"us-east"`; Claude Code install flow documented a config path the
  client does not read. All addressed before v0.1 ship.

### Known limitations (planned for v0.2)
- The MCP server schedules dispatch time but does not invoke the LLM
  itself. The agent calling the tool is expected to execute the
  prompt when the window arrives.
- Queue is in-memory; restarts lose state. SQLite-backed durable
  queue is planned for v0.2.
- No provider adapters yet for Anthropic Message Batches or OpenAI
  Batches APIs. Direct Batch routing lands in v0.2.
- Python port (`ebb-ai` PyPI) is a placeholder. v0.2.

[Unreleased]: https://github.com/tidegap/tidegap/compare/v0.19.0...HEAD
[0.19.0]: https://github.com/tidegap/tidegap/compare/v0.18.0...v0.19.0
[0.18.0]: https://github.com/tidegap/tidegap/compare/v0.17.0...v0.18.0
[0.17.0]: https://github.com/Vitalini/ebb-ai/compare/v0.16.1...v0.17.0
[0.16.1]: https://github.com/Vitalini/ebb-ai/compare/v0.16.0...v0.16.1
[0.16.0]: https://github.com/Vitalini/ebb-ai/compare/v0.15.1...v0.16.0
[0.15.1]: https://github.com/Vitalini/ebb-ai/compare/v0.15.0...v0.15.1
[0.15.0]: https://github.com/Vitalini/ebb-ai/compare/v0.14.1...v0.15.0
[0.14.1]: https://github.com/Vitalini/ebb-ai/compare/v0.14.0...v0.14.1
[0.14.0]: https://github.com/Vitalini/ebb-ai/compare/v0.13.0...v0.14.0
[0.13.0]: https://github.com/Vitalini/ebb-ai/compare/v0.12.0...v0.13.0
[0.12.0]: https://github.com/Vitalini/ebb-ai/compare/v0.11.0...v0.12.0
[0.11.0]: https://github.com/Vitalini/ebb-ai/compare/v0.10.0...v0.11.0
[0.10.0]: https://github.com/Vitalini/ebb-ai/compare/v0.9.0...v0.10.0
[0.9.0]: https://github.com/Vitalini/ebb-ai/compare/v0.8.3...v0.9.0
[0.8.3]: https://github.com/Vitalini/ebb-ai/compare/v0.8.2...v0.8.3
[0.8.2]: https://github.com/Vitalini/ebb-ai/compare/v0.8.1...v0.8.2
[0.8.1]: https://github.com/Vitalini/ebb-ai/compare/v0.8.0...v0.8.1
[0.8.0]: https://github.com/Vitalini/ebb-ai/compare/v0.7.1...v0.8.0
[0.5.0]: https://github.com/Vitalini/ebb-ai/compare/v0.4.0...v0.5.0
[0.4.0]: https://github.com/Vitalini/ebb-ai/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/Vitalini/ebb-ai/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/Vitalini/ebb-ai/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/Vitalini/ebb-ai/releases/tag/v0.1.0
