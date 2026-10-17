<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="assets/brand/tidegap-logo-dark.svg">
    <img src="assets/brand/tidegap-logo-light.svg" alt="Tidegap" width="280">
  </picture>
</p>

# Tidegap

**Run non-urgent LLM tasks at the cleanest grid hour before your deadline.**

Tidegap takes the LLM tasks your agent does not need right now, runs them at the lowest-carbon grid hour before a deadline you set, and sends them through the provider Batch API when the deadline allows.

- Picks the dispatch hour from a live 72-hour grid carbon-intensity forecast: 5 real-data feeds, 31 regions (measured, counted in code).
- Routes work with a deadline over 24 hours through the Anthropic and OpenAI Batch APIs, at 50 % of the sync list price (projected, provider list price).
- Writes a signed carbon receipt per task to a local SQLite ledger. `tidegap verify` checks it offline.

[![npm](https://img.shields.io/npm/v/%40tidegap%2Fcore?label=npm)](https://www.npmjs.com/package/@tidegap/core) [![PyPI](https://img.shields.io/pypi/v/tidegap)](https://pypi.org/project/tidegap/) [![License: Apache-2.0](https://img.shields.io/badge/license-Apache--2.0-5eead4)](./LICENSE) [![Glama](https://glama.ai/mcp/servers/tidegap/tidegap/badges/score.svg)](https://glama.ai/mcp/servers/tidegap/tidegap)

```bash
npm install @tidegap/core                                  # TypeScript / Node
pip install "tidegap[anthropic,openai,signing]"            # Python 3.11+
claude plugin marketplace add tidegap/tidegap && claude plugin install tidegap   # Claude Code
npx -y @tidegap/mcp                                        # any other MCP host
```

```ts
// save as plan.mjs, run: node plan.mjs   (GB uses the free UK feed, no API key)
import { recommendWindow, ukCarbonIntensityFeed } from "@tidegap/core";
const deadline = new Date(Date.now() + 24 * 3600 * 1000).toISOString();
const plan = await recommendWindow({ region: "GB", deadline }, { feed: ukCarbonIntensityFeed(), rng: () => 0 });
console.log(plan.scheduledFor, plan.intensityGCo2PerKwh, plan.band);
// 2026-10-16T11:00:00.000Z 66 very_clean   (forecast value on 2026-10-15; yours will differ)
```

```python
import asyncio; from datetime import datetime, timedelta, timezone
from tidegap import recommend_window, uk_carbon_intensity_feed
deadline = datetime.now(timezone.utc) + timedelta(hours=24)
plan = asyncio.run(recommend_window(region="GB", deadline=deadline, feed=uk_carbon_intensity_feed(), rng=lambda: 0))
print(plan.scheduled_for, plan.intensity_g_co2_per_kwh, plan.band)
# 2026-10-16T11:00:00.000Z 66 very_clean   (forecast value on 2026-10-15; yours will differ)
```

Without `rng`, Tidegap picks at random among the cleanest band of near-equal hours, so repeated runs spread load and can return different hours; an `rng` that returns 0 gives the strict minimum.

**Proof:** one real run (GB, 2026-09-30, live National Grid ESO forecast). Forecast peak 183 gCO2/kWh, recommended window 88 gCO2/kWh: about 52 % lower, for this run only (forecast, projected). The test task had a 5-minute deadline, so it ran at once; its signed receipt records 158 gCO2/kWh (measured). [Raw output and reproducer](docs/examples/2026-09-30-GB-tick/) · [every number and its source](docs/claims.md)

**In an agent:** in Claude Code, `/tidegap:defer "Summarize today's notifications" --by 4h`. In any other MCP host, the agent calls `recommend_window` and `schedule_task` (10 MCP tools, 13 hosts — [host configs](https://www.tidegap.com/docs#install)).

## Renamed from Ebb AI

Until 0.17 this project was Ebb AI (`@ebb-ai/*`, `ebb-ai` on PyPI, the `ebb` command). 0.18.0 renames it to Tidegap, because "Ebb" conflicts with an existing software trademark. Your queue, receipts, signing key and daemon keep working. The old names worked for one release (0.18) and were removed in 0.19. **Coming from 0.17? Upgrade through 0.18 once before 0.19** (or move `~/.ebb-ai` to `~/.tidegap` by hand): 0.19 no longer moves the old data directory. If 0.19 already ran, stop tidegap, move `~/.tidegap` aside, then rename `~/.ebb-ai` to `~/.tidegap`.

| What you have from 0.17 | What happens on 0.19 | What you do |
|---|---|---|
| Ledger, key and config in `~/.ebb-ai/` | Not read since 0.19; one stderr line names `~/.ebb-ai`. 0.18 moved it to `~/.tidegap/` and left a link | Before 0.19: run any 0.18 command once. After: stop tidegap, move `~/.tidegap` aside, rename `~/.ebb-ai` to `~/.tidegap` |
| `EBB_*` variables (shell, MCP host config) | Not read since 0.19; one stderr line names each one | Rename them to `TIDEGAP_*` |
| `EBB_*` keys in `~/.tidegap/config` | Not read since 0.19; one stderr line names each one | Rename the keys to `TIDEGAP_*` |
| Secrets in `~/.config/ebb/env` | Not read since 0.19; one stderr line names the file. 0.18 `tidegap install` copied it to `~/.config/tidegap/env` | Move it to `~/.config/tidegap/env` and rename its `EBB_*` keys to `TIDEGAP_*` |
| Daemon `com.ebb-ai.tick` / `ebb-tick.timer` | Keeps running while `@ebb-ai/cli` is installed | `npm i -g @tidegap/cli` (uninstall `@ebb-ai/cli` first if npm reports `EEXIST`), `tidegap install`, run the unload commands it prints, then `npm uninstall -g @ebb-ai/cli` |
| `ebb <command>`, `ebb-mcp` | Removed in 0.19 | Use `tidegap <command>`, `tidegap-mcp` |
| `npx -y @ebb-ai/mcp` in a host config | Runs a 0.17.1 shim that starts `@tidegap/mcp` | Switch to `npx -y @tidegap/mcp` under the key `tidegap` (tools become `mcp__tidegap__*`) |
| Claude Code plugin `ebb-ai@ebb-ai`, `/ebb-ai:*` commands | No in-place update: the marketplace and plugin names changed | `claude plugin uninstall ebb-ai`, `claude plugin marketplace remove ebb-ai`, `claude plugin marketplace add tidegap/tidegap`, `claude plugin install tidegap`; then use `/tidegap:*` |
| OpenClaw `clawhub:@vitalini/ebb`, config `plugins.entries.ebb` | The old plugin stays on 0.17; the new plugin id is `tidegap` | `openclaw plugins install clawhub:@vitalini/tidegap`, move your config block to `plugins.entries.tidegap`, remove the old plugin |
| `pip install ebb-ai`, `import ebb_ai` | A 0.17.1 shim installs `tidegap`; the old import works with a warning | `pip install tidegap`, `import tidegap` |
| Links to `github.com/Vitalini/ebb-ai` and `www.ebb-ai.com` | GitHub redirects; the site redirects to `www.tidegap.com` | Nothing |

<p align="center"><img src="assets/readme-hero.png" alt="Tidegap: GB grid carbon-intensity forecast from 2026-09-30, peak 183 and recommended hour 88 gCO2/kWh (forecast, projected, one run)" width="800"></p>

## Why defer non-urgent AI work?

US data centers are projected to consume 6.7–12% of national electricity
grid load by 2028 ([DOE 2024](https://www.energy.gov/eere/buildings/articles/2024-united-states-data-center-energy-usage-report)), driven primarily by AI compute.
Most agent workload that lands on that load is *deferrable* (overnight
summaries, batch analyses, scheduled compliance scans, multi-step
report generation) — agent code just dispatches it synchronously by
default. `tidegap` makes the choice automatic. Four parallel wins:

1. **Lighter on the grid.** Spreads load away from peak hours, which is
   what ISOs and grid operators want from large compute users.
2. **50% cheaper (projected, Batch API list price).** Auto-routes
   through Anthropic and OpenAI Batch APIs (24-hour SLA) when the
   deadline allows. Same prompt, half the bill.
3. **Faster at off-peak.** Anthropic explicitly expanded off-peak
   capacity in 2026 ([rate-limit policy](https://docs.claude.com/en/api/rate-limits))
   — doubled usage limits outside peak hours, citing smoothed demand.
   Sync calls observe shorter queues.
4. **Lower carbon.** Dispatch lands in the cleanest grid hour inside
   the deadline; the saving depends on region and day (see
   [docs/claims.md](docs/claims.md)). Per-task carbon receipts against the actual
   grid intensity used at dispatch, persisted to a local SQLite ledger.
   Auditable, region-aware, reproducible. v0.10+ uses per-model Wh/token
   coefficients (Patterson 2021, Luccioni 2024, Hugging Face AI Energy
   Score) so receipts reflect what the agent actually ran — not a flat
   placeholder. v0.11+ signs every receipt with Ed25519 so consumers can
   verify them offline via `tidegap verify` (B2B ESG export path).

`tidegap` is the same code that would have fired a sync LLM call —
now deferred to the cleanest, cheapest, fastest hour inside the
deadline. Apache-2.0.

A real run, excerpted (GB, 2026-09-30T21:03:30Z, live National Grid ESO
feed, local Ollama `llama3.2:1b`; raw output and reproducer in
[`docs/examples/2026-09-30-GB-tick/`](docs/examples/2026-09-30-GB-tick/)):

```console
$ bash docs/examples/2026-09-30-GB-tick/command.sh
forecast source: ukCarbonIntensity (forecast)
forecast now:  2026-09-30T21:00:00.000Z  158 gCO2/kWh
forecast peak: 2026-10-01T17:00:00.000Z  183 gCO2/kWh

recommendWindow({ region: "GB", model: "llama3.2:1b", ... }):
  "scheduledFor": "2026-10-02T09:00:00.000Z",
  "intensityGCo2PerKwh": 88,
  "band": "very_clean",

$ tidegap tick --db <temp> --region GB
tick: 1 inspected, 1 dispatched, 0 failed

$ tidegap verify t-ef2354ee-eff0-431c-b11e-6edfcb8299b0 --db <temp>
✓ VALID
intensity_g_kwh   158
grid_source       ukCarbonIntensity
signer_public_key tTpsWuAS52easY0sgqz5E42aen7tdE5otdfLN6F+kxg=
```

| | UTC hour | Carbon intensity |
|---|---|---|
| Forecast peak | 2026-10-01T17:00 | 183 gCO2/kWh |
| Recommended window (72h deadline) | 2026-10-02T09:00 | 88 gCO2/kWh |

*(forecast (projected), one GB run, 2026-09-30 — 88 vs 183 gCO2/kWh is
~52% lower for this run only; not a general or typical figure. The
158 gCO2/kWh the receipt records at dispatch is the measured value. See
[docs/claims.md](docs/claims.md).)*

Price: not available for this run. Tidegap has no electricity-price feed, and
its sync vs Batch list-price comparison needs at least two candidate models;
this run used one unpriced local Ollama model.

`recommendWindow()` surfaces as an **MCP tool** to any compatible agent host
(Claude Desktop, Claude Code, Cursor, Cline, Continue, Zed,
Windsurf, OpenClaw, OpenAI Codex CLI, Pi). The agent asks
`recommend_window`, sees the plan, then commits via `schedule_task`
— or doesn't.

> **Status:** v0.19.0 (this release) · 2026-10-17 · published on npm and PyPI
> · `@tidegap/{core,mcp,cli}` on npm under the
> `@tidegap` org; `tidegap` on PyPI; `@vitalini/tidegap` OpenClaw
> plugin on ClawHub (`openclaw plugins install clawhub:@vitalini/tidegap`),
> not npm, and shares the queue. **One-command Claude Code plugin**
> via `/plugin marketplace add tidegap/tidegap && /plugin install tidegap`.
> **Five real-data grid feeds** across **31 regions** (NA/EU/APAC)
> — measured against the code, see [docs/claims.md](docs/claims.md):
> UK National Grid ESO Carbon Intensity API (GB, free no key),
> US EIA Open Data (CAISO / ERCOT / ISO-NE / PJM, free with key),
> ENTSO-E Transparency Platform (FR / DE / ES / IT / NL / …, free with
> token), WattTime v3 marginal-emissions forecasts (US ISOs, free with
> account — takes precedence over EIA where covered), and Electricity Maps
> as universal fallback. **v0.10:**
> per-model Wh/token coefficients across 59 LLMs (measured, count grows
> with each catalogue refresh; Patterson 2021,
> Luccioni 2024, HF AI Energy Score) replace the v0.1–v0.9 flat
> placeholder. **v0.11:** Ed25519-signed carbon receipts (offline
> verifiable via `tidegap verify`) plus WAL multi-writer SQLite so
> `tidegap tick` and the MCP server can share `~/.tidegap/queue.db`.
> **v0.12 ("trust repairs"):** Batch API routing is real — deferrable
> tasks (deadline > 24h) are submitted to the provider's Batch API and
> polled to completion (`submitted` status), instead of the previous
> dead-code gate; receipts record grid-data provenance (intensity, feed
> source — synthetic mock is disclosed, not silently signed) and the
> energy-coefficient confidence tier; Python- and TS-signed receipts
> verify in either language (one canonical signing form, JCS numbers);
> daemons installed by `tidegap install` actually dispatch (real
> node/script paths, `~/.config/tidegap/env` secrets); hardened ledger
> (0600, redacted `body_json`); honest feed labeling
> (forecast vs persistence). Anthropic + OpenAI Batch adapters, Python
> port at parity, live dashboard, `recommend_window` planning endpoint,
> always-on `tidegap tick` CLI with macOS launchd + Linux systemd +
> pmset/rtcwake wake events, full control surface (`cancel_task` /
> `expedite_task` / `update_deadline` / `retry_task` / `cancel_all`),
> receipt redaction, file output, retry-with-backoff. **1,423 tests
> passing** (923 TS + 500 Python, measured on this branch 2026-10-16)
> across 5 packages and 2 languages. See [QUICKSTART.md](./QUICKSTART.md).

[![Tests](https://img.shields.io/badge/tests-1423%20passing-22c55e)](#tests)
[![MCP tools](https://img.shields.io/badge/MCP-10%20tools-5eead4)](https://www.tidegap.com/docs)
[![Hosts](https://img.shields.io/badge/MCP%20hosts-13-5eead4)](https://www.tidegap.com/docs#install)
[![Website](https://img.shields.io/badge/website-tidegap.com-5eead4)](https://www.tidegap.com)

### Live demo

[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https%3A%2F%2Fgithub.com%2Ftidegap%2Ftidegap&root-directory=apps%2Fdashboard&project-name=tidegap-dashboard&repository-name=tidegap-dashboard)

Or visit the maintainer-hosted dashboard at
**[www.tidegap.com](https://www.tidegap.com)** to see live grid-load and
carbon-intensity forecasts across 31 grid regions (NA / EU / APAC —
CAISO, ERCOT, ISO-NE, PJM, Great Britain, France, Germany, and more)
and to try the best-window planner without installing anything.
Great Britain is powered by the free
[National Grid ESO Carbon Intensity API](https://carbonintensity.org.uk/)
(real data, no key required); US ISOs use WattTime v3 marginal-emissions
forecasts when a WattTime account is configured (falling through to the
EIA open-data feed otherwise), EU zones ENTSO-E, with Electricity Maps as
the universal fallback and a clearly-labelled deterministic mock when no
key is configured.

---

## Why

AI inference is becoming a major load on US grid infrastructure.
Data-center electricity demand has doubled since 2020 and is projected
to keep rising as agentic workloads scale.
But the same agent code that triggers this load dispatches it
synchronously by default — even when the task is "summarize my inbox
overnight" or "rewrite these 5,000 product descriptions by Friday."
Three things follow:

- **Cost.** Anthropic and OpenAI both offer Batch APIs at a flat **50%
  discount (projected, provider list price)** for tasks that can wait
  up to 24 hours. Almost no agent
  code uses them, because the choice has to be made at the call site.
  `tidegap` makes the choice automatic — and routes deadline-tolerant
  work through the cheaper path.
- **Grid load.** Data-center AI compute is concentrated in a few
  US regions (PJM Mid-Atlantic / Virginia, ERCOT Texas, CAISO
  California). Peak-hour AI workloads compete with hospitals,
  industrial users, and residential customers for capacity that is
  already constrained — Virginia regulators have flagged data-center
  load growth as a top-tier reliability concern. Time-shifting
  deferrable workloads to off-peak windows reduces the peak the grid
  has to plan for.
- **Carbon, as a measurable side effect.** Grid carbon intensity
  swings substantially over a single day as generation mix shifts.
  The same dispatch decision that saves cost and smooths load also
  emits less CO₂. `tidegap` writes an
  auditable receipt for every dispatch — useful for ESG reporting,
  cost-accounting, and upcoming compute-disclosure regulations.

`tidegap` automates the choice for any task that is not "answer me
right now."

---

## Components

| Package | Purpose |
|---|---|
| `@tidegap/core` | TypeScript core library. `defer()` API, `AnthropicAdapter`, `OpenAIAdapter`, `GeminiAdapter`, `OllamaAdapter`, opt-in SQLite-backed durable queue, per-model energy coefficients (`estimateEnergyKwh`, `MODEL_ENERGY_COEFFICIENTS`). |
| `@tidegap/mcp` | Model Context Protocol server. Drop-in for Claude Desktop, Claude Code, OpenClaw, Cursor. |
| `tidegap` (Python) | Python 3.11+ port. `asyncio` scheduler, `aiosqlite` persistence, Anthropic + OpenAI + Gemini + Ollama adapters, mirrored `tidegap.energy` module. |
| `apps/web` | Next.js 15 website at https://www.tidegap.com — install picker (13 hosts), live carbon-intensity map, best-window planner, docs. |
| `packages/claude-code-plugin` | Claude Code plugin tree (8 `/tidegap:*` slash commands + auto-invocation skill + MCP wiring). |
| `packages/openclaw-plugin` | OpenClaw plugin (`@vitalini/tidegap-ai` on ClawHub). Native OpenClaw tools mirroring the MCP surface. |
| `docs/spec` | Upstream MCP spec proposal for `priority`, `deadline`, `carbon_budget` fields. |

---

## Architecture

![Tidegap architecture diagram](./docs/release/v0.7.1/diagrams/architecture.png)

The MCP server is a thin stdio process the agent host (Claude Code,
Claude Desktop, Cursor, Cline, Zed, OpenClaw) spawns. It enqueues
work to a SQLite-backed queue at `~/.tidegap/queue.db`; an off-process
`tidegap tick` daemon (launchd / systemd / cron) reads scheduled rows
and dispatches them to the LLM provider at the chosen window. The
grid feed is a side-channel — the router picks per-zone between four
real-data sources before falling back to mock.

![grid feed routing](./docs/release/v0.7.1/diagrams/grid-feed-routing.png)

## Quick start

**See [QUICKSTART.md](./QUICKSTART.md) — four steps, five minutes.**

### As a Claude Code plugin (one-command install)

```bash
claude plugin marketplace add tidegap/tidegap
claude plugin install tidegap
```

That ships eight slash commands (`/tidegap:defer`, `/tidegap:plan`,
`/tidegap:check`, `/tidegap:cancel`, `/tidegap:expedite`, `/tidegap:reschedule`,
`/tidegap:retry`, `/tidegap:grid`), an `tidegap` skill, and auto-wires the
`@tidegap/mcp` MCP server. Full plugin reference: **[`packages/claude-code-plugin/README.md`](./packages/claude-code-plugin/README.md)**.

```
> /tidegap:defer "Summarize today's GitHub notifications" --by 4h
Deferred ✓ scheduled for 22:15 UTC (cleanest window inside the deadline)

> /tidegap:check
2 tasks queued · oldest in 1h · cleanest at 03:00 UTC
```

Full command surface: `/tidegap:{defer, plan, check, cancel, expedite,
reschedule, retry, grid}`. Tasks persist to `~/.tidegap/queue.db` and
survive Claude Code restarts.

### As an MCP server (Claude Desktop / Cursor / Cline / Zed)

```bash
npm install -g @tidegap/mcp     # or run via npx -y @tidegap/mcp
```

Then add to Claude Desktop's MCP config
(`~/Library/Application Support/Claude/claude_desktop_config.json` on
macOS):

```json
{
  "mcpServers": {
    "tidegap": {
      "command": "npx",
      "args": ["-y", "@tidegap/mcp"],
      "env": {
        "TIDEGAP_ELECTRICITY_MAPS_API_KEY": "optional; falls back to mock data without it. GB is always live via the free UK Carbon Intensity API.",
        "TIDEGAP_EIA_API_KEY": "optional; US ISO fuel-mix (average) intensity.",
        "TIDEGAP_ENTSOE_SECURITY_TOKEN": "optional; EU zone intensity.",
        "WATTTIME_USERNAME": "optional; with WATTTIME_PASSWORD, enables WattTime v3 marginal-emissions forecasts for US ISOs (takes precedence over EIA where covered).",
        "WATTTIME_PASSWORD": "optional; pairs with WATTTIME_USERNAME."
      }
    }
  }
}
```

The MCP server exposes ten tools to the agent (measured, `toolsForHost("mcp")` in
[`packages/core-ts/src/tool-surface.ts`](packages/core-ts/src/tool-surface.ts)):

- `get_grid_forecast(region, hours?)` — returns the next N hours of
  carbon intensity for a grid region (e.g. `US-CAL-CISO`).
- `recommend_window(deadline, region?, ...)` — plans the cleanest window
  inside the deadline without queueing anything.
- `schedule_task(prompt, deadline, model?, carbon_budget_g?)` — queues a
  task for execution at the cleanest window inside the deadline;
  `deadline_kind: "quota_reset"` sets the deadline to the next configured
  quota reset minus a margin.
- `check_queue_status(task_id?)` — lists pending tasks and any
  completed receipts; viewing one finished task marks it read.
- `cancel_task`, `expedite_task`, `update_deadline`, `retry_task`,
  `cancel_all` — control a queued task (or the whole queue).
- `reply_task(task_id, text)` — continue a completed task as a new task.

### As a library

```typescript
import { defer } from "@tidegap/core";

const result = await defer(
  () => anthropic.messages.create({ /* … */ }),
  {
    deadline: "2026-05-13T08:00:00-04:00",
    carbonBudgetG: 5,
    region: "US-CAL-CISO",
  },
);
```

### With a provider adapter and the Batch API (v0.2)

```typescript
import { Scheduler, AnthropicAdapter } from "@tidegap/core";

const scheduler = new Scheduler({ dbPath: "/var/lib/tidegap/queue.sqlite" });
const adapter = new AnthropicAdapter();

await scheduler.defer(
  () => adapter.dispatch("claude-sonnet-5", "Summarize today's git commits."),
  { deadline: "2026-05-13T08:00:00-04:00", region: "US-CAL-CISO" },
);

// or — submit 100 prompts via Anthropic Message Batches for a 50% discount:
const handle = await adapter.dispatchBatch("claude-sonnet-5", prompts);
console.log(handle.batchId);
```

The SQLite-backed queue is opt-in via `dbPath`; without it the
scheduler runs in-memory as in v0.1. The Anthropic and OpenAI SDKs are
peer dependencies — install them only if you use the corresponding
adapter.

### Run through your Claude Code subscription

`tidegap tick` can run tasks through the local `claude` CLI. It uses your Claude Code subscription quota and login, so you need no API key.

**Requirements.** Install Claude Code and log in once (`claude`, then `/login`) as the user who runs the tick daemon. If a task fails with an "unknown option" message, update Claude Code.

**Which tasks use it.**

- A task with `provider: "claude-code"` always runs through Claude Code. `schedule_task` (MCP) and quick add in `tidegap ui` accept this provider. The OpenClaw plugin does not.
- An `anthropic` task runs through Claude Code when `ANTHROPIC_API_KEY` is not set. When the key is set, it uses the Anthropic API as before.
- `openai`, `gemini` and `ollama` tasks never run through Claude Code. When the tick finds Claude Code and one of these tasks is due without its key, the task fails with "no adapter configured" and does not wait.

**How the tick finds `claude`.** First `TIDEGAP_CLAUDE_BIN`, then each directory on `PATH`, then `~/.local/bin`, `~/.claude/local`, `/opt/homebrew/bin` and `/usr/local/bin`. On macOS, as a last step, it asks your login shell (`zsh -ilc 'command -v claude'`). It does this only when a pending task needs Claude Code. This step finds `claude` under launchd, whose `PATH` does not include `~/.local/bin`.

**What a run can do.** The tick runs:

```bash
claude -p --output-format json --tools "WebSearch,WebFetch" \
  --allowedTools "WebSearch,WebFetch" --permission-mode dontAsk \
  --max-budget-usd 1 --safe-mode --strict-mcp-config --no-session-persistence \
  [--model <model>] [--system-prompt-file <file>]
```

- The prompt goes on stdin, so it does not show in `ps`.
- `--tools` and `--allowedTools` name the same tools. `--permission-mode dontAsk` denies every other tool. By default the model can search the web and fetch pages, and nothing else.
- `--safe-mode` and `--strict-mcp-config` turn off your CLAUDE.md, skills, plugins, hooks and MCP servers.
- The run happens in a new temporary directory, never in your repository, and the tick deletes the directory after the run.
- `--no-session-persistence` keeps these runs out of your Claude Code session history.
- The child process does not get `ANTHROPIC_API_KEY` or `ANTHROPIC_AUTH_TOKEN`, so it uses your subscription login. It also does not get your other provider keys, the WattTime login or any `TIDEGAP_*` variable.
- The tick runs a `claude` it finds on `PATH` or in a known location only when neither the file nor its directory is world-writable.
- A run that takes more than 10 minutes is stopped, together with every process it started, and the task fails.

**Tools.** A run gets `WebSearch` and `WebFetch` by default, so a task such as "what is the weather forecast for Kyiv tomorrow" gets a real answer. To change the set for one task, pass `tools` (an array of tool names) to `schedule_task` or `POST /api/tasks`; `[]` means no tools, and a reply keeps the tools of its parent. To change the default, set `TIDEGAP_CLAUDE_TOOLS` (a comma list; an empty value means no tools). Only `WebSearch`, `WebFetch`, `Read`, `Grep` and `Glob` are allowed. Any other name, such as `Bash`, `Write` or `Edit`, is rejected when you queue the task. Web pages are untrusted input: a page can contain text that tries to give the model instructions (prompt injection). For this reason a run never gets a tool that runs commands or writes files. `Read`, `Grep` and `Glob` can read files that your user can read, so add them only for prompts you trust. A set cannot combine a file tool with a web tool, because a fetched page could make the run send a local file out. The receipt records the tool set of the run, and `tidegap queue show <id>` prints it as `tools:`.

**Model.** The tick passes the task's `model` to `--model` when it is a `claude-*` id or one of `opus`, `sonnet`, `haiku`, `fable`, `opusplan` (optionally with `[1m]`). Otherwise Claude Code uses its own default. A `claude-code` task queued without a model gets `"default"`. The receipt records the model that Claude Code reports. `maxTokens` and `temperature` have no effect, because the CLI has no flags for them.

**Settings** (environment or `~/.config/tidegap/env`):

| Variable | Effect |
|---|---|
| `TIDEGAP_CLAUDE_BIN` | Path of the `claude` binary. Skips the lookup. |
| `TIDEGAP_CLAUDE_CODE=0` | Do not look for Claude Code (`false`, `off` and `no` also work). |
| `TIDEGAP_CLAUDE_CODE_MAX_BUDGET_USD` | `--max-budget-usd` cap per run. Default `1`. An invalid value falls back to `1` with a warning. |
| `TIDEGAP_CLAUDE_TOOLS` | Default tool set, a comma list from the allowlist. Default `WebSearch,WebFetch`; an empty value means no tools. An invalid value keeps the default with a warning. |

**Cost and quota.** Tasks use the same Claude Code quota as your interactive sessions. A night of queued tasks can use up the limit you expect to have in the morning. Claude Code's list-price estimate for each run is in `tidegap queue show <id> --raw` (`total_cost_usd`, next to `session_id`). Your subscription is not billed per run. The budget cap uses this estimate.

**Carbon receipt.** The receipt has provider `claude-code`. Its token count includes the system prompt that Claude Code adds to each run (about 3k tokens) when Claude Code writes it to the prompt cache. Cache reads are not counted. Thus a receipt can show more tokens than an API call with the same prompt.

**Usage limit.** A run that hits the subscription limit does not fail. The task goes back to the queue and does not start before the limit resets; then it runs at the cleanest hour. The reset time comes from your limit state (see "Usage and limits" below) when a window is used up, else from the time in Claude Code's message, else one hour later. After the first limit result in a tick, the other due tasks wait for the same time without a run. A task fails with the limit message when the reset is more than 8 days after the task was queued. `tidegap tick` prints `N deferred until HH:MM`.

**Failures.** Any other failed run fails the task once, with no retry. The error names the cause:

- `claude` not found or not executable: install Claude Code or set `TIDEGAP_CLAUDE_BIN`.
- "Not logged in": run `claude` once as this user and complete `/login`.
- Budget cap: `error_max_budget_usd`.
- Timeout: "timed out after 600s".
- Any other exit: the exit code and the end of stderr.

`retry_task` and `expedite_task` do not run `claude-code` tasks yet: they dispatch inside the MCP server, which has no Claude Code adapter.

### Usage and limits

Tidegap shows how much of your Claude Code 5-hour and weekly limits you used and when they reset. It can start a task after the reset.

**Where the numbers come from.** Claude Code gives the limits to its status line command. `tidegap usage hook` is a status line command: it writes the limits to `~/.tidegap/usage.json` (mode 0600, no token) and prints nothing. `tidegap install` asks, in a terminal, to add it to `~/.claude/settings.json`; it changes the file only when you answer yes. To add it yourself:

```json
{
  "statusLine": { "type": "command", "command": "tidegap usage hook" }
}
```

If you already have a status line command, keep it after `--`: `tidegap usage hook -- ~/.claude/statusline.sh`. The hook gives your command the same input and shows its output. Claude Code sends the limits for Pro and Max logins, after the first reply of a session. The values are as old as your last Claude Code reply; `tidegap usage` shows their age.

**Read the limits.**

```bash
tidegap usage          # one row per window: used, resets
tidegap usage --json   # the usage/v1 document
```

The MCP tool `tidegap_usage` returns the same document. It is read-only.

**Run after the limit resets.** `tidegap queue reschedule <id> --after-limit-reset`, or `after_limit_reset: true` on MCP `schedule_task`. The task does not start before the reset, and runs at the cleanest hour after it. The reset is the latest reset of a used-up window; when no window is used up, it is the reset of the fuller window. With no limit state, the command fails and names the cause.

**Optional: the usage API.** `TIDEGAP_USAGE_OAUTH=1` makes Tidegap also read Anthropic's usage endpoint (`api.anthropic.com/api/oauth/usage`) with your Claude Code login. It is off by default. Read this before you turn it on:

- The endpoint is not documented by Anthropic and can change or stop at any time.
- Anthropic's terms say Pro and Max login tokens are for Claude Code and Claude.ai. This read uses that token outside Claude Code. It is not inference, but your account carries the risk.
- Tidegap reads the token from the macOS Keychain (`/usr/bin/security`, which can ask for permission once) or `~/.claude/.credentials.json`. It never stores, logs or refreshes the token, and never writes to `~/.claude` or the Keychain.
- Tidegap uses a status line reading under 5 minutes old first. Every process shares one cache in `~/.tidegap/usage.json`: a reading is reused for 5 minutes (1 minute after a limit result in a tick), and no request is sent for at least 60 minutes after a rate-limit answer.

**Settings** (environment or `~/.tidegap/config`; the environment wins):

| Variable | Effect |
|---|---|
| `TIDEGAP_USAGE=off` | Do not read limits at all (`0`, `false` and `no` also work). The hook writes nothing. |
| `TIDEGAP_USAGE_OAUTH=1` | Also read the usage API (see above). Default off. |

The Mac app and the launchd tick do not see your shell variables, so put these in `~/.tidegap/config`.

### Python

```bash
pip install "tidegap[anthropic,openai,signing]"
```

From a clone, see [Install (development)](#install-development).

```python
import asyncio
from tidegap import defer

asyncio.run(defer(
    lambda: do_work(),
    deadline="2026-05-13T08:00:00-04:00",
    carbon_budget_g=5,
    region="US-CAL-CISO",
))
```

### Your queue: `tidegap ui`, notifications, session line

```bash
tidegap ui                      # opens the local task page in your browser
tidegap queue list --unread     # the same inbox in the terminal
tidegap queue show <id>         # one task: prompt, result, receipt
```

`tidegap ui` serves a local task manager. **Agenda** (the default) lists pending
tasks by day with the carbon band of each run hour; overdue tasks and unread
failures sit in "Needs attention". **Journal** lists finished tasks with
status, provider and kind filters. **Timeline** shows the forecast curve with
tasks at their scheduled hour. A task's drawer shows the result, the
conversation with a reply box, the receipt and the `claude --resume` line of
the session that queued it. From the page you can cancel (with a 5 s Undo),
reschedule, move a task to another day (drag it onto a day, or use the
move-to list), run it now, reply, mark it read or unread, stop a series, and
start a dispatcher when none is running. Actions change the ledger; tasks
still run on the dispatcher's next tick (`tidegap tick`), and the page shows when
that last ran. It listens on 127.0.0.1 only, and every API request needs
a random token that is printed once with the link and changes on every start.

`tidegap tick` posts a desktop notification for each task that completes or
fails (macOS, Linux with `notify-send`, Windows). Turn it off with
`tidegap tick --no-notify`, `TIDEGAP_NO_NOTIFY=1` in the environment, or `TIDEGAP_NOTIFY=0` in `~/.tidegap/config`. The Claude
Code plugin adds one line at session start when finished tasks are unread.

### Dashboard

```bash
pnpm --filter @tidegap/web dev
# → http://localhost:3000
```

Pages: live carbon-intensity map (31 regions, NA/EU/APAC — measured,
see [docs/claims.md](docs/claims.md)), 72-hour forecast charts,
best-window planner, and a queue explainer (`/queue`). The site never
sees your queue; open your own with `tidegap ui` (below).

**Grid data sources** (per zone, falls back to mock on failure):

> **Where do the keys go?** The environment variables in the `Auth` column
> configure the **hosts** — the `tidegap` CLI, the `@tidegap/mcp` server, and this
> dashboard. Each host reads them at its own entry point and injects them into
> `@tidegap/core`, which is environment-pure and reads nothing ambient.
> The **`@vitalini/tidegap` OpenClaw plugin reads no environment variables at all**:
> configure it under `plugins.entries.tidegap.config` in your gateway config, using
> `eiaApiKey`, `entsoeSecurityToken`, `electricityMapsApiKey`,
> `wattTimeUsername` / `wattTimePassword` (plus `anthropicApiKey`,
> `openaiApiKey`, `geminiApiKey` / `googleApiKey`, `ollamaHost`,
> `ollamaModels`, `carbonBudgetG`, `carbonBudgetWindow`, `defaultRegion`,
> `dbPath`). OpenClaw resolves the `"${ENV_VAR}"` shorthand in the credential
> fields, so you can keep exporting the same variables and let the gateway read
> them on the plugin's behalf.

| Zone | Source | Auth (CLI / MCP / dashboard) | Notes |
|---|---|---|---|
| `GB` | [UK National Grid ESO Carbon Intensity API](https://carbonintensity.org.uk/) | None | Real 48h forecast, always on |
| `US-CAL-CISO`, `US-TEX-ERCO`, `US-NE-ISNE`, `US-NY-NYIS`, `US-MIDA-PJM`, `US-MIDW-MISO` | [WattTime v3](https://watttime.org/) marginal (co2_moer) | Free account (`WATTTIME_USERNAME` + `WATTTIME_PASSWORD`) | **Marginal**-emissions FORECAST (lbs/MWh → gCO2/kWh). Takes precedence over EIA where covered; falls through to EIA on any error. Signal disclosed as `signalType: "marginal"` on forecasts/receipts |
| `US-CAL-CISO`, `US-TEX-ERCO`, `US-NE-ISNE`, `US-MIDA-PJM` (+`US-NY-NYIS`, `US-MIDW-MISO`) | [US EIA Open Data](https://www.eia.gov/opendata/) | Free API key (`TIDEGAP_EIA_API_KEY`) | Hourly fuel-mix → carbon intensity via IPCC AR5 factors (average signal; used when WattTime is unconfigured) |
| `FR`, `DE` (plus `ES`, `IT`, `NL` opt-in) | [ENTSO-E Transparency Platform](https://transparency.entsoe.eu/) | Free token (`TIDEGAP_ENTSOE_SECURITY_TOKEN`) | Realised generation by type → carbon intensity |
| any zone (universal fallback) | [Electricity Maps](https://www.electricitymaps.com/) free-tier | `TIDEGAP_ELECTRICITY_MAPS_API_KEY` | Used when zone-specific source missing |
| anything else | Deterministic mock curve | None | Used when no key set or upstream fails |

WattTime v3 uses granular sub-BA region codes; only `US-CAL-CISO →
CAISO_NORTH` is verified against WattTime's live public docs — the other
US mappings are best-effort and marked unverified in
`packages/core-ts/src/grid.ts`, degrading safely to EIA if a code is
rejected. Want to add another free public source? Each adapter is a single
function in `packages/core-ts/src/grid.ts` — open a PR.

---

## Install (development)

```bash
# from the repo root
pnpm install        # installs all workspace packages
pnpm build          # builds @tidegap/core and @tidegap/mcp
pnpm test           # runs vitest across packages
```

Python package from the clone (editable):

```bash
pip install -e "packages/core-py[anthropic,openai,signing]"
```

Requirements: Node 20+, pnpm 9+. Python 3.11+ if working on the Python
package.

---

## Documentation

- [`docs/`](./docs/) — design docs, MCP spec proposals (forthcoming).
- [`examples/`](./examples/) — OpenClaw demo skill, Claude Code config.

---

## License

[Apache License 2.0](./LICENSE) — patent grant included.

---

## Contributing

This project is in active early development. Issues and PRs welcome;
see [`CHANGELOG.md`](./CHANGELOG.md) for what has shipped. Major new features should
be discussed in an issue first to avoid duplicate effort.

---

*Built by [Vitalii Borovyk](https://github.com/Vitalini).*
