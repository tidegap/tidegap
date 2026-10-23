---
title: MCP Tool Descriptions to TDQS 5 - Plan
type: feat
date: 2026-10-22
artifact_contract: ce-unified-plan/v1
product_contract_source: ce-plan-bootstrap
execution: code
---

# MCP Tool Descriptions to TDQS 5 - Plan

## Goal Capsule

- **Objective:** An agent that connects to the Tidegap MCP server picks the right tool and fills its arguments from the tool list alone, and Glama's TDQS rates every MCP tool 5.0/5 once Glama builds the next release.
- **Means:** rewrite every MCP tool description and parameter description in the canonical surface to one fixed template, and declare MCP tool annotations (KTD1, KTD2, KTD3).
- **Authority:** this plan, then `docs/solutions/tooling-decisions/tool-surface-shared-descriptions.md`, then the repo `CLAUDE.md` hard rules. The TDQS rubric at https://tdqs.dev/spec is the scoring reference.
- **Stop conditions:** stop and report if a description change would need a handler change (behavior is out of scope), or if the MCP SDK in use rejects the `annotations` field.
- **Execution profile:** one stream, sequential units, one PR. No browser QA. No release.
- **Finishes:** the implementer opens the PR. Glama re-scoring happens after the next release, which the maintainer cuts.

---

## Product Contract

### Summary

Rewrite the descriptions of all 12 MCP tools and their parameters in `packages/core-ts/src/tool-surface.ts` to a fixed Purpose / Use when / Do not use / Behavior / Returns template, add MCP tool annotations, and regenerate the docs and test counts. No handler changes.

### Problem Frame

Glama scored the server A 4.3/5 on release v0.19.0 across 10 tools. Every tool lost points on Parameters (3/5: parameter text adds nothing beyond the JSON schema). Most lost a point on Usage Guidelines (no "do not use, use X instead"), Behavior and Completeness (no auth, idempotency, side effects or return value stated), and some on Purpose (cancel_task vs cancel_all) and Conciseness (schedule_task, check_queue_status). The server declares no annotations, so the descriptions carry the full disclosure burden. Full breakdown: the Glama capture listed under Sources.

Glama saw 10 tools because its Dockerfile still runs `npm install -g @ebb-ai/mcp`. That shim depends on `@tidegap/mcp ^0.18.0`, which on 0.x resolves only to the latest 0.18.x. Glama labels the build "v0.19.0" after the GitHub release, but it scored 0.18.x code, and it will never see a later release through the shim. v0.18.0 and v0.19.0 both register the same 10 MCP tools. `tidegap_usage` and `postpone_task` were added on `main` after v0.19.0, so the README's "12 MCP tools" is correct for `main` and the next release.

| Tool | In the scored build (0.18.x) | On main | Glama TDQS |
|---|---|---|---|
| get_grid_forecast | yes | yes | 4.2 |
| recommend_window | yes | yes | 4.4 |
| schedule_task | yes | yes | 4.6 |
| check_queue_status | yes | yes | 4.6 |
| cancel_task | yes | yes | 4.3 |
| cancel_all | yes | yes | 4.3 |
| expedite_task | yes | yes | 4.4 |
| update_deadline | yes | yes | 4.0 |
| reply_task | yes | yes | 4.5 |
| retry_task | yes | yes | 4.2 |
| tidegap_usage | no | yes (MCP only) | not scored |
| postpone_task | no | yes (MCP only) | not scored |
| set_delivery | OpenClaw only | OpenClaw only | not on MCP |

### Requirements

**Tool descriptions**

- R1. Every MCP tool description follows the template in KTD3: the purpose sentence first, then Use when, Do not use (naming the sibling to use instead), Behavior, Returns.
- R2. Every description names at least one sibling that exists on the same host, and never names a tool that the host does not register.
- R3. cancel_task and cancel_all each name the other in their first sentence or Do not use clause.
- R4. Behavior states, where true: what the call writes (the local task queue, a named cache file, or the exact phrase "writes nothing"), whether a repeat call with the same arguments changes anything, that the server is local with no login, and which tools need a provider API key.
- R5. Returns names the reply fields that host's handler emits and the rejection cases.
- R6. Each description is at most 600 characters. schedule_task may go to 900 because it has 25 MCP parameters. No promotional wording, no restated enum or format facts.
- R7. The first sentence stands alone as the tool summary, because `scripts/build-docs.mjs` (`firstSentence`) puts it in the docs tool table.

