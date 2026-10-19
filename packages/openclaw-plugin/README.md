<img src="https://www.tidegap.com/icon-192.png" alt="Tidegap" width="48" height="48">

# @vitalini/tidegap

OpenClaw plugin that exposes Tidegap as native OpenClaw tools.
Published on ClawHub as `@vitalini/tidegap`; its runtime id in the gateway
is `tidegap`.

When a user says "do this later", "by tomorrow", "tonight", "overnight",
"by EOD", "remind me to", or any other deferral phrase, this plugin's
`schedule_task` tool gets invoked automatically — the LLM dispatch is
routed to the cleanest electricity-grid hour inside the deadline, for
lower carbon than running immediately (the saving depends on region and
day — see [docs/claims.md](../../docs/claims.md)).

## Tools registered

Tool names match the `@tidegap/mcp` MCP-server surface (no prefix).

| Tool                  | Purpose                                                       |
|-----------------------|---------------------------------------------------------------|
| `schedule_task`       | Queue a task at the cleanest hour. The deferral trigger.      |
| `recommend_window`    | Preview the cleanest hour without queueing. Read-only.        |
| `check_queue_status`  | List all tasks / detail one (with carbon receipt). Read-only. |
| `cancel_task`         | Cancel a pending task. In a series it skips one occurrence; `series: true` ends the series. Idempotent. |
| `get_grid_forecast`   | Hourly grid carbon-intensity forecast. Read-only.             |
| `update_deadline`     | Move a queued/scheduled task's deadline.                      |
| `cancel_all`          | Cancel every queued/scheduled task at once.                   |
| `set_delivery`        | Choose how a task's result is delivered when it completes.    |
| `expedite_task`       | Dispatch a queued/scheduled task now, skipping the window.    |
| `retry_task`          | Re-dispatch a failed task.                                    |
| `reply_task`          | Continue a completed task: a new task sends the earlier prompt, the reply and your text to the same model. |

## Result delivery

> ### ⚠ Delivery can send task content outside OpenClaw
>
> Four of the six delivery modes move the **full text of your task's
> result** past the boundary of your OpenClaw session. Know which you are
> choosing:
>
> | Mode | Where the result goes |
> |---|---|
> | `queue` | stays in the local SQLite ledger — **the only mode with no transmission at all** |
> | `os` | a desktop notification on the gateway host (truncated preview) — local |
> | `chat` | **your gateway's configured chat channel — which today is Telegram.** `chat` and `telegram` currently take the *same* Bot-API path, so "chat" is **not** an inside-OpenClaw-only mode on a Telegram-backed gateway |
> | `telegram` | **the full result to Telegram's servers** — a third party |
> | `webhook` | **HTTP POST of the full result to whatever URL you supply** — Tidegap does not restrict, allowlist, or inspect that destination |
> | `file` | written to **any path you supply** on the gateway host, readable by anything with filesystem access |
>
> The prompt you defer is also stored in the local ledger until the task
> completes (then redacted), and the result is always kept in the queue
> regardless of mode. **For sensitive work use `queue`** and read the
> result back with `check_queue_status` — it is the only mode that keeps
> the content on your machine. Treat a webhook URL, a Telegram target and
> a file path as trust decisions about that data, and verify each before
> use.

When a deferred task completes, its result is delivered through the
mode(s) chosen per task — `chat` (the active OpenClaw chat), `telegram`,
`webhook` (POST to any URL), `file` (a report in md/html/txt/json/pdf),
`queue` (no push), or `os` (a native desktop notification on the gateway
host). The result is always kept in the queue too. Call `set_delivery`
right after `schedule_task`, once you've asked the user how they want the
result. Default: `chat` — the result comes back where the conversation is
(on a Telegram-backed gateway, that means through Telegram; see the box
above).

The `os` mode is dependency-free — it spawns the platform's built-in
notifier (`osascript` on macOS, `notify-send` on Linux, a PowerShell toast
on Windows). Unsupported platform or a missing binary records an honest
delivery failure (visible via `check_queue_status`) rather than throwing.

The `pdf` file format renders the same HTML report through **puppeteer's**
headless Chrome. puppeteer is an *optional* dependency — it is not bundled
and not required to install the plugin. Add it only if you want PDF output,
where the gateway loaded the plugin, then restart the gateway:

