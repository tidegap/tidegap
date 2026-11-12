---
title: TS and Python selectWindow share one JSON fixture, and snippets pin rng because the clean band is a random pick
date: 2026-10-15
category: best-practices
module: packages/core-ts/test/fixtures/select-window-vectors.json
problem_type: best_practice
component: testing_framework
severity: medium
applies_when:
  - "Changing the window-selection policy in core-ts or core-py"
  - "Writing README or doc snippets that call recommendWindow / recommend_window and show output"
  - "Sorting or breaking a tie by a string in both cores"
tags: [parity, fixtures, select-window, rng, vitest, pytest]
---

# TS and Python selectWindow share one JSON fixture, and snippets pin rng

## Context

`selectWindow` exists twice: `packages/core-ts/src/select-window.ts` and the Python port in `packages/core-py`. Nothing tied them together, so the two selection policies could drift silently.

## Guidance

**One fixture, read by both suites.** `packages/core-ts/test/fixtures/select-window-vectors.json` holds vectors: `id`, `now`, `deadline`, `rng`, `entries` (datetime, intensity, band) and `expected` (`chosen_datetime`, `chosen_intensity`, `band_size`, `tolerance`, or `null` when no window fits). `select-window.test.ts` (vitest, `it.each`) and `test_select_window.py` (pytest, `parametrize`) both load it, inject `now` and `rng`, and assert the same results. A policy change in one language turns the other suite red. The fixture lives under core-ts; the Python test reaches it by relative path (`parents[2] / "core-ts" / ...`), so do not move it without updating both.

**Why `rng` is in every vector.** Inside the clean band of near-equal hours, the policy picks at random, to spread dispatch load. A vector without a pinned `rng` is not reproducible. Pin `rng` to a constant; `0` yields the strict minimum.

**README snippets pin `rng: () => 0` for the same reason.** Without it, two runs of the snippet return different hours, and the printed output comment would look wrong. The README says so explicitly. The output value itself is a live forecast, so it is a claims row (#33), see [claims-audit-method](claims-audit-method.md).

## Adding a vector

Add one entry to the JSON, run the core-ts vitest suite and the core-py pytest suite in `packages/core-py`. Both must pass with no code change to the tests.

## Order keys must be computed the same way in both languages (batch 37)

A sort or tie-break that both cores sign must use a key that both runtimes compute identically. JS compares strings by UTF-16 code units; Python `str` compares by code points, so the two disagree for ids outside the Basic Multilingual Plane. Python uses `s.encode("utf-16-be", "surrogatepass")` as the key (`surrogatepass` keeps a lone surrogate instead of raising). The fix was proved by one generator that fed the same 3000 random ids to both sides and compared the orders; the committed proof is a shared vector (`vec-models-non-bmp`) plus a Python test that fails with the old key. Rule detail: `../logic-errors/multi-model-receipt-billing.md`.
