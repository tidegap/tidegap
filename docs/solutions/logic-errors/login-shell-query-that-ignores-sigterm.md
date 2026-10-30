---
title: A login-shell query that ignores SIGTERM; bound the wait in the caller, cache only a good answer, retry after 60 s
date: 2026-10-30
category: logic-errors
module: apps/macos/TidegapKit/Sources/TidegapKit/ServerLauncher.swift (shellInfo, queryLoginShell), packages/cli/src/claude-code.ts (queryLoginShell)
problem_type: logic_error
component: tooling
severity: medium
symptoms:
  - "After a login launch, the Mac app shows \"tidegap not found\" until it restarts, although the 60 s poll keeps running"
  - "A `zsh -ilc` that gets SIGTERM at the runner's 10 s limit runs on, then exits 0 and prints its PATH"
  - "The first retry fix (ask again after 60 s) never fired for a startup file that hangs"
root_cause: logic_error
resolution_type: code_fix
related_components: [macos-app, cli]
tags: [macos, login-shell, zsh, sigterm, timeout, retry, fake-clock, launch-at-login]
---

# A login-shell query that ignores SIGTERM

## Problem

The Mac app asks an interactive login zsh for `PATH` and `command -v tidegap` (`ServerLauncher.queryLoginShell`, `zsh -ilc`), so a `node` from nvm or fnm is found. Before PR #198, `shellInfo()` cached the first answer for the app's lifetime, also an answer without a `PATH`. At login the machine is busy, and a startup file that touches a privacy-protected folder waits on a permission prompt. One failed query then left the app at "tidegap not found" until a restart.

## Symptoms

- After a restart with launch at login on, the app showed "tidegap not found". The poll ran every 60 s, but `findExecutable` searched only the fixed folders.
- Probe (2026-10-30): a `zsh -ilc` whose `.zshrc` sleeps 3 s got SIGTERM at 1 s. It ran the full 3 s, exited 0 and printed `PATH`. A non-interactive `zsh -lc` died on the same signal.

## What Didn't Work

- **Retry only an answer without a `PATH`.** The first U6 version cached a good answer and asked again 60 s after a failed one. The review (P2) found that it never fired in its target case. `SystemProcessRunner.run` sends SIGTERM at its limit (`process.terminate()`), but it returns only when both pipes reach EOF. An interactive zsh ignores SIGTERM, so `run` returned only when the startup file finished. No failed answer came back to retry, and `connectOnce` held `busy` for that whole time.
- **Kill harder.** Not chosen for the app. The runner reads stdout and stderr until EOF, so a process that a startup file started keeps the read open after the shell dies. `currentVersion()` met the same trap with a shim's grandchild (`pendingVersion`, in `../best-practices/vetting-a-process-by-pid-before-signalling.md`, "Restart keeps the port").

## Solution

`shellInfo()` bounds the wait itself and keeps the one running query (`ServerLauncher.swift`):

```swift
if let shell, shell.tidegap != nil { return shell }  // only an answer with a PATH and a tidegap
if let shellFailedAt, now().timeIntervalSince(shellFailedAt) < Self.loginShellRetryInterval {
    return shell ?? (nil, nil)                       // failed less than 60 s ago
}
let query = pendingShell ?? Task { [loginShell] in await loginShell() }
pendingShell = query
guard let info = await withTimeout(loginShellTimeout, { await query.value }) else {
    shellFailedAt = now()                            // a late answer counts as failed
    return shell ?? (nil, nil)
}
pendingShell = nil
if info.path != nil { shell = info }                 // the last PATH serves meanwhile
if info.path == nil || info.tidegap == nil { shellFailedAt = now() }
return shell ?? info
```

- An answer with a `PATH` but no `tidegap` counts as failed too (batch 27). Before, it was kept for the app's lifetime, so a `tidegap` installed later through a version manager was never found. Its `PATH` still reaches `environment(for:)` and a command override until a retry 60 s later asks again.

- `loginShellTimeout` is 10 s, a real wait inside `withTimeout`. `loginShellRetryInterval` is 60 s, counted from the injected `now`, so tests move a fake clock and do not sleep.
- `withTimeout` neither cancels nor awaits the operation, so a hung zsh cannot hold the caller.
- A timed-out query stays in `pendingShell`. The next try, 60 s later, waits on that same query again. If it ended meanwhile, its answer is used at once.

## Why This Works

The bound now sits in the caller, which owns the time. It does not depend on the child obeying a signal. Reusing the running query keeps a hung startup file to one zsh, with one set of pipes and reader threads. Without it, each retry would start a new zsh that blocks on the same prompt. When the user answers the prompt, the late answer is not lost: the next try picks it up, so `node` is found without a restart.

## Prevention