```bash
cd ~/.openclaw/extensions/tidegap && npm install puppeteer
```

If puppeteer is absent when a `pdf` delivery runs, the delivery records a
clear, actionable failure (surfaced via `check_queue_status`) with these
exact install steps, and the report is still kept in the queue.

## Install

**Requires Node 22.5 or newer** — the SQLite queue uses Node's built-in
`node:sqlite` with no fallback, so the OpenClaw gateway must run on Node
≥ 22.5 (declared in `engines`).

```bash
openclaw plugins install clawhub:@vitalini/tidegap
```

Restart the OpenClaw gateway. To update later:
`openclaw plugins update @vitalini/tidegap`.

**Upgrading from `@vitalini/ebb` (0.17 and earlier).** The plugin id changed
from `ebb` to `tidegap`, and OpenClaw gives a plugin only its own config
block, so the new plugin cannot read the old one. Install the new plugin,
move your settings from `plugins.entries.ebb` to `plugins.entries.tidegap`
in the gateway config, then remove the old plugin. Since 0.19 the queue is
no longer moved from `~/.ebb-ai`: upgrade through 0.18 once, or move
`~/.ebb-ai` to `~/.tidegap` by hand (if 0.19 already created `~/.tidegap`,
stop the gateway and move that one aside first).

## Verify the install (smoke test)

After installing and restarting the gateway:

1. **Inspect** — all eleven tools should be listed:

   ```bash
   openclaw plugins inspect tidegap --runtime --json
   ```

   The `tools` array contains `schedule_task`, `recommend_window`,
   `check_queue_status`, `cancel_task`, `get_grid_forecast`,
   `update_deadline`, `cancel_all`, `set_delivery`, `expedite_task`,
   `retry_task`, `reply_task`. (`Shape: non-capability` in the plain
   `inspect` output is the normal label OpenClaw gives tool plugins — it
   is not an error.)

2. **Validate** the installed package:

   ```bash
   openclaw plugins validate --root ~/.openclaw/extensions/tidegap --entry ./dist/index.js
   ```

3. **Exercise the tools** in any OpenClaw session:
   - "preview the cleanest window for a task due tomorrow 6pm in GB"
     → `recommend_window`
   - "do this overnight: summarise today's commits" → `schedule_task`
   - "what's in my tidegap queue?" → `check_queue_status`

The queue is a SQLite ledger opened through Node's built-in `node:sqlite`
(Node ≥ 22.5) — there is no native module to compile, so a fresh install
needs no extra build step.

### Building from source

```bash
pnpm --filter @vitalini/tidegap build          # bundle to dist/index.js
openclaw plugins build    --root packages/openclaw-plugin --entry ./dist/index.js
openclaw plugins validate --root packages/openclaw-plugin --entry ./dist/index.js
pnpm --filter @vitalini/tidegap test           # run the plugin test suite
```

Pack and install the tarball directly (no ClawHub round-trip):

```bash
cd packages/openclaw-plugin && npm pack
openclaw plugins install ./vitalini-tidegap-<version>.tgz
```

## Configuration

**This plugin reads no environment variables.** Everything is configured
through OpenClaw plugin config, under `plugins.entries.tidegap.config` in your
gateway config. (Environment variables still configure the `tidegap` CLI and the
`@tidegap/mcp` server — they are separate hosts and are unaffected.)

Why: ClawHub's ClawScan raises `suspicious.env_credential_access` (severity:
critical) on any ambient-environment read inside a bundle that also makes
network calls, regardless of whether the value is a secret. So the reads are
gone entirely, and `@tidegap/core` is environment-pure for the same reason.

```json
{
  "plugins": {
    "entries": {
      "tidegap": {
        "enabled": true,
        "config": {
          "dbPath": "/home/you/.tidegap/queue.db",
          "defaultRegion": "GB",
          "eiaApiKey": "${TIDEGAP_EIA_API_KEY}",
          "anthropicApiKey": "${ANTHROPIC_API_KEY}"
        }
      }
    }
  }
}
```

### Migrating from environment variables

