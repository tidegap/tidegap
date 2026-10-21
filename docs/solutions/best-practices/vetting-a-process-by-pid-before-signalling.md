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
- Kernel start time equals the one read at vetting time (`kinfo_proc.p_starttime` through `sysctl`).
- argv still matches `tidegap ui` (`KERN_PROCARGS2`).

Why: `tidegap --version` and the 3 s grace period take time. The kernel can give the pid to another process meanwhile. Start time plus argv tells the two processes apart. Check argv before spawning `--version`, so a foreign pid costs no spawn.

## Rules

- No replacement command means keep the old server. Killing it would leave nothing to run.
- Version = the last non-empty stdout line of `tidegap --version`. A version manager (nvm, fnm) may print a warning first. Do not cache it: a runtime update changes it.
- `ProcessInspector` is a struct of closures (argv, parent, start time, signal). Tests describe processes that do not exist. One test reads the real test process through `sysctl`.
- `tidegap ui` removes its own `ui.json` on SIGTERM, so a dead server leaves no stale record.

## Tests

`ServerLauncherTests`: pid reuse before SIGTERM and before SIGKILL, launchd and own pid never signalled, no command keeps the old server, foreign pid, orphan old/fresh/undated, version-parse cases, real-process `sysctl` read. `swift test`: 82 pass.

## Open follow-ups

- Real-world run on the owner's Mac: the new app should retire the old orphaned server by itself (install step after #132). Result not recorded yet.
- A pid of another user has unreadable argv: treated as foreign, left alone. No user-visible message.
- A short window remains between the last `stillVetted()` and `kill()`. It cannot be closed with pids alone.
