/** Shortcuts: a stub until its stream lands (`ready: false`). */

import type { KindDescriptor } from "../registry.js";

export const shortcuts: KindDescriptor = {
  kind: "shortcuts",
  label: "Shortcuts",
  description: "Runs a macOS Shortcut with the message as its input.",
  platforms: ["darwin"],
  ready: false,
  fields: [],
  steps: [],
  defaultEvents: ["task_done", "task_failed", "not_ready"],
  docsAnchor: "notify-shortcuts",
};