**Parameter descriptions**

- R8. Every parameter description on both hosts says what the JSON schema cannot: an example value, where the value comes from (for example "the `t-<uuid>` id from schedule_task or check_queue_status"), the default when omitted, when to omit it, and interactions with other parameters.
- R9. Parameter descriptions do not restate the schema's type, enum list, `format` or numeric bounds unless they add a unit or meaning.

**Annotations**

- R10. Every MCP tool advertises `annotations` with `title`, `readOnlyHint`, `destructiveHint`, `idempotentHint` and `openWorldHint`, set per KTD2, and no description contradicts its annotations.

**Release hygiene**

- R11. One CHANGELOG entry under `[Unreleased]`. No version bump. Generated docs and test counts are regenerated, not hand-edited.

### Success Criteria

- After the next release is built on Glama, TDQS shows 12 tools, each at 5.0/5, and no `Annotation Contradiction` flag.
- Before that, the U1 structural tests pass on every MCP tool.

### Scope Boundaries

- Handler behavior, reply text and tool names stay unchanged. `cancel_all` keeps its name even though Glama noted the naming deviation, because renaming breaks existing agent configs.
- The Python package needs no change: `packages/core-py` has no MCP server and no tool surface (`mcp` appears only as a pyproject keyword).
- OpenClaw-only `set_delivery` keeps its description. OpenClaw receives the rewritten shared descriptions as a side effect of the single surface.
- README tool tables (`README.md`, `packages/mcp-server/README.md`, `packages/openclaw-plugin/README.md`) are hand-written one-line summaries with correct counts. They need no change.
- Not built: an `outputSchema` per tool. It would lower the Completeness bar, but MCP clients then expect `structuredContent` in replies, which is a handler change. Revisit if a 5.0 on Completeness does not land from text alone.
- Not built: a local LLM grader that reproduces TDQS. The structural tests in U1 and Glama's own run are the checks; build a grader only if Glama scores stay below 5 after the release.

#### Deferred to Follow-Up Work

- Glama listing fixes (Dockerfile, env schema, related servers): the maintainer does these in the Glama admin UI after the release. See "Glama build" below.

---

## Planning Contract

### Key Technical Decisions

- KTD1. **Edit the canonical surface, not `server.ts`.** The descriptions live in `TOOL_SURFACE` in `packages/core-ts/src/tool-surface.ts`. `packages/mcp-server/src/server.ts` only renders them (`buildZodField` puts each parameter description into the zod schema, `buildToolList` serves the tool description). This follows `docs/solutions/tooling-decisions/tool-surface-shared-descriptions.md`.
- KTD2. **Declare annotations in the surface; render them on MCP only.** Add an optional neutral `annotations` field to `CanonicalToolDef` and emit it from `buildToolList`. OpenClaw ignores it. TDQS grades Behavior relative to annotations, so declaring them removes part of the disclosure burden from the text. The values (table below) follow these rules:
  - `readOnlyHint: true` only when the call writes no file and no row (MCP spec: "does not modify its environment"). `check_queue_status` is `false`, because viewing a finished task marks it read. `tidegap_usage` is `false`, because it rewrites its cache file.
  - `destructiveHint: true` when the call deletes or irreversibly replaces existing data: cancel_task, cancel_all, and retry_task (the new receipt replaces the old signed one).
  - `idempotentHint: true` when a second identical call changes nothing more. cancel_all is `false`: each call skips the current occurrence of a repeating task, and the scheduler queues the next one.
  - `openWorldHint: true` when the call itself reaches a provider API, a grid feed or a usage endpoint over the network. A call that schedules a task reaches the grid feed (`scheduleProviderCall` fetches the forecast).
  - The implementer checks each value against the handler in `server.ts` and the scheduler method it calls in `packages/core-ts/src/scheduler.ts`, and corrects the table if they disagree.
