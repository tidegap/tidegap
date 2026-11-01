---
title: A gap the machine slept through is not a dead tick daemon; count missed ticks on awake time
date: 2026-10-22
last_updated: 2026-11-01
category: logic-errors
module: packages/core-ts (readiness.ts), packages/cli (platform/sleep.ts, platform/probe.ts, channels/serve.ts, commands/tick.ts, ui/dispatcher.ts, ui/api.ts)
problem_type: logic_error
component: tooling
severity: medium
applies_when:
  - "Code judges a periodic job dead from wall-clock time since its last run"
  - "The job runs on a laptop that sleeps (launchd or systemd timer)"
  - "An alert is sent from a gap measurement"
  - "A sweep fails a long-running row (a job occurrence) from its age"
  - "Code calls a ticker running, or allows a second ticker, from the age of last_tick_at"
tags: [sleep, launchd, kern-waketime, hrtime, readiness, false-alert, recovery-message, jobs, interrupted, dispatcher, start-dispatcher, second-ticker]
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

## The dispatcher state follows the same rule (PR #216)

After #144 and #145, readiness and the page's age text (`agoAwake`, `packages/cli/ui/dom.js:152`) counted awake time. The UI server's dispatcher state did not: `DispatcherControl.state()` called a tick recent only within two intervals of wall time. After a sleep the pill turned amber ("Dispatcher idle · 2 min ago") while readiness called the daemon on time. `start()` read the same state, so Start dispatcher spawned a second ticker beside the daemon that had just woken.

- **Fix the shared state, not one view of it.** `state(ticker)` and `start(ticker)` (`packages/cli/src/ui/dispatcher.ts:128`) take readiness's `ticker`. A tick is also recent when `ticker.recent` is true and `ticker.last_tick_at` is the same instant as the ledger's `last_tick_at`. A page-side override of the pill from `readiness.ticker.recent` was rejected: the dialog's state row, Start dispatcher, `nextTickHint` (`packages/cli/ui/app.js:402`) and the agenda's overdue rule (`packages/cli/ui/agenda.js:35`) read `dispatcher.state`, so the pill would disagree with them.
- **Reuse the reading; do not take a second one.** `status()` in `packages/cli/src/ui/api.ts` reads readiness once, before the dispatcher state, and passes its ticker. Readiness reads the sleep counter only for a gap over two intervals (`sleepReadNeeded`), so the fix adds no `sysctl` spawn. The start route reads readiness too; a failed read there leaves the wall rule. `status()` still fails when readiness throws, as before.
- **A reading counts only for its own tick**, the same pairing as `agoAwake`. Another ticker (the OpenClaw loop) can move `last_tick_at` without a reading.
- **Accepted: Start is refused for up to 3 awake intervals after a sleep** while the daemon has not ticked yet: 3 min without the daemon (60 s interval), 15 min with it (300 s). The page does not offer Start in that window, because the pill, the banner and the dialog all read running, and a dead daemon frees Start after that time. Do not cut the bound to 2 intervals for the dispatcher: launchd can start a new interval at the wake, so in the third interval the state would read stale, and Start would spawn a ticker beside a daemon that is about to tick.
- **Open.** The daemon probe is cached for 30 s (`PROBE_TTL_MS`, `packages/cli/src/readiness.ts:74`). For up to 30 s after an install or uninstall, readiness can use the 300 s interval while the dispatcher state uses 60 s.

Rule: when a check moves to the awake rule, grep every reader that decides "running" from the age of `last_tick_at` (`LAST_TICK_META_KEY`, `last_tick_at`). Each one takes readiness's ticker, or reads a state that does.

Tests: `packages/cli/test/ui-actions.test.ts`, "after a sleep: readiness counts awake time for the tick the ledger shows": the same tick gives running and 409 with nothing spawned; a reading of another tick gives stale and 201; a tick late on awake time gives stale; 10 of 20 minutes asleep gives stale and 201; readiness that fails on the start route leaves the wall rule.

## Tests worth copying

Fake counters (same boot, other boot, counter going back); Linux clocks injected through `LinuxClocks`; `readSleep` returns null under a test runner without injected clocks. QA: `telegram` S5.14.
