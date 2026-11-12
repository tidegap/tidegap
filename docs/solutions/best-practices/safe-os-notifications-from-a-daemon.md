---
title: OS notifications from a daemon without shell injection (macOS, Linux, Windows)
date: 2026-10-15
last_updated: 2026-11-11
category: best-practices
module: packages/core-ts/src/notify.ts, packages/cli/src/commands/tick.ts, packages/openclaw-plugin/src/delivery.ts
problem_type: best_practice
component: tooling
severity: high
applies_when:
  - "A background process shows a desktop notification whose text comes from a model or task output"
  - "A notification must wait for a setting the process has not read yet"
tags: [notifications, osascript, notify-send, powershell, injection, child-process, openclaw, held-queue, bounded-buffer]
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

## Held until the config is read (OpenClaw, #254)

The OpenClaw plugin's startup dispatcher can finish a task before any tool call has passed the plugin config, so `disableOsNotifications` is still unknown. Before #254 such a task posted a desktop notification even when the user had turned them off.

- **Hold, and say so.** The `os` outcome is recorded at once as `held: the plugin has not read its config yet`. The first config (`setOsNotificationsDisabled`, from a tool call or the captured gateway config) posts each held notification, or records `os notifications are off (disableOsNotifications)` (`packages/openclaw-plugin/src/delivery.ts`).
- **Any in-memory hold needs a cap and a drop log.** A gateway that never passes a config would grow the map for the process's lifetime. `MAX_HELD_OS` is 100; past it the oldest task is dropped with a `console.warn` naming it, and its outcome keeps saying held, so the record stays true. The result itself stays in the queue.
- **Hold in a `finally`.** `packages/openclaw-plugin/src/index.ts` calls `holdOsNotification` in the `finally` of the outcome write, so a held notification still waits for the config when writing the delivery record fails.
- **Release is best effort.** Each release catches its own error and logs it, so one failed post does not stop the others.

## History

PR #45 review found the first macOS version interpolated text into the script, notify-send lacked `--` and escaping, and the OpenClaw notifier had no timeout. All three were fixed in follow-up commits.
