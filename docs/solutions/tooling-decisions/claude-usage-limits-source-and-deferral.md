---
title: Claude usage limits: statusline hook first, OAuth endpoint opt-in, and deferral that requeues
date: 2026-10-17
category: tooling-decisions
module: packages/cli/src/usage, packages/cli/src/providers/claude-code.ts, packages/core-ts/src/scheduler.ts
problem_type: tooling_decision
component: tooling
severity: high
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
- `claude-code` picks `retryAt` in this order: the host reset when a window is used up (including the task model's scoped window), the time in the result text (`|<epoch>` or `resets 7pm (Zone)`), the host reset, now + 60 min. Floor: now + 5 min.
- The earliest start sits one minute before the chosen hour so the row does not read as an exact pin. See `../logic-errors/quota-reset-deadlines.md` for the weekly-reset side.

## Writing `~/.claude/settings.json`

Changed in batch 28 (plan `docs/plans/2026-10-30-2136-fix-usage-popover-and-statusline-hook-plan.md`). The first version offered the wrap only in a terminal, and without one printed a snippet that named a bare `tidegap` (not on `PATH` for an app install) and replaced the user's statusLine instead of wrapping it. On the reporting Mac the hook was never registered, and the popover showed only the raw cause text.

- **Consent rule.** A write happens only on an explicit act: the terminal yes in `tidegap install`, the `tidegap usage install-hook` command, or the Connect Claude Code click in the Usage popover. `tidegap install` without a terminal prints the state and the exact `usage install-hook` command for this install, and writes nothing, so an agent running the install never edits Claude Code's settings without the user's yes. The plugin's `/tidegap:usage` and `install.md` tell an agent to ask, then run the command.
- **One module** (`packages/cli/src/commands/statusline-setup.ts`) inspects, plans and writes for all three surfaces. States: `absent`, `other`, `connected`, `legacy` (the old unguarded hook), `stale` (a guarded hook whose node or script is gone), `unreadable`. A command with `usage hook` that Tidegap did not write counts as `connected` and is never rewritten.
- **The stored command is guarded**: `sh -c '<guard>' tidegap-usage-hook <node> <script> -- '<user command>'`. The paths and the user's command are positional arguments, never spliced into the program, and the user's command stays the last word. When every launcher path exists, the guard runs `<launcher> usage hook -- sh -c <user command>`; otherwise it runs the user's command alone (or prints nothing). So a node upgrade, a moved runtime or an uninstall never blanks the status line in every Claude Code session. The parser accepts only the exact shape the builder writes; a round-trip test covers quotes, `$`, backticks, spaces, a trailing `;` and newlines.
- **The node path** is the first `node` on `PATH` that resolves to the running binary, so a Homebrew upgrade that moves the versioned binary leaves the stored path valid.
- **The file is the user's.** Parse it, change the `statusLine` key only, re-read before the write and refuse when it changed, back it up (`settings.json.tidegap.bak`, mode kept), write atomically, replace a symlink's target and not the link, and never write through a link planted at the backup or temp path. A parse failure is never rewritten. Reasons are fixed phrases (`is not valid JSON`, `is not a JSON object`, `has a statusLine in another format`, `cannot be read (<errno>)`): a parser message quotes the file, and the file can hold secrets in `env`.
- **`--remove`** restores the wrapped command exactly, or drops the `type` and `command` the hook added (and the key when nothing else is left).
- **The page route** `GET|POST /api/usage/statusline` takes the page token or a `macos` client token, never an extension (as integrations and settings). It is body-less, answers only the state, and keeps the usage/v1 document unchanged, so MCP and `tidegap usage --json` see no contract change.
- **The OAuth read stays opt-in.** The popover names `TIDEGAP_USAGE_OAUTH=1` in `~/.tidegap/config` in one muted line, with no toggle: a toggle would make the use of the Claude Code login outside Claude Code look endorsed.
- `@tidegap/mcp` depends on `@tidegap/cli` for `@tidegap/cli/usage`, so CI builds the CLI before the MCP server.
