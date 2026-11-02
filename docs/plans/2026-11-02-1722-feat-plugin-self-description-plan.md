---
title: Plugin Self-Description for Agents (Batch 32) - Plan
type: feat
date: 2026-11-02
topic: plugin-self-description
artifact_contract: ce-unified-plan/v1
product_contract_source: ce-plan-bootstrap
execution: code
---

# Plugin Self-Description for Agents (Batch 32) - Plan

## Goal Capsule

- **Objective:** An agent that loads Tidegap in Claude Code, OpenClaw or another MCP host understands the product from the plugin's own text. It knows what one task is, when to defer, how recurring work goes, when a task runs, how the result comes back, and which command or tool does what. It needs no memory file and no note in an instructions file.
- **Means:** one PR, `feat/plugin-self-description` (Sequencing).
  - The skill is rewritten in the brief's seven-point order (KTD1, KTD2).
  - Each slash command says when to pick it (KTD3).
  - The shared tool texts carry the model inside their budgets (KTD4, KTD5).
  - The MCP server sends `instructions` (KTD6, D1).
  - The READMEs and the marketplace listing follow (KTD7).
  - Docs-drift K22 keeps the four core facts in the skill; S7.4 also checks the skill's slash commands and tools (KTD8).
  - One parity rule covers every surface (KTD9).
