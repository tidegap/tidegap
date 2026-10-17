---
title: Deterministic tests for killing a process group
date: 2026-10-17
category: developer-experience
module: packages/cli/test/claude-code-adapter.test.ts
problem_type: developer_experience
component: testing
severity: low
applies_when:
  - "A test starts a child and checks that a timeout kills it and its children"
  - "A CI test passes locally and fails on a slow runner"
tags: [flaky-test, process-group, kill, polling, ci]
---

# Process-group kill tests

PR #80. Production code: `../tooling-decisions/running-claude-p-from-a-daemon.md` (own group, `process.kill(-pid, ...)`).

The test timed out a fixture at 300 ms, then checked `process.kill(grandchild, 0)` once. Two races on a slow runner:

- The timeout fired before the fixture wrote its pid file. The file was empty, the pid read as 0, and `kill(0, 0)` signals our own group: it always succeeds, so the check failed or passed for the wrong reason.
- The check ran before the signalled group had exited. The signal lands after `dispatch` rejects.

Rules used in the fix (test only):

- Give the timeout slack (2000 ms) so the fixture reaches the state under test.
- Assert the pid is real (`> 1`) before using it.
- Poll `isAlive(pid)` every 50 ms up to 5 s, then assert. `isAlive` treats `EPERM` as alive.
- Never assert a negative ("is gone") with one immediate check.

Evidence: 30 isolated runs, 0 failures; full cli suite in parallel, 364 passed.
