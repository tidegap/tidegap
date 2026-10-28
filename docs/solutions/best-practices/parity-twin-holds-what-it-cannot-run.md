---
title: "A parity twin that cannot run a feature holds its rows and reports them; it never runs them half-way"
date: 2026-10-28
category: best-practices
module: packages/core-py/src/tidegap (scheduler.py, types.py), packages/core-py/README.md, apps/web/content/docs/10-jobs.md
problem_type: best_practice
component: tooling
severity: high
applies_when:
  - "A feature lands in one core (TS or Python) and the other core will not port it"
  - "Two tickers with different abilities share the SQLite ledger and can claim the same rows"
  - "A library call has no CLI and no exit code, so its result object is the only signal"
  - "A report reads the ledger, and a failed read could look like an empty result"
tags: [parity, core-py, jobs, held-for-node, tick-result, shared-ledger, fail-loud, claims]
---

# A parity twin that cannot run a feature holds and reports

## Context

`tidegap` on PyPI shares the SQLite ledger with the Node core, but it has no jobs code. Before #190 its tick treated job runs as plain rows (problem frame of `docs/plans/2026-10-28-0441-fix-reliability-parity-and-receipts-plan.md`):

- It ran a due prompt-job run when the caller passed an adapter for its provider. `ProviderCallSpec.from_dict` drops the run's `caps` and `tools`, so the run had no time limit, no budget cap and no tool set. A deadline over 24 h could send it to a Batch API. Its outcome then waited for a Node sweep.
- It ran a `claude-code` job run when an adapter served that provider.
- It held a `command` or `claude-code` row with no adapter, but said nothing. With only the Python ticker running, no job ever ran, and nothing reported it.
- `expedite_task` and `retry_task` refused only `command` rows.

Two fixes were possible: port the jobs sweep and the runners to Python, or keep jobs on the Node daemon and make the Python side say so. The owner chose the second, with one more rule: no silent partial behaviour (plan, Key Decisions).

## Guidance

1. **Never run a row half-way.** A run without its caps, its tools or its sweep is not a weaker copy of the run the user scheduled; it is a different run. Hold the row, unchanged, for the core that can run it. The Python tick now holds every pending job run (`queued`, `scheduled` or `submitted`, with a `job_id`), whatever its provider and the adapters passed.
2. **Hold at the claim too, not only in the sweep.** The tick reads its held set at the start, and a Node sweep can insert a job run after that read. `claim_scheduled` and `claim_submitted` in `packages/core-py/src/tidegap/scheduler.py` match only `job_id IS NULL`, so a late job run is never claimed. A test inserts a submitted job run during the tick and fails when the predicate is removed (#190 review).
3. **Report through the only channel the caller has.** The package has no CLI and no exit code; `TickResult` is what a caller can branch on. It carries `held_for_node`, `active_jobs`, `node_last_tick_at` and `node_report_error`, Python-only fields that are part of the documented exception. The tick also logs one warning on the `tidegap.scheduler` logger with the counts and the fix (`tidegap install`, then `tidegap status`). The level is always warning: a recent Node tick does not prove that the Node daemon has a runner for the held rows.
4. **Report from the ledger, not from memory.** An in-memory copy of a held row stays `scheduled` after the Node daemon completes it. With a store, the report comes from ledger reads after the sweeps; memory counts only when there is no store.
5. **A failed read is not "nothing held".** The first version returned an empty list, 0 and `None` when the read after the sweeps failed, so the result said that nothing was held (#190 review, P2). The tick now falls back to the set it held at the start, sets `node_report_error`, and the warning names the error. Give the error its own field: a caller that reads only the list cannot tell "empty" from "unknown".
6. **A refusal names only commands that work for the row.** The first refusal named `tidegap queue run-now <id>` for every job run. The Node CLI refuses that command for a `failed` or `submitted` row, so `retry_task` always printed a broken command (#190 review, P2). `_refuse_job_run` names `queue run-now` only for a queued or scheduled row, and `tidegap jobs run <job id>` always.
7. **Write the exception where readers look, and check it.** The parity sentence in `CLAUDE.md` names the exception. The core-py README section "Jobs run on the Node daemon" and the jobs page section `{#jobs-versions}` state the rule. Drift rule K18 checks the page's provider list and `TickResult` field names against the Python source (`generated-docs-embed-and-drift-rule-with-vacuous-pass-guards.md`, section K18).

## Why This Matters

A half-way run spends the user's tokens without the limits the user set, and nothing in its result says that it was different. A silent hold fails the other way: the user waits for a job that never runs. A hold with a loud report shows the gap on every tick. When the Node daemon runs, the cost is one warning per tick, and a user who runs both tickers on purpose can filter the logger.

## When to Apply

- A core gains a row type, a field or a sweep that the other core does not have, and both cores read the same ledger.
- Running a row in the other core would mean skipping part of its contract: limits, tools, a follow-up sweep.
- A result object or a status is the only way a caller learns that work was left undone.

## Open (#190 review)

- After `shutdown()`, a hydrated in-memory copy of a job run has no `job_id`. `tick()` or `expedite_task()` on a closed scheduler could still dispatch it. This stale-hydration class is older than #190.
- Not tested: a hold of a `command` or `claude-code` row without a store; a failed read of the job rows at the start of the tick (the claims still refuse them).

## Related

- `../logic-errors/floating-jobs-occurrence-sweep.md`, rule 10: which rows each host holds.
- `cross-language-select-window-parity.md`: parity through a shared fixture, for a feature both cores have.
- `shared-sqlite-ledger-migrations.md`: the ledger both cores open.
