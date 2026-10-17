// The popup's view model. Pure: no DOM and no extension API, so it is tested
// directly (test/popup.test.js).

import { clock, readinessLine, windowText } from "../lib/summary.js";

export { readinessLine };

export const EMPTY_TEXT = "No tasks queued. Ask your agent to schedule one.";

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/** "14:00" today, "Sat 14:00" another day, "" without a time. */
export function runLabel(iso, now = Date.now()) {
  const d = new Date(iso ?? NaN);
  if (!Number.isFinite(d.getTime())) return "";
  const today = new Date(now);
  const sameDay = d.getFullYear() === today.getFullYear() && d.getMonth() === today.getMonth() && d.getDate() === today.getDate();
  return sameDay ? clock(iso) : `${DAYS[d.getDay()]} ${clock(iso)}`;
}

/**
 * The Later presets of a list item, or null when the server sends none (a
 * 0.19.0 server: hide the Later menu). `when` is the resolved start in local
 * time; `reason` is shown as text on a disabled preset.
 */
function laterOptions(task, now) {
  if (!Array.isArray(task.later_options)) return null;
  return task.later_options.map((o) => ({
    preset: String(o.preset),
    label: String(o.label ?? o.preset),
    when: o.available ? runLabel(o.not_before, now) : "",
    available: o.available === true,
    reason: o.available ? "" : String(o.reason ?? "not available"),
  }));
}

/** Rows from a /api/tasks answer, earliest run first; rows without a time last. */
export function rowsFrom(body, now = Date.now()) {
  const tasks = Array.isArray(body?.tasks) ? body.tasks : [];
  const at = (t) => {
    const ms = Date.parse(t.scheduled_for ?? "");
    return Number.isFinite(ms) ? ms : Infinity;
  };
  return [...tasks]
    .sort((a, b) => at(a) - at(b))
    .map((t) => {
      const later = laterOptions(t, now);
      return {
        id: t.task_id,
        title: String(t.display_title || t.title || t.task_id),
        status: t.status,
        when: t.status === "running" || t.status === "submitted" ? t.status : runLabel(t.scheduled_for, now),
        actions: {
          later: later !== null && t.actions?.later === true,
          cancel: t.actions?.cancel === true,
          runNow: t.actions?.runNow === true,
        },
        later,
      };
    });
}

/** The three row buttons in order, each enabled per the task's `actions`. */
export function rowButtons(row) {
  const buttons = [
    { action: "cancel", label: "Cancel", disabled: !row.actions.cancel },
    { action: "runNow", label: "Run now", disabled: !row.actions.runNow },
  ];
  // A server without later_options gets no Later button at all.
  if (row.later) buttons.unshift({ action: "later", label: "Later", disabled: !row.actions.later });
  return buttons;
}

/** The confirm question for the actions that need one. */
export const CONFIRM = Object.freeze({
  cancel: { question: "Cancel this task?", yes: "Yes, cancel", no: "Keep" },
  runNow: { question: "Run this task on the next tick?", yes: "Yes, run now", no: "Not now" },
});

/** The one line shown after an action succeeded; `item` is the server's list item. */
export function doneLine(action, item, now = Date.now()) {
  if (action === "cancel") return "Cancelled.";
  if (action === "runNow") return "Runs on the next tick.";
  const when = runLabel(item?.scheduled_for ?? item?.not_before, now);
  return when ? `Moved to ${when}.` : "Moved.";
}

/** The header line: the clean window, or why there is none. */
export function headerLine(summary) {
  if (!summary) return "";
  if (summary.clean_window) return windowText(summary.clean_window, summary.region);
  return summary.forecast_ok === false ? "Forecast unavailable" : "";
}

/**
 * The status block for a failed call: { kind, text, options }. `options`
 * means "show a link to the options page".
 */
export function statusFor(result) {
  if (result.state === "unpaired") return { kind: "unpaired", text: result.message, options: true };
  if (result.state === "offline") return { kind: "offline", text: result.message, options: false };
  return { kind: "error", text: result.message, options: result.status === 403 };
}
