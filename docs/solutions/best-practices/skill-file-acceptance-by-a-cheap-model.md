---
title: "A skill file passes when a cheap model answers from its text alone: fixed questions, the fact first in each section, the frontmatter description as the trigger surface"
date: 2026-11-02
category: best-practices
module: packages/claude-code-plugin/skills/tidegap/SKILL.md, packages/claude-code-plugin/commands/*.md
problem_type: best_practice
component: documentation
severity: medium
last_updated: 2026-11-09
applies_when:
  - "Writing or rewriting a skill file or a slash command that agents load"
  - "Changing a frontmatter description of a skill or a command"
  - "Planning how to prove that an agent understands the product from the plugin text"
tags: [skill, acceptance-check, haiku, cheap-model, fact-first, frontmatter, description, trigger-phrases, yaml, agent-skills, claude-code-plugin]
---

# Acceptance of a skill file by a cheap model

## Context

Batch 32 (plan PR #223, PR #224) rewrote the `tidegap` skill so that a fresh agent learns the product from it. The drift rules check that facts are present (K22, S7.4). They do not check that a reader finds the facts. The plan added an acceptance check (AE1): one Haiku agent gets only the text of `SKILL.md` (no tools, no repo) and six fixed questions. A reviewer agent grades each answer against a key. Haiku stands for a fresh agent that loads the skill (plan, Assumptions).

The first run failed in part on two questions (per the PR #224 record):

- Q1, "What is Tidegap?": the answer had no forecast and no Batch path. The draft's `## What Tidegap is` started with the runner sentence ("One task is one run of one runner: ..."). The tick daemon, the 72-hour forecast, the Batch path and the receipt were in the second paragraph.
- Q5, "How does the result reach you?": the answer did not say that the notice holds no result.

The facts were in the text, but not first. The fix moved the fact that answers each heading's question to the start of the section. The second run answered 6 of 6 questions.

## Guidance

1. **Write the questions and their answer keys in the plan.** Ask one question for each thing an agent must do right. In #224: what Tidegap is; when to defer and when not; how many agents run per task; when a task queued with `--not-before 70m --by 3h` runs; how the result reaches you; how to make a nightly job. Take questions from real mistakes. In the 2026-11-01 live check, a `--not-before 70m --by 3h` task ran 2 h 48 min after it was queued (`wake-an-idle-session-from-a-stop-hook.md`). An agent that reads `--not-before` as the start time looks for the result at the wrong time.
2. **Run the check with the cheapest model and the file text only.** Paste the text. Give no tools and no other context. Grade each answer against its key, and record the answers and the verdicts in the PR. When a question fails, change the skill and run the check once more. When the same question fails twice, stop: the section cannot carry the fact, so change the structure of the section, not its words.
3. **Run it after the last content change and before the code review.** Then the review also reads the skill fix that the check caused.
4. **Start each section with the fact that answers its heading.** A cheap model answers from the first paragraph under the matching heading, and it stops there. When a section has two facts, put first the fact that the heading's question asks for. K22 reads the whole section, so a move inside the section keeps the gate green. The acceptance check is the only check of the order.
5. **The frontmatter `description` is the trigger surface.** Claude Code shows the model the name and the description of a skill or a command before the body loads. The model compares the user's words with that text to choose. So:
   - **Keep every trigger phrase.** A one-time script lists each quoted phrase of the old description that the new description does not have. The expected result is none. In #224 the skill kept all 31 phrases and `defer.md` kept its 12. The plan did not add a drift rule for the phrases: they are product text, and no code is their source.
   - **Stay within 1,024 characters**, the Agent Skills limit for `description`. The skill description is 918 characters after #224.
   - **Name the ways in and the main fact.** The skill description names `/tidegap:defer`, `schedule_task` and `tidegap queue add`, and "one task is one run of one runner".
   - **Put no `: ` and no ` #` in a plain (unquoted) value.** With js-yaml, `description: Tidegap queues them: one task ...` fails ("bad indentation of a mapping entry"). `description: a #b c` loads as `a`, with no error. Use a dash or a comma. The plan review marked a draft with `: ` in a description as P1. Parse each changed frontmatter with a YAML parser in the PR: #224 parsed 11 (the skill and ten commands).
6. **Keep the skill short.** The body loads into the context each time the skill runs. #224 set a cap of 260 lines and removed the old version notes ("As of v0.7.1"). Since #244 the drift rule K25 enforces the cap. A cut that turns a table into a list drops the purpose column unless each entry keeps its purpose (`generated-docs-embed-and-drift-rule-with-vacuous-pass-guards.md`, K25).

## Why This Matters

A drift rule proves that a fact is in the file. It does not prove that an agent finds the fact. A section that starts with a secondary fact passes every rule, and the agent still answers the main question wrongly. A trigger phrase that is lost, or a frontmatter value that does not parse, stops the skill from loading for those words. No test of the code sees either problem.

## When to Apply

- Each rewrite of `packages/claude-code-plugin/skills/tidegap/SKILL.md`, or a new section in it.
- Each change to a `description:` line in `packages/claude-code-plugin/commands/*.md` or in the skill.
- A plan that says "an agent understands X from the text": write the question and the key into the plan's verification section.

## Examples

Before the fix (the first paragraph answers "what is a task", not "what is Tidegap"):

```markdown
## What Tidegap is

Tidegap is a queue for work that can wait. One task is one run of one runner: ...

The tick daemon (`tidegap tick`) runs each task at the cleanest grid hour inside
its window, from a 72-hour forecast. ...
```

After the fix (the first paragraph answers the heading; K22's runner sentence comes second and still passes):

```markdown
## What Tidegap is

Tidegap is a queue for work that can wait. The tick daemon (`tidegap tick`)
runs each task at the cleanest grid hour inside its window, from a 72-hour
forecast. An `anthropic` or `openai` task whose deadline is more than 24 hours
away can go through that provider's Batch API ...

One task is one run of one runner: ...
```

## Related

- `agent-facing-text-is-a-contract.md` (each fact checked against the code; the claims lens of the review).
- `generated-docs-embed-and-drift-rule-with-vacuous-pass-guards.md` (K22 and S7.4).
- `agent-hooks-for-scheduling-intents.md` (the trigger phrases of the prompt-hint hook).
