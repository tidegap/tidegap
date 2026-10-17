/**
 * OS notification builder (v0.17), shared by `tidegap tick` and the OpenClaw
 * `os` delivery mode. Pure: it returns the command to run and never spawns,
 * so core stays free of `child_process` and the hosts own the side effect.
 *
 * Title and body are untrusted (prompt and model output). The builder keeps
 * them out of every script text: macOS and Linux get them as argv after
 * `--`, and Windows reads them from environment variables the host sets on
 * the spawn (or from inert base64 literals, see `windowsText`).
 */

import { stripControlChars } from "./history.js";
import { redactPrompt } from "./redact.js";
import type { CarbonReceipt, TaskRecord } from "./types.js";

/** A command a host can spawn to raise a desktop notification. */
export interface OsNotifyCommand {
  cmd: string;
  args: string[];
  /**
   * Extra environment variables for the spawned process (Windows: the title
   * and body). The host merges them over its own environment.
   */
  env?: Record<string, string>;
}

/** Environment variable names the Windows script reads the text from. */
export const WIN_NOTIFY_TITLE_VAR = "TIDEGAP_NOTIFY_TITLE";
export const WIN_NOTIFY_BODY_VAR = "TIDEGAP_NOTIFY_BODY";

/** Fixed AppleScript: the text arrives as `argv`, never as script source. */
const MAC_NOTIFY_SCRIPT = [
  "-e",
  "on run argv",
  "-e",
  "display notification (item 2 of argv) with title (item 1 of argv)",
  "-e",
  "end run",
];

/**
 * notify-send bodies go through a markup parser on most Linux daemons
 * (`<b>`, `<a href>`); escape it so model output stays plain text.
 */
function escapeMarkup(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function winToastScript(titleExpr: string, bodyExpr: string): string {
  return [
    "[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType=WindowsRuntime] | Out-Null;",
    "$t = [Windows.UI.Notifications.ToastNotificationManager]::GetTemplateContent([Windows.UI.Notifications.ToastTemplateType]::ToastText02);",
    "$texts = $t.GetElementsByTagName('text');",
    `$texts.Item(0).AppendChild($t.CreateTextNode(${titleExpr})) | Out-Null;`,
    `$texts.Item(1).AppendChild($t.CreateTextNode(${bodyExpr})) | Out-Null;`,
    "$toast = [Windows.UI.Notifications.ToastNotification]::new($t);",
    "[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('tidegap').Show($toast);",
  ].join(" ");
}

/** A PowerShell expression that decodes `text` from a base64 literal. */
function psBase64(text: string): string {
  // Base64 uses only [A-Za-z0-9+/=], so the single-quoted literal is inert.
  const b64 = Buffer.from(text, "utf8").toString("base64");
  return `[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${b64}'))`;
}

export interface OsNotifyOptions {
  /**
   * How the Windows script receives the text. `env` (default): from
   * environment variables in `OsNotifyCommand.env`, which the host merges
   * over its own environment. `base64`: decoded from base64 literals in the
   * script, for a host that must not read its environment to merge it (the
   * OpenClaw plugin). Neither form lets the text reach the script as code.
   */
  windowsText?: "env" | "base64";
}

/**
 * Build the per-platform notification command. Returns null for a platform
 * without a known notifier; the host then skips the notification.
 */
export function osNotifyCommand(
  platform: NodeJS.Platform,
  title: string,
  body: string,
  opts: OsNotifyOptions = {},
): OsNotifyCommand | null {
  if (platform === "darwin") {
    return { cmd: "osascript", args: [...MAC_NOTIFY_SCRIPT, "--", title, body] };
  }
  if (platform === "linux") {
    return { cmd: "notify-send", args: ["--", title, escapeMarkup(body)] };
  }
  if (platform === "win32") {
    const base = ["-NoProfile", "-NonInteractive", "-Command"];
    if (opts.windowsText === "base64") {
      return { cmd: "powershell", args: [...base, winToastScript(psBase64(title), psBase64(body))] };
    }
    return {
      cmd: "powershell",
      args: [...base, winToastScript(`$env:${WIN_NOTIFY_TITLE_VAR}`, `$env:${WIN_NOTIFY_BODY_VAR}`)],
      env: { [WIN_NOTIFY_TITLE_VAR]: title, [WIN_NOTIFY_BODY_VAR]: body },
    };
  }
  return null;
}

/** Characters of result text shown in a notification body. */
export const NOTIFY_PREVIEW_CHARS = 140;

function oneLine(text: string): string {
  return stripControlChars(redactPrompt(text, undefined))
    .replace(/\s+/g, " ")
    .trim();
}

/** `text` cut to `max` characters (code points) plus an ellipsis. */
export function clip(text: string, max: number): string {
  const chars = Array.from(text);
  return chars.length > max ? `${chars.slice(0, max).join("")}…` : text;
}

function grams(receipt: CarbonReceipt | undefined): string {
  if (receipt && typeof receipt.actualCarbonGCo2 === "number") {
    return `${receipt.actualCarbonGCo2} gCO2e`;
  }
  if (receipt && typeof receipt.estimatedCarbonGCo2 === "number") {
    return `~${receipt.estimatedCarbonGCo2} gCO2e`;
  }
  return "carbon n/a";
}

/**
 * Notification title and body for a finished task: the task title (or id),
 * a redacted one-line preview of the result (completed) or the first line
 * of the error (failed), the grams, and the `tidegap queue show <id>` command.
 */
export function taskNotificationContent(
  record: Pick<TaskRecord<unknown>, "taskId" | "status" | "title" | "error" | "result" | "receipt">,
): { title: string; body: string } {
  const name = clip(oneLine(record.title ?? "") || record.taskId, 80);
  const show = `tidegap queue show ${record.taskId}`;
  if (record.status === "failed") {
    const firstErr = (record.error ?? "").split(/\r?\n/).find((l) => l.trim()) ?? "unknown error";
    return {
      title: `Tidegap: failed: ${name}`,
      body: `${clip(oneLine(firstErr), NOTIFY_PREVIEW_CHARS)}\n${show}`,
    };
  }
  const r = record.result as { text?: unknown } | undefined;
  const text = r && typeof r === "object" && typeof r.text === "string" ? r.text : "";
  const preview = clip(oneLine(text), NOTIFY_PREVIEW_CHARS);
  return {
    title: `Tidegap: done: ${name}`,
    body: `${preview ? `${preview}\n` : ""}${grams(record.receipt)} · ${show}`,
  };
}
