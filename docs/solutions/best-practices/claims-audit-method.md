---
title: Auditing quantitative claims — classify measured/simulated/projected with a repo source, and a served-page grep on Next.js App Router double-counts
date: 2026-09-30
category: best-practices
module: docs/claims.md / apps/web (Next.js App Router)
problem_type: best_practice
component: documentation
severity: medium
applies_when:
  - "Auditing or writing copy (README, site, marketing) that states a number derived from this repo's code, tests, or a captured run"
  - "Verifying a string appears on a served Next.js App Router page by curling the HTML and counting matches"
tags: [claims-audit, documentation, nextjs, rsc, served-page-check, unsourced-claims]
---

# Auditing quantitative claims — classify measured/simulated/projected with a repo source, and a served-page grep on Next.js App Router double-counts

## Context

Ahead of the InfoQ article prep (PR #37), several headline numbers in the README and site (e.g. "40 to 70% lower carbon", "−80% vs dispatching at peak") turned out to have no computation or run behind them anywhere in the repo. `docs/claims.md` was built to audit every quantitative claim in `README.md`, `QUICKSTART.md`, `packages/*/README.md`, `apps/web/README.md` and `apps/web/src` against the code, and to drop or reword anything that couldn't be sourced rather than softening it with hedge words.

## Guidance

**Give every claim a row: the claim, where it appears, its class, its source, and the decision.**

`docs/claims.md`'s legend defines three classes, in order of how directly the number is tied to this repo:

- **Measured** — produced by a run, test, or direct code inspection, with the command or file cited (e.g. claim #6, "31 regions", sourced to `packages/core-ts/src/data/regions.json` having 31 keys).
- **Simulated** — produced by a model or synthetic curve in this repo: a fixture, the mock grid feed's floor/amplitude parameters, a seeded-RNG test (e.g. claim #5, a −84% grid-load figure derived from `even-distribution.test.ts`'s simulated dispatch concentration).
- **Projected** — a third-party forecast or vendor-published figure, cited by source (e.g. claim #24, the DOE 2024 data-center electricity projection, cited with a live link).

A claim with none of these — no test, run, or external citation backing it — is **unsourced** and gets dropped or reworded to remove the number, not softened with a qualifier. `docs/claims.md`'s "Dropped" section lists nine such claims (e.g. "40 to 70% lower carbon" had no test or run producing that band; replaced with "lower carbon", no number).

**A forecast-derived number is "projected" even from a real run; only a directly-read value is "measured".**

Claim #31 in `docs/claims.md` is the sharpest case: one real `tidegap tick` run against the live GB grid feed produced a 72-hour forecast. The 183 and 88 gCO2/kWh figures used in copy come from *reading values out of that forecast* — still a projection, because a forecast is inherently a prediction, not an observed value — so they're labelled "projected (forecast values from one run)". The 158 gCO2/kWh figure is different: it's the feed's value *at dispatch time*, recorded directly in the signed receipt, so it's labelled "measured". Same run, two different classes, because the distinction is about how the number was produced, not which run it came from.

**A served-page `curl | grep -c` check on Next.js App Router counts every match twice.**

App Router ships each server-rendered string twice in the HTML response: once in the rendered DOM, and again serialized into the RSC flight payload (the `self.__next_f.push(...)` script blocks that hydrate the client). A verification step that does `curl -s localhost:PORT/ | grep -c "some string"` will report 2 for a string that appears once in the visible page — because it also matches inside the flight payload's serialized copy of the same string. A served-page check that needs an accurate count must isolate the DOM fragment (e.g. strip or exclude `<script>` blocks, or match against a unique surrounding HTML tag) rather than grepping the raw response.

## Why This Matters

Softening an unsourced claim ("up to 70%", "as much as") still implies a real range exists — it just hides the fact that nothing in the repo produces it. Dropping the number is the only choice that doesn't quietly relabel a fabrication as a hedge. Conflating "projected" and "measured" for the same run (as in claim #31) would make a forecast look like an observation, which is the same category error the whole audit exists to catch, just reintroduced at the labelling step. And a served-page check that silently double-counts can pass a verification that should have failed (a string present once, expected zero, reading as 2 either way) or fail one that should have passed — either way the check stops being trustworthy without anyone noticing why.

## When to Apply

- Writing or reviewing any prose claim that cites a number tied to this repo's behavior, test results, or a captured run.
- Building or reviewing a `docs/claims.md`-style audit table for any future copy pass.
- Writing a served-page verification step against `apps/web` (or any Next.js App Router app) that greps rendered HTML for a string or counts its occurrences.

## Examples

```bash
# Wrong: double-counts because App Router duplicates the string into the RSC flight payload
curl -s localhost:3000/ | grep -c "31 regions"   # => 2, even though the string renders once

# Right: isolate the DOM fragment before counting (e.g. match a surrounding tag,
# or strip <script> blocks first)
curl -s localhost:3000/ | sed '/<script/,/<\/script>/d' | grep -c "31 regions"   # => 1
```

| Value | Class | Why |
|---|---|---|
| "31 regions" | measured | `regionFloors` has 31 keys in `packages/core-ts/src/data/regions.json` |
| "−84% grid-load, time-shifted" | simulated | derived from `even-distribution.test.ts`'s simulated dispatch concentration |
| "US data centers 6.7–12% of national grid by 2028" | projected | externally cited, DOE 2024 |
| 183/88 gCO2/kWh (forecast window) | projected | read from one real run's 72h forecast — still a prediction |
| 158 gCO2/kWh (at dispatch) | measured | recorded directly in the run's signed receipt |

## Sweep every surface that carries copy, not just READMEs (PR #43)

The 0.16.1 sweep found unlabelled "50% cheaper" and "faster" claims outside the files the first audit covered. A claim lives wherever a string is published. Grep each number across all of these before release:

- `README.md` and `packages/*/README.md`
- plugin manifests: `.claude-plugin/marketplace.json`, `packages/claude-code-plugin/.claude-plugin/plugin.json`
- `packages/claude-code-plugin/skills/tidegap/SKILL.md`
- MCP tool descriptions in `packages/core-ts/src/tool-surface.ts`, **and** the matching `tool-surface.test.ts.snap` (update both or the snapshot test fails)
- the site hero in `apps/web/src/app/page.tsx`

Rules applied: "50% cheaper" became "50% of sync list price (projected)" (a vendor-published figure, class projected). "faster" was dropped from the hero because nothing measures it. A README snippet output comment (claim #33) gets its own row, because the number depends on a live feed and changes between runs.

## Related

- `docs/claims.md` — the full audit table and legend this guidance generalizes from (32 rows, PR #37).
- `docs/plans/2026-09-30-1647-chore-infoq-article-prep-plan.md` — plan item that scoped the audit and the served-page check's dynamic-rendering note (`apps/web/src/app/layout.tsx:119-121` reads `headers()`, so every route renders dynamically and no prerendered HTML exists to grep instead).
