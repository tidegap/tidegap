---
title: Quota-reset deadlines are recomputed in a shared pre-tick step and written only while the task is still pending
date: 2026-10-15
category: logic-errors
module: packages/core-ts/src/quota.ts
problem_type: logic_error
component: tooling
severity: high
applies_when:
  - "Changing quota-reset scheduling or sweepQuotaDeadlines"
  - "Adding a new ticker that calls Scheduler.tick"
  - "Writing a task row from a sweep that can overlap another ticker"
tags: [quota, deadline, prepareTick, rescheduleIfPending, batch-api]
---

# Quota-reset deadlines

## Context

A `deadline_kind: "quota_reset"` task runs before the next weekly subscription reset. Config comes from `~/.tidegap/config`: `TIDEGAP_QUOTA_RESET_<LABEL>=<weekday> <HH:MM> [zone]`, `TIDEGAP_QUOTA_MARGIN_H_<LABEL>` (default 2 h, max 168).

## Rules

- **Deadline = next reset minus margin**, chosen as the first reset where `reset - margin > now` (`resolveQuotaDeadline`). The host resolves it at enqueue.
- **After a reset passes, the stored deadline is stale.** `sweepQuotaDeadlines` re-resolves `queued`/`scheduled` quota tasks whose most recent previous reset is later than the stored deadline. The test ignores the margin, so editing the margin later cannot misfire. The comparison is strict: with margin 0 the stored deadline IS the reset, so equality means "passed".
- **Every ticker calls `prepareTick` before `Scheduler.tick`** (`tidegap tick`, the OpenClaw loop). It records `last_tick_at` and runs the sweep, never throws, and returns messages. A new ticker that skips it leaves quota tasks on dead deadlines.
- **The sweep writes only to still-pending rows.** It reads the list, then another ticker may claim a task. `Scheduler.rescheduleIfPending` re-reads the row, returns false unless it is `queued`/`scheduled`, and passes `onlyIfPending` down to the store's conditional `updateIfPending`. Without this the sweep overwrote a `running`/`completed` row with `scheduled`. Since ui v2 this is one case of the general `transitionIf` rule (see `compare-and-set-task-transitions.md`).
- **Unconfigured labels are left unchanged** and reported once per label.
- **Batch API side effect:** `collectBatchSubmitCandidates` routes provider-call tasks through the Batch API when `deadline - now > 24 h` and batch is preferred. A quota deadline several days out therefore submits a batch, which the provider runs within its own 24 h SLA. This is documented in the tool description and the CHANGELOG. Do not treat it as a bug.
