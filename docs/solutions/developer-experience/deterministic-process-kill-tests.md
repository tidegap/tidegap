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
- **The flake on #170 and #174 (a shell alive for the whole 5 s after the tick exited) was a runner gap, not slowness.** Cause and fix in the next section.

## The pid file is not proof that the parent is ready

`packages/cli/test/jobs-runner.test.ts`, "the command group dies with the tick". CI (Node 20) failed twice: after SIGTERM or SIGINT to the tick, the shell pid stayed alive for the whole 5 s poll. Reruns passed.

Cause, in the runner: `runShell` added its SIGTERM and SIGINT listeners after `spawn` returned. The shell can run and write its pid file before the parent gets that far. The test treats the pid file as "the run is live" and signals the tick. Under load the signal landed in that gap: no listener, so the default action ended the tick at once, and the group was never signalled. The shell lived on, reparented to init.

Found with a probe in a Linux `node:20` container (2 CPUs, `yes` load) that logs the runner's stop path: in the failing runs the tick logged nothing, and `/proc/<shell>/status` showed `S` (alive), parent 1. Raising the poll would not help: nothing kills that shell.

Fix: `runShell` calls `hook()` before `spawn`. A signal that arrives during the synchronous spawn is handled after it, when the group is already tracked. Regression test: a pass-through `vi.mock` of `spawn` records the SIGTERM listener count at the spawn and expects the runner's listener to be there.

If the spawn fails, the listeners come off two loop turns later, not at once. Node catches the signal at once but calls the listener only in a later poll phase, and removing the last listener before then drops the signal: the tick goes on after it was told to stop. One turn is not enough when the run started from an I/O callback. Test: a nonexistent `cwd` rejects with `ENOENT`, the listener is still there, and two `setImmediate` turns later the counts are back.

Rules:

- A child's own output (pid file, ready line) proves the child runs, not that the parent finished its setup after `spawn`. Do the setup a signal depends on before `spawn`.
- When a "gone" poll times out for the full bound, suspect that the kill never happened before you suspect slowness. Check the process state (`/proc/<pid>/status`: `Z` is a dead child not reaped yet; `S` or `R` is alive).

Evidence: probe, 60 runs under load: 9 shells still alive after 5 s before the fix, 0 orphans after. Test file 20 runs under load after the fix: 0 failures on macOS and in the Linux container.
