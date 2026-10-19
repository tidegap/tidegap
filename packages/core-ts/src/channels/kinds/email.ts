/** Email: a stub until its stream lands (`ready: false`). */

import type { KindDescriptor } from "../registry.js";

export const email: KindDescriptor = {
  kind: "email",
  label: "Email",
  description: "Mail through your own SMTP account.",
  ready: false,
  fields: [],
  steps: [],
  defaultEvents: ["task_failed", "not_ready", "digest"],
  docsAnchor: "notify-email",
};
