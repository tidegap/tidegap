---
title: OS notifications from a daemon without shell injection (macOS, Linux, Windows)
date: 2026-10-15
category: best-practices
module: packages/core-ts/src/notify.ts, packages/cli/src/commands/tick.ts, packages/openclaw-plugin/src/delivery.ts
problem_type: best_practice
component: tooling
severity: high
applies_when:
  - "A background process shows a desktop notification whose text comes from a model or task output"
tags: [notifications, osascript, notify-send, powershell, injection, child-process]
---

# OS notifications from a daemon without shell injection

Notification text is untrusted (model output, task titles). `osNotifyCommand` in `packages/core-ts/src/notify.ts` returns `{cmd, args, env?}`. The caller spawns it with no shell.

## Per platform

- **macOS:** `osascript -e 'on run argv' -e 'display notification (item 2 of argv) with title (item 1 of argv)' -e 'end run' -- <title> <body>`. The text is argv, never interpolated into AppleScript.
- **Linux:** `notify-send -- <title> <body>`. `--` stops option parsing. Escape markup in the body (`escapeMarkup`), because most daemons parse `<b>` and `<a href>`.
- **Windows:** PowerShell script that reads the text from variables, not from the script string.
  - Default (`tidegap tick`): environment variables in `OsNotifyCommand.env`, merged over the host environment.
  - `windowsText: "base64"` (OpenClaw plugin): base64 literals decoded in the script. The plugin bundle must read zero environment variables (ClawScan flags `env_credential_access`), so it cannot merge env.

## Process rules

- Child timeout 5 s (`NOTIFY_TIMEOUT_MS` in `tick.ts` and `delivery.ts`). A hung notifier must not block a tick or delivery.
- Missing binary is a silent no-op: `child.on("error", () => {})`, `child.unref()`. A failed toast is not a tick error.
- Never use `exec` or a shell string for any of this.

## History

PR #45 review found the first macOS version interpolated text into the script, notify-send lacked `--` and escaping, and the OpenClaw notifier had no timeout. All three were fixed in follow-up commits.