- KTD3. **One description template, in this order:**
  1. Purpose: one sentence with a verb, the resource, the scope, and the sibling it differs from when one is close.
  2. `Use when:` the trigger, in user phrasing where the tool is chosen from user words.
  3. `Do not use` for X: `use <sibling>`.
  4. `Behavior:` what is written and where, repeat-call effect, local with no login, provider key if needed.
  5. `Returns:` the reply fields, then the rejection cases.

  Directional example, not final text (update_deadline, about 520 characters): "Change the deadline of one queued or scheduled task and re-pick its cleanest window inside the new deadline. Use when: the user moves the due time, earlier or later. Do not use to delay the start inside the same deadline (use postpone_task), to run now (expedite_task) or to stop it (cancel_task). Behavior: rewrites only this task in the local queue and re-reads the grid forecast; no login; repeating the call changes nothing more. Returns: status, scheduled_for, new_deadline. Rejects running, finished or unknown tasks and a deadline in the past."
- KTD4. **Per-host description override where the hosts differ.** The MCP text is the TDQS target and is written from the MCP handler. Two things differ on OpenClaw. First, `postpone_task`, `tidegap_usage` and MCP-only parameters such as `dry_run` do not exist there. Second, the OpenClaw handlers in `packages/openclaw-plugin/src/index.ts` return structured objects (for example cancel_all returns `{matched, cancelled, errors}`), throw on rejection, and take provider keys from plugin config. Add an optional per-host description override to `CanonicalToolDef` and a resolver that `toolsForHost`, the OpenClaw `toolDescription()` and `neutralSurfaceForHost` all use.
  - A tool keeps one shared text when that text is true on both hosts.
  - Otherwise the base `description` is the MCP text and an `openclaw` override is written from the OpenClaw handler. Expect overrides on at least schedule_task, check_queue_status, cancel_task and update_deadline, plus any tool whose Returns or Behavior differs.
  - Rejected: limiting shared text to facts true on both hosts. That drops update_deadline's routing to postpone_task and the MCP reply fields, which are the losses Glama scored. The U1 tests run on every host-resolved text, so an override cannot skip the template.
- KTD5. **Parameter detail goes in both channels, weighted to the schema.** TDQS credits either channel. Rich property descriptions carry every parameter (R8). The tool description adds a short clause only for the one or two inputs that need translation from user words (deadline from "by tomorrow", task_id source), because the scored 4/5 Parameters on expedite_task and schedule_task came from exactly that.
- KTD6. **Structural tests guard the template; the snapshot guards drift.** Glama's grader cannot run locally. U1 adds deterministic checks for length, clause order, sibling existence per host, and annotation presence. The existing snapshot in `packages/core-ts/test/__snapshots__/tool-surface.test.ts.snap` is regenerated and its diff read.

### Per-tool content map

Sibling routing and annotations the descriptions must carry. "RO/De/Id/OW" = readOnly / destructive / idempotent / openWorld. Values marked "verify" depend on handler details the implementer confirms.

