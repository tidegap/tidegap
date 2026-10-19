# `tidegap ui` client API

The contract the browser extension and the Mac app code against. Both are clients of the local `tidegap ui` server. They never read `queue.db`. Source: `packages/cli/src/ui/` (`server.ts`, `api.ts`, `clients.ts`, `discovery.ts`, `summary.ts`). Tests: `packages/cli/test/ui-*.test.ts`.

Available from CLI 0.19.0. A 0.18 server answers 401 to every client token, because it checks the bearer before it routes. Readiness, `later_options`, `POST /api/tasks/<id>/postpone` and the client-token 403 on task creation arrive with the coherence batch (the release after 0.19.0); a 0.19.0 server lacks them, so treat a missing `readiness` or `later_options` as "not supported" and hide the line or the Later menu.

## Finding the server

- Default address: `http://127.0.0.1:47821/`. `tidegap ui` tries port 47821 first. When the port is taken, it serves on a free port and prints a warning; clients configured for 47821 do not find it. `--port <n>` sets a port and does not fall back (`--port 0` takes any free port).
- Discovery file: while the server runs, `~/.tidegap/ui.json` (mode 0600) holds:

  ```json
  { "version": 1, "pid": 4242, "port": 47821, "url": "http://127.0.0.1:47821/", "started_at": "2026-10-17T09:00:00.000Z", "cli_version": "0.19.0" }
  ```

  It holds no token. The server removes it on a clean stop, only when the `pid` is its own. A file left by a crash names a dead pid: check the pid before you trust the port.
- The extension cannot read files. It uses port 47821, with an override in its options. The Mac app reads `ui.json`.

## Authentication

Every `/api/*` request, the event stream included, sends `Authorization: Bearer <token>`. No cookie is set or read.

| Token | Where it comes from | Lifetime |
|---|---|---|
| page | random per run, in the link that `tidegap ui` prints (`#token=…`) | until the server stops |
| client (`tgc_…`) | `tidegap clients add --name <n> --kind extension\|macos [--json]`, or "Connect an app" in the page | until revoked |

- `tidegap clients add --json` prints `{"client_id": "…", "token": "tgc_…"}`. The token is shown once.
- The registry `~/.tidegap/ui-clients.json` (mode 0600) stores `{id, name, kind, token_sha256, created_at}` per client, never the token. The server re-reads it when it changes, so `add` and `revoke` apply without a restart.
- `tidegap clients list` shows ids, kinds and names. `tidegap clients revoke <id>` removes a client; its next request gets 401.

### Origin and scope matrix

| `Origin` header | page token | client token | no or bad token |
|---|---|---|---|
| absent | all routes | all routes except the page-only and agent-facing ones (403); `/api/integrations*` with a `macos` client token only (403 for an `extension` one) | 401 |
| `http://<loopback>:<this port>` | all routes | all routes except the page-only and agent-facing ones (403); `/api/integrations*` with a `macos` client token only | 401 |
| `chrome-extension://`, `moz-extension://`, `safari-web-extension://` + an id of letters, digits and `-` | 403 | `/api/*` except the page-only, agent-facing and integrations ones (403) | 401 |
| anything else, `null` included | 403 | 403 | 403 |

- Page-only: `/api/clients*` and `POST /api/tasks/<id>/reply`. Agent-facing: `POST /api/tasks`. A client token never creates a task (owner rule: only agents create tasks).
- Page and Mac app: `/api/integrations*`. The page token, or a client token of kind `macos`, and never from an extension origin, whatever the token. The rule checks the origin, so a `macos` token pasted into an extension still gets 403.
- `<loopback>` is `127.0.0.1`, `localhost` or `[::1]`. The `Host` header must name one of them, with no port or this server's port; anything else gets 403.
- An extension origin with a path, a port or an empty id is "anything else".
- An extension origin gets 403 on every static file (`/`, `/app.js`, …).
- The server sends no CORS headers. An MV3 extension with `host_permissions` for `http://127.0.0.1/*` fetches without CORS in Chrome and Firefox.

## Routes for clients

