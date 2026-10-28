---
title: Deterministic tests for killing a process group
date: 2026-10-17
last_updated: 2026-10-28
category: developer-experience
module: packages/cli/test (claude-code-adapter.test.ts, jobs-runner.test.ts, jobs-tick.test.ts)
problem_type: developer_experience
component: testing
severity: low
applies_when:
  - "A test starts a child and checks that a timeout kills it and its children"
  - "A CI test passes locally and fails on a slow runner"
  - "A test sends SIGTERM or SIGINT to a tick, or stops the daemon, while a command runs"
  - "A test checks the forced exit of the daemon (a second stop signal)"
  - "A signal or process test fails rarely in CI and passes in a local loop"
tags: [flaky-test, process-group, kill, polling, ci, signals, daemon, sigterm, forced-exit, fake-timers]
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

## Signal tests against a tick (PRs #163, #170, #178)

Production rules: `../best-practices/channels-url-policy-and-child-process-rules.md` (command groups stop with the tick).

- **The stub tick must do what the real tick does after a stop.** The real `tick --once` goes on to its next due rows and then calls `process.exit`. The first stub stayed alive with `setInterval`, so its test passed while a real tick exited 1 before the grace ended (#163 review). The stub in `packages/cli/test/jobs-runner.test.ts` takes an `after` mode: `wait` (stays alive), `finish` (exits 1 after its commands, like the CLI) and `exit` (exits while a run is live). Cover `finish`, and assert that the second command never wrote its pid file.
- **Test both listener shapes.** Alone, the tick must die by the signal: `{ code: null, signal }`. With another listener (`listen`, the daemon's shape), the tick lives on; a command that traps SIGTERM still gets SIGKILL after the grace, and a command that starts after the signal is stopped at once. Run each case for SIGTERM and SIGINT.
- **Stop an in-process daemon without signalling the test worker.** `jobs-tick.test.ts` records the SIGTERM listeners present before `runTick` starts and calls only the new ones. A real `process.kill(process.pid, "SIGTERM")` would hit the worker.
- **Always stop the daemon in `afterEach`.** A failed assertion otherwise leaves it asleep for its one-hour interval with its listeners and console spy on, and later tests in the worker inherit them (#170 review).
- **Test the forced exit with a fake `exit` and a fake `Date` (#178).** `runTick` takes `exit` (default `process.exit`). `jobs-tick.test.ts` passes one that records the code, so a forced exit never ends the test worker. The second stop must come at least 1 s after the first: fake only `Date` between the two calls (`vi.useFakeTimers({ toFake: ["Date"] })`, then `setSystemTime` 1.5 s later). The timers stay real, so the fake `claude` and the polls run, and the test does not sleep.
- **Cleanup must not trust the start wait.** Under the parallel leak gate (`pnpm test:leaks`) the daemon took more than 5 s to reach the spawn. The test read pid 0, skipped the kill and leaked a temp dir (#178 review). `killGroup` now polls for the pid file again and kills a fake that started late.
- **The runner's stop state lasts for the process.** After a stop, every later `runShell` in the same test worker is stopped at once. Keep stop tests in a child process, or put one stop per worker.
- **The flake on #170 and #174 (a shell alive for the whole 5 s after the tick exited) was a runner gap, not slowness.** Cause and fix in the next section.

## The pid file is not proof that the parent is ready

`packages/cli/test/jobs-runner.test.ts`, "the command group dies with the tick". CI (Node 20) failed twice: after SIGTERM or SIGINT to the tick, the shell pid stayed alive for the whole 5 s poll. Reruns passed.

Cause, in the runner: `runShell` added its SIGTERM and SIGINT listeners after `spawn` returned. The shell can run and write its pid file before the parent gets that far. The test treats the pid file as "the run is live" and signals the tick. Under load the signal landed in that gap: no listener, so the default action ended the tick at once, and the group was never signalled. The shell lived on, reparented to init.

Found with a probe in a Linux `node:20` container (2 CPUs, `yes` load) that logs the runner's stop path: in the failing runs the tick logged nothing, and `/proc/<shell>/status` showed `S` (alive), parent 1. Raising the poll would not help: nothing kills that shell.

A loop of the test file did not find it. Before the fix, 20 runs under CPU load passed (#175 investigation): the signal must land between the shell's pid file write and the parent's `hook()` after `spawn` returned, and a loop reaches that gap about as rarely as CI does. The probe ran only the failing case, 60 times, with the runner logging its stop path. A failure then showed which step never ran, so the result did not rest on a pass count.

Fix: `runShell` calls `hook()` before `spawn`. A signal that arrives during the synchronous spawn is handled after it, when the group is already tracked. Regression test: a pass-through `vi.mock` of `spawn` records the SIGTERM listener count at the spawn and expects the runner's listener to be there.

Removing the listeners has the same gap. Node catches a signal at once but calls the listener only in a later poll phase. When the last listener comes off before then, the signal is dropped and the tick goes on after it was told to stop. So the listeners come off two loop turns later (`unhookIfIdleLater`) on every path: a failed spawn (#175 review) and the last run that settles (`untrackGroup`, and `settleStop` when the tick is not alone; #178). One turn is not enough when the run started or settled in an I/O callback. The one exception is the re-raise in `settleStop`: it removes them at once, because the raised signal must reach the default action, not this listener.

Tests: a settled run keeps its listeners for two `setImmediate` turns, then has none. A spawn that throws (a NUL byte in the command: `ERR_INVALID_ARG_VALUE`, before any child exists) and a spawn that returns no pid (a missing `cwd`: `ENOENT`) both keep the SIGTERM listener until two turns pass. The stop tests wait two turns in `afterEach`, so no test starts while a settled run's listeners are still on.

Rules:

- A child's own output (pid file, ready line) proves the child runs, not that the parent finished its setup after `spawn`. Do the setup a signal depends on before `spawn`.
- Do not remove the last signal listener at once. Defer the removal by two loop turns, unless you re-raise the signal yourself.
- For a rare CI flake in a signal or process test, instrument the code path and run only the failing case many times under load. A clean loop of the whole test file proves little either way.
- When a "gone" poll times out for the full bound, suspect that the kill never happened before you suspect slowness. Check the process state (`/proc/<pid>/status`: `Z` is a dead child not reaped yet; `S` or `R` is alive).

Evidence: probe, 60 runs under load: 9 shells still alive after 5 s before the fix, 0 orphans after. Test file 20 runs under load after the fix: 0 failures on macOS and in the Linux container. The loop alone would not prove the fix, because it also passed before; the probe does.