Every credential field is declared in the manifest's
`configContracts.secretInputs`, so OpenClaw resolves the `"${ENV_VAR}"` /
`"$ENV_VAR"` shorthand for it and hands the plugin the resolved value — the
**gateway** performs the environment read, never this bundle. If you already
export these variables, keep exporting them and reference them as shown above.
`uiHints` marks the same fields sensitive, so the gateway UI masks them.

| Was (environment variable) | Now (plugin config field) |
|---|---|
| `TIDEGAP_ELECTRICITY_MAPS_API_KEY` | `electricityMapsApiKey` |
| `TIDEGAP_EIA_API_KEY` | `eiaApiKey` |
| `TIDEGAP_ENTSOE_SECURITY_TOKEN` | `entsoeSecurityToken` |
| `WATTTIME_USERNAME` | `wattTimeUsername` |
| `WATTTIME_PASSWORD` | `wattTimePassword` |
| `ANTHROPIC_API_KEY` | `anthropicApiKey` |
| `OPENAI_API_KEY` | `openaiApiKey` |
| `GEMINI_API_KEY` | `geminiApiKey` |
| `GOOGLE_API_KEY` | `googleApiKey` |
| `OLLAMA_HOST` | `ollamaHost` |
| `OLLAMA_MODELS` | `ollamaModels` |
| `TIDEGAP_CARBON_BUDGET_G` | `carbonBudgetG` (a number, not a string) |
| `TIDEGAP_CARBON_BUDGET_WINDOW` | `carbonBudgetWindow` |
| `TIDEGAP_DEFAULT_REGION` | `defaultRegion` |
| `EBB_DELIVERY_FILE` | `deliveryStorePath` |
| `EBB_DISABLE_STARTUP_DISPATCH=1` | `disableStartupDispatch: true` |
| `TIDEGAP_NO_NOTIFY=1` (read by the CLI) | `disableOsNotifications: true` |

Provider credentials are usually unnecessary: with the OpenClaw runtime LLM
bridge captured (on the first tool call), deferred tasks dispatch through the
gateway's own configured model with no API key at all.

`dbPath` defaults to `~/.tidegap/queue.db` — the same path used by
`@tidegap/mcp` (MCP server) and `@tidegap/cli` (CLI). All three share
one ledger, so deferring a task in OpenClaw and listing it from
`tidegap stats` Just Works.

`defaultRegion` — the grid region used when a tool call doesn't name
one. The plugin resolves the region of each call in this order:

1. the tool call's `region` argument,
2. `defaultRegion` in plugin config,
3. the region setting stored on this machine: `tidegap region set <zone>`,
   or Settings → Grid region in `tidegap ui` and the Mac app (key
   `TIDEGAP_DEFAULT_REGION` in `~/.tidegap/config`),
4. a guess from the host machine's time zone: `Europe/London`→`GB`,
   `America/Los_Angeles`→`US-CAL-CISO`, `America/New_York`→`US-MIDA-PJM`,
   `Europe/Paris`→`FR`, `Europe/Berlin`→`DE`, and more,
5. `GB` (always-live data via UK NESO, no API key).

**Leave `defaultRegion` unset to follow the stored setting**, which the
plugin reads again when the file changes (no gateway restart). A stored
value that is not a supported zone is ignored with one warning per change.
`schedule_task` reports a `region_source` (`flag` / `config` / `setting` /
`timezone` / `fallback`) so you can see which rule applied.

A `region` argument must be one of the 31 supported zones (any case);
another value is rejected with the closest zones and a link to request a
region (`Unknown zone UA. Closest: PL. …`). With `electricityMapsApiKey`
set, any zone passes. Non-GB regions need the matching grid credential in
plugin config (`eiaApiKey`, `entsoeSecurityToken`, `electricityMapsApiKey`,
`wattTimeUsername` / `wattTimePassword`) for live data, otherwise a
deterministic mock is used.

## When does the plugin auto-invoke?

The `schedule_task` tool description tells the LLM to invoke when
the user's phrasing signals deferral:

- "do this later" / "by tomorrow" / "tonight" / "overnight"
- "by EOD" / "this week" / "next week"
- "when you have a moment" / "remind me to"
- "queue this up" / "schedule this"
- "no rush" / "not urgent"

For interactive tasks ("summarize this", "what does X do", "write a
function") the plugin stays out of the way.

## License

Apache-2.0 © Vitalii Borovyk · https://github.com/tidegap/tidegap
