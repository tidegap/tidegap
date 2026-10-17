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
  - "Editing ~/.claude/settings.json from an installer"
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

- `tidegap install` asks first, in a terminal only, and only a yes writes. It wraps an existing `statusLine`; with none it prints the snippet. The file is the user's: parse it, change one key, write atomically, never rewrite on a parse error.
- `@tidegap/mcp` now depends on `@tidegap/cli` for `@tidegap/cli/usage`, so CI builds the CLI before the MCP server.
