---
title: "Multi-model runs: bill every model, take the weakest confidence, and filter entries by one rule in the adapter and the core"
date: 2026-10-28
category: logic-errors
module: packages/core-ts/src/energy.ts (billModelUsage), packages/core-py/src/tidegap/energy.py (bill_model_usage), packages/cli/src/providers/claude-code.ts (reportedRun), packages/core-ts/src/scheduler.ts
problem_type: logic_error
component: tooling
symptoms:
  - "A claude -p run with a helper model or a subagent billed only the model with the most output tokens"
  - "The receipt named a model that used no tokens and billed another model's tokens with its coefficients"
  - "A negative token count made totalTokens smaller than the run's real total"
root_cause: logic_error
resolution_type: code_fix
severity: medium
tags: [receipts, billing, multi-model, claude-code, energy, parity, fixtures, rounding]
---

# Multi-model receipt billing

## Problem

`reportedRun` in `packages/cli/src/providers/claude-code.ts` picked the `modelUsage` entry with the most output tokens and billed only that model. A run where a helper model read web pages, or a subagent worked, under-reported its carbon. The CHANGELOG listed it under Known issues until #191.

## Symptoms

- The fake `claude` fixture `success` already reported two models with tokens. Its receipt had `totalTokens` 2056 before #191 and 2097 after, the sum over both models.
- In the first version of the fix, the adapter could name a model with no tokens: haiku with 0 input and 0 output next to sonnet with 500 input and 0 output gave `model` haiku, and sonnet's 500 tokens were billed with haiku's coefficients (#191 review, P3).
- A negative count (haiku with -3000 input and 60 output, next to sonnet with 4000 input and 50 output) gave `totalTokens` 1110, not 4050 (same review).

## What Didn't Work

- **Billing the dominant model.** Simple, and wrong for every run with a helper.
- **Two rules for "billed entry".** The first adapter version sorted every entry with numeric counts. The core's bill drops an entry with zero tokens or a bad count. When only one billed entry was left, the scheduler took the single-model path with the adapter's `model` and `usage`, so the receipt's name and numbers came from entries that the bill did not count.

## Solution

One bill function per core on one shared fixture (`packages/core-ts/test/fixtures/model-usage-billing-vectors.json`, read by both suites):

- **Billed entry:** every entry, except one that reports both counts as 0. A count that is absent, not a number, negative or not finite is unreported: the bill uses the typical count (500), as the single-model path does for an absent count, and the entry and `totalTokens` leave it out (batch 25). When no billed entry reports a count, the bill has no `totalTokens`, so the receipt does not state a 0 that no model reported (#194 review).
- **Grams:** each billed entry with its own model's coefficients at the dispatch intensity. The total is the unrounded sum, rounded to 0.1 g; each entry is rounded to 0.01 g, so a small helper model does not show 0. The entries may not add up to the total; the receipts page says so.
- **Order:** output tokens descending, then model id. An unreported output counts as 0. The receipt's `model` is the first entry.
- **Confidence:** `energySource` and `energyResolution` are the weakest across the entries (`measured` > `estimated` > `fallback`; `exact` > `normalized` > `family-fallback` > `default`). The total is only as sure as its least sure part; the dominant model's tiers would claim more. Both tiers describe the energy coefficients, not the token counts: an entry billed at the typical count shows that only by the count it leaves out.
- **Fewer than two billed entries:** no bill. The single-model path runs unchanged, so a one-model list gives the same receipt as before, with no `models` field.
- **The adapter applies the same rule.** `reportedRun` keeps every model it saw, leaves an unreported count out of the entry, and sorts an entry that reports both counts as 0 last, so its `model` is a billed entry whenever one exists. Its `usage` sums the reported counts of the billed entries only. With one billed entry the run takes the single-model path, and a 0 from an entry that bills nothing must not stand in for a count the billed entry did not report.

## Why This Works

The receipt's name, totals and confidence now come from one list. A bad count cannot reach `canonicalize`, which throws on a non-finite number: the receipt build catches that error, and the task completes with no receipt and only a warning in the log. Weakest-tier confidence keeps the receipt from claiming measured precision for grams that are partly estimated.

## Prevention

- When the adapter and the core both judge entries, they use one rule. The comparator is still written twice; the #191 review kept it that way, because a shared helper needs a new public export from `@tidegap/core`.
- Every rule change gets a vector in the shared billing fixture, so both cores fail together. The fixture covers measured and estimated sources together, an unknown model, a tie, a zero-token entry, no intensity, a bad count, an absent input, an absent output, both counts absent, a non-number count, no reported count at all and a 0.005 g rounding edge.
- Open edge (#194 review): the single-model path does not apply the unreported rule to a negative or non-finite number. Both schedulers accept any number as a count, and the `claude-code` adapter passes the top-level `usage` as given when `modelUsage` is absent. Only an absent or non-number count gets the typical count there.
- Open edge (#191 review): the tie-break on equal output tokens compares model ids by UTF-16 code units in TS and by code points in Python. The order differs only for ids with characters outside the Basic Multilingual Plane.

## Related Issues

- `../best-practices/signed-receipt-additive-fields.md`: how `models` entered the signed payload.
- `../best-practices/cross-language-select-window-parity.md`: the same one-fixture, two-suites pattern.
- `../tooling-decisions/running-claude-p-from-a-daemon.md`: the `claude -p` adapter.
- `cli-tick-scheduler-missing-grid-feed.md`: the dispatch intensity a receipt bills against.
