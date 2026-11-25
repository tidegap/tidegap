---
title: TS and Python selectWindow share one JSON fixture, and snippets pin rng because the clean band is a random pick
date: 2026-10-15
last_updated: 2026-11-24
category: best-practices
module: packages/core-ts/test/fixtures/select-window-vectors.json, packages/core-ts/src/redact.ts (DEFAULT_REDACTION_PATTERNS), packages/core-py/src/tidegap/scheduler.py (_DEFAULT_REDACTION_PATTERNS)
problem_type: best_practice
component: testing_framework
severity: medium
applies_when:
  - "Changing the window-selection policy in core-ts or core-py"
  - "Writing README or doc snippets that call recommendWindow / recommend_window and show output"
  - "Sorting or breaking a tie by a string in both cores"
  - "Writing or changing a regex that both cores hold, such as a default redaction pattern"
tags: [parity, fixtures, select-window, rng, vitest, pytest, regex, redaction, unicode, word-boundary]
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

## A regex class means one thing in `re` and another in JS (#285)

The default redaction patterns exist twice: `DEFAULT_REDACTION_PATTERNS` in `packages/core-ts/src/redact.ts` and `_DEFAULT_REDACTION_PATTERNS` in `packages/core-py/src/tidegap/scheduler.py`, whose comment says it mirrors the TS list exactly. The same pattern text does not match the same strings. Python `re` compiles a `str` pattern with Unicode classes. In JS, `\d`, `\w` and `\b` are ASCII.

- **Write the digits as `[0-9]` in Python.** In `re`, `\d` matches any Unicode digit, for example the Arabic-Indic `٧` (U+0667). #285 writes the Telegram bot token and the Discord webhook patterns with `[0-9]` in Python and keeps `\d` in TS. The check: both near-miss tables hold a token with Arabic-Indic digits and a Discord webhook id in Arabic-Indic digits (`test_default_patterns_leave_near_misses` in `packages/core-py/tests/test_audit_2026_07.py`, "default patterns: channel tokens" in `packages/core-ts/test/redact.test.ts`). A `\d` in the Python pattern fails the Python row.
- **Known gap, open: `\b` in the older patterns.** The Bearer, AWS, GitHub, Google, Slack and JWT patterns use `\b`. In `re`, a non-ASCII letter is a word character, so a key glued to one (`éAKIA…`, `ключAKIA…`) is redacted by TS and kept by Python. The Bearer pattern has a second gap: `re.IGNORECASE` folds some non-ASCII letters, such as the Kelvin sign (U+212A), into `[A-Za-z]`, and JS `/i` without `u` does not. No test row covers either case.
- **Fix for the gap, not done:** write the ASCII edge out, `(?<![A-Za-z0-9_])` for a leading `\b` and `(?![A-Za-z0-9_])` for a trailing one, as the TS cut-edge patterns (`VENDOR_KEY_PREFIXES`) already do, and add a glued-key row to both tables. `re.ASCII` is not a drop-in fix: it also makes `\s` ASCII-only, and in JS `\s` matches Unicode spaces such as U+00A0.

Rule: a pattern both cores hold spells out the class it means (`[0-9]`, `[A-Za-z0-9_]`), and its tables in both cores have one row with non-ASCII digits and one with a non-ASCII letter next to the match.
