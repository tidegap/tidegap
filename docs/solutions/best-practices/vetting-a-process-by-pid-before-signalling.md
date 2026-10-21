---
title: Vetting a process named only by a pid before reuse or signal (Mac app)
date: 2026-10-20
category: best-practices
module: apps/macos/TidegapKit/Sources/TidegapKit/ServerVetting.swift, ServerLauncher.swift
problem_type: best_practice
component: tooling
severity: high
applies_when:
  - "A program finds a pid in a file (ui.json) and must decide to attach to it, kill it, or ignore it"
  - "The process may be old code, an orphan, or a pid the kernel gave to another program"
tags: [macos, pid, sysctl, sigterm, ui-json, orphan, pid-reuse]
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

## Tests

`ServerLauncherTests`: `verdictTable` (reuse, foreign, replace on version or orphan, undated orphan, `isTidegapUI`), `systemInspectorReadsThisProcess` (real test process through `sysctl`), `versionIsTheLastNonEmptyStdoutLine`, `ownChildOnOldVersionIsRespawned`, `terminatesOnlyItsOwnChild`.

`ConnectionTests`: `foreignProcessOnThePidIsLeftAlone`, `pidReusedBeforeSigtermIsLeftAlone`, `pidReusedBeforeSigkillIsLeftAlone`, `launchdAndTheAppItselfAreNeverSignalled`, `oldServerIsKeptWhenNoCommandCanReplaceIt`.

`retire()` and `stillVetted()` have no direct test. They are covered indirectly: the pid-reuse tests reach `retire()` through `adoptableServer()` and check the start-time and argv guards before SIGTERM and SIGKILL. The `isAlive` guard in `stillVetted()` is not covered.

## Open follow-ups

- Version-change restart sends SIGTERM, then spawns without waiting. The new server may land on a random port, and the extension loses it until re-attach.
- A runtime update mid-session is picked up only on Reconnect, two failed polls or relaunch.
- The `--version` check is bounded only by the runner's 30 s. A shim child that keeps stdout open can block longer.
- Two app instances that resolve different tidegap commands replace each other's server.
- No test bounds kill/start across polls.
- The orphan case (old code, ppid 1) is not yet exercised on a real Mac.
