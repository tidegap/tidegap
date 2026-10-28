---
title: Channels and Region Leftovers (Batch 23) - Plan
type: refactor
date: 2026-10-28
topic: channels-and-region-leftovers
artifact_contract: ce-unified-plan/v1
product_contract_source: ce-plan-bootstrap
execution: code
---

# Channels and Region Leftovers (Batch 23) - Plan

## Goal Capsule

- **Objective:** A channel that was just connected never shows an error left by an older test. A docs edit that breaks the notifications error-code rule fails CI through a rule whose guards have tests. `tidegap region detect` and the region resolver guess the region through one code path. Nothing else changes for users.
- **Means:** one PR, `refactor/channels-region-leftovers`, with three units: a recency check before a channel test records its result (KTD1), K13 as a pure function with unit tests (KTD3), and `detectRegion` through core `resolveRegion` (KTD4).
- **Authority:** the Product Contract decides what; the Planning Contract decides how. Binding: `CLAUDE.md` (hard rules, generated files, git conventions), `docs/spec/ui-client-api.md`, `docs/solutions/best-practices/channels-one-step-connect-secrets-file-and-atomic-lock.md`, `docs/solutions/best-practices/generated-docs-embed-and-drift-rule-with-vacuous-pass-guards.md`, `docs/solutions/best-practices/grid-region-setting-resolver-and-live-reads.md`, `docs/solutions/workflow-issues/public-repo-hygiene.md`.
- **Scope of this plan:** the remainders of triage rows 25, 26 and 27, each checked against `main` at `e1f631a`. Kept: R1-R6. Cut: items already shipped, items that would change behaviour inside a refactor, and items that only move one line (Scope Boundaries).
- **Execution profile:** one Opus `ce-work` agent in `.worktrees/refactor/channels-region-leftovers`, units in the order U1, U2, U3. No `pnpm qa ui`: no unit touches the page or a UI server route.
- **Who ships:** the PR ends green after one `ce-code-review` pass. Agents do not merge. No version bump, release or publish.
- **Stop conditions:** stop and report when:
  - a unit needs a change in `packages/core-py` (parity work is an owner decision);
  - a unit changes a route, body, status code or sentence in `docs/spec/ui-client-api.md`;
  - a U3 characterization test needs a new expected value after the refactor;
  - a test needs the real `HOME`, `~/.tidegap`, `~/.claude` or `~/.config/tidegap`;
  - the gate fails the same way twice.
- **Open blockers:** none. Inferred defaults are under Assumptions.

---

## Product Contract

### Summary

Close what is left of triage rows 25-27. A channel test that finishes after a newer Connect or a Remove stops writing its result over the newer state. The K13 docs drift rule becomes a pure function with unit tests, like K15-K17. The CLI's region guess calls the core resolver instead of repeating its last steps.

### Problem Frame

Three leftovers survived earlier batches.

Channels: `ChannelSetup.test()` waits for a Connect in flight, sends with the stored values, then records the result. Nothing stops a Connect or a Remove of the same channel while that send runs. When the old test fails late, it records a failure over the newer Connect's success, and a freshly connected card turns to error. After a Remove, it writes a last-delivery row for a channel that no longer exists. The secrets file lock does not help: it guards the secrets file, not the last-delivery record, and not the order of two async calls.

Docs drift: K13 already reads its known codes from core `DELIVERY_CODES` (commit `4f7bc37c`). Its eight guards against a vacuous pass have no test, so a guard that stops firing goes unnoticed. K15-K17 solved the same problem with pure functions and fixture tests.

Region: `detectRegion` in `packages/cli/src/region.ts` repeats the time-zone and fallback steps of core `resolveRegion`. Two copies of one rule can drift, and then `region detect` and `region show` disagree.

### Requirements

**Channels**

- R1. A channel test whose send finishes after a successful Connect or a Remove of the same channel does not record its result as the channel's last delivery. This holds when the Connect or Remove runs in another process, such as the CLI against `tidegap ui`. The caller still gets the test's own outcome.
- R2. The UI client API does not change: no route, request body, response shape, status code or sentence in `docs/spec/ui-client-api.md`.

**Docs drift**

- R3. K13 keeps its id, title, checks and problem text. Its body becomes a pure function with unit tests for the pass path, each guard and each failure kind, and both CI and `pnpm preflight` run those tests.

**Region**

- R4. `detectRegion` gets its result from core `resolveRegion`. Its output stays byte-identical for every input, pinned by tests written before the change.

**Release hygiene**

