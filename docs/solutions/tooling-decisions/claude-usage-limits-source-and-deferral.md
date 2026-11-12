---
title: "Claude usage limits: statusline hook first, OAuth endpoint opt-in, and deferral that requeues"
date: 2026-10-17
category: tooling-decisions
module: packages/cli/src/usage, packages/cli/src/providers/claude-code.ts, packages/core-ts/src/scheduler.ts
problem_type: tooling_decision
component: tooling
severity: high
last_updated: 2026-11-09
applies_when:
  - "Reading Claude Code 5-hour or weekly limits from outside Claude Code"
  - "A provider hits a usage limit and the task must run later, not fail"
  - "Editing ~/.claude/settings.json from an installer, a CLI command or the local page"
tags: [usage-limits, statusline, oauth, tos, provider-defer, settings-json, claude-code]
---

# Claude usage limits: source, ToS, deferral

PR #76. Plan: `docs/plans/2026-10-17-1530-feat-usage-limits-plan.md` (decision log D1-D4). Builds on `running-claude-p-from-a-daemon.md`.

## Decision: the statusline hook is the source; the OAuth endpoint is opt-in

- **Source 1: Claude Code's statusline input.** Claude Code passes `rate_limits.five_hour` and `seven_day` (`used_percentage`, `resets_at` in epoch seconds) to the statusline command for Pro/Max logins, after the first API response. A window disappears once its `resets_at` passes. `tidegap usage hook` is that command: it writes the windows to `~/.tidegap/usage.json` (0600, no token) and can wrap an existing command (`tidegap usage hook -- <cmd>`).
- **Source 2: Anthropic's usage endpoint, off by default** (`TIDEGAP_USAGE_OAUTH=1`). The endpoint is undocumented. Calling it means using the Claude Code login token outside Claude Code. That is a terms-of-service risk, so the user turns it on knowingly and the README says why. The client never stores or refreshes the token, caches reads (300 s; 60 min after a 429), and tests prove the token is absent from results and from the cache file.
- **Why the order:** the hook uses data Claude Code already hands to a user-configured command. No token leaves Claude Code, so there is no ToS question and no secret to protect. The cost is that readings exist only while Claude Code runs, so every reading carries its age.
- `TIDEGAP_USAGE=off` turns every read off (status `disabled`).

## Deferral semantics

- A provider throws `ProviderDeferError(retryAt)`. The tick sets the running task back to `scheduled` with `notBefore = retryAt` by compare-and-set on `running` (`../logic-errors/compare-and-set-task-transitions.md`): a cancel during the run wins. The cap is 8 days from `enqueuedAt`; after that the task fails.
- Other due tasks on the same provider defer in the same tick without a dispatch. Spawning them would burn the same limit message once per task.
- `claude-code` picks `retryAt` in this order: the host reset when a window is used up (including the task model's scoped window), the time in the result text (`|<epoch>`, `resets 7pm (Zone)`, or since #245 a weekly reset with a date, `resets Oct 20, 9am (Zone)`: English month names only, the zone's current year or the next when the instant has passed, and no reset for a day that does not exist or a date more than 8 days ahead, the defer cap), the host reset, now + 60 min. Floor: now + 5 min.
- The earliest start sits one minute before the chosen hour so the row does not read as an exact pin. See `../logic-errors/quota-reset-deadlines.md` for the weekly-reset side.

## Writing `~/.claude/settings.json`

Changed in batch 28 (plan `docs/plans/2026-10-30-2136-fix-usage-popover-and-statusline-hook-plan.md`). The first version offered the wrap only in a terminal, and without one printed a snippet that named a bare `tidegap` (not on `PATH` for an app install) and replaced the user's statusLine instead of wrapping it. On the reporting Mac the hook was never registered, and the popover showed only the raw cause text.