| Tool | Do not use for → sibling | RO/De/Id/OW | Behavior and Returns notes |
|---|---|---|---|
| get_grid_forecast | picking a run time for a task → recommend_window; queuing → schedule_task | T/F/T/T | Fetches a grid feed; mock data is labelled `grid_source: mock`. Unknown zone rejected with the closest zones |
| recommend_window | committing → schedule_task; raw hourly curve → get_grid_forecast | T/F/T/T | Nothing persisted. Returns window, alternatives, batch_eligible, grid_source, reasoning |
| schedule_task | a task the user waits for (run it now, no tool); preview only → recommend_window or dry_run; Claude limits → tidegap_usage | F/F/F/T | Each call adds one task row. Cut the "three wins" sentence and the long trigger list to the strongest phrases. Returns task_id, window, region_source, runs_in, readiness line |
| check_queue_status | changing a task → cancel_task, postpone_task, update_deadline, retry_task; Claude limits → tidegap_usage | F/F/T/F | Marks a finished task read; never changes status. Drop the persistence parenthetical (R6) |
| tidegap_usage | queue state → check_queue_status | F/F/T/T | Writes only its cache `~/.tidegap/usage.json`; never touches tasks or settings. include_spend scan takes seconds |
| cancel_task | many tasks → cancel_all; run later → postpone_task; failed task → nothing to cancel | F/T/T/F | Idempotent on finished tasks; series semantics. Returns `Task <id> status:` |
| cancel_all | one task → cancel_task | F/T/F/F | Leaves running and finished tasks. Repeating tasks skip this occurrence and queue the next; end a series with cancel_task series=true. MCP returns "Cancelled N of M" plus per-task errors |
| expedite_task | failed task → retry_task; claude-code task → `tidegap queue run-now` | F/F/F/T | Dispatches now; needs a provider API key on the host; the receipt records intensitySource=expedited. Returns status, error |
| update_deadline | later start inside the same deadline → postpone_task (MCP override per KTD4); run now → expedite_task | F/F/T/T (verify forecast fetch) | Returns status, scheduled_for, new_deadline |
| postpone_task | a new due time → update_deadline; stop → cancel_task | F/F/F/F (verify) | Never moves a task earlier. Returns not_before, scheduled_for, deadline |
| reply_task | failed or cancelled task → retry_task or schedule_task | F/F/F/T | Adds a new task; one provider call later. Returns task_id, parent_task_id, scheduled_for, deadline |
| retry_task | a task that did not fail → expedite_task or update_deadline | F/T/F/T | Needs a provider API key; replaces the old receipt; claude-code tasks refused. Returns status, error |

### Glama build

Not code work. For the maintainer in the Glama admin UI (Dockerfile tab), after the release that ships this change:

- Build from the source checkout:
  - build steps: `corepack enable`, `pnpm install --frozen-lockfile`, `pnpm --filter @tidegap/mcp... build`
  - CMD: `["mcp-proxy", "--", "node", "packages/mcp-server/dist/server.js"]`
  - `pnpm build` (all `packages/*`) also works but builds more than the server needs.
- The entry point runs `main()` only when executed directly (`isDirectRun` in `server.ts`) and speaks MCP over stdio.
- Set `TIDEGAP_DB_PATH=:memory:` so the container never writes `~/.tidegap/queue.db`.
- Without grid keys the server falls back to the mock feed, which is enough for inspection.
- Replace the env schema's `EBB_*` names with `TIDEGAP_ELECTRICITY_MAPS_API_KEY`, `TIDEGAP_EIA_API_KEY` and `TIDEGAP_ENTSOE_SECURITY_TOKEN`, all optional.
- `better-sqlite3` needs its Linux prebuilt binary or a C toolchain in the image. Check this on the first Glama build.
- Simpler alternative that scores only published code: build step `npm install -g @tidegap/mcp`, CMD `["mcp-proxy", "--", "tidegap-mcp"]`.

### Assumptions

- Glama will re-score on the next GitHub release once its Dockerfile no longer installs `@ebb-ai/mcp`.
- Shorter, structured text plus annotations is enough to reach 5 on Behavior and Completeness without an output schema.
- OpenClaw agents benefit from the same rewritten text. No OpenClaw-specific scoring exists.

### Risks

| Risk | Mitigation |
|---|---|
| A description contradicts an annotation (for example "read-only" on check_queue_status) and triggers the Annotation Contradiction flag | KTD2 rules, plus U1 tests on the readOnly and destructive clauses |
| A first sentence with an inner ". X" breaks `firstSentence` and the docs table | R7. `pnpm gen:docs:check` diff is read in U4 |
| A description names a tool or parameter its host lacks (for example `dry_run` on OpenClaw). `docs-drift` S7.3 scans only the plugin commands, not `TOOL_SURFACE` | U1 test on tool and parameter names per host |
| Behavior claims drift from handlers | The implementer reads each handler in `server.ts` before writing its Returns clause |

---

## Implementation Units

### U1. Surface mechanism and structural tests

