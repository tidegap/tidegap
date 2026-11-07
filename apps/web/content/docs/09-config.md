---
id: config
label: Config
---

<!-- source: apps/web/src/app/docs/page.tsx (v2 paths and ENVS), QUICKSTART.md step 4; Grid region: packages/core-ts/src/region.ts, packages/cli/src/region.ts, packages/mcp-server/src/server.ts, packages/openclaw-plugin/src/index.ts; Run limits: packages/core-ts/src/run-limits.ts, packages/cli/src/limits.ts -->
Tidegap works with no keys and no config. Keys unlock live grid data for more regions and let the tick send tasks to a provider.

### Paths {#paths}

| Path | What it holds |
| --- | --- |
| `~/.tidegap/queue.db` | The SQLite ledger: the queue and the carbon receipts. The CLI, the MCP server and `tidegap ui` share it. |
| `~/.tidegap/signing.key` | The private key that signs receipts (`0600`), with `signing.key.pub` next to it. It never leaves the machine. |
| `~/.tidegap/telemetry.key` | Reserved for a planned opt-in leaderboard. Not created until you opt in, and never sent. |
| `~/.tidegap/ui.json` | The port and pid of a running `tidegap ui`. No token. |
| `~/.tidegap/sessions/` | Files of the Claude Code plugin (folder `0700`, files `0600`): `claude-<pid>.json`, which session a running Claude Code process is in, and `notices/<session_id>`, present while that session has finished tasks it was not told about. See [Agent handoff](#handoff-notices). |
| `~/.tidegap/config` | Settings as `KEY=value` lines. `tidegap region set` writes `TIDEGAP_DEFAULT_REGION` here, and `tidegap limits set` the [run limits](#limits). |
| `~/.config/tidegap/env` | Keys and secrets as `KEY=value` lines (`0600`). The CLI reads it; the MCP server does not. A variable in the real environment wins over the file. |
| `~/.config/tidegap/channel-secrets.json` | The secret fields of the notification channels (`0600`): webhook URLs, passwords, ntfy topics, Pushover keys. `tidegap channels remove <id>` deletes a channel's entry. There is no uninstall command: delete this file and the env file by hand. See [Notifications](#notify-security). |

### Environment {#env}

Set these in the MCP host's `env` block, or in the shell that runs the tick. GB is always live through National Grid ESO, with no key.

| Variable | What it unlocks | OpenClaw config key |
| --- | --- | --- |
| `TIDEGAP_EIA_API_KEY` | Live average-emissions data for the US ISOs (EIA). Free at eia.gov/opendata. | `eiaApiKey` |
| `WATTTIME_USERNAME`, `WATTTIME_PASSWORD` | Live marginal-emissions forecasts for the US ISOs (WattTime v3). Wins over EIA where it covers a region. | `wattTimeUsername`, `wattTimePassword` |
| `TIDEGAP_ENTSOE_SECURITY_TOKEN` | Live data for European zones (ENTSO-E Transparency Platform). | `entsoeSecurityToken` |
| `TIDEGAP_ELECTRICITY_MAPS_API_KEY` | Electricity Maps free tier, the fallback for any other zone. | `electricityMapsApiKey` |
| `ANTHROPIC_API_KEY`, `OPENAI_API_KEY` | Dispatch to Anthropic or OpenAI. Both can use the Batch API when the deadline allows. | `anthropicApiKey`, `openaiApiKey` |
| `GEMINI_API_KEY`, `GOOGLE_API_KEY` | Dispatch to Google Gemini. `GEMINI_API_KEY` wins. | `geminiApiKey`, `googleApiKey` |
| `OLLAMA_HOST`, `OLLAMA_MODELS` | Dispatch to a local Ollama server (default `http://localhost:11434`). No key needed. | `ollamaHost`, `ollamaModels` |
| `TIDEGAP_PUSHOVER_API_BASE` | Tests only: a loopback `http://` address that replaces the Pushover API. Any other value is ignored with one log line. | - |
| `TIDEGAP_DEFAULT_REGION` | The grid region when nothing more specific names one. Overrides the stored setting. See [Grid region](#region). | `defaultRegion` |

Without a grid key, a region other than GB uses a deterministic mock curve. Without a provider key, tasks are queued but not sent.

### OpenClaw plugin config {#openclaw-config}

The OpenClaw plugin reads no environment variables. Set the keys from the last column under `plugins.entries.tidegap.config` in the gateway config. OpenClaw resolves `"${ENV_VAR}"` in those fields, so the values can still come from the environment.

### Grid region {#region}

Tidegap plans every task against the forecast of one grid region. Set it once and every surface uses it: the tick, the queue, `tidegap ui`, the Mac app, the browser extension, the Telegram listener, the MCP server and the OpenClaw plugin.

```bash
tidegap region show        # the zone, where it came from, its data source
tidegap region set FR      # store a zone (any case; UK means GB)
tidegap region set auto    # clear it; the time-zone guess applies again
```

In the page and the Mac app: **Settings → Grid region**. See [UI & apps](#region-card).

The first rule that gives a region wins. `tidegap region show`, `/api/summary`, `/api/status` and the `schedule_task` reply of the MCP server and the OpenClaw plugin name the rule that applied (`source` or `region_source`).

| Order | `region_source` | Where the region comes from |
| --- | --- | --- |
| 1 | `flag` | `tidegap tick --region` or `tidegap ui --region`, or the `region` argument of a tool call. |
| 2 | `env` | `TIDEGAP_DEFAULT_REGION` in the environment. The CLI also reads it from `~/.config/tidegap/env`. |
| 2 | `config` | OpenClaw only, in place of `env`: the plugin's `defaultRegion`. |
| 3 | `setting` | `TIDEGAP_DEFAULT_REGION` in `~/.tidegap/config`, written by `tidegap region set` or the Settings card. |
| 4 | `timezone` | A guess from the machine's time zone. Only time zones with one clear grid are mapped (see the table below). |
| 5 | `fallback` | `GB`, which has live data with no key. |

A change applies without a restart. Tasks already queued keep their region.

| Surface | Reads `TIDEGAP_DEFAULT_REGION` from | A changed setting applies |
| --- | --- | --- |
| `tidegap tick`, `tidegap ui`, the Telegram listener | The environment and `~/.config/tidegap/env`, read again on each tick, request or command | On the next tick, request or command |
| `tidegap region`, `tidegap queue` | The environment and `~/.config/tidegap/env`, on each run | On the next run |
| Mac app, browser extension | Through the `tidegap ui` they connect to | On the next request |
| MCP server (`@tidegap/mcp`) | The process environment only: the host's `env` block. It never reads `~/.config/tidegap/env`. A changed value needs a host restart | On the next tool call |
| OpenClaw plugin | No environment: the plugin `defaultRegion` instead | On the next tool call |

**Unknown zone.** `tidegap region set`, the Settings card and a tool's `region` argument accept only the zones below, in any case. Anything else fails with the closest zones and a link to request a region, for example `Unknown zone UA. Closest: PL. Request a region: <link>`. A tool argument for another zone passes when a key serves it live: any zone except `IT` with `TIDEGAP_ELECTRICITY_MAPS_API_KEY`, and `IT`, an ENTSO-E zone, only with `TIDEGAP_ENTSOE_SECURITY_TOKEN`. A stored value that is not a supported zone is ignored and reported, and the next rule applies.

**Ukraine.** There is no Ukrainian grid data yet. A time zone in Ukraine (`Europe/Kyiv`, `Europe/Kiev`, `Europe/Uzhgorod`, `Europe/Zaporozhye`) maps to `PL`, the nearest supported grid in the same synchronous area. The hour-of-day timing carries over; the absolute grams do not. `tidegap region show` and the card say "No Ukrainian grid data yet" and link to a region request.

**Supported zones.** Live data needs the key in the "Key" column (US zones also go live with `WATTTIME_USERNAME` and `WATTTIME_PASSWORD`); without it the zone uses a deterministic sample curve. `tidegap region list` prints the same list.

<!-- embed:regions -->

### Run limits {#limits}

Each run of a task or a job has a time limit, and a failed run is tried again by its retry policy. The limits and the retry policy are settings in `~/.tidegap/config`: raise one, set it per runner, or switch a time limit off with `none`.

| Setting | `~/.tidegap/config` keys | Per-task flag and field | Value | Built-in default | `none` and `0` |
| --- | --- | --- | --- | --- | --- |
| Command time limit | `TIDEGAP_COMMAND_TIMEOUT` | `--command-timeout` (`queue add`, `jobs`); HTTP `command_timeout_s` | duration | `30m` | `none`: no limit. `0`: refused. |
| LLM time limit | `TIDEGAP_LLM_TIMEOUT`, `TIDEGAP_LLM_TIMEOUT_<RUNNER>` | `--llm-timeout` (`queue add`, `jobs`); MCP and OpenClaw `llm_timeout`; HTTP `llm_timeout_s` | duration | `claude-code` `30m`; `anthropic`, `openai`, `gemini`, `ollama` `10m` | `none`: no limit. `0`: refused. |
| Retries | `TIDEGAP_RETRIES`, `TIDEGAP_RETRIES_<RUNNER>` | `--retries` (`queue add`, `jobs`); MCP and OpenClaw `retries`; HTTP `retries` | whole number 0-10 | `1` | `0`: no automatic retry. `none`: refused. |
| Retry delay | `TIDEGAP_RETRY_DELAY`, `TIDEGAP_RETRY_DELAY_<RUNNER>` | `--retry-delay` (`queue add`, `jobs`); MCP and OpenClaw `retry_delay`; HTTP `retry_delay_s` | duration; retry k waits delay × 2^(k−1) | `30m` | Both refused. |

- **Duration:** a number and a unit, `s`, `m` (or `min`), `h` or `d`, in any case: `90s`, `30m`, `1.5h`, `2d`. A bare number is seconds. From 1 second to 7 days. For a longer run, use `none`.
- **`<RUNNER>`:** `COMMAND`, `CLAUDE_CODE`, `ANTHROPIC`, `OPENAI`, `GEMINI` or `OLLAMA`. The LLM time limit takes the five model runners; retries and the retry delay take all six. A command job's LLM step uses the LLM time limit of its provider.
- **Precedence:** the task's or job's own value, then `<KEY>_<RUNNER>`, then `<KEY>`, then the built-in default. Each view names the source: `task`, `setting:<runner>`, `setting` or `default`.
- **Machine form:** HTTP JSON carries a time limit or the retry delay as seconds in an `_s` key, a time limit also as the string `"none"`, and retries as a number. In an input, `null` removes the job's own value, so the next layer applies.

Show and change the settings with `tidegap limits`:

```
tidegap limits
tidegap limits set llm-timeout 1h --runner claude-code
tidegap limits set command-timeout none
tidegap limits set retries 0 --runner command
tidegap limits reset command-timeout
```

A change applies to the next run, with no restart. The tick, the MCP server, the OpenClaw plugin and the Python package read the file each time a run starts. A line that is not a valid limit, such as `TIDEGAP_COMMAND_TIMEOUT=0`, is ignored and the next layer applies; `tidegap limits` lists it with the reason.

`tidegap queue add` prints the limit and the retry policy that apply now. The `dispatched` event of each run records each setting and its source; `tidegap queue show`, `check_queue_status` and `tidegap jobs show` print them.

A time limit is the whole limit of an API call: each call gets its own HTTP timeouts from it (none for `none`), so no hidden ceiling, such as Node's 300-second wait for response headers, ends it earlier. Two cases keep that 300-second wait: an SDK package too old to take per-call fetch options (the `openai` package before version 5), and the OpenClaw plugin's own model calls (a provider key in its config, Gemini, Ollama), since its bundle leaves out the HTTP client that sets the timeouts. Calls through the OpenClaw runtime do not use it. A task that goes to a provider Batch API (a deadline over 24 hours away) has no time limit: the provider owns the hour of a Batch run, so its own `llm_timeout` is not applied there, and the reply that queues it says so.

**`none` holds other tasks.** The tick runs due tasks one at a time, so a run with no limit holds every other due task while it runs. `tidegap queue cancel <id>` stops it within 15 seconds, and `tidegap status` names a run that has run longer than two tick intervals.

A job or a queued command task stored by an older version holds the old defaults (5 minutes for a command, 10 minutes for an LLM step). Those values follow the settings; a value you set yourself stays the task's own.

### Retries {#retries}

A failed run of any runner, a one-off shell command included, is tried again by its retry policy:

- **When:** the failure must be one a retry can fix: a time limit, a command or Claude Code exit, a 429 or 5xx after the call's own quick resends, a network error, an errored or expired Batch, or a run a stopped tick interrupted. A permanent failure never retries: a refused request (a 4xx other than 429, a content refusal), missing setup (a key, a secret, a folder, the `claude` binary), a spent budget, an LLM step that failed after its command ran, or a Batch submit a forced stop cut.
- **How often:** up to `retries` times. Retry k starts no earlier than the retry delay times 2^(k−1) after the failure (30, 60, 120 minutes with the defaults), then at the cleanest hour before the deadline. A retry that cannot start before the deadline is not made, and the error ends with `(no time left before the deadline for a retry)`.
- **What you see:** each failed attempt that is tried again writes an `attempt_failed` event with its attempt number, failure class, first error line and the next attempt's time; the task is `scheduled` again. Only the final outcome sends a notice, wakes a session or writes a result file; a final failure after more than one attempt ends with `(after N attempts)`.
- **Commands:** a one-off command retries like every runner, so it may run twice. For a command that must not run twice, queue it with `--retries 0`, or set `tidegap limits set retries 0 --runner command`. `tidegap queue add --runner command` prints the retry line before the first run.
- **Billing:** a retried API call after a network error or a time limit may be billed twice: the provider may have accepted the first call.
- **By hand:** `tidegap queue retry <id>` (or `retry_task`, `/tidegap:retry`) runs a failed task again as attempt 1 of a new count, whatever its deadline. A job run is refused: the job retries its runs itself, by the same policy, as separate runs of its slot.