### `GET /api/summary[?since=<iso>]`

One answer for a compact client.

```json
{
  "generated_at": "2026-10-17T10:00:00.000Z",
  "region": "FR",
  "counts": { "queued": 2, "scheduled": 1, "running": 1, "submitted": 1 },
  "active": 5,
  "unread": 1,
  "next_run": { "task_id": "…", "title": "…", "scheduled_for": "2026-10-17T13:00:00.000Z" },
  "clean_window": { "start": "2026-10-17T14:00:00.000Z", "end": "2026-10-17T17:00:00.000Z", "band": "clean", "g": 104, "now": false, "fallback": false },
  "forecast_ok": true,
  "finished": [{ "task_id": "…", "title": "…", "status": "completed", "completed_at": "2026-10-17T09:58:00.000Z" }],
  "cursor": "2026-10-17T09:58:00.000Z",
  "readiness": { "ready": false, "line": "Tasks will not run: no tick daemon. Run `tidegap install`.", "problems": [ … ], … },
  "limits": { "line": "Claude 5h: 72%, resets 16:30", "status": "ok", "window": "five_hour", "pct": 72, "resets_at": "2026-10-17T14:30:00.000Z" }
}
```

- `readiness` is the readiness object (see "Readiness" below), the same as in `/api/status`.
- `limits` is the Claude Code limit state in one line (see "Limits" below). A 0.19 server has no `limits`; `limits: null` means the read failed. Show `line` under the header when it is a non-empty string; show nothing otherwise.

- `active` is the sum of `counts`. `unread` counts completed or failed tasks nobody has opened.
- `next_run` is the queued or scheduled task with the earliest `scheduled_for`, or `null`.
- `clean_window` comes from a 24-hour forecast for the server's default region, cached for 10 minutes and shared with `/api/forecast`. It is the first run of consecutive `very_clean` or `clean` hours that ends after now, including the hours of that run that already passed. `band` is `very_clean` only when every hour is very clean. `g` is the lowest intensity in the window (gCO2e/kWh). `now` is true when the window contains now.
- With no clean hour, `clean_window` is the single cleanest hour after now, with `fallback: true`. A fallback window feeds the badge and the menu header, never a "clean window" notification.
- A forecast failure gives `clean_window: null` and `forecast_ok: false`, with status 200.
- `finished` is present only when `since` is given: completed or failed tasks with `completed_at` after `since`, newest first, at most 20. When more than 20 finished after `since`, it lists the oldest of them: at most 20, cut so that tasks with the same `completed_at` stay in one answer (more than 20 only when more than 20 share the first instant). The next poll with the new cursor lists the rest.
- `cursor`: store it and send it back as `since` next time. It is the server's clock, so client clock skew does not matter. Without `since` it is `generated_at`. With `since` it is the newest `completed_at` listed, or `since` itself when nothing finished.
- A `since` that is not an ISO-8601 instant gets 400.

Polling `summary` with the stored cursor gives each finished task once (AE3). Task titles are untrusted text (they come from prompts): render them as text only and truncate them in notifications.

### Readiness

"Will queued tasks run?" One object, the same in `/api/summary`, `/api/status` and `tidegap status --json`; the MCP `schedule_task` reply ends with its `line` (or `Runs at <time> local.` when ready). Source: `packages/core-ts/src/readiness.ts`.

```json
{
  "ready": false,
  "problems": [
    { "code": "no_daemon", "message": "Tasks will not run: no tick daemon.", "fix": "tidegap install" },
    { "code": "no_runner", "message": "Tasks will not run: 2 openai tasks have no runner.", "fix": "add OPENAI_API_KEY to ~/.config/tidegap/env", "provider": "openai", "tasks": 2 }
  ],
  "line": "Tasks will not run: no tick daemon. Run `tidegap install`.",
  "notes": [],
  "ticker": { "daemon": "not_installed", "last_tick_at": null, "interval_s": 60, "recent": false },
  "runners": { "source": "snapshot", "providers": ["claude-code", "anthropic"], "unknown": [] }
}
```

