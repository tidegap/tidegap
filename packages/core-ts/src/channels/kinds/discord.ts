/** Discord: a stub until its stream lands (`ready: false`). */

import type { KindDescriptor } from "../registry.js";

export const discord: KindDescriptor = {
  kind: "discord",
  label: "Discord",
  description: "Messages in a Discord channel through a webhook.",
  ready: false,
  fields: [],
  steps: [],
  defaultEvents: ["task_done", "task_failed", "not_ready"],
  docsAnchor: "notify-discord",
};
