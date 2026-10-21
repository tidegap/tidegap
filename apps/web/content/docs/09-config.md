---
id: config
label: Config
---

<!-- source: apps/web/src/app/docs/page.tsx (v2 paths and ENVS), QUICKSTART.md step 4; Grid region: packages/core-ts/src/region.ts, packages/cli/src/region.ts, packages/mcp-server/src/server.ts, packages/openclaw-plugin/src/index.ts -->
Tidegap works with no keys and no config. Keys unlock live grid data for more regions and let the tick send tasks to a provider.

### Paths {#paths}

| Path | What it holds |
| --- | --- |
| `~/.tidegap/queue.db` | The SQLite ledger: the queue and the carbon receipts. The CLI, the MCP server and `tidegap ui` share it. |
| `~/.tidegap/signing.key` | The private key that signs receipts (`0600`), with `signing.key.pub` next to it. It never leaves the machine. |
| `~/.tidegap/telemetry.key` | Reserved for a planned opt-in leaderboard. Not created until you opt in, and never sent. |
| `~/.tidegap/ui.json` | The port and pid of a running `tidegap ui`. No token. |
| `~/.tidegap/config` | Settings as `KEY=value` lines. `tidegap region set` writes `TIDEGAP_DEFAULT_REGION` here. |
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
