/**
 * macOS Shortcuts (R12, KTD16): the host runs `shortcuts run <name>` with
 * the message text as the Shortcut Input, on macOS only. The name is the
 * only field; it may not start with "-", so it can never read as an option
 * of the `shortcuts` tool.
 */

import type { DeliverySpec, FieldValues, KindDescriptor } from "../registry.js";
import type { NotificationPayload } from "../payload.js";

export const SHORTCUT_NAME_MAX = 100;

export const shortcuts: KindDescriptor = {
  kind: "shortcuts",
  label: "Shortcuts",
  description: "Runs a macOS Shortcut with the message as its input: send an iMessage, add a reminder, turn on a light.",
  platforms: ["darwin"],
  ready: true,
  fields: [
    {
      name: "name",
      label: "Shortcut name",
      input: "text",
      required: true,
      placeholder: "Tidegap",
      maxLength: SHORTCUT_NAME_MAX,
      pattern: "[^-][\\s\\S]*",
      invalid: "Type the shortcut name exactly as the Shortcuts app shows it. It cannot start with -.",
    },
  ],
  steps: [
    { text: "Open the Shortcuts app and create a new shortcut.", link: "https://support.apple.com/guide/shortcuts-mac/create-a-custom-shortcut-apd84c576f8c/mac" },
    { text: "Add an action that uses Shortcut Input, for example Send Message or Add New Reminder." },
    { text: "Name the shortcut Tidegap." },
    { text: "Type the name here and press Connect. The shortcut runs once with a test message." },
  ],
  defaultEvents: ["task_done", "task_failed", "not_ready"],
  docsAnchor: "notify-shortcuts",
  target: (values) => `Shortcut "${String(values.name ?? "")}"`,
  errors: {
    not_found: { text: "The Shortcuts app has no shortcut with this name. Check the spelling and the capital letters.", field: "name" },
    no_shortcuts: { text: "The shortcuts tool was not found. Shortcuts needs macOS 12 or later." },
    timeout: { text: "The shortcut did not finish in 20 seconds. Remove actions that wait for you, such as Ask for Input.", field: "name" },
    shortcut_failed: { text: "The shortcut stopped with an error. Run it once in the Shortcuts app to see the error.", field: "name" },
  },
  format(payload: NotificationPayload, values: FieldValues): DeliverySpec {
    return { type: "shortcut", name: String(values.name), input: payload.text };
  },
};