- **Consent rule.** A write happens only on an explicit act: the terminal yes in `tidegap install`, the `tidegap usage install-hook` command, or the Connect Claude Code click in the Usage popover. `tidegap install` without a terminal prints the state and the exact `usage install-hook` command for this install, and writes nothing, so an agent running the install never edits Claude Code's settings without the user's yes. The plugin's `/tidegap:usage` and `install.md` tell an agent to ask, then run the command.
- **One module** (`packages/cli/src/commands/statusline-setup.ts`) inspects, plans and writes for all three surfaces. States: `absent`, `other`, `connected`, `legacy` (an older hook: unguarded, or the first guard text), `stale` (a guarded hook whose node or script is gone), `unreadable`. A command with `usage hook` that Tidegap did not write counts as `connected` and is never rewritten.
- **The stored command is guarded**: `sh -c '<guard>' tidegap-usage-hook <node> <script> -- '<user command>'`. The paths and the user's command are positional arguments, never spliced into the program, and the user's command stays the last word. The guard reads stdin once, byte for byte (a background `cat` whose output ends with `x` and its exit code, so trailing newlines stay; the JSON holds no NUL byte), for at most 2 s: a watchdog sends the `cat` TERM, and the watchdog's own output goes to `/dev/null`, or it would hold the command substitution open. A terminal on stdin gives no input, as in `usage hook`. When every launcher path exists and the read reached its end (a cut read is no reading), it pipes those bytes to `<launcher> usage hook` in the background, stdout and stderr to `/dev/null`, its exit code ignored. `$!` of that pipeline is the Tidegap process itself (no subshell around it), so two watchdogs send it TERM at 2 s and KILL at 3 s, and the guard waits for it or them. Each watchdog's `sleep` ends with it (a TERM trap kills the `sleep`), so no timer outlives the guard. POSIX `sh` only (macOS `/bin/sh` is bash 3.2, Linux is `dash`): no `timeout` binary, no `wait -n`; a background command's stdin is `/dev/null` without job control, so the `cat` reads a copy of stdin on fd 3. Then it pipes the same bytes to `sh -c <user command>`, whose output and exit code are the status line's (no user command: exit 0, no output). So a node upgrade, a moved runtime, an uninstall or a runtime that crashes never blanks the status line in every Claude Code session. A runtime that hangs, or a stdin that stays open, delays it by at most 5 s (2 s of read, 3 s of Tidegap); the tests drive both under `/bin/sh`. The parser accepts only the exact shapes the builder writes; a round-trip test covers quotes, `$`, backticks, spaces, a trailing `;` and newlines.
- **The first guard text (#213) is `legacy`.** It `exec`ed `<launcher> usage hook -- sh -c <user command>` when the paths existed, so a runtime that was there but crashed printed nothing, and an exit-code fallback could not tell that crash from the user's own command failing. The parser keeps that text (`GUARD_V1`) and the unbounded second text (`GUARD_V2`), and reads both as `legacy`, so `tidegap install`, `usage install-hook` and Reconnect offer the update, and `--remove` restores the user's command from either text. A hook keeps the first text, and its behaviour, until the user accepts the update. A guard text that changes again must keep every older text parsed the same way.
- **End of input at the install question answers no (#220).** `readline` acts in two ways. At the end of a pipe a pending `rl.question` never settles. In a terminal (Node 26 in #220), Ctrl-D or Ctrl-C closes the interface and rejects the question; before #220 that printed "Could not update the Claude Code settings" on the `[y/N]` line. Now the question races the interface's `close` event: a closed interface answers no, the skip line starts on a line of its own, and the install keeps its own exit code (no `SIGINT` listener, `index.ts` unchanged). A unit test on a pipe sees only the first case. QA S1.33 types Ctrl-D in a real terminal from `script(1)`, fed through `cat |`, because macOS `script` refuses a socket as its stdin and Node's stdio pipes are sockets. The step runs on macOS only.
- **The node path** is the first `node` on `PATH` that resolves to the running binary, so a Homebrew upgrade that moves the versioned binary leaves the stored path valid.
- **The file is the user's.** Parse it, change the `statusLine` key only, re-read before the write and refuse when it changed, back it up (`settings.json.tidegap.bak`, mode kept), write atomically, replace a symlink's target and not the link, and never write through a link planted at the backup or temp path. A parse failure is never rewritten. Reasons are fixed phrases (`is not valid JSON`, `is not a JSON object`, `has a statusLine in another format`, `cannot be read (<errno>)`): a parser message quotes the file, and the file can hold secrets in `env`.
- **`--remove`** restores the wrapped command exactly, or drops the `type` and `command` the hook added (and the key when nothing else is left).
- **The page route** `GET|POST /api/usage/statusline` takes the page token or a `macos` client token, never an extension (as integrations and settings). It is body-less, answers only the state, and keeps the usage/v1 document unchanged, so MCP and `tidegap usage --json` see no contract change.
- **The OAuth read stays opt-in.** The popover names `TIDEGAP_USAGE_OAUTH=1` in `~/.tidegap/config` in one muted line, with no toggle: a toggle would make the use of the Claude Code login outside Claude Code look endorsed.
- `@tidegap/mcp` depends on `@tidegap/cli` for `@tidegap/cli/usage`, so CI builds the CLI before the MCP server.
