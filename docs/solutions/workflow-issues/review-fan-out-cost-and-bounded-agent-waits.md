---
title: "A review pass costs per reviewer, not per finding: cap the reviewers and pick them by risk; a wait in an agent brief needs a bound and a fallback"
date: 2026-10-30
category: workflow-issues
module: development workflow (ce-code-review passes, implementation agent briefs)
problem_type: workflow_issue
component: development_workflow
severity: medium
applies_when:
  - "Running one code review pass per PR in a batch of parallel PRs"
  - "Choosing how many reviewer subagents a review pass dispatches"
  - "Writing an agent brief that asks the agent to wait for machine load, CI or another agent before it runs tests"
tags: [code-review, subagents, token-cost, parallel-batch, agent-briefs, machine-load, bounded-wait]
---

# Review fan-out cost and bounded waits in agent briefs

## Context

Batch 25 ran three PRs in parallel (#194, #195, #196), each with one review pass at its end. Two cost observations came out of it: what a review pass costs, and what an unbounded wait does to an implementation agent.

## Guidance

**A review pass costs per reviewer.** The review of #195, about 1,200 changed lines, ran seven reviewer subagents (correctness, adversarial, reliability, testing, maintainability, project standards, learnings) and cost about 1.47M tokens. The review of #196, about 420 changed lines at the reviewed head, was capped at three reviewer subagents (correctness, testing, project standards) and cost 323k tokens. Each reviewer loads the diff, the touched files and the project rules on its own, so the cost grows with the number of reviewers, not with the number of findings. The #196 pass found three P3 findings, and all were fixed.

- **Cap a pass at three reviewers.** The dispatching agent merges, deduplicates and validates the findings itself, with no further subagents, so the cap holds.
- **Pick the three by the PR's risk, not as a fixed set.** The seven-reviewer pass on #195 found a P1: a Python action ran a row from a stale cache after the Node daemon had failed it (`../logic-errors/compare-and-set-task-transitions.md`, "The Python core"). A PR that changes cross-process writes, a shared ledger or signed data gets an adversarial or reliability reviewer in its three. A UI or test-only PR gets correctness and testing.
- **One pass per PR, at its end.** No interim pass while the work is in progress.

**A wait in a brief needs a bound and a fallback.** An implementation agent was told to wait for the machine load to drop before it ran tests. It started a load monitor with no bound and ended its turn, so it returned to the orchestrator before the tests ran. A brief that asks an agent to wait states the bound and what to do after it: for example, wait at most 10 minutes for the load to fall below the threshold, then run the test files one at a time whatever the load is.

## Why This Matters

A batch pays the review once per PR, and each pass costs about the number of reviewers times the context each one loads. A fixed seven-reviewer pass on every PR multiplies that cost without regard to where the risk is. Picking three reviewers by risk keeps a reviewer aimed at the kind of defect that the #195 P1 was.

An agent that returns early still costs its partial run, and the work needs another dispatch.

## When to Apply

- Every review pass dispatched by an agent, in this repo's batches.
- Every brief that contains "wait", "until" or "when the load is low".

## Related

- `../developer-experience/folding-review-fixes-into-commits.md`: how review fixes land.
- `generated-test-counts-merge-conflict.md`: the other recurring cost of parallel PRs.