- `ready` is true when `problems` is empty. Show nothing extra when ready.
- `line` is the one sentence to show when not ready (the page banner, the Mac menu line, the extension popup line). It is `null` when ready.
- `problems[].code` is one of `no_daemon`, `daemon_not_loaded`, `daemon_stale`, `no_runner`, always in that order. `fix` is a command when it starts with `tidegap `, else one instruction. `provider` and `tasks` appear on `no_runner` only.
- `notes` holds lines that are not problems, for example `first tick within 5 minutes` right after an install.
- `ticker.daemon` is `loaded`, `installed` (unit file present, load state not probed), `installed_not_loaded`, `not_installed` or `unknown`. `recent` is true when `last_tick_at` is at most two intervals old.
- `runners.source` is `snapshot` (the last tick's adapters), `probe` (the server's own lookup) or `unknown` (no runner fact; no `no_runner` problem is raised).
- Every field is untrusted for markup: render as text.

### Limits

The `limits` object of `/api/summary`: the Claude Code subscription limit of this machine's login, formatted once on the server so every client shows the same text. Source: `packages/cli/src/usage/document.ts`.

- `line`: `Claude 5h: 72%, resets 16:30` for the current window with the highest percent (the reset as `Mon 16:30` when it is not today, in the server's local time, which is the client's on the same machine). A last good value served after a failed read, or older than the server's 10-minute reuse time, ends with `(as of HH:MM)`. When every window has reset since the reading: `Claude: limits reset since last seen`, with `window`, `pct` and `resets_at` null. With no limit state: `Claude: limits unavailable (<cause>)`, where cause is `not_logged_in`, `api_key`, `token_expired`, `keychain_unavailable`, `rate_limited`, `network` or `api_error`. With limit reads off (`TIDEGAP_USAGE=off`), or with no reading ever (cause `no_data`, for example no status line hook): `""`.
- `status`: `ok`, `unavailable` or `disabled`.
- `window`, `pct`, `resets_at`: the window the line names (`five_hour` or `seven_day`), its percent used (can pass 100) and its reset (ISO-8601); `null` when the line names none.
- The server waits at most 2 seconds for the limit read on this route (Keychain and usage API together). Past that it answers with the reading it last finished, or `limits: null` when it has none yet; the read goes on in the background, and the next poll gets its result. Concurrent polls share one read.

When `limits` has a reset, the `after_limit_reset` item of `later_options` (below) is available on Claude Code subscription tasks (providers `claude-code` and `anthropic`), with the reset plus 5 minutes as its start. Otherwise it keeps the "needs the reset time" fallback.

### `GET /api/usage[?spend=1]`

The `usage/v1` document: the same as `tidegap usage --json` and MCP `tidegap_usage`. Page or client token. `POST` gets 405.

```json
{
  "schema": "usage/v1",
  "generated_at": "2026-10-17T12:00:00.000Z",
  "claude": {
    "status": "ok",
    "source": "statusline",
    "fetched_at": "2026-10-17T11:58:00.000Z",
    "age_s": 120,
    "stale": false,
    "five_hour": { "pct": 72, "resets_at": "2026-10-17T14:30:00.000Z" },
    "seven_day": { "pct": 40, "resets_at": "2026-10-20T07:00:00.000Z" },
    "scoped": [{ "model": "Fable", "pct": 55, "resets_at": "2026-10-20T07:00:00.000Z" }]
  },
  "codex": {
    "status": "ok",
    "as_of": "2026-10-17T11:40:00.000Z",
    "plan_type": "plus",
    "five_hour": { "pct": 33, "resets_at": "2026-10-17T15:00:00.000Z", "window_minutes": 300 },
    "seven_day": { "pct": 43, "resets_at": "2026-10-21T10:00:00.000Z", "window_minutes": 10080 }
  },
  "target_reset": { "at": "2026-10-17T14:30:00.000Z", "window": "five_hour", "exhausted": false },
  "line": "Claude 5h: 72%, resets 16:30"
}
```

