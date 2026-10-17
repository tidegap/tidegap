---
id: faq
label: FAQ
---

Short answers. Each one names the file it rests on.

### Is it safe for my agent to install?

<!-- source: apps/web/public/install.md ("What this is", "What the install does") -->
Yes. Tidegap is open source (Apache-2.0), and install.md is plain text that the agent can read before it runs anything. The install adds one MCP server entry to the host's config and makes no other system changes.

### Does it send my data anywhere?

<!-- source: apps/web/public/install.md; apps/web/src/app/docs/page.tsx v2 paths ("telemetry.key ... never sent") -->
Nothing goes to Tidegap's authors. Tasks and receipts stay in `~/.tidegap/queue.db` on your machine. Tidegap fetches grid forecasts from public grid feeds, and a task's prompt goes only to the AI provider you configured, when the task runs.

### Do I need an account?

<!-- source: apps/web/public/install.md ("does not require an account") -->
No. There is no Tidegap account. Provider and grid API keys are optional and stay in your own config.

### Do tasks run while my computer sleeps?

<!-- source: packages/cli/src/index.ts (install --laptop, register-wake), QUICKSTART.md step 3 -->
Not while it is asleep. On macOS, `tidegap install --laptop` adds a wake event 30 s before a task's window. Otherwise the tick runs every due task on its first pass after the computer wakes.

### How much carbon does it save?

<!-- source: docs/claims.md rows 22 and 31; docs/examples/2026-09-30-GB-tick -->
It depends on the region, the hour and the deadline. In one real GB run the forecast peak was 183 gCO2/kWh and the chosen window 88 gCO2/kWh. Every receipt records the intensity at dispatch, and the per-model energy estimates may be off by ±50%.

### Which providers and grid feeds does it use?

<!-- source: apps/web/src/app/docs/page.tsx v2 ENVS; docs/claims.md row 10 -->
Tasks go to Anthropic, OpenAI, Google Gemini or a local Ollama server. Grid data comes from National Grid ESO (GB, no key), EIA, WattTime, ENTSO-E and Electricity Maps. A region with no live feed uses a deterministic mock curve.

### What if the deadline is too close?

<!-- source: packages/core-ts/src/scheduler.ts (no usable window: dispatch immediately), packages/core-ts/src/recommend.ts -->
When no forecast hour fits between now and the deadline, Tidegap runs the task at once rather than miss the deadline. If you set a carbon budget that no hour meets, the task fails with a budget error instead.