- **Goal:** the surface can carry annotations and per-host descriptions, and tests enforce the template.
- **Requirements:** R2, R6, R10. KTD2, KTD4, KTD6.
- **Dependencies:** none.
- **Files:**
  - `packages/core-ts/src/tool-surface.ts`
  - `packages/core-ts/src/index.ts` (export the resolver if new)
  - `packages/mcp-server/src/server.ts` (`buildToolList` emits annotations)
  - `packages/openclaw-plugin/src/index.ts` (`toolDescription` resolves for the openclaw host)
  - `packages/openclaw-plugin/src/tool-schemas.ts` (if it reads `def.description` directly)
  - tests: `packages/core-ts/test/tool-surface.test.ts`, `packages/mcp-server/test/tool-surface-derivation.test.ts`, `packages/openclaw-plugin/test/tool-surface-derivation.test.ts`
- **Approach:**
  1. Add the optional neutral `annotations` and per-host description fields to `CanonicalToolDef`.
  2. Resolve the host description inside `toolsForHost` and `neutralSurfaceForHost`, so every existing consumer gets host text unchanged.
  3. Include annotations in the neutral snapshot.
  4. Emit `annotations` in `buildToolList`.
- **Execution note:** write the structural tests first. They fail on today's text, and U2 and U3 turn them green.
- **Patterns to follow:** per-host parameter entries via `hosts: [...]` in the same file. The snapshot canary in `tool-surface.test.ts`.
- **Test scenarios:** the text rules run on every host-resolved description of every tool except the OpenClaw-only `set_delivery`.
  - Each description is at most 600 characters (schedule_task at most 900).
  - Each description contains `Use when:`, a `Do not use` clause, `Behavior:` and `Returns:`, in that order.
  - For each host, every tool name and parameter name of the full surface that appears in a description resolved for that host exists on that host. update_deadline on openclaw does not mention postpone_task, and schedule_task on openclaw does not mention dry_run.
  - cancel_task names cancel_all, and cancel_all names cancel_task.
  - Every MCP tool has all four hint booleans and a title.
  - A tool with `readOnlyHint: true` has the exact phrase "writes nothing" in its Behavior clause, and the rest of the clause has no write verb ("writes", "marks", "creates", "deletes", "refreshes", "updates").
  - A tool with `destructiveHint: false` has no "overwrites", "replaces", "deletes" or "removes" in its Behavior clause.
  - The MCP `tools/list` reply carries each tool's annotations equal to the surface (mcp derivation test).
  - The OpenClaw registered description equals the openclaw-resolved description (openclaw derivation test).
- **Verification:** the new tests exist and fail only on the text rules and the annotation-presence rule. The derivation tests pass.

### U2. Rewrite the twelve MCP tool descriptions

- **Goal:** every MCP tool description meets KTD3 and the per-tool content map.
- **Requirements:** R1–R7. KTD3, KTD4.
- **Dependencies:** U1.
- **Files:** `packages/core-ts/src/tool-surface.ts`, `packages/core-ts/test/__snapshots__/tool-surface.test.ts.snap`.
- **Approach:**
  1. Read each tool's MCP handler in `packages/mcp-server/src/server.ts` and its OpenClaw handler in `packages/openclaw-plugin/src/index.ts` for reply fields and rejection behavior.
  2. Write the MCP description from the content map.
  3. Set each tool's title and four hints from the RO/De/Id/OW column and the KTD2 rules.
  4. Where the MCP text is not true on OpenClaw, write an `openclaw` override from the OpenClaw handler (KTD4).
  5. Regenerate the snapshot and read the diff: only description and annotation lines may change.
- **Patterns to follow:** recommend_window's current text, which scored 5 on Purpose and Usage. Write plain sentences, one fact per sentence.
- **Test scenarios:** covered by the U1 structural tests turning green for descriptions.
- **Verification:** U1 description tests pass. The snapshot diff shows no parameter-set, kind or requiredness change.

### U3. Rewrite parameter descriptions

- **Goal:** every parameter on both hosts tells an agent how to fill it (R8) without restating the schema (R9).
- **Requirements:** R8, R9. KTD5.
- **Dependencies:** U2 (same file, avoids conflicting edits).
- **Files:** `packages/core-ts/src/tool-surface.ts`, `packages/core-ts/test/__snapshots__/tool-surface.test.ts.snap`.
- **Approach:**
  1. Start with the shared descriptors (`deadlineParam`, `regionParam`, `taskIdRequired`, `carbonBudgetParam`, `candidatesParam`, `routeWeightsParam`), then each tool's own parameters.
  2. For task_id: the `t-<uuid>` id from schedule_task or the check_queue_status summary.
  3. For deadline: convert user wording to an ISO-8601 time with offset, with an example.
  4. For every optional parameter: what happens when omitted.
