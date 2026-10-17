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
| absent | all routes | all routes except the page-only and agent-facing ones (403) | 401 |
| `http://<loopback>:<this port>` | all routes | all routes except the page-only and agent-facing ones (403) | 401 |
| `chrome-extension://`, `moz-extension://`, `safari-web-extension://` + an id of letters, digits and `-` | 403 | `/api/*` except the page-only and agent-facing ones (403) | 401 |
| anything else, `null` included | 403 | 403 | 403 |

- Page-only: `/api/clients*` and `POST /api/tasks/<id>/reply`. Agent-facing: `POST /api/tasks`. A client token never creates a task (owner rule: only agents create tasks).
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
  "readiness": { "ready": false, "line": "Tasks will not run: no tick daemon. Run `tidegap install`.", "problems": [ … ], … }
}
```

- `readiness` is the readiness object (see "Readiness" below), the same as in `/api/status`.

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

"Will queued tasks run?" One object, the same in `/api/summary`, `/api/status`, the MCP `schedule_task` reply and `tidegap status --json`. Source: `packages/core-ts/src/readiness.ts`.

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

### Other routes

The page's other routes (`GET /api/tasks/<id>`, `GET /api/forecast`, `POST /api/tasks/<id>/reschedule`, `/read`, `/unread`, `GET /api/series/<id>`, `POST /api/dispatcher/start`) take a client token too. They are not part of this contract and can change with the page.

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

## Errors

Every error body is `{"error": "<one line>"}`, never a stack or a path from a provider.

| Status | When |
|---|---|
| 400 | bad JSON, an unknown key, an invalid field, a body on a body-less route, a bad `since` |
| 401 | no token, an unknown token, a revoked token |
| 403 | a foreign `Host` or `Origin`; the page token from an extension origin; a client token on `/api/clients*`, `POST /api/tasks` or `POST /api/tasks/<id>/reply`; a static file from an extension origin |
| 404 | unknown route or id |
| 405 | wrong method, for example `POST /api/summary` |
| 409 | the core refused the action (for example no window meets a carbon budget, or Later would run the task earlier) |
| 413 | body over 64 KiB |
| 415 | a body route without `Content-Type: application/json` |
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

## Known risk: port squatting

Accepted for a single-user Mac (decision of 2026-10-17). While `tidegap ui` is down, any process that binds 127.0.0.1:47821 first receives the extension's bearer token on its next poll. That includes a process of another macOS account or a sandboxed app, neither of which can read `queue.db`. The token stays valid until revoked. Web pages stay blocked by the Host, Origin and token checks. If you suspect it, revoke the client (`tidegap clients revoke <id>`) and connect it again. The alternative, signed requests (a timestamped HMAC keyed by the token's SHA-256), was considered and not built.
