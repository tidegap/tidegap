/** Slack: a stub until its stream lands (`ready: false`). */

import type { KindDescriptor } from "../registry.js";

export const slack: KindDescriptor = {
  kind: "slack",
  label: "Slack",
  description: "Messages in a Slack channel through an Incoming Webhook.",
  ready: false,
  fields: [],
  steps: [],
  defaultEvents: ["task_done", "task_failed", "not_ready"],
  docsAnchor: "notify-slack",
};
