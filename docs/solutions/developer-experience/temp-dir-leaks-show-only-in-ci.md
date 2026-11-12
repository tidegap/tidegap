---
title: "A test that leaves a tidegap* temp dir passes locally and fails CI: the leak guard wraps the test runs only in CI and in pnpm test:leaks"
date: 2026-11-11
category: developer-experience
module: scripts/test/tmp-leak-guard.mjs, scripts/test/vitest-temp-root.mjs, .github/workflows/ci.yml, packages/*/test/hermetic-home.ts
problem_type: developer_experience
component: testing
severity: low
applies_when:
  - "A new test creates a temp dir with mkdtempSync"
  - "CI fails at the last step of the build + test job with \"tmp-leak-guard: ... leaked: tidegap-...\""
  - "Deciding which local command proves a test branch is clean before a push"
tags: [tests, temp-dir, tmp-leak-guard, ci, vitest, afterEach, mkdtemp]
---

# Temp-dir leaks show only in CI

## Context

`scripts/test/tmp-leak-guard.mjs` fails a run that leaves an entry whose name starts with `tidegap` in the temp dir. It never deletes the entry, so the leak stays for inspection.

In #254 a new `describe` block in `packages/openclaw-plugin/test/plugin.test.ts` made a temp dir per test (`mkdtempSync(join(tmpdir(), "tidegap-held-os-"))`) and did not remove it. Every local check passed. CI failed twice at its last step (`leaked: tidegap-held-os-...`, three and then four entries) until the block got `afterEach(() => rmSync(dir, { recursive: true, force: true }))`.

## Why local runs miss it

- **The guard wraps the test runs only in CI and in `pnpm test:leaks`.** In `.github/workflows/ci.yml`, the build + test, time-zone and macOS jobs take a `snapshot` before the first test step and run `check` after the last one. Locally, `pnpm --filter <name> test` and `pnpm test` run without it.
- **The gate's guard runs no tests.** `pnpm gen:tests:check` runs under the guard, but `scripts/build-test-count.mjs` only lists tests (`vitest list`) and executes none, so a leaking test body never runs there.
- **A dir made from `tmpdir()` is outside the run's temp root.** `scripts/test/vitest-temp-root.mjs` (vitest `globalSetup`) makes one root per run, puts it in `TIDEGAP_TEST_TMP_ROOT`, and removes it at teardown. Only the hermetic home (`packages/<name>/test/hermetic-home.ts`) is made under that root. A test that calls `mkdtempSync(join(tmpdir(), ...))` directly, as most tests do, must remove its own dir.

## Guidance

- Every `mkdtempSync` in a test gets a matching `rmSync(dir, { recursive: true, force: true })` in `afterEach` or `afterAll`. A dir made in `beforeEach` gets `afterEach`.
- Before you push a branch that adds such tests, run the changed package under the guard: `node scripts/test/tmp-leak-guard.mjs -- pnpm --filter <name> test`. Or run `pnpm test:leaks` for all packages. The guard runs the command with a private `TMPDIR` and prints `leaked: <name>` for each entry left behind.
- A test that kills a process must also wait for it before cleanup: `deterministic-process-kill-tests.md`, "Cleanup must not trust the start wait".

## Not built

A check that fails in the local gate would wrap each package's `test` script in the guard, or add a per-file temp-dir assertion to the shared vitest setup. Both change the test tooling for every package, so they are left as a proposal.
