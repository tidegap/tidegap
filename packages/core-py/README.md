<img src="https://www.tidegap.com/icon-192.png" alt="Tidegap" width="48" height="48">

# Tidegap

> Renamed from `ebb-ai` (import `ebb_ai`) in 0.18.0: `pip install tidegap`, `import tidegap`. See [Renamed from Ebb AI](https://github.com/tidegap/tidegap#renamed-from-ebb-ai).

**Run non-urgent LLM tasks at the cleanest grid hour before your deadline — Python library.**

Tidegap takes LLM tasks that can wait, runs them at the lowest-carbon grid hour before a deadline you set, and sends them through the provider Batch API when the deadline allows.

- `recommend_window()` picks the hour from a live 72-hour carbon-intensity forecast: 5 real-data feeds, 31 regions (measured).
- `defer()` queues the task in SQLite. Work with a deadline over 24 hours goes through the Anthropic and OpenAI Batch APIs, at 50 % of the sync list price (projected, provider list price).
- With the `signing` extra, every dispatch writes an Ed25519-signed carbon receipt.

```bash
pip install "tidegap[anthropic,openai,signing]"     # Python 3.11+
```

```python
import asyncio; from datetime import datetime, timedelta, timezone
from tidegap import recommend_window, uk_carbon_intensity_feed
deadline = datetime.now(timezone.utc) + timedelta(hours=24)
plan = asyncio.run(recommend_window(region="GB", deadline=deadline, feed=uk_carbon_intensity_feed(), rng=lambda: 0))
print(plan.scheduled_for, plan.intensity_g_co2_per_kwh, plan.band)
```

Without `rng`, Tidegap picks at random among the cleanest band of near-equal hours, so repeated runs spread load and can return different hours; an `rng` that returns 0 gives the strict minimum.

Proof: one real GB run, 2026-09-30. Forecast peak 183 gCO2/kWh vs recommended window 88 gCO2/kWh, about 52 % lower for this run only (forecast, projected). Same API as the TypeScript package [@tidegap/core](https://www.npmjs.com/package/@tidegap/core). Source: https://github.com/tidegap/tidegap

---

## Why this exists

Modern AI agents call LLM APIs synchronously by default. Three costs follow:

- **Carbon.** Grid carbon intensity swings substantially over a
  single day across the major US ISOs as generation mix shifts.
  Inference at 2 p.m. on a hot day can be materially dirtier than the
  same call at 3 a.m.
- **Dollars.** Anthropic and OpenAI both offer batch APIs at a flat
  50% discount (projected, provider list price) for tasks that can
  wait up to 24 hours. Almost no agent code uses them by default
  because it requires rewriting the call site.
- **Latency, honestly.** Off-peak *sync* execution is sometimes
  faster because providers throttle and queue at peak. **Batch API
  is *not* faster** — it trades latency (up to 24h SLA) for the
  50% discount (projected, provider list price).

`tidegap` fixes all three for any task that is not "answer me right now."

---

## Environment variables

The Python package reads provider credentials from the environment
(`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, …) as a convenience — you are the host
here: you import `tidegap` directly into your own script, notebook or service.

> **Deliberate asymmetry with the TypeScript packages.** `@tidegap/core` (the TS
> mirror of this library) is *environment-pure*: it reads no environment
> variables and takes every credential as an explicit argument, because it gets
> bundled into the `@vitalini/tidegap` OpenClaw plugin, and ClawHub's ClawScan flags
> any ambient-environment read in a bundle that also makes network calls. This
> Python package is never bundled into a third-party plugin, so the ergonomic
> fallbacks stay. Passing credentials explicitly (`AnthropicAdapter(api_key=…)`)
> works here too and is preferred in library code.
>
> Environment variables configure the **`tidegap` CLI** and the **`@tidegap/mcp`
> server**; the **OpenClaw plugin** is configured through OpenClaw plugin config
> (`plugins.entries.tidegap.config`), where each field names the variable it
> replaced.

---

## Install

```bash
pip install tidegap

# with vendor extras and receipt signing
pip install "tidegap[anthropic,openai,signing]"

# from source, for contributors (in a clone of https://github.com/tidegap/tidegap)
pip install -e "packages/core-py[dev,anthropic,openai]"
```

Python 3.11+. The core library only requires `httpx` and `aiosqlite`;
the Anthropic and OpenAI extras pull in the official vendor SDKs.

---

## Quick start

### 1. The five-line version

```python
import asyncio
from datetime import datetime, timedelta, timezone
from tidegap import defer

async def main():
    result = await defer(
        lambda: "do the work here",
        deadline=datetime.now(timezone.utc) + timedelta(hours=12),  # "within 12 hours"
        carbon_budget_g=5,  # optional max grams CO2e
        region="US-CAL-CISO",  # optional grid region
    )
    print(result)

asyncio.run(main())
```

`defer()` returns whatever the callable returns. The task body can be
sync or async; both work.

### 2. Hand-built scheduler with SQLite persistence

For long-running services you want a single, explicitly-constructed
scheduler with a durable queue:

```python
import asyncio
from datetime import datetime, timedelta, timezone
from tidegap import Scheduler, DeferOptions

async def main():
    async with Scheduler(db_path="/var/lib/tidegap/queue.sqlite") as scheduler:
        await scheduler.defer(
            lambda: do_research_run(),
            DeferOptions(
                deadline=(datetime.now(timezone.utc) + timedelta(hours=12)).isoformat(),
                carbon_budget_g=5,
                region="US-CAL-CISO",
                task_id="user:42:weekly-research",
            ),
        )

asyncio.run(main())
```

If the process restarts, the next `Scheduler(db_path=…)` will see the
completed receipts via `await scheduler.list_persisted_tasks()`.

### 3. Anthropic Batch API

```python
import asyncio
from datetime import datetime, timedelta, timezone
from tidegap import Scheduler, DeferOptions
from tidegap.providers import AnthropicAdapter

async def main():
    adapter = AnthropicAdapter()  # reads ANTHROPIC_API_KEY

    async def work():
        result = await adapter.dispatch(
            "claude-sonnet-5",
            "Summarize today's git commits.",
        )
        return result.text

    async with Scheduler() as scheduler:
        summary = await scheduler.defer(
            work,
            DeferOptions(
                deadline=(datetime.now(timezone.utc) + timedelta(hours=12)).isoformat(),
                region="US-CAL-CISO",
            ),
        )
        print(summary)

asyncio.run(main())
```

For genuinely batched work (50+ prompts at once), use the Batch API
directly:

```python
handle = await adapter.dispatch_batch(
    "claude-sonnet-5",
    ["prompt 1", "prompt 2", "prompt 3"],
)
print(handle.batch_id)  # poll via the Anthropic SDK
```

### 4. OpenAI Batch API

```python
import asyncio
from tidegap.providers import OpenAIAdapter

async def main():
    adapter = OpenAIAdapter()  # reads OPENAI_API_KEY
    handle = await adapter.dispatch_batch(
        "gpt-6-sol",
        ["prompt 1", "prompt 2"],
    )
    print(handle.batch_id)
```

`OpenAIAdapter` builds the required JSONL input file in memory,
uploads it via `files.create(purpose="batch")`, and submits the batch
job — the standard OpenAI batch flow.

---

## API reference

### Top-level exports

| Name | Kind | Description |
|---|---|---|
| `defer(task, *, deadline, carbon_budget_g, region, task_id)` | async function | Defers on the process-wide default scheduler. |
| `Scheduler` | class | Explicit scheduler; supports SQLite persistence. |
| `mock_grid_feed()` | function | Deterministic synthetic feed for dev/tests. |
| `electricity_maps_feed(api_key=None)` | function | Electricity Maps free-tier API client. |
| `watttime_feed(username=None, password=None, *, fallback=None)` | function | WattTime v3 marginal (co2_moer) forecast feed for US ISOs (`WATTTIME_USERNAME`/`WATTTIME_PASSWORD`). Takes precedence over EIA where covered; falls through to `fallback` otherwise. |
| `pick_best_window(entries, deadline)` | pure function | Picks the lowest-intensity entry inside `[now, deadline]`. |
| `normalize_deadline(d)` | function | Parses + validates a user-supplied deadline. |
| `CarbonBudgetExceededError` | exception | Raised when no candidate window meets the user budget. |
| `InvalidDeadlineError` | exception (`ValueError`) | Raised when the deadline is unparseable or in the past. |
| `TaskRecord`, `CarbonReceipt`, `GridForecast`, `GridForecastEntry`, `DeferOptions` | dataclasses | Public record types. |

### `Scheduler`

```python
Scheduler(*, feed: GridFeed | None = None,
          default_region: str = "US-CAL-CISO",
          db_path: str | None = None)
```

Methods:

- `await scheduler.connect()` — opens the SQLite connection (no-op
  when `db_path` is unset).
- `await scheduler.defer(task, opts)` — deferred await. Returns the
  task's eventual result.
- `scheduler.enqueue(task, opts)` — fire-and-forget. Returns the
  `TaskRecord` immediately with `status="queued"`.
- `scheduler.get_task(task_id)` / `scheduler.list_tasks()` — in-memory
  snapshots.
- `await scheduler.load_persisted_task(task_id)` /
  `await scheduler.list_persisted_tasks()` — reads from SQLite.
- `await scheduler.tick(adapters)` — runs the due provider-call rows
  with the adapters you pass (`{"anthropic": adapter, ...}`), submits
  and polls Batch API rows, and returns a `TickResult`. It never runs
  a job; see [Jobs run on the Node daemon](#jobs-run-on-the-node-daemon).
- `await scheduler.shutdown()` — cancels in-flight schedule tasks and
  closes the DB. The class also supports `async with`.

### Jobs run on the Node daemon

This package has no jobs code. Jobs (`tidegap jobs`, MCP
`schedule_task` with a repeat) run only on the Node daemon, which
applies their time limit, budget cap and tools. When this package
shares a ledger with the Node core, `scheduler.tick(adapters)` leaves
these rows as they are:

- every job run (a row with a `job_id`) that is queued, scheduled or
  submitted, whatever its provider and the adapters you pass;
- every scheduled `command` or `claude-code` row that no adapter in
  `adapters` serves.

`expedite_task` and `retry_task` refuse a job run and name the Node
command that runs it: `tidegap queue run-now <id>` for a queued or
scheduled run, `tidegap jobs run <job id>` for any run (a job retries
a failed run itself). `cancel_task` still cancels one.

Each tick reports what it left in its `TickResult`:

| Field | Value |
|---|---|
| `held_for_node` | ids of the held rows, sorted |
| `active_jobs` | `active` jobs in the ledger (0 without a `jobs` table) |
| `node_last_tick_at` | the last Node tick (`last_tick_at`), or `None` |
| `node_report_error` | the error when the tick could not read the ledger after its sweeps, else `None` |

When it holds a row or the ledger has an active job, the tick also
logs one warning on the `tidegap.scheduler` logger with the counts and
the last Node tick. If it cannot read the ledger after its sweeps,
`held_for_node` lists the rows it held at the start of the tick, and
the warning names the error. The fix is the Node daemon: `tidegap install`, then
`tidegap status`. If you run both tickers on purpose, filter that
logger.

### Carbon-receipt schema

Every completed task has a `receipt` field:

```python
@dataclass
class CarbonReceipt:
    task_id: str
    ran_at: str
    region: str
    estimated_carbon_g_co2: float
    provider: str | None = None
    model: str | None = None
    duration_ms: float | None = None
```

The `TaskRecord` also carries `intensity_source`: `"scored"` if the
receipt used the forecast entry the scheduler chose against,
`"current"` if we had to fall back to a freshly-fetched current-hour
intensity at dispatch time.

The receipt's `estimated_carbon_g_co2` is computed via
`estimate_energy_kwh(model=..., input_tokens=..., output_tokens=...)
* grid_intensity_g_co2_per_kwh`. As of v0.6 the energy module ships
per-model Wh/token coefficients from the published research
(Patterson et al. 2021; Luccioni, Jernite, Strubell 2024; Hugging
Face AI Energy Score). When no model is specified the function
returns the pre-v0.6 flat `0.0015` kWh estimate to preserve
backwards compatibility. See `tidegap.energy` for the table and
citation metadata.

### Grid feeds

Both feeds implement `GridFeed.fetch_forecast(region, hours)`:

- `mock_grid_feed()` — deterministic intraday sinusoid with regional
  floors. Useful for dev and CI without an API key.
- `electricity_maps_feed(api_key=None)` — hits
  `api.electricitymap.org/v3/carbon-intensity/forecast` with a 5 s
  hard timeout. Falls back to the mock feed (and logs a warning) on
  any failure, mirroring the TypeScript port.

Supported region codes match Electricity Maps' zone codes
(`US-CAL-CISO`, `US-TEX-ERCO`, `US-NE-ISNE`, `US-NY-NYIS`,
`US-MIDA-PJM`, `US-MIDW-MISO`, `FR`, `DE`, `GB`, ...).

### Provider adapters

```python
from tidegap.providers import (
    AnthropicAdapter,
    OpenAIAdapter,
    GeminiAdapter,
    OllamaAdapter,
    DispatchOptions,
)
```

Every adapter implements the sync path:

```python
async def dispatch(model: str, prompt: str,
                   options: DispatchOptions | None = None) -> DispatchResult: ...
```

`AnthropicAdapter` and `OpenAIAdapter` are additionally batch-capable
(`dispatch_batch` + `retrieve_batch`, a flat 50% discount — projected,
provider list price — 24h SLA). `GeminiAdapter`
and `OllamaAdapter` are sync-only and inherit the base batch stubs — the
scheduler feature-detects that and keeps their tasks on the sync path:

- **`GeminiAdapter`** — Google's Generative Language API
  (`generativelanguage.googleapis.com`). Reads `GEMINI_API_KEY`, falling back to
  `GOOGLE_API_KEY`. Batch is deliberately unsupported: Gemini's batch modes do
  not map onto the submit → poll → results contract (Vertex batch needs
  GCS/BigQuery; the Developer-API batch is a long-running operation keyed by an
  operation name, not a batch id).
- **`OllamaAdapter`** — a local Ollama server over HTTP (default
  `http://localhost:11434`, override with `OLLAMA_HOST`). Keyless. Uses
  `/api/chat` and reports `prompt_eval_count` / `eval_count` token counts. No
  batch (local inference).

The Anthropic / OpenAI modules import cleanly even when the vendor SDK isn't
installed — construction is what raises a clear error. Gemini and Ollama use
`httpx` directly (already a core dependency), so they need no extra SDK.

---

## Persistence (Python-only in v0.2)

The Python port ships SQLite-backed durability from day one. To enable
it, construct the `Scheduler` with a `db_path`:

```python
async with Scheduler(db_path="/var/lib/tidegap/queue.sqlite") as scheduler:
    ...
```

Schema:

```sql
CREATE TABLE tasks (
    task_id           TEXT PRIMARY KEY,
    status            TEXT NOT NULL,
    enqueued_at       TEXT NOT NULL,
    scheduled_for     TEXT,
    completed_at      TEXT,
    region            TEXT NOT NULL,
    carbon_budget_g   REAL,
    result_json       TEXT,
    error             TEXT,
    receipt_json      TEXT,
    intensity_source  TEXT
);
```

Receipts and results are stored as JSON. Non-JSON results (e.g. an
Anthropic `Message` object) are stored as `{"_repr": "<repr>"}` so
audit trails survive odd value types.

Multi-writer support (multiple schedulers pointed at one DB) requires
WAL mode and is on the v0.3 roadmap.

---

## Testing

```bash
cd packages/core-py
python3 -m venv .venv
. .venv/bin/activate
pip install -e ".[dev,anthropic,openai]"
pytest -v
```

The test suite covers:

- Mock grid feed shape and intraday curve.
- `pick_best_window` correctness (empty, past, in-window).
- Scheduler accounting: queued/scheduled/running/completed
  transitions.
- Deadline validation: unparseable strings, past dates,
  `datetime` instances.
- Carbon-budget enforcement (US-MIDW-MISO floor exceeds a 0.1 g cap).
- SQLite round-trips, including reopening the DB after shutdown.
- Provider adapter request shapes and response parsing for both
  Anthropic and OpenAI (mocked SDKs — no live calls).

---

## Changes

Release notes: https://github.com/tidegap/tidegap/blob/main/CHANGELOG.md

---

## License

[Apache License 2.0](https://github.com/tidegap/tidegap/blob/main/LICENSE) — patent grant included.

---

*Built by [Vitalii Borovyk](https://github.com/Vitalini).*
