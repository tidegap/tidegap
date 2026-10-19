<img src="https://www.tidegap.com/icon-192.png" alt="Tidegap" width="48" height="48">

# @tidegap/core

> Renamed from `@ebb-ai/core` in 0.18.0. See [Renamed from Ebb AI](https://github.com/tidegap/tidegap#renamed-from-ebb-ai).

Workload scheduling for the agentic-AI economy — the core TypeScript library.

`@tidegap/core` lets your code defer non-urgent LLM tasks to cheap, off-peak
grid windows. Anthropic and OpenAI Batch APIs already give a flat **50%
discount (projected, provider list price)** for 24h-tolerant work;
`@tidegap/core` makes the choice automatic,
picks the cheapest window inside your deadline, and writes an auditable
receipt (cost + carbon + provider + duration) for every dispatch.

It ships:

- `defer(fn, { deadline, region, carbonBudgetG })` — wrap any async task.
- `Scheduler` — opt-in SQLite-backed durable queue (`new Scheduler({ dbPath })`).
- Provider adapters for Anthropic + OpenAI, with sync and Batch API paths.
- Grid carbon-intensity feeds:
  - `mockGridFeed()` — deterministic synthetic curve.
  - `electricityMapsFeed(apiKey)` — Electricity Maps free-tier API.
  - `ukCarbonIntensityFeed()` — UK National Grid ESO (free, no key, GB only).
  - `multiSourceGridFeed({ feeds, fallback })` — per-zone routing.
- `recommendWindow({ region, deadline })` — planning-only API; returns the
  cleanest window without queueing.

## Install

```bash
npm install @tidegap/core
# optional adapters; install only what you use
npm install @anthropic-ai/sdk openai
```

## Quick start

```ts
import { defer } from "@tidegap/core";

const summary = await defer(
  async () => callAnthropic("Summarize today's CHANGELOG"),
  { deadline: new Date(Date.now() + 12 * 3600 * 1000).toISOString(), region: "US-CAL-CISO" },
);
```

## Documentation

Full docs, MCP server, dashboard, and architecture in the
[monorepo README](https://github.com/tidegap/tidegap).

## License

Apache-2.0.
