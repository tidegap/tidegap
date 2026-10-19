---
id: config
label: Config
---

<!-- source: apps/web/src/app/docs/page.tsx (v2 paths and ENVS), QUICKSTART.md step 4 -->
Tidegap works with no keys and no config. Keys unlock live grid data for more regions and let the tick send tasks to a provider.

### Paths {#paths}

| Path | What it holds |
| --- | --- |
| `~/.tidegap/queue.db` | The SQLite ledger: the queue and the carbon receipts. The CLI, the MCP server and `tidegap ui` share it. |
| `~/.tidegap/signing.key` | The private key that signs receipts (`0600`), with `signing.key.pub` next to it. It never leaves the machine. |
| `~/.tidegap/telemetry.key` | Reserved for a planned opt-in leaderboard. Not created until you opt in, and never sent. |
| `~/.tidegap/ui.json` | The port and pid of a running `tidegap ui`. No token. |

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

Without a grid key, a region other than GB uses a deterministic mock curve. Without a provider key, tasks are queued but not sent.

### OpenClaw plugin config {#openclaw-config}

The OpenClaw plugin reads no environment variables. Set the keys from the last column under `plugins.entries.tidegap.config` in the gateway config. OpenClaw resolves `"${ENV_VAR}"` in those fields, so the values can still come from the environment.
