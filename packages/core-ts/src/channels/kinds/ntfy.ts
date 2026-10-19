/** ntfy: a stub until its stream lands (`ready: false`). */

import type { KindDescriptor } from "../registry.js";

export const ntfy: KindDescriptor = {
  kind: "ntfy",
  label: "ntfy",
  description: "Push notifications to your phone through ntfy.",
  ready: false,
  fields: [],
  steps: [],
  defaultEvents: ["task_done", "task_failed", "not_ready"],
  docsAnchor: "notify-ntfy",
};