- **Authority:** the Product Contract decides what; the Planning Contract decides how. Binding repo rules:
  - `CLAUDE.md` (gate, generated files, hard rules, git conventions).
  - `docs/solutions/tooling-decisions/tool-surface-shared-descriptions.md` (change a text once, in `TOOL_SURFACE`; the TDQS template; 600 characters per tool and 900 for `schedule_task`, never raised; a host's text names only what that host does).
  - `docs/solutions/best-practices/generated-docs-embed-and-drift-rule-with-vacuous-pass-guards.md` (read facts from built code; one guard per part; fail on empty input; a one-time mutation check).
  - `docs/solutions/best-practices/agent-hooks-for-scheduling-intents.md` (one "every night" window, K17; the guard asks and never denies).
  - `docs/solutions/best-practices/session-notices-claim-once-per-finish.md` and `docs/solutions/best-practices/wake-an-idle-session-from-a-stop-hook.md` (what the notice and the wake do).
  - `docs/claims.md` (hedges: "projected" on the Batch discount; the one GB run).
  - `docs/solutions/workflow-issues/public-repo-hygiene.md`, `docs/solutions/workflow-issues/generated-test-counts-merge-conflict.md`, `docs/solutions/developer-experience/folding-review-fixes-into-commits.md`.
- **Execution profile:** one Opus `ce-work` agent in `.worktrees/feat/plugin-self-description`, units U1-U7 in order, one stream. Simplify runs on the two code files with logic (`packages/mcp-server/src/server.ts`, `scripts/qa/docs-drift.mjs`); the markdown and the text strings, `tool-surface.ts` included, skip it. `pnpm qa docs` and `pnpm qa mcp` run once each, at the end. No `pnpm qa ui`: no page file changes. The acceptance check (Verification Contract) runs after U7 and before the one `ce-code-review` at the end, so a skill fix it causes gets reviewed too. Then `ce-compound`.
- **Who ships:** the PR ends green, with its review done and the diff reviewed. The agent does not merge. No version bump, release or publish.
- **Stop conditions:** stop and report in these cases:
  - A sentence this plan asks for needs behaviour that does not exist. Cut the sentence and name it in the report.
  - A tool text cannot hold its KTD4 or KTD5 facts inside its budget. Keep the fact in the parameter text, and report the tool and the measured length.
  - A change needs a file outside the unit lists, apart from the generated files.
  - Any code path other than the MCP initialize answer (D1) changes behaviour.
  - The acceptance check fails the same question twice.
  - A test or QA step needs the real `HOME`, `~/.tidegap`, `~/.claude` or `~/.config/tidegap`.
- **Decisions for the owner:** three, each with a recommendation that this plan follows. The orchestrator confirms or flips them before `ce-work` starts.
  - D1 (R6). MCP server `instructions`. Recommended: yes. One string of at most 1,000 characters goes in the initialize answer (KTD6). Claude Code puts server instructions in the model's context in every session, also when it defers the tool schemas and shows only tool names. Cost: about 220 tokens in each session that connects the server. Alternative: no instructions. The model then lives only in the tool texts, which an agent may not read before it decides.
  - D2 (R5). The tool-text budget. Recommended: keep 600 characters per tool and 900 for `schedule_task`, as the learning says. The full model goes to the instructions (D1). `schedule_task` gets two facts, the parameter texts carry the timing and result details, and the other tools stay as they are (KTD4). Alternative (the brief's wording): two or three model sentences on every tool. That needs about 1,000 characters per tool and a budget change.
  - D3 (R8). The marketplace listing. Recommended: fix `.claude-plugin/marketplace.json` in this PR, with no version change. It says "8 Claude Code slash commands" and "Eight slash commands" with eight names; the plugin has ten. Alternative: leave it for the next release PR.

---

## Product Contract

### Summary

The `tidegap` skill becomes the agent contract. Seven sections, in the brief's order, say what a task is, when to defer, how recurring work goes, how the result comes back on each surface, when a task runs, how to hand work to a run, and what each command and tool does. Each slash command says when to pick it over its siblings. The MCP server sends a short version of the model when a host connects, and the `schedule_task` and `not_before` texts carry its two key facts. The OpenClaw texts and README say what the gateway does. A new docs-drift rule keeps the four core facts in the skill.

### Problem Frame

Each item was checked on `main` at `99a414af`.

- **The skill never says what a task is.** `packages/claude-code-plugin/skills/tidegap/SKILL.md` (203 lines) says when to defer and how to call `/tidegap:defer`. It does not say that one task is one run of one runner, that Tidegap starts no other agents, or what `--not-before` means. In the 2026-11-01 live check, a `--not-before 70m --by 3h` task ran 2 h 48 min after it was queued (`docs/solutions/best-practices/wake-an-idle-session-from-a-stop-hook.md`). An agent that reads `--not-before` as a start time looks for the result at the wrong moment.
- **How a result comes back is only partly told.** The skill covers the Claude Code notice, `queue wait`, `--wake` and `queue events` (`SKILL.md:142-167`). It does not say which of them is automatic, and it says nothing of OpenClaw delivery or of other hosts. Its command table lists the slash commands only, no MCP tool. Two lines carry old version notes ("As of v0.7.1", `SKILL.md:59` and `:183`).
- **The commands do not say when to pick them.** Each frontmatter `description` says what the command does (`commands/*.md`, line 2), but not which sibling to use instead, for example `later`, `reschedule` or `expedite`. `defer.md:185-187` says that a direct `schedule_task` call has no session id; the MCP server finds the session in the plugin's session file (`packages/mcp-server/src/origin.ts:1-15`). The `defer.md` description gives "50% cost reduction" without the "projected" hedge of `docs/claims.md` row 4.
- **The tool texts are full.** Each tool text is 529-600 characters long (budget 600). `schedule_task` is 870 characters on MCP and 884 on OpenClaw (budget 900; `packages/core-ts/test/tool-surface.test.ts:158-166`). The learning forbids a larger budget. The MCP server sends no `instructions` (the `new Server(...)` call in `packages/mcp-server/src/server.ts`).
- **The OpenClaw text claims a Batch path that the gateway does not take.** The OpenClaw `schedule_task` text says that long deadlines may use the provider Batch API, and the OpenClaw `provider` text says that `anthropic` and `openai` can. The gateway's adapters have no `dispatchBatch` (`packages/openclaw-plugin/src/dispatch.ts:33-38`, `src/index.ts:494-495`), so the gateway's own sweep always runs a task synchronously. Only a `tidegap tick` daemon on the same queue can send a task to a Batch API: the tick host's adapter decides, for a deadline more than 24 hours away (`isBatchCandidate`, `packages/core-ts/src/scheduler.ts:1062-1089`).
- **The READMEs and the listing drift.** The plugin README section "Without the plugin" names 10 of the 12 MCP tools (`postpone_task` and `tidegap_usage` are missing). Its "Related packages" names `@tidegap/openclaw-plugin`; the package is `@vitalini/tidegap`. `.claude-plugin/marketplace.json` says eight slash commands and lists eight; there are ten. The OpenClaw README has no section for agents.
- **Nothing keeps the facts in the skill.** S7.4 checks only the `tidegap` commands and flags that the skill names (`scripts/qa/docs-drift.mjs:181-188`). K17 checks the night window (`:307-311`). A rewrite can drop any fact, or name a slash command or tool that does not exist, and the gate still passes.
- **The brief's lists miss two tools and three runners.** The brief lists ten MCP tools; `toolsForHost("mcp")` has twelve. The other two are `postpone_task` and `tidegap_usage`, which `/tidegap:later` and `/tidegap:usage` call. The brief names three runners; `QUEUE_ADD_RUNNERS` has six: `claude-code`, `anthropic`, `openai`, `gemini`, `ollama` and `command` (`packages/cli/src/commands/queue-add.ts:41`). This plan uses the lists in the code.

### Requirements

- R1. `SKILL.md` teaches the seven points in the brief's order, one `##` section each (KTD1): what Tidegap is; when to defer and when not; recurring work through Tidegap, not cron; how the result comes back on each surface; when a task runs; handing work to a run; the commands and tools.
- R2. The frontmatter `description` keeps each of its 31 quoted trigger phrases and names the three ways in (`/tidegap:defer`, `schedule_task`, `tidegap queue add`), in at most 1,024 characters (KTD2).
- R3. Every `tidegap` command and flag, every slash command and every tool name in `SKILL.md` exists (S7.4, extended by KTD8).
- R4. Each of the ten command descriptions says what the command does and when an agent picks it over its nearest sibling (KTD3). `defer.md` keeps all its trigger phrases and the "projected" hedge, and its session paragraph matches `origin.ts`.
- R5. On MCP, the `schedule_task` text says that a task is one run of one runner and where its result stays, and the `not_before` text says that it is a bound, not a run time. Both stay inside today's budgets (KTD4, D2).
- R6. The MCP server's initialize answer carries `instructions` that state the model in at most 1,000 characters (KTD6, D1).
- R7. On OpenClaw, the tool texts and the README say what the gateway does: one LLM call per task, run synchronously by the gateway, the result sent by the `set_delivery` mode, and no earliest-start option (KTD5). The OpenClaw `schedule_task` and `provider` texts make no Batch API claim.
- R8. The plugin README names `SKILL.md` as the agent contract, lists all 12 MCP tools and names the OpenClaw package correctly. Per D3, the marketplace listing names ten slash commands (KTD7).
- R9. Docs-drift K22 fails when `SKILL.md` loses one of the four facts: a task is one run of one runner, with the code's runner list; `--not-before` is not a run time; how the result comes back, with the code's notice line; recurring work through `--repeat`, with every job repeat value (KTD8).
- R10. No behaviour changes, except R6. No version field changes. One CHANGELOG entry goes at the end of `### Changed` under `[Unreleased]`.

### Acceptance Examples

- AE1. Covers R1. A Haiku agent that gets only the text of `SKILL.md` answers the six questions of the Verification Contract, and each answer matches its key.
- AE2. Covers R2. Each quoted phrase of the description on `main` is in the new description, and the new description has at most 1,024 characters.
- AE3. Covers R3. With `/tidegap:later` changed to `/tidegap:postpone` in `SKILL.md`, S7.4 fails and names `/tidegap:postpone`. With `check_queue_status` changed to `check_queue_state`, S7.4 fails and names `check_queue_state`.
- AE4. Covers R6. An MCP client on an in-memory transport reads instructions that contain "one run of one runner", `not_before`, "not a run time", `check_queue_status`, `repeat` and "not cron", in at most 1,000 characters.
- AE5. Covers R5, R7. The MCP `schedule_task` text contains "one run of one runner" and `check_queue_status`. The OpenClaw `schedule_task` text contains "one LLM call", "synchronously" and `set_delivery`, and no "Batch".
- AE6. Covers R9. Each of these edits to `SKILL.md` fails K22 with its own message: the "one run of one runner" sentence removed; `ollama` removed from it; the `--not-before` sentence removed; "1 task" changed to "2 tasks" in the notice line; `--wake` removed from its section; `weekdays` removed from the recurring section; the recurring heading renamed.

### Scope Boundaries

- Markdown and text strings, plus the D1 `instructions` string. No new flag, option, tool, parameter or hook.
- The hook scripts (`packages/claude-code-plugin/hooks/*`), `AGENTS_BLOCK` and the hint line of `prompt-hint.sh` do not change. K14 and K17 already guard them.
- `apps/web/content/docs` changes only where a page contradicts the new skill (U7 lists the checks). None is expected.
- `packages/openclaw-plugin/openclaw.plugin.json` and `packages/claude-code-plugin/.claude-plugin/plugin.json` keep their texts; both are correct.
- No version bump, release or publish.

#### Dropped from the brief

- "Two or three sentences on every MCP tool": replaced by D2.
- The brief's ten-tool and three-runner lists: the plan uses the code's twelve tools and six runners (Problem Frame).

#### Deferred to Follow-Up Work

- `/tidegap:defer` does not parse `--not-before` or `--after-limit-reset`, and `usage.md` step 3 suggests `after_limit_reset` with it. A new slash-command argument is a new flag, outside this batch.
- `docs/claims.md` row 17 ("8 commands") is a dated audit and stays as it is.

#### Considered and not built

- A new `scripts/qa/docs-drift-skill.mjs` module with unit tests for K22. K19-K21 are inline with a one-time mutation check (#220), and a new test file also needs `ci.yml` and `preflight`. Evidence that would change the call: K22 needs a parser of its own.
- A drift rule over the frontmatter trigger phrases. The phrases are product text with no source in code; AE2 is a one-time check.
- Server instructions on OpenClaw. `defineToolPlugin` takes only `id`, `name`, `description`, `configSchema` and `tools` (`packages/openclaw-plugin/src/index.ts:641-646`).
- A `pnpm qa mcp` step for D1 over stdio. The U2 unit test drives the same `createEbbServer`.
- Model sentences on the other ten MCP tools (D2, alternative).

### Sources / Research

- Repo reads: `packages/claude-code-plugin/skills/tidegap/SKILL.md`, `packages/claude-code-plugin/commands/*.md`, `packages/claude-code-plugin/README.md`, `packages/claude-code-plugin/hooks/hooks.json`, `packages/claude-code-plugin/.claude-plugin/plugin.json`, `.claude-plugin/marketplace.json`, `packages/core-ts/src/tool-surface.ts`, `packages/core-ts/test/tool-surface.test.ts`, `packages/core-ts/src/scheduler.ts` (`isBatchCandidate`), `packages/core-ts/src/task-events.ts` (`planned_mode`), `packages/mcp-server/src/server.ts`, `packages/mcp-server/src/origin.ts`, `packages/mcp-server/README.md`, `packages/openclaw-plugin/README.md`, `packages/openclaw-plugin/src/index.ts`, `packages/openclaw-plugin/src/dispatch.ts`, `packages/cli/src/commands/queue-add.ts`, `packages/cli/src/handoff/notices.ts` (`renderNoticeBlock`), `scripts/qa/docs-drift.mjs` (S7.3, S7.4, K17, K20, K21), `scripts/qa/docs-drift-jobs.mjs` (`nightWindowProblems`), `scripts/build-docs.mjs` (the `tools` embed uses each MCP tool's first sentence), `apps/web/content/docs/12-handoff.md`, `docs/plans/2026-10-19-qa-matrix-checklist.md` (S7 rows), `docs/claims.md`, `CHANGELOG.md`.
- Measured on `main`: every tool text per host with `descriptionForHost`. Drafts measured for this plan: KTD2 908 characters, KTD4 892, KTD5 856, KTD6 875.
- CLI help read in a temporary `HOME`: `tidegap queue add --help`, `tidegap queue --help`.
- Learnings: the files under Authority.
- External: none. The MCP `instructions` field comes from the SDK in use (`@modelcontextprotocol/sdk` ^1.32.2); U2 confirms it in the installed types before it uses it.

---

## Planning Contract

### Key Technical Decisions

- KTD1. **The skill outline, in the brief's order.** The `##` headings below are exact, because K22 reads sections by their heading line. Every bullet of today's "Anti-patterns to avoid" stays, in the section it concerns. Target: at most 260 lines.
  1. `## What Tidegap is`. It carries the K22 sentence word for word: "One task is one run of one runner: `anthropic`, `openai`, `gemini` or `ollama` (a model API call), `claude-code` (one `claude -p` run) or `command` (one shell command the user approved)." The next sentence: "Tidegap never starts more agents than that: several jobs are several tasks." Then: the tick daemon (`tidegap tick`) runs each task at the cleanest grid hour inside its window, from a 72-hour forecast. A long deadline can go through the Anthropic or OpenAI Batch API (50% of sync list price, projected). Each task gets a signed carbon receipt in the local ledger (`tidegap verify <task-id>`). Today's GB-run sentence stays, with its hedges and the `docs/claims.md` link.
  2. `## When to defer`. Today's three conditions, then "Do not defer when" with today's four cases. The two anti-pattern bullets about the choice move here: do not ask "should we defer this?", and do not fall back to a synchronous call. Then `### How to defer`: today's `/tidegap:defer` argument list (`--by`, `--region`, `--budget`, `--output`, `--repeat`) without the version note, and the advice to preview with `/tidegap:plan` before `/tidegap:defer`.
  3. `## Recurring work: use Tidegap, not cron`. Today's four steps, with the user-run `tidegap jobs add --command '<cmd>' --summarize '<what to report>' --daily --window 22:00-08:00` line, and the "never write a crontab" rule. New: the plugin's guard asks the user before a Bash call edits a crontab, loads a launchd agent, enables a systemd user unit or authors a command job; it never blocks. A prompt about recurring work gets one hint line. The section names `--repeat` with `daily`, `weekdays`, `weekly` and `every_n_hours`, each in its own code span. The night window is `22:00-08:00` in every sentence and command (K17).
  4. `## How the result comes back`. One block per surface. Each block says what is automatic and what the agent does.
     - Claude Code with the plugin. Automatic: a notice on the next prompt, whose first line is quoted exactly as `renderNoticeBlock` prints it for one task (`Tidegap: 1 task queued from this session finished:`); it names each task's id, status and title, and never holds the result. Also automatic: the session-start line about unread tasks. With `--wake` (`wake_session: true`), an idle session wakes within 12 hours after its last turn. The agent does: read the result with `tidegap queue show <id>` or `check_queue_status task_id=<id>`; block with `tidegap queue wait <id> --timeout 1m` (`--timeout 9m` with a 600000 ms Bash timeout); follow with `tidegap queue events <id> --json --after <event-id>`; list with `tidegap queue list --json --session current`; or read the file of `--result-path` (`result_path`) or `--output` (`output_path`).
     - OpenClaw. Automatic: the gateway sends the result by the mode that `set_delivery` chose (default `chat`), and the queue always keeps it. The agent asks the user how to deliver, calls `set_delivery` after `schedule_task`, and reads the result with `check_queue_status`.
     - Another host (MCP or the CLI without the plugin). Nothing is automatic. The agent polls `check_queue_status`, `tidegap queue wait` or `tidegap queue events --json`, or reads the result file. Outside a Claude Code session, `tidegap queue add` says that notices are off.
  5. `## When a task runs`. It carries the K22 sentence word for word: "`--not-before` (MCP `not_before`) is the earliest start, not a run time." It says that `tidegap queue add` and `schedule_task` take it, and `/tidegap:defer` does not. Then: the scheduler picks the cleanest hour between it and the deadline (`--by`); the live check (`--not-before 70m --by 3h` ran 2 h 48 min after it was queued); the deadline holds while the tick daemon runs (`tidegap status` says whether it does); a window of 2 hours or more gives the scheduler room. `--after-limit-reset` (`after_limit_reset`) is the other earliest start. `/tidegap:expedite` runs a task now; `/tidegap:later` moves it later, never earlier.
  6. `## Handing work to a run`. `tidegap queue add --runner claude-code --cwd <dir> --profile read --result-path <new file> --by <when>`, and its `schedule_task` twins (`runner`, `cwd`, `permission_profile`, `result_path`, `wake_session`). A run never gets Bash, Write or Edit. `result_path` and `output_path` must be inside the task's folder, this project or the temp folder; `~/.ssh`, `~/.config`, `~/Library` and similar folders are refused. A `claude-code` task queued from this session, in its project folder and with no web tools, runs in a copy of this session (`planned_mode: fork` in its `created` event, and the reply's `runs_in:` line). Any other run starts fresh (`planned_mode: fresh`), and so does every run of a job, so the prompt must name what the run needs. A `command` task is the user's call: `schedule_task` refuses it, and the guard asks before `tidegap queue add --runner command`.
  7. `## Commands and tools`. Two tables with one line of purpose each: the ten slash commands (today's "The full command surface" table), and the twelve MCP tools plus `set_delivery` (OpenClaw only). Then one list of the CLI commands an agent uses: `tidegap queue add`, `wait`, `events`, `show`, `list`, `tidegap jobs`, `tidegap status`, `tidegap install`.

  After point 7: `## Reading the receipt` (today's text) and `## When tasks do not run` (today's "When dispatch isn't happening", without the version notes). Today's "Inspecting the grid" moves into point 7. The "every night" window also appears in point 3's copy-paste commands, as today.
- KTD2. **The frontmatter description.** The 31 quoted phrases stay, in their order. The routing sentence ("Route through /tidegap:defer (slash command) or schedule_task (MCP tool) so the LLM dispatch fires … when the deadline allows.") becomes: "Tidegap queues them — one task is one run of one runner, at the cleanest grid hour before its deadline, through the Anthropic/OpenAI Batch APIs (50% of sync list price, projected) when the deadline allows. Route via /tidegap:defer, schedule_task (MCP) or `tidegap queue add` (Bash)." The rest stays. Measured: 908 characters, every phrase present. The Agent Skills format caps `description` at 1,024 characters. No frontmatter value in this PR contains ": " or " #": both break a plain YAML scalar, so a dash or a comma takes their place.
- KTD3. **Command descriptions.** Each frontmatter `description` is "what it does" plus "when to use it, and which sibling to use instead". The first body paragraph stays unless it contradicts the description. The texts:

  | File | `description` |
  |---|---|
  | `cancel.md` | Cancel a queued or scheduled Tidegap task by id, or every pending task with --all. Use it when the work is no longer wanted; to run it later, use /tidegap:later. On a repeating task it skips one run; --series ends the series. |
  | `check.md` | Show Tidegap tasks — the list, or one task's status, result and carbon receipt. Use it when the user asks whether a task finished or what it returned; it changes no task's status. |
  | `defer.md` | Queue a task that can wait — one run of one runner at the cleanest grid hour before the deadline, through the Anthropic/OpenAI Batch APIs (50% of sync list price, projected) when the deadline allows, with a signed carbon receipt; --repeat makes a recurring job. Then today's trigger sentence with all 12 phrases, and today's "Don't run the task inline …" sentence. Last: "Use /tidegap:plan to preview without queueing." |
  | `expedite.md` | Run a queued Tidegap task now, outside its carbon window. Use it only when the user wants the result before the planned time; /tidegap:later moves a task later instead. |
  | `grid.md` | Show a grid region's carbon intensity now and for the next 24 hours, with no task involved. Use it when the user asks how clean the grid is; /tidegap:plan says when a task would run. |
  | `later.md` | Postpone a queued Tidegap task by 1h, to tonight, tomorrow_morning, after_limit_reset or a later time; it never moves earlier. Use it to delay the start; /tidegap:reschedule changes the deadline, /tidegap:expedite runs it now. |
  | `plan.md` | Preview when a task would run and its carbon estimate, without queueing it. Use it when the user asks when something would run or what waiting saves; commit with /tidegap:defer. |
  | `reschedule.md` | Change a queued Tidegap task's deadline, earlier or later, and re-score its window. Use it when the deadline moved; /tidegap:later only delays the start. |
  | `retry.md` | Re-dispatch a failed Tidegap task under the same id. Use it after a transient provider error; when the carbon budget failed, extend the deadline with /tidegap:reschedule first. |
  | `usage.md` | Show how much of the Claude Code 5-hour and weekly limits is used and when each resets. Use it when the user asks about limits or wants work to wait for a reset. |

  `defer.md:185-187` becomes: "This command passes the session id. A `schedule_task` call without the command finds the session itself when the Tidegap plugin runs in this Claude Code session, so it also gets the resume line and the notice."
- KTD4. **MCP texts inside the budget (D2).** Only `schedule_task` and its `not_before` parameter change; the other MCP tools keep their texts.
  - The `schedule_task` Behavior clause becomes: "Behavior: adds one task, one run of one runner (dry_run writes nothing), or with repeat a job of such tasks; `tidegap tick` runs it; reads the grid forecast; no login; the result stays in the queue (check_queue_status)." The other clauses stay. Measured: 892 of 900 characters. The words "in this project" leave this text; the `repeat` parameter keeps them.
  - The `not_before` parameter gains: "It is a bound, not a run time: with not_before 70 minutes away and a 3-hour deadline, the task can run near the end."
  - The first sentence does not change, so the `tools` embed of the docs (`scripts/build-docs.mjs`) does not change.
- KTD5. **OpenClaw texts.** They say what the gateway does.
  - `schedule_task` (OpenClaw): the first sentence loses "; long deadlines may use the provider Batch API". The Behavior clause becomes: "Behavior: adds one task, one LLM call (never several agents), or with repeat a job of such tasks with chat delivery; the gateway runs it synchronously with a plugin provider key or the OpenClaw runtime; reads the grid forecast." Measured: 856 of 900 characters.
  - `provider` (OpenClaw): "'anthropic' and 'openai' can use the 50%-cheaper Batch API when the deadline allows; 'gemini' and 'ollama' always run synchronously." becomes "The gateway runs every task synchronously." A `tidegap tick` daemon on the same queue can still send a long-deadline task to a Batch API (`isBatchCandidate`, `packages/core-ts/src/scheduler.ts:1062-1089`), but that is the daemon's behaviour, not the gateway's (KTD9).
  - No generated file embeds an OpenClaw text: the `tools` embed reads `toolsForHost("mcp")`.
  - The OpenClaw `cancel_task` note ("a Batch call may still bill") and the `batchEligible` field of `recommend_window` stay: a `tidegap tick` daemon can submit such a call.
- KTD6. **MCP server instructions (D1).** `packages/mcp-server/src/server.ts` exports `SERVER_INSTRUCTIONS` and passes it as `instructions` in the options of `new Server(...)`. The text (875 characters):

  > Tidegap is a queue for work that can wait. One task is one run of one runner: a model API call, a claude-code run (claude -p) or a shell command the user queued; Tidegap never starts more than one per task, so several jobs are several tasks. The tick daemon (`tidegap tick`) runs each task at the cleanest grid hour between its earliest start (not_before) and its deadline, from a 72-hour forecast: not_before is a bound, not a run time. Long deadlines may use the provider Batch API; every task gets a signed carbon receipt. Recurring work is schedule_task with repeat, not cron. Nothing is pushed over MCP: read a result with check_queue_status, or ask for a file with result_path or output_path. In Claude Code with the Tidegap plugin, the next prompt carries a notice when a task finishes, and wake_session wakes an idle session. Preview a run time with recommend_window.

  The text names no tool count, so K5 does not read it. It names only MCP tools and MCP parameters.
- KTD7. **READMEs and the listing.**
  - `packages/claude-code-plugin/README.md`: "Auto-invocation skill" opens with one paragraph: `skills/tidegap/SKILL.md` is the agent contract (what a task is, when to defer, recurring jobs, how results come back, when a task runs, hand-offs, every command and tool), and docs-drift K22 keeps its four core facts. The trigger-phrase sentence stays. "Result delivery" starts with the session notice and the wake, and names `--result-path` beside `--output`. "Without the plugin" lists all 12 MCP tools. "Related packages" names `@vitalini/tidegap` (OpenClaw plugin).
  - `packages/openclaw-plugin/README.md`: a new `## For agents` section after "Tools registered", one bullet per point: one task is one LLM call through the gateway's model or a plugin provider key, and the plugin starts no other agents; the gateway's sweep runs due tasks every minute, synchronously; when to defer (as the `schedule_task` text says); recurring work is `schedule_task` with `repeat`, never cron, and the plugin creates prompt jobs only; the result goes out by the `set_delivery` mode (default `chat`), the queue always keeps it, and `check_queue_status` reads it; a task runs before its deadline, and OpenClaw has no earliest-start option.
  - `.claude-plugin/marketplace.json` (D3): "8 Claude Code slash commands" becomes "10 Claude Code slash commands"; "Eight slash commands (/tidegap:{defer, plan, check, cancel, expedite, reschedule, retry, grid})" becomes "Ten slash commands (/tidegap:{defer, plan, check, cancel, expedite, reschedule, retry, grid, later, usage})". No version field changes.
- KTD8. **K22 and the S7.4 extension, inline in `scripts/qa/docs-drift.mjs`, reading built code as K21 does.**
  - S7.4 also checks two lists in `SKILL.md`. Each `/tidegap:<name>` must name a file `packages/claude-code-plugin/commands/<name>.md`. Each tool-shaped name (S7.3's pattern and suffix exclusions) must be a `TOOL_SURFACE` tool. The title becomes "skills/tidegap/SKILL.md names only real commands, flags, slash commands and tools".
  - K22, "the tidegap skill states the four facts an agent needs", goes after K21. It reads `SKILL.md` by exact `## ` heading lines. A section ends at the next heading of level 1 or 2 outside a code fence. Sentences split as in K17. Four parts, each with its own message:
    - F1, `## What Tidegap is`: exactly one sentence contains "one run of one runner". Its one-word code spans equal `QUEUE_ADD_RUNNERS` of `packages/cli/dist/commands/queue-add.js`, both ways (`listProblems`).
    - F2, `## When a task runs`: one sentence contains `` `--not-before` `` and "not a run time".
    - F3, `## How the result comes back`: a code span equals the first line of the `text` that `renderNoticeBlock` returns for one stub notice, `{ record: { taskId, status, title } }` (`packages/cli/dist/handoff/notices.js`); an empty list returns no text. Code spans start with `--wake`, `tidegap queue wait` and `tidegap queue events`.
    - F4, `## Recurring work: use Tidegap, not cron`: a code span `--repeat`, and one code span per job repeat value, that is, the MCP `schedule_task` `repeat` enum without `none` and `quota_reset` (as K15 derives it).
  - Guards: a missing section, an empty `QUEUE_ADD_RUNNERS`, an empty notice line and an empty repeat list each fail alone.
  - The header comment of `docs-drift.mjs` names K22 and the S7.4 extension.
  - Rejected: a separate module with its own tests (Considered and not built), and fact checks by keywords spread over the whole file, which pass when the fact moves to another section.
- KTD9. **The parity rule.** A fact is stated once per surface, in that surface's own terms, and each surface states only what it does.
  - Tool texts change only in `TOOL_SURFACE`. The MCP server and the OpenClaw plugin read them, and their derivation tests pin that.
  - MCP says `not_before`, `result_path` and the Claude Code notice. OpenClaw says "one LLM call", the gateway's synchronous run and `set_delivery`, and never names an MCP-only parameter (the existing "names nothing its host lacks" test).
  - The four facts have a check on each surface that carries them: `SKILL.md` by K22, the instructions by the U2 test, the `schedule_task` texts and the `not_before` text by the U1 test. The slash-command descriptions and the OpenClaw README are checked once by hand in the PR.
  - A new fact on one surface goes to the others in the same PR, or the PR says why it does not apply there.

### High-Level Technical Design

Parity matrix: where each point lives after this PR. "—" means the surface does not carry it, on purpose.

| Point | `SKILL.md` | Slash commands | MCP `instructions` | MCP tool and parameter texts | OpenClaw texts and README |
|---|---|---|---|---|---|
| 1. What a task is | F1 sentence (K22) | `defer` description | yes (U2 test) | `schedule_task` Behavior (U1 test) | `schedule_task` Behavior (U1 test), README (by hand) |
| 2. When to defer | section 2 | `defer` triggers | — | `schedule_task` Use when | `schedule_task` Use when, README |
| 3. Recurring work | section 3 (K22 F4, K17) | `defer` `--repeat` | yes | `repeat`, `window` | `repeat`, README |
| 4. How the result comes back | section 4 (K22 F3) | `check` | yes | `check_queue_status`, `result_path`, `wake_session` | `set_delivery`, README |
| 5. When a task runs | F2 sentence (K22) | `later`, `expedite`, `reschedule` | yes | `not_before` (U1 test) | README (deadline only) |
| 6. Handing work to a run | section 6 | — | — | `runner`, `cwd`, `permission_profile`, `result_path`, `output_path` | — (no `claude-code` or `command` runner on OpenClaw) |
| 7. Commands and tools | section 7 (S7.4) | each description | `recommend_window` | each tool's text | README tools table |

### Assumptions

- Claude Code puts MCP server `instructions` in the model's context; other hosts may ignore them, so the `schedule_task` texts still carry the two key facts.
- The Agent Skills limit of 1,024 characters applies to the skill's `description`.
- `@modelcontextprotocol/sdk` ^1.32.2 takes `instructions` in the `Server` options and gives it to a client through `getInstructions()`. U2 checks the installed types first; if the field is missing, that is a stop condition.
- A Haiku agent that answers from the file alone stands for a fresh agent that loads the skill.

### Sequencing

One PR, `feat/plugin-self-description`, branched from `main`, one stream (no parallel streams). The units go in order U1 → U7: U3 and U4 use the texts U1 fixes, and K22 (U6) reads the skill U3 writes. No open PR touches these files.

- QA ids: S7.9 continues the S7 rows of the checklist; K22 continues after K21.
- CHANGELOG: the entry goes at the end of `### Changed` under `[Unreleased]`.
- Generated files: on a conflict, take `main`'s version and run the generator (`pnpm gen:tests`, `pnpm gen:docs`).

### Risks

- The instructions cost about 220 tokens in every session that connects the MCP server (D1).
- K22 pins exact sentences. A rewording of a fact sentence fails the gate until K22 changes in the same PR. That is the point of the rule.
- Glama scores a released build. The template order and the budgets stay, so the TDQS score should not drop; read it after the next release.
- A longer skill costs more context when it loads. The 260-line cap limits that.
- The OpenClaw texts change on ClawHub with the next release. The change removes a Batch claim that the gateway cannot meet.

---

## Implementation Units

### U1. Tool texts in the shared surface

- **Goal:** R5 and R7 in the tool and parameter texts.
- **Requirements:** R5, R7; KTD4, KTD5, KTD9.
- **Dependencies:** none.
- **Files:** `packages/core-ts/src/tool-surface.ts`, `packages/core-ts/test/tool-surface.test.ts`, `packages/core-ts/test/__snapshots__/tool-surface.test.ts.snap`.
- **Approach:**
  1. Apply KTD4 to the MCP `schedule_task` text and the `not_before` parameter.
  2. Apply KTD5 to the OpenClaw `schedule_task` text and the OpenClaw `provider` parameter.
  3. Update the snapshot with the test runner's update flag, and read the diff: only these four texts change.
- **Patterns to follow:** the description-template tests (`tool-surface.test.ts:158-240`) and the learning's "Wording facts to verify before writing".
- **Test scenarios:**
  - Covers AE5. The MCP `schedule_task` text contains "one run of one runner" and `check_queue_status`.
  - Covers AE5. The OpenClaw `schedule_task` text contains "one LLM call", "synchronously" and `set_delivery`, and no "Batch".
  - The `not_before` text contains "not a run time".
  - The OpenClaw `provider` text contains "synchronously" and no "Batch".
  - The existing budget, clause-order, sibling, read-only and "no network" tests pass for every tool and host.
  - The MCP and OpenClaw derivation tests pass unchanged.
- **Verification:** `pnpm --filter @tidegap/core test`, `pnpm --filter @tidegap/mcp test` and `pnpm --filter @vitalini/tidegap test` pass.

### U2. MCP server instructions

- **Goal:** R6 (D1).
- **Requirements:** R6; KTD6, KTD9.
- **Dependencies:** none.
- **Files:** `packages/mcp-server/src/server.ts`, `packages/mcp-server/test/server.protocol.test.ts`.
- **Approach:**
  1. Check that the installed SDK types take `instructions` in the `Server` options.
  2. Export `SERVER_INSTRUCTIONS` with the KTD6 text and pass it to `new Server(...)`. Update the file's header comment.
- **Patterns to follow:** the in-memory client set-up of `server.protocol.test.ts`.
- **Test scenarios:**
  - Covers AE4. A client on an in-memory transport gets instructions equal to `SERVER_INSTRUCTIONS`.
  - The text has at most 1,000 characters and contains every AE4 string.
  - Each tool-shaped name in the text is in `toolsForHost("mcp")`.
  - The tool list and the call results do not change (the existing tests pass).
- **Verification:** `pnpm --filter @tidegap/mcp test` passes; `pnpm qa mcp` passes once at the end of the PR.

### U3. The skill

- **Goal:** R1, R2 and R3 in `SKILL.md`.
- **Requirements:** R1, R2, R3; KTD1, KTD2.
- **Dependencies:** U1 (the skill quotes the tool facts U1 fixes).
- **Files:** `packages/claude-code-plugin/skills/tidegap/SKILL.md`.
- **Approach:**
  1. Write the frontmatter `description` of KTD2.
  2. Write the sections in the KTD1 order, with the two K22 sentences word for word.
  3. Check every claim against the code it names, by the learning's "Wording facts to verify before writing". Cut a sentence that needs behaviour that does not exist.
- **Patterns to follow:** the handoff page (`apps/web/content/docs/12-handoff.md`) for the notice, wake, wait and result-file facts; the plugin README's hook list for the guard and the hint.
- **Test expectation:** none in unit tests; markdown only. K22, S7.4, K5, K11 and K17 prove it (U6), and so does the acceptance check.
- **Verification:** `node scripts/qa/docs-drift.mjs` prints PASS (S7.4, K5, K11, K17); K22 and the S7.4 extension check the file at U6; the frontmatter parses as YAML; AE2 is checked once with a script and recorded in the PR; the file has at most 260 lines.

### U4. The slash commands

- **Goal:** R4.
- **Requirements:** R4; KTD3.
- **Dependencies:** none.
- **Files:** `packages/claude-code-plugin/commands/cancel.md`, `check.md`, `defer.md`, `expedite.md`, `grid.md`, `later.md`, `plan.md`, `reschedule.md`, `retry.md`, `usage.md`.
- **Approach:**
  1. Replace each frontmatter `description` with its KTD3 text.
  2. Replace `defer.md:185-187` with the KTD3 sentence.
  3. Read each first body paragraph, and fix only a sentence that contradicts the new description.
  4. Check each claim of each new description against the command's tool and its code (`TOOL_SURFACE` and the handler). Cut a claim that is not true.
- **Patterns to follow:** S7.3's rules: name only real tools and real arguments.
- **Test expectation:** none in unit tests; markdown only. S7.3, K11 and K17 prove it.
- **Verification:** `node scripts/qa/docs-drift.mjs` prints PASS; all ten frontmatters parse as YAML; every phrase of `defer.md`'s description on `main` is in the new one (one-time check, in the PR).

### U5. READMEs and the listing

- **Goal:** R7 (README part) and R8.
- **Requirements:** R7, R8; KTD7; D3.
- **Dependencies:** U1.
- **Files:** `packages/claude-code-plugin/README.md`, `packages/openclaw-plugin/README.md`, `.claude-plugin/marketplace.json`.
- **Approach:**
  1. Apply KTD7 to each file.
  2. Keep each tool count in the form K5 reads ("12 MCP tools", "11 tools" for OpenClaw).
- **Patterns to follow:** the README tables as they are; the OpenClaw "Result delivery" box for the delivery facts.
- **Test expectation:** none in unit tests; markdown and JSON text only. K5, K11 and S8.4 prove it.
- **Verification:** `pnpm check:versions` passes; `.claude-plugin/marketplace.json` parses; `node scripts/qa/docs-drift.mjs` prints PASS.

### U6. Docs-drift K22 and the S7.4 extension

- **Goal:** R3 and R9.
- **Requirements:** R3, R9; KTD8.
- **Dependencies:** U3.
- **Files:** `scripts/qa/docs-drift.mjs`, `docs/plans/2026-10-19-qa-matrix-checklist.md`.
- **Approach:**
  1. Extend S7.4 (KTD8).
  2. Add K22 after K21, with a heading-section helper next to `pageSection`.
  3. Name K22 and the S7.4 extension in the header comment.
  4. Add the checklist row after S7.8: "- [x] S7.9 `skills/tidegap/SKILL.md` states the four facts (K22) — script:docs-drift.mjs — Haiku · ev:K22".
- **Patterns to follow:** K20 and K21 (`docs-drift.mjs:398-439`): built code, `oneBullet` and `listProblems`, an empty side fails.
- **Test scenarios:**
  - K22 and S7.4 pass on the branch.
  - Covers AE3. Once, by hand: `/tidegap:postpone` and `check_queue_state` in `SKILL.md` each fail S7.4 and name the bad name.
  - Covers AE6. Once, by hand: each of the seven AE6 edits fails K22 with its own message.
  - Revert every edit, and record the runs in the PR.
- **Verification:** `node scripts/qa/docs-drift.mjs` prints PASS; `pnpm qa docs` passes once at the end of the PR.

### U7. CHANGELOG, the site check and generated files

- **Goal:** the user-facing record, no contradiction on the site, and generated files that match.
- **Requirements:** R10; all.
- **Dependencies:** U1-U6.
- **Files:** `CHANGELOG.md`; only if a check below finds a contradiction: the page in `apps/web/content/docs`; generated: the `README.md` test block, `apps/web/src/lib/tests.generated.ts`, and, only if their inputs changed, `apps/web/src/lib/docs.generated.ts` and `apps/web/public/llms-full.txt`.
- **Approach:**
  1. Grep `apps/web/content/docs` for four contradictions: a sentence that says a task runs at its `--not-before` time; an OpenClaw Batch claim; "8 commands" or "eight slash commands"; a claim that a direct `schedule_task` call has no session or resume line. None is expected. Fix a hit in its page.
  2. Add one entry at the end of `### Changed` under `[Unreleased]`: "**The plugins describe Tidegap to agents.** The `tidegap` skill now states, in order, what a task is (one run of one runner; Tidegap starts no other agents), when to defer, recurring work through `--repeat` instead of cron, how the result comes back in Claude Code, OpenClaw and other hosts, that `--not-before` is the earliest start and not a run time, how to hand work to a run, and one line per command and tool. Each slash command says when to pick it. The MCP server sends a short form as its `instructions` when a host connects, and the `schedule_task` and `not_before` texts carry the key facts. The OpenClaw texts no longer say that the gateway uses a Batch API; it runs tasks synchronously. Docs-drift K22 keeps the four core facts in the skill, and S7.4 also checks its slash commands and tools."
  3. Run `pnpm gen:tests` and `pnpm gen:docs`.
- **Test expectation:** none beyond `pnpm gen:tests:check` and `pnpm gen:docs:check`.
- **Verification:** the gate passes.

---

## Verification Contract

- The gate, from the repo root, on the final commit: `pnpm build && pnpm typecheck && pnpm gen:tests:check && pnpm gen:docs:check && node scripts/qa/docs-drift.mjs`. Read a failing log with `grep -nE "✘|Error|expected" <log> | head -40`.
- Unit tests: `pnpm --filter @tidegap/core test`, `pnpm --filter @tidegap/mcp test`, `pnpm --filter @vitalini/tidegap test`, and `node --test scripts/qa/docs-drift-jobs.test.mjs` (K17 still passes).
- QA: `pnpm qa docs` and `pnpm qa mcp`, once each at the end. No `pnpm qa ui`.
- `pnpm check:versions` passes, and no version field changes. `pnpm check:hygiene` prints PASS. A grep over the added lines for session trailers, session links, local home paths and owner names prints nothing.
- Lengths, measured once and recorded in the PR: the skill `description` (at most 1,024 characters), the skill file (at most 260 lines), `SERVER_INSTRUCTIONS` (at most 1,000), and each changed tool text (the U1 tests).
- AE2 and the `defer.md` phrase check: a one-time script lists every quoted phrase of the `main` text that the new text lacks. Expected: none.
- The 11 frontmatters (the skill and ten commands) parse with a YAML parser, and each keeps its `description` key.
- **The acceptance check (AE1).** After U7 and before `ce-code-review`, a reviewer agent gives one Haiku agent the text of `SKILL.md` from the branch head and these six questions, with no tools and no other context. The reviewer agent grades each answer against its key and records the answers and the verdicts in the PR. A failed question means a fix to the skill and one more run; a second failure on the same question is a stop condition.

  | # | Question | Key |
  |---|---|---|
  | 1 | What is Tidegap? | A queue for work that can wait. The tick daemon runs each task at the cleanest grid hour inside its window, from a 72-hour forecast; a long deadline can use a provider Batch API; each task gets a signed carbon receipt. |
  | 2 | When should you defer a task, and when not? | Defer when the user accepts a delay, the task is one bounded deliverable, and the deadline leaves at least 2 hours. Not when the user waits on the result, needs live data, the deadline is under 30 minutes or past, or is debugging. |
  | 3 | How many agents does Tidegap run per task? | One run of one runner per task. It never fans out; several jobs are several tasks. |
  | 4 | When does a task queued with `--not-before 70m --by 3h` run? | At the cleanest hour between 70 minutes and 3 hours after it was queued, not at 70 minutes. It can run near the end of the window (2 h 48 min in the live check). |
  | 5 | How does the result reach you? | In Claude Code with the plugin: automatically, a notice on the next prompt (ids, status and title, never the result), or a wake of the idle session with `--wake`. The agent reads the result with `tidegap queue show` or `check_queue_status`, can block with `tidegap queue wait --timeout` under the Bash limit, or reads the result file. On OpenClaw, by the `set_delivery` mode. Elsewhere, by polling. |
  | 6 | How do you make a nightly job? | A prompt job: `/tidegap:defer <task> --repeat daily --window 22:00-08:00`, or `schedule_task` with `repeat: daily` and `window: 22:00-08:00`. A shell-command job: show the user `tidegap jobs add --command '<cmd>' --summarize '<what to report>' --daily --window 22:00-08:00` to run. Never cron. |

- `git diff origin/main --stat` lists only the unit files and the generated files.
- Commits follow Conventional Commits, for example `docs(plugin): …`, `docs(core): …` for the tool texts, `feat(mcp): send server instructions`, `test(docs): K22 …`, `docs(changelog): …`. Git runs with `git -c core.editor=true -c sequence.editor=true`, each message from a uniquely named file through `-F`. Review fixes fold into their commits. Commit messages and the PR body carry no session trailer or session link.
- The PR body names the D1-D3 outcomes, the measured lengths, the one-time S7.4 and K22 failure runs, the phrase check and the acceptance-check answers.

### Owner check after merge

1. Start a fresh Claude Code session with the plugin from `main` and no memory note about Tidegap. Ask: "Every night, summarize new issues in this repo." The agent proposes `--repeat daily --window 22:00-08:00` and no cron.
2. In the same session, ask: "Review this diff, not before an hour from now, within 3 hours." The agent queues it with `--not-before 1h --by 3h` (or `not_before`), and says that it runs at the cleanest hour in that window and that the notice comes on the next prompt.

---

## Definition of Done

- R1-R10 are met by their units, or reported under a stop condition.
- AE1-AE6 hold as unit tests, docs-drift steps or the recorded one-time checks.
- The PR touches only its unit files and the generated files.
- On the final commit, the gate, the unit tests, `pnpm check:versions`, `pnpm check:hygiene`, `pnpm qa docs` and `pnpm qa mcp` pass, and CI is green.
- `ce-code-review` ran once, and its findings are fixed and folded into their commits. The acceptance check passed.
- No abandoned-attempt text, debug output or temporary files remain in the diff.
- The agent does not merge the PR.
