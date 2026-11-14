---
title: "Derived text (a summary) is stored beside the raw result, never in its place; machine readers stay on the raw text"
date: 2026-11-14
category: best-practices
module: packages/cli/src/providers/command.ts (summarize), packages/core-ts/src/history.ts (taskResultText, taskSummaryText, taskSummaryError), packages/core-ts/src/channels/format.ts (taskDoneMessage, runVerdict), packages/core-ts/src/jobs.ts (wake match)
problem_type: best_practice
component: tooling
severity: medium
applies_when:
  - "Adding a step that rewrites a task's output for people: a summary, a translation, a rendering"
  - "Changing the text a channel notice or a page shows for a run"
  - "Adding a reader of a task's result (a trigger, a button, a file, an agent read)"
tags: [jobs, summarize, notices, channels, telegram, wake-match, result-text, acceptance-examples]
---

# Derived text beside the raw result

## Context

Before #273 a command job's Telegram notice was the command's raw stdout: its first line, then a 600-character block. The owner could not read it. `--summarize` existed, but it was undocumented and its reply REPLACED `result.text`. Several readers need the raw output, so a summarized job would have broken them without any visible error.

## Guidance

- **Store derived text in its own field.** `result.text` is the command's output, always. The summarize reply goes to `result.summary`. When the step fails, the reason goes to `result.summaryError`. Read them with `taskResultText`, `taskSummaryText`, `taskSummaryError` (`packages/core-ts/src/history.ts`). A future translation or rendering gets a field of its own too.
- **Machine readers bind to the raw field, and a test names each one.** The raw readers are: `--wake match` (`jobs.ts`, test "the wake pattern tests the run's output, never its summary" in `packages/core-ts/test/jobs-sweep.test.ts`), the Telegram [Result] button (test "the event passes jobNext through; the Result button replies with the raw report" in `packages/core-ts/test/channels-format.test.ts`), `result_path` files (`packages/cli/src/handoff/results.ts`), `queue show` and the session notice an agent reads (`queue.ts`, `queue-watch.ts`). Only notices, the digest and the page show the summary; the page shows both (`result_text`, `summary_text`). A new reader picks its field on purpose and gets a test that feeds a different summary and raw text.
- **An optional enrichment step never fails or repeats the primary work.** A summarize error, timeout, budget stop, empty or non-string reply, or an unconfigured provider completes the run once with the raw output and a `summaryError`. The notice shows one line, `No summary: <reason>`. The receipt counts the command only; the failed call's tokens are not counted. The old rule (fail the run, then skip the slot retry so the command does not run twice) is gone; see `../logic-errors/floating-jobs-occurrence-sweep.md` rule 3.
- **A notice for people is verdict first.** Line 1: `<job> — <verdict>`, the verdict at most 120 characters (`runVerdict`: the summary's first line, else the output's, else the first error line). Line 2: `Finished HH:MM · next …`. Then the body, at most 600 characters (`TELEGRAM_PREVIEW_CHARS`). The raw text stays behind the [Result] button.
- **Pin the user-facing texts as exact strings from the plan's acceptance examples.** The plan wrote AE1-AE4 as full channel texts; `packages/core-ts/test/channels-format.test.ts` and `packages/cli/test/channels-emit.test.ts` assert them as exact strings. A test that only checks `includes(...)` lets the layout drift. Use invented names and values only (the repo is public: `../workflow-issues/public-repo-hygiene.md`).
- **Every channel renders from one `eventMessage`, so the end-to-end text is checked once.** `pnpm qa channels` S40.1 and S40.2 run a real summarized job through the fake claude and read the notice on the webhook fake. A per-channel copy of that check adds nothing.

## Why This Matters

A replaced field fails silently: a wake pattern stops matching, a [Result] button shows prose, an agent parses a summary as data. No error appears; the job looks healthy. A failing enrichment that fails the run costs a second run of the real work or a lost result.

## Related

- `user-regex-in-a-bounded-vm.md` (the wake match)
- `telegram-channel-security.md` (previews)
- `../logic-errors/floating-jobs-occurrence-sweep.md` (retries and failure classes)
