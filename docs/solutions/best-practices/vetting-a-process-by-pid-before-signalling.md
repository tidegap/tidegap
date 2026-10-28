---
title: Vetting a process named only by a pid before reuse or signal (Mac app)
date: 2026-10-20
category: best-practices
module: apps/macos/TidegapKit/Sources/TidegapKit/ServerVetting.swift, ServerLauncher.swift, Connection.swift, TerminationSignals.swift, apps/macos/scripts/install.sh
problem_type: best_practice
component: tooling
severity: high
last_updated: 2026-10-28
applies_when:
  - "A program finds a pid in a file (ui.json) and must decide to attach to it, kill it, or ignore it"
  - "The process may be old code, an orphan, or a pid the kernel gave to another program"
  - "A script must stop the Mac app before it replaces the bundle"
tags: [macos, pid, sysctl, sigterm, ui-json, orphan, pid-reuse, quit, osascript, sigkill, dispatch-source]
---

# Vetting a process named only by a pid

PR #132. After a runtime update the Mac app attached to an orphaned `tidegap ui` (ppid 1, old code) from `~/.tidegap/ui.json`, so the UI served old code. A pid in a file proves nothing: the process may be dead, old, or a different program.

## Decision table

`ServerLauncher.adoptableServer()` runs it. `ServerVetting.verdict` holds the pure rules.

| ui.json server | Action |
|---|---|
| pid dead, <= 1, or the app itself | ignore, start own server |
| argv is not `index.js ui` / `tidegap ui`, or unreadable | foreign: never signal, start own server |
| `tidegap` command not resolvable | keep (reuse) the old server |
| `cli_version` != `tidegap --version` | replace: SIGTERM, SIGKILL after 3 s |
| current, parent is launchd (1), started before the app (or undated) | replace: orphan of an earlier run |
| current, parent is this app or a terminal, or started after the app | reuse |

The same check runs on re-attach after two failed polls. The app's own child is respawned when `tidegap --version` changed since it started.

## Re-check before every signal

`retire()` calls `stillVetted()` right before SIGTERM and again before SIGKILL. It passes only when all hold:

- pid > 1 and not `getpid()` (`isSignallable`; the system `signal` closure also refuses these).
- Alive (`discovery.isAlive`).
- Kernel start time equals the one read at vetting time (`kinfo_proc.kp_proc.p_un.__p_starttime` through `sysctl`).
- argv still matches `tidegap ui` (`KERN_PROCARGS2`).

Why: `tidegap --version` and the 3 s grace period take time. The kernel can give the pid to another process meanwhile. Start time plus argv tells the two processes apart. Check argv before spawning `--version`, so a foreign pid costs no spawn.

## Rules

- No replacement command means keep the old server. Killing it would leave nothing to run.
- Version = the last non-empty stdout line of `tidegap --version`. A version manager (nvm, fnm) may print a warning first. Do not cache it: a runtime update changes it.
- `ProcessInspector` is a struct of closures (argv, parent, start time, signal). Tests describe processes that do not exist. One test reads the real test process through `sysctl`.
- `tidegap ui` removes its own `ui.json` on SIGTERM, so a dead server leaves no stale record.
- A `start()` that times out retires its own child before it reports the failure (`retireChild()`): SIGTERM, wait `killGrace`, SIGKILL, wait again. The next spawn never meets the old child on 47821. The failure comes up to 2 x `killGrace` (6 s) later. A child that exits before it writes `ui.json` is already gone; its error carries the last line of the server log (after a Node crash, the `Error: ...` line above the stack; `causeLine`).

## Tests

`ServerLauncherTests`: `verdictTable` (reuse, foreign, replace on version or orphan, undated orphan, `isTidegapUI`), `systemInspectorReadsThisProcess` (real test process through `sysctl`), `versionIsTheLastNonEmptyStdoutLine`, `ownChildOnOldVersionIsRespawned`, `terminatesOnlyItsOwnChild`. The timed-out start: `startTimesOutWhenNoDiscoveryAppears`, `timedOutStartKillsAChildThatIgnoresSigterm`, `startAfterATimedOutOneSpawnsOnceTheOldChildIsGone`.

`ConnectionTests`: `foreignProcessOnThePidIsLeftAlone`, `pidReusedBeforeSigtermIsLeftAlone`, `pidReusedBeforeSigkillIsLeftAlone`, `launchdAndTheAppItselfAreNeverSignalled`, `oldServerIsKeptWhenNoCommandCanReplaceIt`.

