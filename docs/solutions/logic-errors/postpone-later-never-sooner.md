---
title: "Later" postpone presets: never earlier than the planned start, and how each preset moves the deadline
date: 2026-10-17
category: logic-errors
module: packages/core-ts/src/postpone.ts, packages/core-ts/src/scheduler.ts (postponeTask)
problem_type: logic_error
component: tooling
severity: medium
applies_when:
  - "Adding or changing a postpone, snooze or reschedule action"
  - "A client (page, Mac app, extension, Telegram, MCP) offers a time shortcut"
tags: [postpone, later, presets, not-before, deadline, compare-and-set]
---

# Later: never sooner

PR #81. Decision log in `docs/plans/2026-10-17-1533-feat-coherence-batch-plan.md`.

## Rule

"Later" moves a pending task to a time at or after its current planned start. A target at or before the planned start is refused with the planned time (API: 409). A client that wants "sooner" calls Run now. That action overrides `notBefore` on purpose and leaves no audit row: `run-now-clears-not-before-without-audit.md`. Because Later never lowers `notBefore`, the two actions cannot be confused.

If the task has no future plan (planned start is now), a window that starts now counts as later, so "Tonight" on a due task at 22:30 still works. A caller `reset_at` in the past is refused.

## One vocabulary

Presets `1h`, `tonight`, `tomorrow_morning`, `after_limit_reset`, plus `until`, `delay_minutes` and the CLI `+<dur>`. Resolved in the process's local time zone, in core, once. Surfaces only map ids to labels (`POSTPONE_LABELS`). `later_options` in the API carries each preset's resolved start, or the reason it is unavailable (for `after_limit_reset` without a reset, how to give one).

## Deadline per preset

| Preset | Reschedule shape | Deadline |
| --- | --- | --- |
| delay (`1h`, `+dur`), `after_limit_reset` | `{notBefore}` | `max(old deadline, notBefore + 2 h)` (the plan's KTD4 said +1 h; the log corrects it) |
| `tonight`, `tomorrow_morning` | `{dayStart, dayEnd}` | window end: the task runs inside the window |
| pin (`until`) | `{at}` | as `rescheduleTask` |

Owner call kept as a default: day presets can lower a later deadline. Override would keep it.

`after_limit_reset` takes the reset from, in order: the caller's `reset_at`, the plugged-in source (`usageLimitResetSource()`, `claude-code` and `anthropic` tasks only, async), a still-future reset given before. With none it is refused with "needs the reset time". Usage side: `../tooling-decisions/claude-usage-limits-source-and-deferral.md`.

The write is a compare-and-set on pending statuses (`compare-and-set-task-transitions.md`). A `quota_reset` task becomes `absolute`. Only the selected occurrence of a series moves.
