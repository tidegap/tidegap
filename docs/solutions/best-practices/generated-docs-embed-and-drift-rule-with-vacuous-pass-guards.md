---
title: "Generated docs embeds and a drift rule that cannot pass vacuously (K12 regions, K13 channels, K15 jobs)"
date: 2026-10-20
category: best-practices
module: scripts/build-docs.mjs, scripts/qa/docs-drift.mjs, apps/web/content/docs
problem_type: best_practice
component: documentation
severity: medium
last_updated: 2026-10-26
applies_when:
  - "A docs page repeats facts that live in code (a zone table, per-kind steps, error sentences, CLI help)"
  - "A QA script compares docs with code by scanning the docs for patterns"
tags: [docs, drift, generated, embed, qa, vacuous-pass, mutation-check, jobs, parse-back, tool-surface]
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
- **Stop where a check gets brittle.** Not in K15: the `packages/mcp-server/README.md` repeat list (a table cell mixing signatures and prose) and option names in prose. Known gaps from the review: the guard needs 3 quoted sentences, not one per shape, so deleting the every-N-hours sentence still passes; numeric claims (output and time caps, the 30-minute retry, auto-pause after 3 slots) have no rule, so check them by hand (`claims-audit-method.md`).

## What the rules caught

- `regionRequestUrl` linked to an issue template that did not exist (K12, #125).
- Docs claimed an Electricity Maps key passes any zone; `IT` is an ENTSO-E zone and needs the token.
- The Cadence table and the tools-page list could drift from the `repeat` enum unnoticed until K15 covered them (#159 review).

## Costs

- Adding a docs page shifts file numbers (06 was Telegram; Telegram, Receipts, Config, FAQ moved to 07-10 in #130). The drift script, the QA matrix references and cross-links change together.
- Run `node scripts/qa/docs-drift.mjs`, `pnpm gen:docs:check` and `pnpm gen:tests:check` before the PR.