- R5. No change in `packages/core-py`, no version bump, no release. `CHANGELOG.md` gets one `### Fixed` line under `[Unreleased]`, for R1 only.
- R6. The learnings that list these items as open record the outcome: the open follow-ups of the region doc and the unit-test paragraph of the drift-rule doc.

### Scope Boundaries

Cut, with the evidence on `main`:

| Item | Verdict | Evidence |
|---|---|---|
| Row 25: a stale writer overwrites a newer secret | Already prevented | `connect` runs once per id at a time (the `connecting` map). `disconnect`, `remove` and `settings` wait for it and then finish with no further await. Across processes, `writeSecrets` reads, changes and writes under `withFileLock`, and the last writer wins by design. The remaining hazard is the last-delivery record (R1). |
| Row 26: known-code list built from regexes | Shipped | Commit `4f7bc37c`. K13 reads `DELIVERY_CODES`; the CLI's `DeliveryError` type accepts only those codes. |
| Row 26: every emitted code is documented | Not built | 35 of the 38 host codes are not on the page by design. Per-kind codes reach the page through the generated `channel-<kind>` embeds. The card shows a sentence for every code, with a generic fallback. Listing every code on the page is docs work, not a drift fix. |
| Row 27: `hostRegionInputs()` | Cut | Each of the five entry points still calls `readEnvCredentials()` for the grid feed, and its region part is a one-line object. A helper adds a call and removes no logic. |
| Row 27: `catalogZoneOrAlias()` in core | Cut | It removes one expression in `parseRegionInput` but adds a permanent export to the published `@tidegap/core`. Applying the UK alias to `--region` and the env variable would change behaviour. |
| Row 27: `closestRegions` 2-letter minor | Shipped | Commit `3920405e` (`maxSuggestDistance`); core test "short inputs only match within edit distance 1". |
| Rows 18 and 38 | Owner decision | Both need `packages/core-py` (parity, receipt schema). |

Considered and not built:

- Suggestions for "Ukraine" and "Kyiv", where `closestRegions` returns none. A new suggestion is a behaviour change and does not belong in a refactor batch.

### Sources / Research

- `packages/cli/src/channels/channel-setup.ts`: `test`, `settled`, `connect`, `runConnect`, `remove`, `recordLast`.
- `packages/cli/src/channels/emit.ts`: `readLast` and `writeLast`. Every last-delivery record already carries its time `at`, and the ledger is shared by the CLI and `tidegap ui`.
- `scripts/qa/docs-drift.mjs` (the K13 block), `scripts/qa/docs-drift-jobs.mjs`, `scripts/qa/docs-drift-jobs.test.mjs`.
- `packages/cli/src/region.ts` (`detectRegion`, `regionView`), `packages/core-ts/src/region.ts` (`resolveRegion`).

---

## Planning Contract

### Key Technical Decisions

- KTD1. **A test records its result only when the channel row still exists and the stored last delivery is not newer than the test's start.** `test()` takes its start time before the send. After the send, it re-reads the row and the stored record, and skips `recordLast` when the row is gone or the stored `at` is later than the start. The record and its `at` already live in the shared ledger, so the check needs no new state and also covers a Connect or Remove in another process. Rejected: a per-id generation counter in `ChannelSetup` (the backlog's proposal), because it covers one process only and duplicates what `at` already records; making Connect and Remove wait for a test in flight, because they would wait for a full send with retries, which can pass 20 s.
  - A successful Connect writes a newer record, and a Remove deletes the row and the record. A stale test skips after either.
  - A failed Connect, a disconnect and a settings change write no record. A stale test still records after them, because the stored values it used are still the channel's values.
- KTD2. **The caller still gets the stale test's own outcome.** A failed stale test still throws its delivery error. A passing one returns the current status; after a Remove the row is gone, so it rejects with `not_found`. Only the record is skipped, so R2 holds.
- KTD3. **K13 moves to `scripts/qa/docs-drift-channels.mjs`, next to `docs-drift-jobs.mjs`.** The function takes the page texts, the core values K13 reads, the `channels` subcommand list and a reader for a subcommand's `--help` result. It returns the list of problems. `docs-drift.mjs` keeps the file reads, the CLI spawn and the `expect` call. The problem strings stay word for word, so a failing log reads the same as today.
- KTD4. **`detectRegion` calls `resolveRegion` with the time zone alone.** With no flag, env value or setting, the resolver returns only the `timezone` or `fallback` source, with the same keys in the same order. `detectRegion` keeps its default parameter, so an omitted or `undefined` argument still means the host zone. There is no core change, so no new export and no parity question.

### Assumptions

