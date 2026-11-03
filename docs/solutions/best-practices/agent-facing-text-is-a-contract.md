---
title: "Agent-facing text is a contract: check each fact against the code, pin the core facts, keep a command's body in step with its description"
date: 2026-11-02
category: best-practices
module: packages/claude-code-plugin (skills/tidegap/SKILL.md, commands/*.md, README.md), packages/core-ts/src/tool-surface.ts, packages/mcp-server/src/server.ts, packages/openclaw-plugin/README.md, scripts/qa/docs-drift.mjs
problem_type: best_practice
component: documentation
severity: medium
applies_when:
  - "Writing or rewriting a skill, a slash command, a tool text, the MCP server instructions or a plugin README"
  - "A sentence tells an agent which runner, path, tool or task state to use"
  - "A plan drafts agent-facing text that the implementation copies"
  - "A command file sends the agent to a tool or to a sibling command"
tags: [agent-contract, skill, slash-command, claude-code-plugin, mcp-instructions, openclaw, docs-drift, k22, review, claims-lens, batch-api, protected-folders, retry]
---

# Agent-facing text is a contract

## Context

Batch 32 (plan PR #223, PR #224) rewrote the `tidegap` skill, the ten slash-command descriptions, two tool texts and the MCP server instructions, so that an agent learns the product from the plugin alone. An agent acts on each sentence of that text: it picks a runner, writes a path, calls a tool. A false sentence gives a wrong action, not a typo.

False facts came from three places:

- **Old text on `main`.** The plan's research found five before any writing:
  - `defer.md` said that a direct `schedule_task` call has no session id. The server finds the session itself (`packages/mcp-server/src/origin.ts:1-15`).
  - The `defer.md` description said "50% cost reduction" without the "projected" hedge of `docs/claims.md`.
  - The OpenClaw tool texts promised a Batch path. The gateway's adapters omit `dispatchBatch` (`packages/openclaw-plugin/src/index.ts:494-495`), so the gateway runs every task synchronously.
  - The plugin README named the wrong OpenClaw package.
  - The marketplace listing counted eight slash commands. There are ten.
- **The freshly written text.** The review of #224 still found two false facts (both P2). One review lens checked each factual sentence of the diff against the code (52 claims):
  - The skill and the `defer.md` description said that a long deadline goes through the Batch API. Only `anthropic` and `openai` tasks can (`isBatchCandidate`, `packages/core-ts/src/scheduler.ts:1069-1089`). A task queued from Claude Code defaults to the `claude-code` runner, and that runner has no Batch path (`packages/cli/src/providers/claude-code.ts:813`). So the sentence was false for the default case. The plan's skill outline (KTD1) had the sentence without the runner condition. The MCP `provider` parameter text already had the condition.
  - `defer.md` and the plugin README recommended `--output ~/.tidegap/inbox/<id>.json`. `~/.tidegap` is in `PROTECTED_HOME_DIRS` (`packages/core-ts/src/handoff.ts:118`), so `outputPathError` refuses the path. The example is older than the protection, which came with #210. The rewrite kept the example. K20 compares the protected-folder list only on the handoff and tools pages, so no rule read the plugin's example.
- **The body of a command.** `retry.md` told the agent to fix a carbon-budget failure with `/tidegap:reschedule`. `updateDeadline` refuses a failed task (`scheduler.ts:1808-1816`). The plan's new `retry.md` description (KTD3) copied that advice from the body, so the false fact also went into the description.

## Guidance

1. **Check each fact that an agent acts on against the code, in the PR that writes the fact.** Such a fact names a runner or provider, an allowed or refused path, the task states a tool accepts, the flags a command parses, or a default. Read the line that defines it, and cite `file:line` in the plan or the PR. Plan text is not a source. In #224 the false Batch sentence and the false `retry.md` advice both came from the plan. Before you copy a plan's draft text, check each of its facts again. The tool texts have a list of the facts that their review found: `../tooling-decisions/tool-surface-shared-descriptions.md`, "Wording facts to verify before writing".
2. **Review agent-facing text with a claims lens.** Give one reviewer only this job: for each sentence that states behaviour, quote the defining line, or mark the sentence false. In #224 this lens found both P2s. The tests and drift rules did not find them, because a rule guards only the facts that it names.
3. **Pin the core facts with a drift rule that reads the code.** K22 keeps four facts in the skill, each in its own section. The values come from built code: the runner list from `QUEUE_ADD_RUNNERS`, the notice line from `renderNoticeBlock`, the repeat values from `TOOL_SURFACE`. S7.4 checks that each slash command and each tool name in the skill exists. The rule details: `generated-docs-embed-and-drift-rule-with-vacuous-pass-guards.md`, "K22 and S7.4". A rule keeps its facts present and equal to the code. It does not make the other sentences true. Rules 1 and 2 do that.
4. **State one fact on every surface, in that surface's terms (KTD9).** The surfaces are the skill, the slash commands, the MCP instructions, the tool texts, and the OpenClaw texts and README. A surface states only what its host does. The OpenClaw gateway runs every task synchronously, so its texts lost the Batch claim. Its `cancel_task` note ("a Batch call may still bill") stays, because a `tidegap tick` daemon on the same queue can submit such a call. When one surface gets a new fact, the other surfaces get it in the same PR, or the PR says why it does not apply there. In #224 these checks guard the core facts on each surface:
   - The skill: K22.
   - The instructions: `packages/mcp-server/test/server.protocol.test.ts`.
   - The `schedule_task` and `not_before` texts: `packages/core-ts/test/tool-surface.test.ts`.
   - The slash-command descriptions and the OpenClaw README have no check. Check them by hand in the PR.
5. **A command's description, its body and its tool must agree.** The model reads the description to choose a command, and it follows the body. When the body sends a task to a tool or to a sibling command, read the handler. Make sure the handler accepts the task in that state. In `retry.md`, `retry_task` runs a failed task now and has no budget check (`retryTask`, `scheduler.ts:1875-1935`). `update_deadline` rejects a failed task. So the fixed body says: a retry does not keep the budget. To keep the budget, queue the task again with `/tidegap:defer <task> --by <later deadline> --budget <grams>`. The description names the sibling for a task that has not failed (`/tidegap:expedite`).

## Why This Matters

An agent does not check the text against the code. It writes `~/.tidegap/inbox/x.json`, and the call fails. It waits for a Batch discount that a `claude-code` task never gets. It calls `update_deadline` on a failed task and gets an error. The tests stay green in each of these cases, because the tests check the code and not the sentence. In #224 the gate, the unit tests and the drift rules passed with both P2s in the diff. Only the claims lens found them.

## When to Apply

- Any PR that changes `packages/claude-code-plugin/skills/**`, `packages/claude-code-plugin/commands/*.md`, `TOOL_SURFACE` texts, `SERVER_INSTRUCTIONS`, or a package README section for agents.
- A plan that drafts agent-facing sentences: cite the code line for each fact in the plan itself.
- A code change that changes a refusal list, a default or a state rule (#210 added `~/.tidegap` to the protected folders): grep the agent-facing files for examples that the change makes false.

## Examples

| Text (before #224) | Code | Text (after #224) |
|---|---|---|
| A long deadline can go through the Anthropic or OpenAI Batch API. | `isBatchCandidate` takes only `provider` `anthropic` or `openai` | An `anthropic` or `openai` task whose deadline is more than 24 hours away can go through that provider's Batch API; the other runners never do. |
| `--output ~/.tidegap/inbox/<task_id>.json` | `PROTECTED_HOME_DIRS` holds `.tidegap` | A file in this project or the temp folder (`/tmp/tidegap-<name>.json`). The skill lists `~/.tidegap` among the refused folders. |
| `CarbonBudgetExceededError`: use `/tidegap:reschedule <id> --by <new>` to extend the deadline first. | `updateDeadline` throws on `failed` | A retry runs the task now, so the budget does not hold. To keep the budget, queue the task again with `/tidegap:defer`. |

**Prevention, not built (a check for a later PR).** A docs-drift rule could read each `--output`, `--result-path`, `output_path` and `result_path` example path in `packages/claude-code-plugin/**` and the package READMEs. It fails when a path starts with `~/` and a `PROTECTED_HOME_DIRS` entry. Today K20 reads only the docs pages, so a new example under `~/.tidegap` passes the gate.

**Known gap.** The first sentence of the MCP `schedule_task` text and `SERVER_INSTRUCTIONS` still say that long deadlines "may use the provider Batch API", and they name no runner. The word "may" hedges it, and the MCP `provider` text gives the condition. Add the runner condition when one of these texts changes next.

## Related

- `generated-docs-embed-and-drift-rule-with-vacuous-pass-guards.md` (K20, K22, S7.4).
- `skill-file-acceptance-by-a-cheap-model.md` (the reading test of the skill, and the frontmatter rules).
- `../tooling-decisions/tool-surface-shared-descriptions.md` (budgets, server instructions, per-host texts).
- `claims-audit-method.md` (numbers and hedges on every published surface).
- `agent-hooks-for-scheduling-intents.md` (the hint and the guard, K17).
