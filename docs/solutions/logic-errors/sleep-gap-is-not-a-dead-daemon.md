---
title: A gap the machine slept through is not a dead tick daemon; count missed ticks on awake time
date: 2026-10-22
last_updated: 2026-10-27
category: logic-errors
module: packages/core-ts (readiness.ts), packages/cli (platform/sleep.ts, platform/probe.ts, channels/serve.ts, commands/tick.ts)
problem_type: logic_error
component: tooling
severity: medium
applies_when:
  - "Code judges a periodic job dead from wall-clock time since its last run"
  - "The job runs on a laptop that sleeps (launchd or systemd timer)"
  - "An alert is sent from a gap measurement"
  - "A sweep fails a long-running row (a job occurrence) from its age"
tags: [sleep, launchd, kern-waketime, hrtime, readiness, false-alert, recovery-message, jobs, interrupted]
---

# A sleep gap is not a dead daemon

PR #144. After a Mac sleep (11:05 to 11:24) the listener sent "the tick daemon is not running". The daemon was fine: `assessReadiness` compared wall-clock time since `last_tick_at` with two intervals. Rule: **count missed ticks on awake time, never on wall time.**

## The sleep counter

Each CLI tick stores a `SleepReading` (`boot_at`, `slept_ms`, `woke_at`) in ledger meta `last_tick_sleep` (`writeTickSleep`, with the tick time `at`). Readiness compares the stored reading with one taken now (`sleptBetween`).

| Platform | How `slept_ms` is read (`readSleep` in `platform/sleep.ts`) |
| --- | --- |
| macOS | `sysctl -n kern.boottime kern.waketime kern.wake_abs_time hw.tbfrequency`. Sleep since boot = (`kern.waketime` - `kern.boottime`) - `kern.wake_abs_time` / `hw.tbfrequency`. `wake_abs_time` counts awake ticks only. `waketime` 0 = never slept. |
| Linux | `os.uptime()` (boot clock, counts suspend) minus `process.hrtime` (monotonic, does not). |
| Other, or a key is missing / unparsable | `null`: no reading, the old two-interval wall rule applies. A failing `sysctl` must never hide a real dead daemon. |

- Do not use `process.hrtime` on macOS. It equals `mach_continuous_time`, which counts through sleep, so it gives no sleep.
- DarkWake (a short wake for Power Nap or maintenance) moves `kern.waketime`. On AC power DarkWake keeps ticks running, so the tick daemon may fire inside a "sleep". The arithmetic stays right: the counter holds only time with no awake ticks.
- Two readings pair only when `boot_at` is within 2 minutes (another boot gives 0) and the stored `at` matches `last_tick_at`. Another ticker (the OpenClaw loop) can move `last_tick_at` without a reading.
- `sleptBetween` is capped at the wall gap; a counter that went back gives 0.

## The bound: 3 intervals after a sleep

`recent = wallGap - slept <= (asleep ? 3 : 2) * intervalS`. After a wake launchd may start a new interval at the wake, so one more interval is allowed. `asleep` needs at least 60 s of sleep.

The sleep counter is read only for a gap over 2 intervals (`sleepReadNeeded` in core; used by `tickerReadiness` in `serve.ts` and `gatherReadiness`). Shorter gaps cost no `sysctl` spawn.

## Unit tick or manual tick

A manual `tidegap tick --once` proves nothing about the unit. `tickStartedBy` (`commands/tick.ts`) stores `last_tick_by`: `unit` for `--daemon`, a launchd job (`XPC_SERVICE_NAME` is the job label) or systemd (`INVOCATION_ID`); else `manual`.

## Recovery message rules (`notReadyEvent`, `channels/emit.ts`)

- Sent once ("the tick daemon is running again"), only after a ticker alert was actually sent. No alert sent, no recovery.
- A manual tick keeps the sent mark and sends nothing.
- Quiet hours apply. The daily summary never folds it.
- Payload: `"recovered": true`; ntfy uses the `task_done` priority.

## No reading here, a reading at dispatch: wait, do not fall back

The table's `null` rule (fall back to the wall clock) fits readiness, where a false "not running" alert is the cost. It does not fit a check that fails work. The job sweep fails a `running` occurrence as interrupted after its caps of awake time (`interrupted`, `packages/core-ts/src/jobs.ts`). The OpenClaw loop passes no sleep reading, so on a shared ledger its sweep would fail a CLI run that only slept. Since #164, a host with no reading waits until the later of the deadline and the dispatch, plus the caps, when the `dispatched` event stored a reading; a host that can read the counter decides first, and a dead tick still frees the job by then. Details: `floating-jobs-occurrence-sweep.md`, rule 5.

## Tests worth copying

Fake counters (same boot, other boot, counter going back); Linux clocks injected through `LinuxClocks`; `readSleep` returns null under a test runner without injected clocks. QA: `telegram` S5.14.
