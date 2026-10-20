/**
 * Command: a program on this computer gets each message as the Tidegap JSON
 * (the webhook's `tidegap` body, `version: 1`) on its standard input. The
 * host runs it with an argv array and no shell, a fixed working directory,
 * a minimal environment (no secret, no Tidegap variable) and a time limit.
 * Use it for scripts: a local logger, a home-automation CLI, `osascript`.
 */

import type { DeliverySpec, FieldValues, KindDescriptor } from "../registry.js";
import type { NotificationPayload } from "../payload.js";
import { webhookBody } from "./webhook.js";

/** Most argument lines. */
export const COMMAND_MAX_ARGS = 10;

/** The `args` field as argv items: one per non-empty line, trimmed. */
export function commandArgs(text: string | number | undefined): string[] {
  return typeof text === "string" ? text.split("\n").map((l) => l.trim()).filter(Boolean) : [];
}

export const command: KindDescriptor = {
  kind: "command",
  label: "Command",
  description: "Runs a program on this computer with each message as JSON on its standard input.",
  platforms: ["darwin", "linux"],
  ready: true,
  fields: [
    {
      name: "path",
      label: "Program",
      input: "text",
      required: true,
      maxLength: 1024,
      pattern: "/[\\s\\S]*",
      placeholder: "/Users/you/bin/on-tidegap",
      invalid: "Type the full path of the program, starting with /.",
      help: "The full path of an executable file. Tidegap runs it directly, with no shell.",
    },
    {
      name: "args",
      label: "Arguments",
      input: "textarea",
      advanced: true,
      maxLines: COMMAND_MAX_ARGS,
      maxLength: 2048,
      placeholder: "--quiet",
      help: `Optional. One argument per line, at most ${COMMAND_MAX_ARGS}; no quotes needed. They are not secret: other programs on this computer can see them.`,
    },
  ],
  steps: [
    { text: "Write a program or script that reads JSON from its standard input and make it executable (chmod +x)." },
    { text: 'The JSON is {"version": 1, "event", "level", "title", "text", "at", "task"}; the test message has "event": "test".' },
    { text: "It runs in your home folder with only PATH, HOME, LANG and TMPDIR set, and must finish in 20 seconds." },
    { text: "Type the full path here and press Connect. Exit code 0 means delivered." },
  ],
  defaultEvents: ["task_done", "task_failed", "not_ready"],
  docsAnchor: "notify-command",
  target: (values) => String(values.path ?? "Command"),
  errors: {
    not_found: { text: "There is no program at this path. Check the path.", field: "path" },
    not_executable: { text: "This file is not executable. Run chmod +x on it, or pick another file.", field: "path" },
    timeout: { text: "The program did not finish in 20 seconds. Make it exit sooner, or start slow work in the background.", field: "path" },
    command_failed: { text: "The program exited with an error. Run it by hand with a test message on its input to see why.", field: "path" },
  },
  format(payload: NotificationPayload, values: FieldValues): DeliverySpec {
    return { type: "command", path: String(values.path), args: commandArgs(values.args), input: webhookBody(payload) };
  },
};
