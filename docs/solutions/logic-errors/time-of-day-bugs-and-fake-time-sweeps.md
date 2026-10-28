---
title: Time-of-day bugs hide behind the clock; sweep fake time across hours, DST ends and zones in one test run
date: 2026-10-16
category: logic-errors
module: packages/core-ts (scheduler.ts, grid.ts, quota.ts), packages/openclaw-plugin tests, packages/cli/test/ui-channel-card.test.ts, .github/workflows/ci.yml (tz job)
problem_type: logic_error
component: tooling
severity: high
last_updated: 2026-10-28
applies_when:
  - "A test passes or fails depending on the hour or the time zone it runs in"
  - "Code infers a state (such as 'pinned') by comparing two timestamps"
  - "Code floors or rounds 'now' to an hour, or builds day boundaries"
  - "Tests in one file share a ledger or store"
  - "A test asserts a local-day label (today, a weekday, a date) for a fixed instant"
tags: [flaky-test, time-of-day, dst, utc, fake-timers, pinned-rows, shared-ledger, fixtures, zone-offsets, ci-tz]
---

# Time-of-day bugs and fake-time sweeps

PR #59 (fix of the failure that blocked every PR on 2026-10-16). An earlier flake, PR #39 (`fix/test-tick-future-flake`), was a test-only clock fix. This one was two code bugs and two test bugs. Rule: **a test that fails only at some hours is a code bug until a sweep says otherwise.**

## Findings

1. **Do not infer "pinned" from `scheduledFor === notBefore`.** A re-plan that moved a task to a day beyond the forecast kept its time of day. Enqueued between 19:00 and 19:59 UTC with a 6 h window, the fallback landed exactly on 00:00 UTC, equal to `notBefore`. `replanSweep` (`quota.ts`) and `isBatchCandidate` (`scheduler.ts`) read that as an exact-time pin and never gave the row a carbon window. Fix: the day fallback moves one minute into the day. A derived marker needs a value no other path can produce, or an explicit flag.
2. **Floor "now" in UTC, never in local time.** Feeds used `setMinutes(0,0,0)`. In the repeated hour at DST end (Europe/Kyiv, 2026-10-25) that resolves one hour early, so the forecast fell one hour short. Local flooring is also wrong in zones with :30 and :45 offsets. All four feeds (mock, UK, EIA, ENTSO-E) now use `setUTCMinutes`; `grid.test.ts` and `grid-feeds-fixtures.test.ts` check the UTC hour under Europe/Kyiv, Asia/Kolkata, America/Los_Angeles and UTC.
3. **Tests that share a ledger must assert on their own task.** The plugin AE9 test shared its ledger with the `schedule_task` test, whose task the mock curve can place in the current hour; the tick then ran it. The AE9 test now checks only that its own quota task was not dispatched. A second test bug: the "stale cache" test dispatched on its first tick at 04:xx UTC because the mock curve picks the current hour; it now pins the row an hour out.

## The sweep (reusable method)

Copy the test file to a throwaway, not committed. Run it under fake `Date` at HH:30 for **every hour of several days**: an ordinary day, the EU DST end (2026-10-25), the US DST end (2026-11-01), and the days around them. That was 120 instants, in one vitest run per zone (`TZ=UTC`, `Europe/Kyiv`, `America/Los_Angeles`). One run replaces waiting a day for the clock to reach the bad hour. Before the fix it failed at 19:30 UTC, 04:30 UTC and 2026-10-24 12:30 in Kyiv; after, 2651/2651 in each zone.

## Fixture instants and zone offsets (PR #184)

The `tz` job in `.github/workflows/ci.yml` runs the core, MCP and CLI tests under `Asia/Kolkata` (+05:30) and `Pacific/Kiritimati` (+14:00). Before #184 it ran the core tests only. Its first run with the CLI tests failed one test: `ui-channel-card.test.ts` expected "Last message today HH:MM" and got "Last message Mon 19 Oct 23:59". NOW was 10:00 UTC, which is local midnight at +14:00, so a delivery one minute before NOW fell on the previous local day. The card was right; the fixture was wrong.

- **A fixture instant on a whole UTC hour is local midnight somewhere.** Zone offsets run from -12:00 to +14:00, and every offset is a whole number of quarter hours (+05:45, +08:45, +13:45, -09:30 and -02:30 exist). So local midnight in any zone falls on a UTC quarter hour (:00, :15, :30, :45). When a test asserts a local day, keep NOW and each instant the assertion compares inside one UTC quarter hour, off its edges. `NOW = 10:07:30Z` with deltas under 7 minutes does this. A larger delta needs a fixed `TZ` for that test, or an assertion on the instant instead of the label.
- **CI checks two zones; a fixture change checks twelve.** The `tz` job catches a half-hour offset and the far end. For a change to a fixture or to a local-day label, run the file once per zone, as in the sweep above. The #184 review used these offsets: UTC, +05:30, +05:45, +08:45, +13:45, +14:00, -02:30, -09:30, -10:00, -11:00, -12:00, and +14:00 again as `Etc/GMT-14` (no DST rules). Example names: `Asia/Kathmandu` (+05:45), `Australia/Eucla` (+08:45), `Pacific/Chatham` (+13:45 in its summer), `America/St_Johns` (-02:30 in its summer), `Pacific/Marquesas` (-09:30), `Etc/GMT+12` (-12:00). The `Etc/GMT` names invert the sign.

## Not repaired

Rows already moved this way by 0.17 or 0.18 keep their day-start time. They cannot be told apart from a real exact-time pin. The CHANGELOG says so.

## Related

- `repeat-series-and-replies.md` (pinned tasks stay unplanned until the forecast covers the window)
- `quota-reset-deadlines.md`