`retire()` and `stillVetted()` have no direct test. They are covered indirectly: the pid-reuse tests reach `retire()` through `adoptableServer()` and check the start-time and argv guards before SIGTERM and SIGKILL. The `isAlive` guard in `stillVetted()` is not covered.

## Restart keeps the port (PR #139)

- Before a spawn, the old server (vetted `retire()` or the app's own child) must exit: SIGTERM, wait `killGrace`, SIGKILL, wait again.
- Then, only when Settings sets no port, the old server held 47821 and the app signalled it, wait for 47821 to be free (`portIsFree`, a `bind` with `SO_REUSEADDR` as Node uses). Without `--port` the CLI falls back to a random port, which the extension does not find. With `--port` it fails instead, and the next attach retries.
- A successful poll compares ui.json `cli_version` with `tidegap --version` at most once per 5 minutes (attach counts as a check) and re-attaches when they differ. One restart per new version, none within 30 minutes of the last: a flapping `--version` cannot loop. A version counts as restarted only when ui.json names another pid afterwards. The vetting in `attach` runs `--version` again; when that answer is nil, the server is kept and the next check tries again.
- `currentVersion()` has its own 5 s limit (`withTimeout`). It does not await the run, so a runner that ignores cancellation cannot hold the poll. The timed-out run is not stopped either: `SystemProcessRunner.run` reads the pipes on blocked GCD threads until a shim's grandchild closes stdout. So the launcher keeps that one run (`pendingVersion`) and the next call waits on it instead of starting another. A stuck shim holds one process, its pipes and reader threads, not one set per check.
- `apps/macos/scripts/sync-runtime.sh` puts a repo build into the runtime without a version change. This check then sees the same version, so the app keeps the old server until it is quit and reopened.
- Tests: `ConnectionTests` "Restarting on the default port" and "Runtime update mid-session" sections, with `FakeClock` and `FakePorts`; `ServerLauncherTests` `stuckVersionRunIsNotStartedAgain`, `timeoutDoesNotWaitForAnOperationThatIgnoresCancellation` and `loopbackPortProbeSeesAListener` (a real listener on an ephemeral port, never 47821).

## SIGTERM quits like Quit (PR #183, #185)

Since #183 the app turns SIGTERM into `NSApp.terminate` (`TerminationSignals.swift`: `SIG_IGN`, then a dispatch source on the main queue; no code runs in a signal handler). `applicationWillTerminate` then stops the server the app started, so `killall Tidegap` leaves no `tidegap ui` and no `ui.json`.

- **The child still dies on SIGTERM.** A signal set to `SIG_IGN` normally stays ignored across `exec`. The #183 review checked by experiment that a child started with Foundation `Process` does not inherit the app's `SIG_IGN` or its open sockets. Node also resets signal dispositions at startup. So the SIGTERM the app sends its own child (on quit, and in `retireChild()`) still stops `tidegap ui`, and the spawn needs no reset of its own.
- **SIGTERM is no longer a hard stop.** It takes the same path as Quit, and an open modal alert holds both. A script that must have the app gone, because it replaces the bundle, escalates: Quit, a bounded wait, SIGTERM, a bounded wait, SIGKILL. `apps/macos/scripts/install.sh` does this with 5 s waits that poll `pgrep` (#185). Before #185 its fallback was `pkill -x Tidegap` alone, so it could copy the new bundle under a running app.
- **Do not wait for the Quit reply.** `tell application id "com.tidegap.mac" to quit` waits for the app's answer to the Apple event, up to the AppleScript default of 2 minutes, and an open alert holds that answer too. Wrap it in `ignoring application responses` and poll for the process instead.
- Accepted in #185: no wait after SIGKILL, and `pgrep -x Tidegap` also sees other users' copies, which `pkill` cannot signal (each wait is bounded at 5 s).
- Tests: `TerminationSignalsTests` `signalRunsTheClosureOnTheQueueAndTheProcessLives`, `aSignalAfterTheFirstCallRunsTheClosureAgain` and `cancelGivesTheSignalItsDefaultActionBack` (SIGUSR1, a `.serialized` suite). The `install.sh` escalation has no automated test.

## Open follow-ups

- Two app instances that resolve different tidegap commands replace each other's server.
- The orphan case (old code, ppid 1) is not yet exercised on a real Mac.
- The Uninstall block in `apps/macos/README.md` sends a plain Quit, which waits for the reply, and does not check that the app exited before `rm -rf` removes the bundle.
