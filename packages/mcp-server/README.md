<img src="https://www.tidegap.com/icon-192.png" alt="Tidegap" width="48" height="48">

# @tidegap/mcp

> Renamed from `@ebb-ai/mcp` in 0.18.0. Use the host config key `tidegap` and `npx -y @tidegap/mcp`; the `ebb-mcp` bin and the `EBB_*` variables were removed in 0.19. See [Renamed from Ebb AI](https://github.com/tidegap/tidegap#renamed-from-ebb-ai).

**MCP server that lets your agent run non-urgent LLM tasks at the cleanest grid hour before a deadline.**

Add it to any MCP host. When a user says "do this tonight" or "by tomorrow", the agent calls `schedule_task`. Tidegap then runs the task at the lowest-carbon grid hour before the deadline, and through the provider Batch API when the deadline allows.

- 12 MCP tools (measured), among them `recommend_window`, `schedule_task`, `check_queue_status`, `get_grid_forecast`, `cancel_task`, `postpone_task`, `update_deadline`.
- Live 72-hour forecast. GB needs no key; other regions use free keys (EIA, ENTSO-E, WattTime, Electricity Maps).
- One signed carbon receipt per task, stored in `~/.tidegap/queue.db`.

```bash
npx -y @tidegap/mcp
```

```json
{ "mcpServers": {
    "tidegap": { "command": "npx", "args": ["-y", "@tidegap/mcp"] }
} }
```

Proof: one real GB run, 2026-09-30. Forecast peak 183 gCO2/kWh vs recommended window 88 gCO2/kWh, about 52 % lower for this run only (forecast, projected). Receipt at dispatch: 158 gCO2/kWh (measured). Host-specific configs: https://www.tidegap.com/docs#install

## Run

```bash
npx -y @tidegap/mcp
```

The server speaks MCP over stdio. To wire it into an agent client:

### Claude Desktop

Edit `~/Library/Application Support/Claude/claude_desktop_config.json`
on macOS (Linux/Windows have similar paths):

```json
{
  "mcpServers": {
    "tidegap": {
      "command": "npx",
      "args": ["-y", "@tidegap/mcp"],
      "env": {
        "TIDEGAP_ELECTRICITY_MAPS_API_KEY": "optional - mock data without it",
        "TIDEGAP_DEFAULT_REGION": "US-CAL-CISO"
      }
    }
  }
}
```

Restart Claude Desktop after editing.

### Claude Code

Add `tidegap` to your `~/.claude/mcp.json` (or workspace `.claude/mcp.json`):

```json
{
  "mcpServers": {
    "tidegap": {
      "command": "npx",
      "args": ["-y", "@tidegap/mcp"]
    }
  }
}
```

### OpenClaw

Add to `~/.openclaw/mcp.json`:

```json
{
  "mcpServers": {
    "tidegap": {
      "command": "npx",
      "args": ["-y", "@tidegap/mcp"]
    }
  }
}
```

## Tools exposed (12, measured)

| Tool | Purpose |
|---|---|
| `get_grid_forecast(region, hours?)` | Hour-by-hour carbon intensity for a region; useful before deciding whether to defer. |
| `recommend_window(deadline, region?, ...)` | Plan the cleanest window inside the deadline without queueing anything. |
| `schedule_task(prompt, deadline, model?, region?, carbon_budget_g?, repeat?, origin_session_id?, not_before?)` | Queue a task to run in the cleanest window inside the deadline. Returns a task_id and one line that says whether it will run: `Runs at <time> local.`, or the readiness sentence with its fix, for example ``Tasks will not run: no tick daemon. Run `tidegap install`.``. `not_before` sets the earliest start. `repeat` defaults to `none`, also for `deadline_kind: "quota_reset"`. |
| `check_queue_status(task_id?)` | Inspect the queue or one specific task; includes a carbon receipt once the task has completed. |
| `cancel_task(task_id, series?)` | Cancel a queued or scheduled task; on a repeating task, skip it, or end the series with `series: true`. |
| `reply_task(task_id, text, deadline?)` | Continue a completed task: a new task with the conversation plus this text, same provider and model. |
| `expedite_task(task_id)` | Dispatch a queued or scheduled task now, outside its carbon window. |
| `postpone_task(task_id, preset? \| until? \| delay_minutes?, reset_at?)` | "Later": move a pending task later, never earlier. Presets `1h`, `tonight` (22:00 to 06:00), `tomorrow_morning` (09:00 to 12:00), `after_limit_reset` (5 minutes after the Claude limit reset: `reset_at`, else this machine's limit reading, else a reset time given before). |
| `update_deadline(task_id, deadline)` | Reschedule a task against a new deadline. |
| `retry_task(task_id)` | Re-dispatch a failed task. |
| `cancel_all(status?)` | Cancel every task that is still queued or scheduled. |
| `tidegap_usage()` | Read-only: the Claude Code subscription limits of this machine and when they reset. |

## Environment variables

These variables configure **this MCP server** (and the `tidegap` CLI, which reads
the same set). They are read at the server's own entry point and injected into
`@tidegap/core`, which is environment-pure and reads nothing ambient itself.

> **OpenClaw plugin users:** the `@vitalini/tidegap` OpenClaw plugin reads **no**
> environment variables. Configure it through plugin config instead, under
> `plugins.entries.tidegap.config` in your gateway config — the "Plugin config"
> column below names the field that replaces each variable. OpenClaw resolves
> the `"${ENV_VAR}"` shorthand in those fields, so you can keep exporting the
> same variables and let the gateway read them on the plugin's behalf.

| Var | Plugin config | Purpose |
|---|---|---|
| `TIDEGAP_ELECTRICITY_MAPS_API_KEY` | `electricityMapsApiKey` | API key from [electricitymaps.com](https://www.electricitymaps.com/free-tier-api). Universal fallback. If unset (and no zone-specific feed is configured), the server falls back to deterministic mock data so you can still run the whole stack locally. |
| `TIDEGAP_EIA_API_KEY` | `eiaApiKey` | Free [US EIA](https://www.eia.gov/opendata/) key. Enables average-emissions intensity for the US ISO zones (CAISO / ERCOT / ISO-NE / NYISO / PJM / MISO). |
| `TIDEGAP_ENTSOE_SECURITY_TOKEN` | `entsoeSecurityToken` | Free [ENTSO-E](https://transparency.entsoe.eu/) token. Enables EU zone intensity (FR / DE / ES / IT / NL). |
| `WATTTIME_USERNAME` + `WATTTIME_PASSWORD` | `wattTimeUsername` + `wattTimePassword` | Free [WattTime v3](https://watttime.org/) account. Enables **marginal**-emissions (co2_moer) forecasts for the US ISO zones — takes precedence over EIA where covered, falls through to EIA on any error. The marginal signal is disclosed as `signalType: "marginal"` on forecasts and receipts. |
| `TIDEGAP_DEFAULT_REGION` | `defaultRegion` | Electricity Maps zone code, default `US-CAL-CISO`. |
| `ANTHROPIC_API_KEY` | `anthropicApiKey` | Enables the `anthropic` provider (batch-capable). |
| `OPENAI_API_KEY` | `openaiApiKey` | Enables the `openai` provider (batch-capable). |
| `GEMINI_API_KEY` / `GOOGLE_API_KEY` | `geminiApiKey` / `googleApiKey` | Enables the `gemini` provider (Generative Language API, sync-only). `GEMINI_API_KEY` is preferred; `GOOGLE_API_KEY` is the fallback. |
| `OLLAMA_HOST` | `ollamaHost` | Enables the local `ollama` provider (sync-only). Default `http://localhost:11434`; keyless — set this var to opt the provider in. |

## Develop

From the root of a clone of https://github.com/tidegap/tidegap:

```bash
pnpm install
pnpm --filter @tidegap/mcp build
node packages/mcp-server/dist/server.js
```
