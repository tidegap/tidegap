---
title: Deterministic tests for killing a process group
date: 2026-10-17
last_updated: 2026-10-27
category: developer-experience
module: packages/cli/test (claude-code-adapter.test.ts, jobs-runner.test.ts, jobs-tick.test.ts)
problem_type: developer_experience
component: testing
severity: low
applies_when:
  - "A test starts a child and checks that a timeout kills it and its children"
  - "A CI test passes locally and fails on a slow runner"
  - "A test sends SIGTERM or SIGINT to a tick, or stops the daemon, while a command runs"
tags: [flaky-test, process-group, kill, polling, ci, signals, daemon, sigterm]
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

## Signal tests against a tick (PRs #163, #170)

Production rules: `../best-practices/channels-url-policy-and-child-process-rules.md` (command groups stop with the tick).

- **The stub tick must do what the real tick does after a stop.** The real `tick --once` goes on to its next due rows and then calls `process.exit`. The first stub stayed alive with `setInterval`, so its test passed while a real tick exited 1 before the grace ended (#163 review). The stub in `packages/cli/test/jobs-runner.test.ts` takes an `after` mode: `wait` (stays alive), `finish` (exits 1 after its commands, like the CLI) and `exit` (exits while a run is live). Cover `finish`, and assert that the second command never wrote its pid file.
- **Test both listener shapes.** Alone, the tick must die by the signal: `{ code: null, signal }`. With another listener (`listen`, the daemon's shape), the tick lives on; a command that traps SIGTERM still gets SIGKILL after the grace, and a command that starts after the signal is stopped at once. Run each case for SIGTERM and SIGINT.
- **Stop an in-process daemon without signalling the test worker.** `jobs-tick.test.ts` records the SIGTERM listeners present before `runTick` starts and calls only the new ones. A real `process.kill(process.pid, "SIGTERM")` would hit the worker.
- **Always stop the daemon in `afterEach`.** A failed assertion otherwise leaves it asleep for its one-hour interval with its listeners and console spy on, and later tests in the worker inherit them (#170 review).
- **The runner's stop state lasts for the process.** After a stop, every later `runShell` in the same test worker is stopped at once. Keep stop tests in a child process, or put one stop per worker.
- **Known flake, cause not found.** Twice on node 20 in CI, a `goneWithin5s` check on the shell's pid failed after the tick had already exited by the signal: the SIGINT case on #170's first run, and "a tick that would go on after the stop" on #174's first run (a docs-only PR). Both reruns passed. One candidate: the shell is orphaned when the tick dies, and `kill(pid, 0)` also succeeds on a zombie until its new parent reaps it. If it recurs, read the process state (`ps -o stat= -p <pid>`, `Z` is a zombie) before you raise the 5 s bound.
