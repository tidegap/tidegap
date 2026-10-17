---
title: EIA fuel-type data publishes up to a day late: a 30 h window gave source "mock"
date: 2026-10-17
category: logic-errors
module: packages/core-ts/src/grid.ts, packages/core-py/src/tidegap/grid.py
problem_type: logic_error
component: tooling
severity: medium
applies_when:
  - "Changing how many hours of history a grid feed requests"
  - "A production /api/grid route reports source mock"
tags: [eia, grid, history-window, persistence-forecast, mock-fallback]
---

# EIA lags up to a day

PR #79.

## Symptom

Production `/api/grid/US-MIDA-PJM` and `US-CAL-CISO` returned `source: mock`. The Vercel log said `eia fetch failed (EIA history covers only 12/24 hours-of-day ...)`.

## Cause

EIA fuel-type rows arrive late: at 22:19Z the newest row was 03Z, 19 hours old. The feed asked for the last 30 hours, so about 11 of them held data. That covered 11-15 hours-of-day, and the persistence forecast needs all 24, so the feed refused and the route fell back to mock. Nothing was wrong with the key (it reaches the feed through the `EBB_*` fallback).

## Fix and rule

The window is 72 hours in both `grid.ts` and `grid.py`; newest row wins across the wider window. Size a history window as `needed hours + worst publication lag`, not `needed hours + a few`. The regression test (TS and Python) serves a feed whose newest 19 hours are unpublished and expects `source: eia`; it fails at 30 h.

A mock fallback hides this kind of failure. After changing a feed, call the production route and read `source`.

## Not fixed here

Electricity Maps key returns 401 (needs a new key). FR/DE/ES/IT/NL route to ENTSO-E and no token is set, so FR is mock by design.