- Characterization tests are enough proof for U3. No `pnpm qa` area covers `region detect` beyond the unit tests.
- R1's CHANGELOG line goes under `### Fixed`. The branch stays `refactor/` because two of the three units are refactors.
- The CLI and `tidegap ui` read one machine clock, so comparing `at` across the two processes is sound for R1.
- U1 and U3 add counted CLI tests, so `pnpm gen:tests` changes the generated pair. U2's `node --test` file is not counted.

### Sequencing

U1, U2 and U3 touch disjoint files. The generated test-count pair is regenerated once, after U3. One commit per unit, in this order:

| Step | Commit title |
|---|---|
| U1 | `fix(cli): a stale channel test no longer records over a newer connect` |
| U2 | `test(qa): K13 as a pure function with guard tests` |
| U3 | `refactor(cli): region detect goes through the core resolver` |
| After U3 | `chore: regenerate test counts` |

---

## Implementation Units

### U1. A stale channel test does not record over a newer state

- **Goal:** a test that finishes after a newer Connect or a Remove leaves the newer state alone (KTD1, KTD2).
- **Requirements:** R1, R2, R5.
- **Dependencies:** none.
- **Files:** `packages/cli/src/channels/channel-setup.ts`, `packages/cli/test/channel-setup.test.ts`, `CHANGELOG.md`.
- **Approach:**
  1. In `test()`, take the start time from `this.now()` before `send`.
  2. After the send, on both the pass and the failure path, re-read the row and `readLast`. Call `recordLast` only when the rule in KTD1 allows it. One private helper keeps both paths on the same rule.
  3. Add one `### Fixed` line under `[Unreleased]`: a channel card no longer turns to error when an older test fails after a newer Connect.
- **Patterns to follow:** `readLast` in `packages/cli/src/channels/emit.ts`. For timing, the test "two connects for the same id at once share one test send" in `channel-setup.test.ts` (`sink.script` with `delayMs`).
- **Execution note:** write the first scenario first and see it fail on current code. In each race scenario, start the Connect or Remove at least a few milliseconds after the test starts, so the two times differ.
- **Test scenarios:**
  - A connected webhook gets a test whose receiver answers 404 after a delay. A Connect to a new URL completes during the delay. The test call rejects with its delivery error. The channel is `connected`, and its last delivery is the Connect's `ok`.
  - The same race, but the slow test passes. The test call resolves with the current status, and the last delivery is the Connect's.
  - A second `ChannelSetup` on the same ledger and secrets file, standing in for the other process, completes a Connect during a slow failing test. The last delivery stays the Connect's `ok`.
  - A Remove runs during a slow test. After the test settles, no `channel_last:<id>` meta row exists. A passing test rejects with `not_found`; a failing one rejects with its delivery error.
  - A Connect fails (receiver 404) during a slow failing test. The test's failure is recorded, because a failed Connect writes no record.
  - A disconnect runs during a slow failing test. The failure is recorded, and the state reads `disconnected`, as today.
  - The existing tests for the last delivery and the backoff pass with no change.
- **Verification:** the scenarios pass; `docs/spec/ui-client-api.md` has no diff.

### U2. K13 as a pure function with guard tests

- **Goal:** every K13 guard and failure kind has a test that runs in CI (KTD3).
- **Requirements:** R3, R6.
- **Dependencies:** none.
- **Files:** create `scripts/qa/docs-drift-channels.mjs` and `scripts/qa/docs-drift-channels.test.mjs`; change `scripts/qa/docs-drift.mjs`, `.github/workflows/ci.yml` (the `node --test` step), `package.json` (`preflight`) and `docs/solutions/best-practices/generated-docs-embed-and-drift-rule-with-vacuous-pass-guards.md`.
- **Approach:**
  1. Move the K13 body into an exported function in the new module. Keep each check, guard and message as it is.
  2. In `docs-drift.mjs`, pass the page texts, `core`, the `channels` subcommands from `commands`, and a `--help` reader built on `cli`. Keep the K13 `track` id and title.
  3. Add the new test file to the CI `node --test` step and to `preflight`, next to `docs-drift-jobs.test.mjs`.
  4. In the drift-rule doc, extend the paragraph "Unit tests for the rules" to K13 with one sentence.
