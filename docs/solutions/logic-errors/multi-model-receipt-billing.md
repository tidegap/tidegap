---
title: "Multi-model runs: bill every model, take the weakest confidence, and filter entries by one rule in the adapter and the core"
date: 2026-10-28
last_updated: 2026-10-30
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
tags: [receipts, billing, multi-model, claude-code, energy, parity, fixtures, rounding, unreported-count, total-tokens]
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
- **Confidence:** `energySource` and `energyResolution` are the weakest across the entries (`measured` > `estimated` > `fallback`; `exact` > `normalized` > `family-fallback` > `default`). The total is only as sure as its least sure part; the dominant model's tiers would claim more. Both tiers describe the energy coefficients, not the token counts.
- **Token counts (batch 27):** the signed top-level `tokenCounts` says when the grams rest on a count that was not reported in full: `partial` when some count or input part was reported, `typical` when none was, absent when every billed count was. It covers every billed entry; an entry has no marker of its own, its missing count shows which one. A new `energySource` value was rejected: every reader ranks that field, and a second meaning breaks the rank.
- **Input reported in part (batch 27):** an adapter that sees an input part that is not a count (a `null` cache-write part next to a fresh input) leaves the input out and passes `partialInputTokens`, the sum of the counted parts. The bill charges max(`partialInputTokens`, 500); the entry and `totalTokens` leave the input out; the marker is `partial`. The field is adapter-to-core input only. The `claude-code` adapter applies it on the `modelUsage` path and the top-level `usage` path alike, and passes it in `usage` only when one entry is billed. Signing the sum of the parts was rejected: it signs a count known to be incomplete. Billing 500 was rejected: it bills a cache-heavy run at its typical count when 90000 tokens were reported.
- **Fewer than two billed entries:** no bill. The single-model path bills `usage` under one model, so a one-model list gives the same receipt as before, with no `models` field.
- **The single-model path uses the same count rule (batch 27).** `singleModelCounts` in `packages/core-ts/src/energy.ts` and `single_model_counts` in `packages/core-py/src/tidegap/energy.py` turn the run's raw counts into the counts to bill, the total and the marker, for the sync and the Batch builders of both cores. A negative, `NaN` or infinite count is billed at 500 instead of billing negative energy or making `canonicalize` throw, which left the task with no receipt. Beside a marker the single-model receipt has no `totalTokens`: the adapters add input and output after checking only that both are present, so `-3000 + 5000` gave a total of 2000 that included the rejected count (#204 review). A sum of counts that overflows to `Infinity` is left out too, on the single-model and the multi-model path. In Python, an integer that does not convert to a finite double is not a count (`math.isfinite(10**400)` raises `OverflowError`; JSON gives TS `Infinity`). The vectors are the `singleModel` list of the shared billing fixture.
- **The adapter applies the same rule.** `reportedRun` keeps every model it saw, leaves an unreported count out of the entry, and sorts an entry that reports both counts as 0 last, so its `model` is a billed entry whenever one exists. Its `usage` sums the reported counts of the billed entries only. With one billed entry the run takes the single-model path, and a 0 from an entry that bills nothing must not stand in for a count the billed entry did not report.

## Why This Works

The receipt's name, totals and confidence now come from one list. A bad count cannot reach `canonicalize`, which throws on a non-finite number: the receipt build catches that error, and the task completes with no receipt and only a warning in the log. Weakest-tier confidence keeps the receipt from claiming measured precision for grams that are partly estimated.

A signed receipt states only what was measured. The bill must charge a model that ran, so an unreported count is billed at the typical count; but the receipt must not sign a count that nobody reported, so the entry and `totalTokens` leave it out. Before #194 the adapter wrote `?? 0`: the receipt signed a 0, and the bill charged 0 tokens for that count. Absent is the honest value for a count, and the typical count is the honest value for the bill; they are different fields.

## Prevention

- When the adapter and the core both judge entries, they use one rule. The comparator is still written twice; the #191 review kept it that way, because a shared helper needs a new public export from `@tidegap/core`.
- Compare vector results strictly. `receipt-models.test.ts` compares entries with `toStrictEqual` and checks that `totalTokens` is not a key when the vector expects `null`. `toEqual` treats `{ inputTokens: undefined }` as `{}`, so a count written as `undefined` instead of left out would pass (#194).
- Every rule change gets a vector in the shared billing fixture, so both cores fail together. The fixture covers measured and estimated sources together, an unknown model, a tie, a zero-token entry, no intensity, a bad count, an absent input, an absent output, both counts absent, a non-number count, no reported count at all and a 0.005 g rounding edge.
- Open edge (batch 27): on the single-model path, when both counts are reported, TS shows the provider's `totalTokens` and Python sums input and output when the run gives no total. The count rule applies to both; the source of the total is not unified, and no shared vector has both counts without a total.
- Open edge (#191 review): the tie-break on equal output tokens compares model ids by UTF-16 code units in TS and by code points in Python. The order differs only for ids with characters outside the Basic Multilingual Plane.

## Related Issues

- `../best-practices/signed-receipt-additive-fields.md`: how `models` entered the signed payload.
- `../best-practices/cross-language-select-window-parity.md`: the same one-fixture, two-suites pattern.
- `../tooling-decisions/running-claude-p-from-a-daemon.md`: the `claude -p` adapter.
- `cli-tick-scheduler-missing-grid-feed.md`: the dispatch intensity a receipt bills against.
