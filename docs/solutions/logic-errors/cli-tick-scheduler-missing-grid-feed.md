---
title: A host that builds its own Scheduler must pass buildDefaultGridFeed, or receipts silently carry mock intensity
date: 2026-09-30
category: logic-errors
module: packages/cli (tick command) / packages/core-ts (Scheduler)
problem_type: logic_error
component: background_job
severity: high
symptoms:
  - "`tidegap tick` receipts for a region with a live feed (e.g. GB) recorded `gridSource: \"mock\"` instead of the region's real feed"
  - "`tidegap verify` and `tidegap receipts list` printed the `!! MOCK DATA` warning for dispatches that should have used a live grid feed"
root_cause: missing_workflow_step
resolution_type: code_fix
related_components: [mcp-server, core-ts]
tags: [scheduler, grid-feed, mock-data, cli, receipts, silent-failure]
---

# A host that builds its own Scheduler must pass buildDefaultGridFeed, or receipts silently carry mock intensity

## Problem

`packages/cli/src/commands/tick.ts` constructed its own `Scheduler` instance for `tidegap tick` without passing a `feed` option, while `packages/mcp-server/src/server.ts:354` already defaulted to `deps.feed ?? buildDefaultGridFeed(env.grid)`. `Scheduler` itself has no implicit default — leaving `feed` unset means dispatch-time intensity is read from `mockGridFeed()`'s synthetic curve (`packages/core-ts/src/grid.ts:80-99`). Every `tidegap tick` receipt, for every region including GB (which has a live, keyless feed via `ukCarbonIntensityFeed`), recorded `gridSource: "mock"`. This shipped for months before this PR's fix (commit `0fa4476`, "fix(cli): tick uses the region's grid feed for receipts").

## Symptoms

- Receipts from `tidegap tick` showed `gridSource: "mock"` even for GB.
- `tidegap verify` and `tidegap receipts list` (`packages/cli/src/commands/verify.ts:126-127`, `packages/cli/src/commands/receipts.ts:64`) print `!! MOCK DATA — grid intensity is synthetic, not from a real feed` — the visible tell, but only if someone ran those commands and read the line.
- No test failed. `pnpm preflight` stayed green throughout, because nothing asserted `gridSource` on a CLI-produced receipt.

## What Didn't Work

Nothing actively failed — that's the danger. The bug was a silent default, not an error path: `Scheduler`'s constructor accepts `feed` as optional and falls back to the mock without logging at the CLI layer (the mock feed itself logs "using mock data" only on live-feed fetch failure, not on "no feed given at all" — see `grid.ts:135`, `220`, `444`). There was no crash, no red test, and no obviously wrong output to trigger investigation; the only signal was noticing the `!! MOCK DATA` line in the CLI's own verbose output.

## Solution

Pass `buildDefaultGridFeed(env.grid)` to the `Scheduler` constructor in `tick.ts`, exactly as `server.ts` already did:

```ts
// packages/cli/src/commands/tick.ts:186-192
const scheduler = new Scheduler({
  dbPath,
  defaultRegion: resolveRegion(undefined, opts.region).region,
  // Same feed the MCP server uses, so the receipt's dispatch-time
  // intensity comes from the region's live feed (mock only as fallback).
  feed: buildDefaultGridFeed(env.grid),
  ...
```

And add a regression test (`packages/cli/test/tick.test.ts`, "tick receipts use the region's grid feed") that stubs `fetch` for the GB Carbon Intensity API, dispatches one task, and asserts on the stored receipt:

```ts
expect(receipt?.gridSource).toBe("ukCarbonIntensity");
expect(receipt?.intensityGCo2PerKwh).toBe(123);
```

## Why This Works

`buildDefaultGridFeed()` (`packages/core-ts/src/grid.ts:1149`) is the "best free feed per zone, mock fallback" composite feed — the same one the MCP server already used. Passing it explicitly removes the implicit reliance on `Scheduler`'s undocumented default-to-mock behavior. Asserting `gridSource` (not just "tick dispatched") is what actually catches a missing feed: a test that only checks dispatch count passes identically whether the feed is live or mock, which is exactly how this bug survived for months.

## Prevention

- **Any new host that constructs a `Scheduler` directly must pass `feed: buildDefaultGridFeed(env.grid)`** (or an explicit `mockGridFeed()` if mock behavior is genuinely intended — e.g. in unit tests). Grep for `new Scheduler(` when adding a host and confirm `feed` is set.
- **A test that exercises real dispatch must assert `gridSource` on the resulting receipt**, not just that dispatch happened. A count-only assertion (`"1 dispatched"`) is silently compatible with both a working feed and a missing one.
- Treat `Scheduler`'s optional, silently-defaulting `feed` parameter as a footgun: consider whether a future refactor should make `feed` required at the `Scheduler` call site, forcing every host to make the choice explicit rather than inheriting a fallback.

## Related

- `packages/core-ts/src/grid.ts:1149` — `buildDefaultGridFeed` definition and doc comment.
- `packages/mcp-server/src/server.ts:354` — the pre-existing correct usage this fix matched.
- `packages/cli/src/commands/verify.ts:126-127`, `packages/cli/src/commands/receipts.ts:64` — the `!! MOCK DATA` tell that exposed this bug.
- `docs/plans/2026-09-30-1647-chore-infoq-article-prep-plan.md` — plan unit that scoped this fix alongside the InfoQ article prep (PR #37).
- CHANGELOG.md, "Fixed" section under the unreleased/0.16.0 heading — user-facing note on the same fix.
