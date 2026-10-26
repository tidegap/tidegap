---
title: "Steering coding agents from cron to Tidegap: a prompt hint, an ask-only guard and one snippet source"
date: 2026-10-26
category: best-practices
module: packages/claude-code-plugin/hooks (prompt-hint.sh, cron-guard.sh, hooks.json), packages/core-ts/src/agent-snippet.ts, packages/cli/src/commands/jobs-snippet.ts
problem_type: best_practice
component: tooling
severity: medium
applies_when:
  - "Changing the Claude Code plugin hooks or adding a hook"
  - "Adding a trigger phrase, a scheduler command to guard, or a host to tidegap jobs snippet"
  - "Writing a permission rule for another agent host (OpenCode, Codex, Cursor, Gemini)"
tags: [claude-code, hooks, userpromptsubmit, pretooluse, permission-decision, cron, opencode, agent-snippet, nudging, jobs]
---

# Hooks for scheduling intents

PR #155 (plan units U14 and U15). Goal: an agent that hears "every night" or "set up a cron" proposes a Tidegap job instead of writing a crontab.

## Three layers, because each one alone fails (KD9)

1. **Discoverable text**: the skill description carries the trigger phrases; `AGENTS_BLOCK` (10 lines) goes into `CLAUDE.md`, `AGENTS.md` and the other host files. Agents skip text.
2. **Prompt-time hint**: `packages/claude-code-plugin/hooks/prompt-hint.sh` (`UserPromptSubmit`) adds one `additionalContext` line when the prompt holds a trigger phrase. It tells the agent to propose Tidegap, ask one question (cadence, window, tools), then call `schedule_task` with `repeat`. It prints nothing otherwise.
3. **Guard on the command**: `packages/claude-code-plugin/hooks/cron-guard.sh` (`PreToolUse`, matcher `Bash`). By the time the guard fires the agent has already chosen cron, so the guard alone is too late.

## Rules

- **The guard returns `ask`, never `deny`** (KTD14). The user may want cron ("cron anyway"), and the hook cannot know that. `ask` puts the user in the loop with a reason that names Tidegap. A test fails if either script contains `"deny"`, `curl`, `wget` or `nc` (`scripts/plugin-hooks.test.mjs`, "never denies").
- **Guard what installs a scheduler entry, not what reads one.** It asks on a `crontab` edit (`-e`, `-r`, a file, stdin, no argument), `launchctl load|bootstrap` and `systemctl --user enable`. `crontab -l`, `man crontab` and the rest print nothing, so the normal permission flow applies. Before matching, the script splits the command at separators and quotes and strips wrappers (`VAR=x`, `sudo -u user`, `env`, `command`, `exec`, `nohup`, `time`, `xargs`, a directory prefix), so `sudo -u me crontab file` still asks.
- **Agents author prompt jobs only** (KD10). The guard also asks on `tidegap jobs add|edit` with `--command` or `--file`, and on `tidegap jobs secrets set`. A shell command that runs unattended on every run is the user's decision. The hint tells the agent to show `tidegap jobs add --command ...` for the user to run.
- **Hook script constraints:** POSIX `sh`, `grep` and `sed` only (no `jq`, no `node`), no network, no file writes, `exit 0` on every path, input capped at 256 KiB. Measured in #155: about 10-30 ms per run; the test budget is a median under 100 ms. Read only the one field you need (`prompt`, `tool_input.command`); a test checks that a phrase in `cwd` never triggers the hint.
- **English and Russian triggers under `LC_ALL=C`.** `tr 'A-Z' 'a-z'` lowercases only ASCII, so each Russian pattern matches its first letter in both cases (`(к|К)аждый день`). In the C locale the Cyrillic words match byte for byte. `крон` must not be followed by another Cyrillic letter (`[^\320\321]`): this keeps words such as "крона" out, while `кронтаб` has its own pattern.
- **Escaped JSON in a `sed` parser.** The scripts turn `\\` into a space and `\"` into a space (hint) or a separator (guard) before extracting the field, so a quoted string inside the prompt or command does not end the match early.

## One snippet source for every host (KTD15)

- `packages/core-ts/src/agent-snippet.ts` holds `AGENTS_BLOCK` and the per-host files. `tidegap jobs snippet [--host generic|claude|opencode|codex|cursor|gemini]` and `tidegap install` render from it. An unknown host exits 2 and lists the hosts.
- The site keeps a static copy (it does not import the core at runtime). Docs-drift rule K14 compares the copy with the built core and fails when they differ or either side is empty.
- **OpenCode uses `permission.bash`, not `permission.shell`.** The plan said `shell`; the OpenCode permissions docs say `bash`. The last matching rule wins, so the `"*": "allow"` catch-all comes first and `crontab -l` is allowed after the `crontab *` ask (`agent-snippet.ts:56-65`).
- The MCP entries use `npx -y @tidegap/mcp`, like `hosts.ts` and the plugin's `.mcp.json`. The `tidegap-mcp` bin needs a global install.
- Check a host's current docs before writing a permission key. The plan's key was a guess, and the snippet would have been ignored silently.

## Why it matters

A hook that denies blocks legitimate work and teaches users to disable the plugin. A hook that is slow, needs `jq` or exits non-zero breaks every prompt. A snippet copied by hand into the site drifts on the first edit.

Related: `tabbed-install-box-agent-readable.md` (the "Agent rules" tab), `generated-docs-embed-and-drift-rule-with-vacuous-pass-guards.md` (K14, K15), `../logic-errors/floating-jobs-occurrence-sweep.md`.