- **Test scenarios:**
  - Every parameter description on both hosts is non-empty and differs from its bare name.
  - Every optional parameter on both hosts states its default or the effect of omitting it. Assert that "Default", "Defaults" or "Omit" appears.
  - The parameter facets in the snapshot (format, min, max, values) are unchanged.
- **Verification:** the tests pass. The snapshot diff shows only `description` changes on params.

### U4. Generated artifacts, counts and CHANGELOG

- **Goal:** the docs, test counts and changelog match the new surface.
- **Requirements:** R7, R11.
- **Dependencies:** U2, U3.
- **Files:**
  - generated: `apps/web/src/lib/docs.generated.ts`, `apps/web/public/llms-full.txt` (from `pnpm gen:docs`)
  - generated: `README.md` tests marker, `apps/web/src/lib/tests.generated.ts` (from `pnpm gen:tests`)
  - `CHANGELOG.md`
- **Approach:**
  1. Run the generators.
  2. Read the docs-table diff: each tool row is the new purpose sentence.
  3. Add one `### Changed` entry under `[Unreleased]` naming the template, the annotations and the parameter rewrite.
- **Test expectation:** none. These are generated files and changelog text, and the gate covers them.
- **Verification:** the gate in the Verification Contract passes.

---

## Verification Contract

| Check | Command | Proves |
|---|---|---|
| Core surface and snapshot | `pnpm --filter @tidegap/core test` | U1 structural rules, snapshot |
| MCP derivation and protocol | `pnpm --filter @tidegap/mcp test` | annotations and descriptions served over MCP |
| OpenClaw derivation | `pnpm --filter @vitalini/tidegap test` | host-resolved descriptions on OpenClaw |
| Repo gate | `pnpm build && pnpm typecheck && pnpm gen:tests:check && pnpm gen:docs:check && node scripts/qa/docs-drift.mjs` | generated files current, docs claims true |
| Stdio smoke | `pnpm --filter @tidegap/mcp smoke` | the built server lists all 12 tools |
| MCP QA flow | `pnpm qa mcp` | tool calls behave as before |

`pnpm check:versions` must still pass, which shows no version moved.

## Definition of Done

- All 12 MCP tool descriptions and all parameter descriptions are rewritten, and the U1 tests pass.
- `tools/list` advertises annotations for every tool.
- The Verification Contract passes.
- The CHANGELOG has an entry under `[Unreleased]`. There is no version bump and no release.
- The diff holds no abandoned drafts, no hand edits to generated files, and no local paths or owner names.
- The PR is open. The "Glama build" steps are in the PR description for the maintainer.

---

## Sources

- Glama capture, 2026-10-22: per-tool TDQS criteria and the Dockerfile tab (`npm install -g @ebb-ai/mcp`, `ebb-mcp`, `EBB_*` env). It is session scratch input, not committed.
- TDQS rubric: https://tdqs.dev/spec and https://tdqs.dev/dimensions. Weights: Purpose 25, Usage 20, Behavior 20, Parameters 15, Conciseness 10, Completeness 10. Rules used:
  - Usage 5 = explicit when, when-not and named alternatives.
  - Purpose 5 = differs from siblings.
  - Parameters baseline 3 above 80% schema coverage; either channel earns credit.
  - Behavior is graded relative to the four annotations, and a contradiction scores 1.
  - No length limit; restating the schema earns nothing.
- `docs/solutions/tooling-decisions/tool-surface-shared-descriptions.md`: change descriptions once in `TOOL_SURFACE`, regenerate the snapshot, state side effects.
- `scripts/build-docs.mjs` (`firstSentence`, `loadCoreData`): docs tool table source.
- `compat/npm/mcp/package.json`: the shim depends on `@tidegap/mcp ^0.18.0`.