- **Patterns to follow:** `scripts/qa/docs-drift-jobs.mjs` and `scripts/qa/docs-drift-jobs.test.mjs`: a fixture page, a fake core, one case per guard, and the full problem list compared.
- **Test scenarios:** the fixture is a small notifications page with two ready kinds, a Telegram page, a fake core and a fake help reader.
  - Pass path: the fixture gives no problems.
  - Guards, one case each:
    - empty `DELIVERY_CODES`
    - no ready kind
    - no `{#notify-<kind>}` section
    - empty `CHANNEL_KINDS`
    - no quoted code
    - fewer than 5 `channels` subcommands
    - no `--help` block
    - a `Usage: tidegap channels` line outside a checked help block
  - Failures, one case each:
    - kind sections out of registry order
    - a `docsAnchor` that differs
    - a section without its embed marker
    - a backticked snake-case code that is not in the code
    - a one-word code in parentheses that is not in the code
    - a page that names an unknown subcommand
    - a subcommand on neither page
    - a help block that differs from the reader's output
    - a reader that exits non-zero
  - Non-changes: an event kind, a field name, a `task_` name and a kind name in parentheses are not read as codes.
  - With any one guard removed from the function, at least one case fails. Check this by hand once.
- **Verification:** `node scripts/qa/docs-drift.mjs` prints `PASS` on the real docs, and the new test file passes under `node --test`.

### U3. Region detect goes through the core resolver

- **Goal:** one code path for the time-zone guess (KTD4).
- **Requirements:** R4, R6.
- **Dependencies:** none.
- **Files:** `packages/cli/src/region.ts`, `packages/cli/test/region.test.ts`, `docs/solutions/best-practices/grid-region-setting-resolver-and-live-reads.md`.
- **Approach:**
  1. Add the characterization tests below.
  2. Replace the body of `detectRegion` with one `resolveRegion` call that passes only the time zone, and narrow the source type to `timezone` or `fallback`.
  3. Remove imports that become unused.
  4. In the region doc's "Open follow-ups from the reviews", mark `detectRegion` as done and record `hostRegionInputs()` and `catalogZoneOrAlias()` as cut, with the reasons from Scope Boundaries.
- **Execution note:** characterization first. The tests pass on current code before `detectRegion` changes, and pass with no edit after.
- **Test scenarios:** compare `JSON.stringify` output, so the key order is pinned too.
  - `Europe/London` gives `GB`, source `timezone`, with the time zone.
  - `Europe/Kyiv` gives `PL`, source `timezone`, the time zone and the approximation.
  - `Asia/Tokyo` gives `GB`, source `fallback`, with the time zone.
  - An empty string gives `GB`, source `fallback`, and no time-zone key.
  - No argument gives the same object as the host zone.
  - `regionView` with an explicit `timeZone: undefined` reports `detected` equal to the guess for the host zone. This pins the default parameter.
- **Verification:** the scenarios pass before and after the change with no edit, and the existing `region detect` and `region show --json` tests pass unchanged.

---

## Verification Contract

- The gate, from the repo root: `pnpm build && pnpm typecheck && pnpm gen:tests:check && pnpm gen:docs:check && node scripts/qa/docs-drift.mjs` prints `PASS`. Read a failing log with `grep -nE "✘|Error|expected" <log> | head -40`.
- `pnpm --filter @tidegap/cli test` for U1 and U3. `pnpm --filter @tidegap/core test` shows the resolver tests still pass; no core source changes.
- `node --test scripts/qa/docs-drift-channels.test.mjs scripts/qa/docs-drift-jobs.test.mjs` for U2.
- `pnpm gen:tests` after U3, committed as `chore: regenerate test counts`. Generated files are never edited by hand.
- `pnpm check:versions` passes, and no `package.json` version changes.
- No `pnpm qa ui`: no unit touches `packages/cli/ui` or a UI route.
- Git:
  - Commits follow Conventional Commits.
  - Git runs as `git -c core.editor=true -c sequence.editor=true`, and each message comes from a uniquely named file passed with `-F`. Never `--delete-branch`.
  - No `Claude-Session` trailer and no session link in any commit or in the PR body (repo rule). Before the push, `git log origin/main..HEAD --format=%B` and the PR body give no match for `Claude-Session|claude.ai/code`.
- Public-repo hygiene: no local paths, owner names, account or token names, or scratch notes in committed files.
- Tests use an isolated `HOME`, never the real one.

---

## Definition of Done

- R1-R6 hold, each proven by its unit's scenarios or a check above.
- The PR changes only the files listed in U1-U3, plus the generated test-count pair.
- The gate and the package checks pass on the final commit, and CI is green.
- One `ce-code-review` pass ran, and its fixes are folded into their unit's commit (`docs/solutions/developer-experience/folding-review-fixes-into-commits.md`).
- `docs/spec/ui-client-api.md` and `packages/core-py` have no diff.
- No abandoned-attempt code, debug output or temporary files remain in the diff.
