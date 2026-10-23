---
title: MCP and OpenClaw tools share one canonical surface, with per-host text, annotations and TDQS-shaped descriptions
date: 2026-10-15
last_updated: 2026-10-22
category: tooling-decisions
module: packages/core-ts/src/tool-surface.ts
problem_type: tooling_decision
component: tooling
severity: medium
applies_when:
  - "Adding or changing an MCP or OpenClaw tool, parameter or description"
  - "A tool call changes state as a side effect"
  - "Rewriting descriptions or annotations to raise a registry quality score (Glama TDQS)"
tags: [tool-surface, mcp, openclaw, snapshot, descriptions, annotations, tdqs, glama]
---

# Tool surface rules

## Context

`TOOL_SURFACE` in `packages/core-ts/src/tool-surface.ts` is the single definition of tool names, parameters and descriptions. The MCP server and the OpenClaw plugin both build from it, so a description cannot drift on one host.

## Rules

- **Change the description once, in `TOOL_SURFACE`.** Never edit it in `server.ts` or the OpenClaw `index.ts`.
- **A parameter that differs by host gets one entry per host** via `hosts: [...]`. Example: `deadline` is required on OpenClaw and optional on MCP (ignored when `deadline_kind` is `quota_reset`). New MCP-only params (`title`, `deadline_kind`, `quota_provider`) set `hosts: ["mcp"]`.
- **Regenerate the snapshot** (`packages/core-ts/test/__snapshots__/tool-surface.test.ts.snap`) with the test runner's update flag and read the diff. It is the divergence canary, so an unexpected line is a real host mismatch.
- **State side effects in the description.** `check_queue_status` with `task_id` marks a completed or failed task read. The description says so, plus "Never changes a task's status", because the model chooses tools from the description and "Read-only" was no longer true. Same for the Batch API routing note on `deadline_kind`.
- **Read the stored row before the mark.** The MCP handler reads the row first, then marks read, so the response shows the pre-mark state.
- Parameters the model must choose between get the user phrasing in the description ("before my weekly limit resets").

## Per-host descriptions

Hosts return different shapes and fail differently, so one description can be wrong for one host. Set `descriptionPerHost: { openclaw: "..." }` on the tool; resolve text only through `descriptionForHost(def, host)`, which falls back to `description`.

- MCP returns snake_case JSON fields and "Rejects ..."; OpenClaw returns camelCase or flat fields and "Throws ...". Name the fields each host really returns.
- Both texts stay in `TOOL_SURFACE`. The snapshot shows each host's text, so a divergence is visible in review.
- Check the tool's handler on that host before writing a claim. `set_delivery` (OpenClaw-only) does not check that the task exists, so its text must not say it throws on an unknown `task_id`.

## Annotations match the handler

Each tool declares `readOnlyHint`, `destructiveHint`, `idempotentHint` and `openWorldHint` (MCP). Derive each from the handler, not from the tool name.

- `readOnlyHint` is true only if the handler writes nothing. `check_queue_status` marks a task read, so it is not read-only.
- `destructiveHint` is true when data is lost or a prompt is redacted (`cancel_task`, `cancel_all`).
- `idempotentHint` is true when a repeat call changes nothing more (`cancel_task`); false for `postpone_task` with a delay, which moves the task again.
- `openWorldHint` is true only if the handler reaches a network service. A test asserts "no network <=> openWorldHint false", so the text "no network or login" and the flag cannot disagree.
- The OpenClaw registration has no annotation field. There, only the text carries the behavior.

## Description template (TDQS)

Glama scores each tool with the TDQS rubric (https://tdqs.dev/): Purpose, Usage Guidelines, Behavior, Parameters, Conciseness, Completeness, each 1 to 5. Write every description in the same order, one sentence per part:

1. **Purpose.** A specific verb and resource, plus the nearest sibling to avoid confusion.
2. **Use when.** The user wording that should trigger it.
3. **Do not use.** Each wrong case, with the sibling to call instead (`use postpone_task`). Naming the alternative is what moves Usage Guidelines from 4 to 5.
4. **Behavior.** What is written or read, network and login, idempotency, side effects (billing, redaction, receipt marks).
5. **Returns.** The fields, because there is no output schema. Name the rejection cases.

Budget: 600 characters per description, 900 for `schedule_task`. When a new fact does not fit, shorten another sentence of the same description. Do not raise the budget. Measure with `descriptionForHost` over every tool and host.

## Parameters score 3 when text repeats the schema

TDQS gives Parameters 3/5 as the baseline when schema coverage is 100%. It rises only when the description adds meaning the schema cannot hold: which values are legal given task state, or how to turn user wording into a value (`Convert the user's wording to an ISO-8601 deadline`). Restating a parameter in the description earns nothing. The same holds for the parameter text itself: say how to fill the argument (format, example, default, effect of omitting it), not what its name says.

## Glama scores a built release

Glama inspects a published release, not `main`. The score after a description change does not move until a new release is cut and indexed.

- A compatibility shim pinned to an old caret range froze the scan. The old-name package (`@ebb-ai/mcp`) depended on `@tidegap/mcp ^0.18`, so a build of the shim fetched 0.18 text. After a rename, move the shim's dependency to the current minor in the same release.
- Check which package version Glama built (the release shown on its TDQS tab) before judging a score.
- Do not chase a number locally. Fix the text, release, then read the per-tool "explanation" lines for the next gaps.

## Wording facts to verify before writing

Each claim in a description should match code. Examples found in review of the TDQS rewrite:

- `recommend_window` rejects when no window meets `carbon_budget_g` (`CarbonBudgetExceededError`).
- `postpone_task`: a given `until` time is used exactly. Presets and delays are re-picked after the start.
- `cancel_task` also cancels running tasks and submitted tasks; a submitted Batch call may still run and bill, because the cancel is local.
- `expedite_task` drops the task's earliest-start constraint.
