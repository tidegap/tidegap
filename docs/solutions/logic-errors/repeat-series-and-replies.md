---
title: Repeat series roll over from the scheduled time, wait for forecast coverage before planning, and replies cap history
date: 2026-10-15
last_updated: 2026-10-27
category: logic-errors
module: packages/core-ts/src/scheduler.ts
problem_type: logic_error
component: tooling
severity: medium
applies_when:
  - "Changing series rollover, repeat rules or stop-series behaviour"
  - "Planning a task whose window starts later than the forecast reaches"
  - "Sending reply history to a provider adapter"
tags: [series, repeat, rollSeries, replanSweep, forecast, reply, history]
---

# Repeat series and replies

## Series rollover (`Scheduler.rollSeries`)

- **The next deadline counts from the previous deadline, not from when the run finished.** `nextPeriod(prevMs, 1 day | 7 days, now)` keeps the cadence even when a run is late. `quota_reset` series use `resolveQuotaDeadline` from the later of prev deadline and now + 1 h, and fall back to weekly without a configured label.
- **The successor starts at the old time.** `notBefore` = previous deadline, `scheduledFor` = new deadline minus 1 h, no estimate. It is `scheduled` and unplanned. No forecast is fetched at rollover.
- **Rollover runs at every terminal end of an occurrence:** completed, failed, and cancelled as a skip. It runs before the terminal write and before the body is redacted, because the successor copies `bodyJson`. Failures are logged and never thrown.
- **Stop series** is cancel with `series: true`: it writes `repeat = none` on the occurrence and cancels the other pending occurrences. A plain cancel is a skip and the series continues. Occurrences already `running` are left to finish; their rollover reads the stored `none` and ends. Concurrency details: `compare-and-set-task-transitions.md`.
- **Stop series from a finished occurrence ends the series at its live one (#167).** An agent or a user often holds the id of the run that just finished, not of the next one. Before #167, `cancelTask` returned a terminal row unchanged, so `series=true` on it did nothing, while MCP, OpenClaw and `tidegap queue cancel --series` all replied "series ended". Now, on a terminal occurrence with a `seriesId`, `cancelTask` finds the series' non-terminal occurrence and cancels it with `series: true` (`Scheduler.cancelTask`, `packages/core-ts/src/scheduler.ts`). Test: `packages/core-ts/test/series.test.ts` (a `quota_reset` series). The Python `cancel_task` takes no series option.
- A moved occurrence keeps its series: kind and quota label follow the series rule, not the single moved row.

## Forecast coverage before planning

- A forecast reaches only a limited horizon. A successor pinned by `notBefore` days ahead has no forecast for its window. Planning on the first hours alone would fix the run at the start of the day.
- `scheduleProviderCall` therefore leaves a pinned task **unplanned** (status `scheduled`, `scheduledFor` clamped into the window, no estimate) until the forecast covers `min(deadline, notBefore + 1 day) - 1 h`. The 1 h slack is because forecast hours start on the hour, so a fetch up to the deadline ends just short of it.
- `replanSweep` retries each tick and plans once coverage exists. Do not "fix" an unplanned row by planning early.

## Replies (`Scheduler.replyToTask`)

- A reply is a new child task (`parentTaskId`) with the parent's turns as `messages` and the reply text as `prompt`. Only completed provider-call tasks accept one.
- **History is capped** by `capHistory` at `HISTORY_MAX_CHARS` (200 000). It drops the oldest turns, a user/assistant pair at a time. The newest pair always stays. The first kept turn is always `user`, because providers reject a conversation that starts with the assistant.
- **Role order at the adapter:** `conversation(prompt, options)` appends the prompt as the last `user` turn. OpenAI-style adapters put `system` first. Gemini maps `assistant` to `model`. Absent or empty `messages` is the old single-turn request.

See also: `time-of-day-bugs-and-fake-time-sweeps.md` (a day-start `scheduledFor` read as a pin).