- Never trust SIGTERM as the timeout for an interactive shell. Bound the wait where the result is consumed, as `withTimeout` does here.
- Cache only a good answer: one with a `PATH` and a `tidegap`. A failed answer gets a time and a retry interval, not a lifetime.
- Keep at most one query in flight. A second caller (for example a timed-out `--version` task during `attach`) waits on the running one.
- Tests (`LoginShellRetryTests.swift`, no sleeps, an injected clock):
  - `aFailedLoginShellQueryIsAskedAgainAfter60s` and `aSuccessfulQueryIsCached`.
  - `aFailedQueryIsNotRepeatedWithin60s`: 59 s gives no query, 60 s queries, and a second failure starts a new 60 s wait.
  - `aHungQueryIsWaitedOnAgainNotStartedTwice`: a continuation-based fake that never answers until the test does, `loginShellTimeout: 0.1`. The query count stays 1 and the late answer resolves the command.
  - `anAnswerWithoutTidegapIsAskedAgainAfter60s` (no second query within 60 s, found at 61 s) and `anAnswerWithoutTidegapKeepsServingItsPath`.
- Put new launcher tests in their own file when another open PR owns `ServerLauncherTests.swift`. `ServerLauncher.init` takes `loginShell`, `now` and `loginShellTimeout`, so a new file needs no change to the old one.

## The poll with no token: fixed in batch 27

- With no stored token, the poll did not start a new connect after "tidegap not found", so the retry waited for **Apply and retry** (#198 review P3). Now `ConnectionState.pollMayConnect` lets the 60 s poll run the connect sequence after "tidegap not found" and "needs update"; only "revoked" waits for **Reconnect**. Tests: `ConnectionTests` `pollConnectsAfterTidegapNotFoundOnceTidegapIsInstalled`, `pollRunsTheConnectSequenceAgainAfterNeedsUpdate`, `pollWaitsForReconnectAfterARevoke`.

## The Node lookup: fixed in #201

- **The trap.** `queryLoginShell` in `packages/cli/src/claude-code.ts` ran `spawnSync("/bin/zsh", ["-ilc", …], { timeout: 5_000 })` with the default `killSignal`, SIGTERM. Probe (2026-10-30, `HOME` and `ZDOTDIR` in a temp folder, a 1 s limit, a startup file that waits 3 s): `spawnSync` returned after 3.0 s with `ETIMEDOUT`. With `killSignal: "SIGKILL"` it returned after 1.0 s, for a wait inside zsh and for a `sleep` child. `spawnSync` blocked the tick's event loop and the `tidegap ui` server for that time. It runs only on macOS and only when a pending task needs `claude` (`running-claude-p-from-a-daemon.md`, "Find the binary safely").
- **The fix.** `queryLoginShell` uses async `spawn` and its own timer. At 5 s the shell gets SIGKILL, stdout is closed, and the query answers at once from the output so far, parsed as before (the last line that starts with the marker). It never rejects: a `spawn` that throws, or a child with no stdout (EMFILE, ENFILE), answers nothing. `findClaudeBinary` and its callers (`readiness.ts`, `tidegap status`, `tidegap install`, the tick, `/api/status`, `/api/summary`) are async; the HTTP shapes did not change.
- **One shell at a time.** With async code, overlapping callers in one process (the UI's status and summary requests) each started a zsh; `spawnSync` had made them wait in turn. The default lookup now goes through `singleFlight` (`usage/host.ts`), so they share one shell. The Node side needs no 60 s retry like the app: a hit is cached for the process, the readiness probe keeps a miss for 30 s, and the tick asks once per run.
- **Tests** (`packages/cli/test/claude-code.test.ts`, block `queryLoginShell`): "kills a shell that ignores SIGTERM at the limit, answers nothing, leaves no process, and never blocks the loop"; "at the limit, answers the path the shell printed before it hung"; "answers by the limit when a child that a startup file started keeps stdout open" (the test kills its own `sleep` child, so none is left); "a spawn that throws, or fails without stdout (EMFILE), answers nothing and raises no error".
- **Not covered.** A startup file's child that holds stdout is not killed with the shell; it ends on its own. Whether SIGKILL ends a zsh that waits on a privacy prompt was not tested.

## Related Issues

- PR #198 (U6 and its review).
- PR #201 (the Node lookup: async `spawn`, SIGKILL at the limit, one shell at a time).
- Batch 27 plan `docs/plans/2026-10-30-1850-fix-receipt-honesty-and-residuals-plan.md` (U10: the poll retry, an answer without `tidegap` is asked again).
- `../best-practices/vetting-a-process-by-pid-before-signalling.md`: the `pendingVersion` pattern, and why a timed-out run is kept, not restarted.
- `../tooling-decisions/running-claude-p-from-a-daemon.md`: a privacy prompt that hangs `open()` under launchd.
- `../best-practices/launch-at-login-in-a-menu-bar-app.md`: the login launch that made this path matter.
