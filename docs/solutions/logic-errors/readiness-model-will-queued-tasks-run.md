---
title: Readiness: "will queued tasks run?" needs a ticker and a runner, and the tick must record itself first
date: 2026-10-17
category: logic-errors
module: packages/core-ts/src/readiness.ts, packages/cli/src/readiness.ts, packages/cli/src/commands/tick.ts
problem_type: logic_error
component: tooling
severity: medium
applies_when:
  - "Adding a surface that tells the user whether tasks will run"
  - "Changing what `tidegap tick` writes to the ledger"
  - "Adding a provider or a notification channel that depends on the tick"
tags: [readiness, tick, daemon, last-tick, runners, status]
---

# Readiness model

PR #81 (coherence batch). Plan: `docs/plans/2026-10-17-1533-feat-coherence-batch-plan.md` (KTD1-KTD3, KTD11).

## What "will it run" needs

Two facts, both required:

1. **A ticker runs.** The daemon unit is loaded, and `last_tick_at` is fresh (about 2 intervals).
2. **Each pending task's provider has a runner.** The tick records the providers its adapters can serve in ledger meta `tick_runners`.

Core's `assessReadiness` is pure over facts the host gathers. A fact nobody can observe (Windows, the MCP server, which has no daemon probe) is `unknown` and raises no problem. A wrong "not ready" is worse than a silent one. Problem codes: `no_daemon`, `daemon_not_loaded`, `daemon_stale` (ticker, `TICKER_CODES`) and `no_runner`.

## Lesson: record `last_tick_at` before any early return

Before U4, a tick on a machine with no adapter returned early and wrote nothing. `tidegap status` then read "no tick ever ran" and said `no_daemon`, which sends the user to reinstall a daemon that works. The fix: `recordTickEvidence` runs before the no-adapter return and writes `last_tick_at` plus `tick_runners`. A daemon without runners now reads `no_runner` with the provider named.

Rule: any new early return in `tick` must come after the evidence write. Any surface that reports "the daemon is dead" must be able to tell "no tick ran" from "a tick ran and had nothing to run with".

## Rules that follow

- The ticker problems are the ones a process outside the tick can see (KTD11). The Telegram listener checks them once per poll cycle, because a stopped tick cannot report itself. `TICKER_CODES` and the readiness line are shared, not copied.
- `tidegap status` exits 0 when ready, 1 when not, creates nothing in `~/.tidegap`, and prints one fix sentence. The UI banner, the dispatcher pill ("Running · nothing can run") and the MCP reply read the same object.
- The runner snapshot may be stale for `claude` on macOS: the login-shell lookup runs only when a pending task needs it (`claude_lookup: "skipped"`), so a snapshot without `claude` does not prove the runner is missing.