- `claude.status`: `ok`, `unavailable` (with `error: {cause, message}`) or `disabled`. `source`: `statusline` (Claude Code's status line input, through `tidegap usage hook`), `api` (a live usage API read, only with `TIDEGAP_USAGE_OAUTH=1`) or `cache` (an earlier API read). `stale: true` marks a last good value; `error` then names why there is no newer one. `scoped` lists per-model weekly windows (usage API only).
- `codex` comes from the newest Codex session log with a limit reading (`$CODEX_HOME` or `~/.codex`, `sessions/` only). `status`: `ok`, `not_found` (no Codex logs) or `no_limits`. `as_of` is the time of that reading, which can be old. A window that reset since then has `pct: null` and `state: "reset_since_seen"`.
- `target_reset` is the time "after limit reset" waits for; absent with no limit state.
- `?spend=1` (or `?spend=true`) adds `claude_spend` and `codex.sessions`. The server then scans the Claude Code logs of the current 5-hour window, which can take a few seconds; ask for it on a user's click, never on a poll. Concurrent requests of the same kind share one read, so repeated clicks start one scan. The scan yields between chunks, so `/api/summary` and the event stream keep answering during it.
- `codex.sessions` (with spend only): the Codex sessions active in the current 5-hour window, newest first, at most five: `{ "session_id": "…", "last_activity": "<ISO-8601>", "tokens": { "input", "cached_input", "output", "reasoning_output", "total" } }`.

```json
"claude_spend": {
  "window": { "start": "2026-10-17T09:30:00.000Z", "basis": "five_hour", "label": "current 5 h window" },
  "total": { "input": 1200, "output": 3400, "cache_write": 50000, "cache_read": 900000, "cost_usd": 1.23 },
  "by_model": [{ "model": "claude-sonnet-5", "input": 1200, "output": 3400, "cache_write": 50000, "cache_read": 900000, "cost_usd": 1.23 }],
  "sessions": [{ "session_id": "…", "project": "repo", "last_activity": "2026-10-17T11:50:00.000Z", "input": 1200, "output": 3400, "cache_write": 50000, "cache_read": 900000, "cost_usd": 1.23 }],
  "unpriced_models": [],
  "files_scanned": 12,
  "note": "API list-price estimate, not billed"
}
```

- `window.basis` is `five_hour` (the window of the 5-hour limit) or `trailing_5h` (the last 5 hours, when the limit is unknown).
- `sessions[].project` is the folder name of the session's working directory, not its path. No prompt, reply or tool text is in the document: the scan reads only types, timestamps, ids, model names and token counts.
- The scan has caps: 2,000 files, 4 GiB and 15 seconds, newest logs first. When one stops it, `truncated` is `files`, `bytes` or `time` and the totals miss the oldest logs; otherwise `truncated` is absent.
- `cost_usd` is an API list-price estimate (cache write 1.25x input for 5 minutes and 2x for 1 hour, cache read 0.1x), not what the subscription bills. `null` for a model with no price; such models are listed in `unpriced_models`. `sessions` are the five most recent.
- A read or scan failure gives 502 `usage unavailable`. Project and model names are untrusted text: render them as text only.

### `GET /api/status`

`readiness` (above) is part of this contract. The other fields (`daemon`, `db_path`, `default_region`, `last_tick_at`, `dispatcher`, `quota`) serve the page and can change with it.

### `GET /api/tasks[?status=<s>[,<s>…]&limit=<n>&unread=1&series=<id>&kind=<k>]`

The task list. Answer: 200 `{"last_tick_at": "<iso>"|null, "tasks": [<item>, …]}`.

- `status`: a comma list of `queued`, `scheduled`, `submitted`, `running`, `completed`, `failed`, `cancelled`. Absent = all. A client's queue view asks for `queued,scheduled,submitted,running`.
- `limit`: 1 to 1000, keeps the newest by enqueue time. `unread=1`: finished tasks nobody opened. `series`: one series, in occurrence order. `kind`: `absolute` or `quota_reset`. An unknown value gets 400.

An item:

```json
{
  "task_id": "…", "title": "…"|null, "display_title": "…", "status": "scheduled",
  "origin_host": "mcp"|null, "deadline": "<iso>"|null, "deadline_kind": "absolute", "quota_provider": null,
  "scheduled_for": "<iso>"|null, "not_before": "<iso>"|null, "completed_at": null, "read_at": null,
  "region": "FR", "series_id": null, "repeat": "none", "provider": "anthropic", "model": "…",
  "parent_task_id": null, "estimated_carbon_g": 1.2, "carbon_g": 1.2, "intensity_g_per_kwh": null,
  "actions": { "cancel": true, "stopSeries": false, "reschedule": true, "runNow": true, "later": true, "reply": false, "markRead": false },
  "later_options": [
    { "preset": "1h", "label": "One hour later", "not_before": "2026-10-17T15:00:00.000Z", "available": true },
    { "preset": "tonight", "label": "Tonight", "not_before": "2026-10-17T19:00:00.000Z", "available": true },
    { "preset": "tomorrow_morning", "label": "Tomorrow morning", "not_before": "2026-10-18T06:00:00.000Z", "available": true },
    { "preset": "after_limit_reset", "label": "After limit reset", "not_before": null, "available": false, "reason": "needs the reset time" }
  ]
}
```

- `actions` says which buttons to enable. `later` follows the same rule as `reschedule`: a queued or scheduled provider-call task.
- `later_options` lists the four presets in this order, for every task. `not_before` is the earliest start the preset would write (ISO-8601; show it in local time), `null` when `available` is false. `reason` (only when unavailable) is one line to show as the disabled item's hint, for example `already planned for 23:00`, `less than one hour of tonight is left`, `needs the reset time`, or the task's state.
- `not_before` on the item is the stored earliest start, `null` when none.

### `POST /api/tasks/<id>/postpone`

"Later". `Content-Type: application/json`, strict keys, exactly one of `preset`, `until`, `delay_minutes`:

| Key | Rule |
|---|---|
| `preset` | `1h`, `tonight`, `tomorrow_morning` or `after_limit_reset` |
| `until` | ISO-8601 instant: an exact time ("Pick a time") |
| `delay_minutes` | integer 1 to 10080: not before the planned start plus this |
| `reset_at` | ISO-8601 instant in the future; only with `preset: "after_limit_reset"`. Wins over the server's own limit reading and is remembered for later tasks |

Rules (KTD4):

- A task never moves earlier. The planned start is `scheduled_for` if in the future, else a future `not_before`, else now. A target at or before it gets 409 with `already planned for <HH:MM>`.
- `1h` and `delay_minutes` count from the planned start, not from now. They keep a later deadline.
- `tonight` is 22:00 to 06:00 local (after midnight: now to 06:00), unavailable with less than one hour left. `tomorrow_morning` is 09:00 to 12:00 local tomorrow. Both set the deadline to the window end.
- `after_limit_reset` starts 5 minutes after the reset: `reset_at`, else the server's Claude limit reading, else a still-future `reset_at` given before. With none: 409 `needs the reset time`.
- `until` pins the exact time. A `quota_reset` task becomes `absolute`.

Answer: 200 with the task's list item (above). 404 for an unknown id, 400 for a bad body, 409 with the refusal line when the core refuses (not movable, earlier than planned, no reset time, the row changed meanwhile).

### `POST /api/tasks/<id>/cancel`

Body `{}` or `{"series": true}` (also end the repeating series). Answer: 200 with the list item; cancelling a finished task returns it unchanged. 409 when the core refuses.

### `POST /api/tasks/<id>/run-now`

No body. Marks a queued or scheduled provider-call task due for the next tick (`actions.runNow`). The server never dispatches; the next tick runs it. Answer: 200 with the list item; 409 when the task cannot run now.

### `GET /api/events`

Server-sent events. `hello` on connect, then `tasks` with `{"ids": [...]}` when tasks change. Refetch the summary on `tasks`, and on `hello` after a reconnect. A stream opened with a client token ends when that token is revoked (the server checks it before each event and each keep-alive); the reconnect then gets 401.

### `GET /api/tasks/<id>`: `events[]`

The task detail carries `events`: the task's audit trail, the newest 50, oldest first. Every change of the task writes one event in the same transaction as the change.

```json
"events": [
  { "at": "<iso>", "kind": "created", "actor": "agent:mcp", "details": { "deadline": "<iso>", "provider": "anthropic", "model": "…" } },
  { "at": "<iso>", "kind": "expedited", "actor": "client:Mac menu",
    "details": { "from": { "scheduled_for": "<iso>", "not_before": "<iso>", "deadline": "<iso>" }, "to": { "scheduled_for": "<iso>", "not_before": null, "deadline": "<iso>" } } }
]
```

- `kind`: `created`, `rescheduled`, `postponed`, `expedited` (run now), `cancelled`, `dispatched`, `completed`, `failed`, `deferred`, `replied`. Ignore an unknown kind.
- `actor`: `page`, `client:<name>` (the client's registry name), `agent:<host>`, `cli`, `tick`, `telegram`, `openclaw` or `system`.
- `details` keys (snake_case, each optional): `from` / `to` (`scheduled_for`, `not_before`, `deadline`) for `rescheduled`, `postponed` and `expedited`; `preset`; `reason` (`deadline`, `retry`, `quota_sweep`, or a deferral message); `provider`, `model`; `error` (first line); `retry_at`; `batch_id`; `child_task_id` (on `replied`); `parent_task_id`; `series`.

The rest of the detail body is not part of this contract.

### Other routes

The page's other routes (`GET /api/tasks/<id>` apart from `events`, `GET /api/forecast`, `POST /api/tasks/<id>/reschedule`, `/read`, `/unread`, `GET /api/series/<id>`, `POST /api/dispatcher/start`) take a client token too. They are not part of this contract and can change with the page.

## Agent-facing routes

### `POST /api/tasks`

Creates a task. Agents create tasks (MCP `schedule_task`, `tidegap` CLI); this route stays for the page token, tests and scripts. **A client token gets 403.**

`Content-Type: application/json`, a body of at most 64 KiB, strict keys:

| Key | Required | Rule |
|---|---|---|
| `prompt` | yes | 1 to 32 000 characters, not blank |
| `deadline` | no | ISO-8601 instant in the future; default now + 24 h |
| `title` | no | at most 200 characters |
| `provider` | no | `anthropic` (default), `openai`, `gemini`, `ollama` |
| `model` | no | 1 to 200 characters; default `TIDEGAP_DEFAULT_MODEL` for Anthropic, else the provider's default model |

Answer: 201 with the task's list item. The new id goes to the event stream. The server schedules the task and never dispatches it; `tidegap tick` runs it.

## Routes for the page only

A client token gets 403 on these.

| Route | Body | Answer |
|---|---|---|
| `GET /api/clients` | none | 200 `{"clients": [{id, name, kind, created_at}]}` |
| `POST /api/clients` | `{"name": "…", "kind": "extension"\|"macos"}`; `kind` defaults to `extension` | 201 `{"client": {…}, "token": "tgc_…"}` |
| `POST /api/clients/<id>/revoke` | none | 200 `{"revoked": "<id>"}`; 404 for an unknown id |
| `POST /api/tasks/<id>/reply` | `{"text": "…", "deadline"?: "<iso>"}` | 201 with the child task's list item. Creates a task, so a client token gets 403 |

## Routes for the page and the Mac app

Settings → Integrations. The page token or a `macos` client token without an extension origin; every other caller gets 403 (see the matrix). The bot token is saved to `~/.config/tidegap/env` and never returned: a status shows its last 4 characters only. An error body is `{"error": "<one sentence>", "code": "<code>"}`; the sentence says what to do next.

| Route | Body | Answer |
|---|---|---|
| `GET /api/integrations` | none | 200 `{"telegram": TelegramStatus}` |
| `POST /api/integrations/telegram/token` | `{"token": "…"}` | 200 status; 400 bad format (`format`); 409 refused by Telegram (`refused`) or the bot has a webhook (`webhook`); 502 Telegram unreachable (`network`); 429 |
| `POST /api/integrations/telegram/pair` | none | 202 status with `pairing`; 200 with the running session when one is active; 409 no token (`no_token`) or refused; 429 |
| `POST /api/integrations/telegram/pair/cancel` | none | 200 status |
| `POST /api/integrations/telegram/test` | none | 200 `{"sent": true}`; 409 not paired (`not_paired`); 502 Telegram error; 429 |
| `POST /api/integrations/telegram/listener/start` | none | 200 status after a restart of the listener unit (unload, then load); 409 not paired or no unit on this platform (`manual`); 429 |
| `POST /api/integrations/telegram/disconnect` | `{"forget_token"?: boolean}` | 200 status. Removes the paired chat and stops the listener; `forget_token` also deletes the token lines from the env file |

`TelegramStatus`:

| Field | Meaning |
|---|---|
| `state` | `not_configured`, `token_saved`, `pairing`, `paired` or `error` |
| `token_hint` | last 4 characters of the saved token |
| `bot_username` | the bot's username from `getMe` (cached 10 minutes) |
| `pairing` | `{code, bot_username, link, expires_at}` while pairing; `link` is `https://t.me/<bot>?start=<code>` |
| `chat` | `{channel_id, label?}` of the paired chat |
| `listener` | paired only: `{state, message?}` with `state` `running`, `not_running`, `conflict`, `unauthorized` or `manual` (no listener unit, Windows) |
| `error` | the sentence for state `error` |

Rate limits per server: token 5 per minute, pair 3 per 10 minutes, test 1 per 10 s, listener start 3 per minute. Over the limit: 429 `{"error": "Wait N seconds and try again.", "retry_after_s": N}`. The MCP server has no tool for these routes: agents never handle the bot token.

## Errors

Every error body is `{"error": "<one line>"}`, never a stack or a path from a provider.

| Status | When |
|---|---|
| 400 | bad JSON, an unknown key, an invalid field, a body on a body-less route, a bad `since` |
| 401 | no token, an unknown token, a revoked token |
| 403 | a foreign `Host` or `Origin`; the page token from an extension origin; a client token on `/api/clients*`, `POST /api/tasks` or `POST /api/tasks/<id>/reply`; an `extension` client token, or any token from an extension origin, on `/api/integrations*`; a static file from an extension origin |
| 404 | unknown route or id |
| 405 | wrong method, for example `POST /api/summary` |
| 409 | the core refused the action (for example no window meets a carbon budget, or Later would run the task earlier) |
| 413 | body over 64 KiB |
| 415 | a body route without `Content-Type: application/json` |
| 429 | an integrations route over its rate limit, with `retry_after_s` |
| 500 | anything else, with a fixed message |

## Badge rule (KTD6)

Both clients use one priority order:

1. No token: `?`.
2. Server unreachable: `off`.
3. `active > 0`: the count, capped at `99+`.
4. `clean_window.now`: `now`.
5. A window later: time to its start (`45m`, `5h`). The Mac menu bar shows the start clock time instead (`14:00`).
6. No forecast: empty.

The tooltip or menu header carries the full line, for example `3 queued · clean 14:00-17:00 FR`.

Not ready: when `readiness.ready` is `false` (rules 3 to 6 only), the text gets a `!` in front (`!3`, `!now`, `!` alone when the text is empty), the extension badge turns amber, and the tooltip or menu shows `readiness.line` first. A server without `readiness` (0.19.0) never adds the `!`.

## Known risk: port squatting

Accepted for a single-user Mac (decision of 2026-10-17). While `tidegap ui` is down, any process that binds 127.0.0.1:47821 first receives the extension's bearer token on its next poll. That includes a process of another macOS account or a sandboxed app, neither of which can read `queue.db`. The token stays valid until revoked. Web pages stay blocked by the Host, Origin and token checks. If you suspect it, revoke the client (`tidegap clients revoke <id>`) and connect it again. The alternative, signed requests (a timestamped HMAC keyed by the token's SHA-256), was considered and not built.
