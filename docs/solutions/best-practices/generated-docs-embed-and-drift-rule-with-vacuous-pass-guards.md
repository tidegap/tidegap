---
title: "Generated docs embeds and a drift rule that cannot pass vacuously (K12 regions, K13 channels, K15-K17 jobs)"
date: 2026-10-20
category: best-practices
module: scripts/build-docs.mjs, scripts/qa/docs-drift.mjs, scripts/qa/docs-drift-jobs.mjs, apps/web/content/docs
problem_type: best_practice
component: documentation
severity: medium
last_updated: 2026-10-28
applies_when:
  - "A docs page repeats facts that live in code (a zone table, per-kind steps, error sentences, CLI help)"
  - "A QA script compares docs with code by scanning the docs for patterns"
  - "A docs page states a number that a code constant enforces (limits, delays, rate limits)"
  - "The same value appears in copy-paste examples in several files (skill, slash command, agent block)"
tags: [docs, drift, generated, embed, qa, vacuous-pass, mutation-check, jobs, parse-back, tool-surface, constants, copy-paste-examples]
---

# Generated docs embeds and drift rules

Two uses: the region zone table and K12 (#125), the Notifications page and K13 (#130).

## Pattern

1. **Generate what can be generated.** `scripts/build-docs.mjs` expands `<!-- embed:regions -->` and `<!-- embed:channel-<kind> -->` from the built core (`REGION_CATALOG`, `regionDataSource`, `KIND_DESCRIPTORS`). Steps, fields, presets, default events and error sentences cannot drift because nobody types them. Each embed has a test in `build-docs.test.mjs`. Commit the output (`docs.generated.ts`, `llms-full.txt`).
2. **Drift rule for what stays hand-written.** `docs-drift.mjs` rules compare prose to code:
   - K12: the precedence table lists exactly the `RegionSource` values; every quoted `Unknown zone X. Closest: ...` equals `unknownRegionMessage(X)`; the Ukraine paragraph lists the approximate time zones; the request template exists.
   - K13: kind sections `{#notify-<kind>}` equal the ready registry kinds in card order and each has its embed; every hand-written quoted error code exists in code; every `tidegap channels <sub>` on the page exists and every subcommand is documented on this page or the Telegram page; every quoted `tidegap channels ... --help` block equals real CLI output (captured under `HOME=$(mktemp -d)`).
3. **Vacuous-pass guards.** A scan over empty input passes. Each rule fails when its input is empty or too small:
   - K12: no `RegionSource` values, no quoted "Unknown zone" example, an empty approximate time-zone map.
   - K13: no ready kind, no kind section, fewer than 10 known codes, no quoted code, fewer than 5 subcommands, no help block.
   - The #125 review caught K12 passing on empty input. The #130 review added: count every quoted `Usage: tidegap channels` line and fail when a help block has another shape; accept a fence language; check one-word codes in the "(`code`)" form.
4. **Mutation check.** Before the PR, break the docs on purpose (rename an anchor, add an unknown code, edit a help line) and see the rule fail. #130 did this for all four K13 parts.
5. **Scope each scan.** K12's precedence scan reads only the "Grid region" section, so other tables do not match.

## K15: jobs docs (#159)

The Jobs page (`10-jobs.md`) and the tools page (`04-tools.md`) repeat the `schedule_task` surface and the guarantee sentences. Nothing on them is generated, so K15 reads both from the built core.

- **Read the facts from the tool surface, never from a constant in the script.** The `repeat` values come from the `repeat` param enum in `TOOL_SURFACE` (minus `none` and `quota_reset`, the older series). The `every_hours` range comes from the param's `min` and `max`, and K15 also checks them against `MIN_EVERY_HOURS` and `MAX_EVERY_HOURS`. The #159 review added this: the range sentence on the page is built from those values, with no bound typed in the script.
- **Check every place a fact appears, and guard each one.** The parameter table, the Cadence table (backticked values plus one "every N hours" row), the `04-tools.md` "`repeat` set to ... creates" list, and every `` `repeat: <value>` `` on both pages. Each part fails when it finds nothing (at least 5 parameter rows, 3 cadence rows, the tools list present, at least one `repeat:` mention).
- **Parse a quoted sentence back into its input and regenerate it.** Every backticked `runs ...` span is parsed into a schedule (cadence, days, window) and compared with `core.guaranteeText(schedule)`. A typo, a changed wording in core, or a sentence for a schedule core cannot express fails. The parser must accept every shape core prints: the review found that `runs once every Mon and Thu, any time of day` failed until the weekly pattern accepted `once` and the `,` ending.
- **Mutation-check each part.** #159 broke the docs six ways (a `monthly` row, `weekly` dropped from the tools list, `repeat: quota_resets`, `2 to 336`, the tools sentence removed, the "every N hours" row renamed); each failed K15.
- **Stop where a check gets brittle.** Not in K15: the `packages/mcp-server/README.md` repeat list (a table cell mixing signatures and prose) and option names in prose.
- **Guard each shape, not a count (#172).** The #159 guard asked for 3 quoted sentences, so deleting the every-N-hours sentence still passed. K15 now records the shape of each parsed sentence and fails when one of "daily with a window", "weekdays", "weekly" or "every N hours" has none. The `repeat` values come from the parameter row's leading list only, so a backticked cross-reference later in the row is not read as a value, and the row match tolerates a trailing space.

## K16 and K17: jobs limits and the night window (#172)

The #159 known gap (numbers on the Jobs page with no rule) became K16; the "every night" window became K17.

- **K16 reads every number from the built code, never from the script.** Core: `DEFAULT_JOB_CAPS` (command and LLM time limits, budget, output cap, summarize input), `JOB_RETRY_DELAY_MS`, `JOB_AUTO_PAUSE_FAILURES`, `SCRUB_MIN_LENGTH`. CLI build: `JOB_WRITES_PER_MINUTE` and `JOB_PREVIEWS_PER_MINUTE` from `packages/cli/dist/ui/jobs-api.js`, `STDERR_TAIL_BYTES` from `packages/cli/dist/jobs/run-shell.js`. A constant that a docs claim needs must be exported first; #164 and #169 exported the retry delay and the write limit for this rule.
- **One guard per claim.** Each claim is a regex with one capture. A claim with no match on the page fails ("does not state the ..."), a code constant that is missing or not positive fails, and every match must equal the constant. Number words (`three`) map to digits. One guard over all claims together would pass with a claim deleted. Two claims share a shape: the stderr tail reads "errors keep their last 4 KiB" and the summarize input reads "(the last 200 KiB)"; neither pattern matches the other sentence, and a test deletes each sentence to prove it.
- **Cover the copy-paste examples, not only the prose.** The first K17 read only sentences that contain "night". The skill, `defer.md` and `AGENTS_BLOCK` also carry `--daily --window ...` and `--repeat daily --window ...` commands, which users and agents copy as they are; a changed window there passed (#172 review, reproduced). K17 now also collects the window of every such command. The wanted window comes from the `schedule_task` text, and each source (tool text, jobs page, `defer.md`, the skill, `AGENTS_BLOCK`) must name at least one window.
- **Match a docs heading as a line, not a substring.** `check-agent-files` looked for each docs category label anywhere in `llms-full.txt`, so a renamed `## Jobs` heading still passed on the word "Jobs" in the body. `missingCategories` matches a `## <label>` line.
- **Mutation-check each claim.** #172 changed each number, deleted each guarantee shape and changed the window in each source; each failed, and two non-changes (a trailing space after the row pipe, a backticked cross-reference in the row) still passed.
- **Unit tests for the rules.** K15-K17 are pure functions in `scripts/qa/docs-drift-jobs.mjs`: page texts and code values in, the list of problems out. `docs-drift.mjs` reads the files and the built modules and calls them. `scripts/qa/docs-drift-jobs.test.mjs` runs them on small fixture pages and a fake core. For K15 it covers the pass path, the six #159 mutations, a deleted every-N-hours sentence, a quoted sentence that differs from `guaranteeText`, and the two non-changes. For K16 and K17 it covers one case of each failure kind (a changed number, a second statement of the same limit that disagrees, a deleted claim, a missing code value, a changed window, a source with no window), not every number or every source. CI runs it in the `node --test` step, and so does `pnpm preflight`.
- **Known gaps.** One match per claim satisfies the guard, so a reworded second statement of the same limit (the command time limit is stated twice) goes unchecked; an en-dash window in a multi-sentence source is not read.

## What the rules caught

- `regionRequestUrl` linked to an issue template that did not exist (K12, #125).
- Docs claimed an Electricity Maps key passes any zone; `IT` is an ENTSO-E zone and needs the token.
- The Cadence table and the tools-page list could drift from the `repeat` enum unnoticed until K15 covered them (#159 review).
- The jobs page and the CHANGELOG counted "secret changes" as rate-limited job writes; no route writes a secret (#172 review, found by reading the limiter, not by a rule).

## Costs

- Adding a docs page shifts file numbers (06 was Telegram; Telegram, Receipts, Config, FAQ moved to 07-10 in #130). The drift script, the QA matrix references and cross-links change together.
- Run `node scripts/qa/docs-drift.mjs`, `pnpm gen:docs:check` and `pnpm gen:tests:check` before the PR.
