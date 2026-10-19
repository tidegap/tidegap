/** Pushover: a stub until its stream lands (`ready: false`). */

import type { KindDescriptor } from "../registry.js";

export const pushover: KindDescriptor = {
  kind: "pushover",
  label: "Pushover",
  description: "Push notifications to your phone through Pushover.",
  ready: false,
  fields: [],
  steps: [],
  defaultEvents: ["task_done", "task_failed", "not_ready"],
  docsAnchor: "notify-pushover",
};
