// The popup's view model. Pure: no DOM and no extension API, so it is tested
// directly (test/popup.test.js).

import { clock, limitsLine, readinessLine, windowText } from "../lib/summary.js";

export { limitsLine, readinessLine };

export const EMPTY_TEXT = "No tasks queued. Ask your agent to schedule one.";

export const OTHER_EMPTY_TEXT = "No other tasks queued.";

/**
 * The text under an empty task list. The badge counts the summary's `active`
 * tasks, job runs included, but the list hides job runs: when the count is
 * larger than the listed rows, the queue is not empty, only this list is.
 */
export function emptyText(active, listed) {
  return Number(active) > listed ? OTHER_EMPTY_TEXT : EMPTY_TEXT;
}

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

/** Task rows the popup shows; the request asks for more (api.js) because job runs are filtered out first. */
export const TASK_LIMIT = 20;

/**
 * Rows from a /api/tasks answer, earliest run first; rows without a time
 * last. Job runs are left out (the Jobs section shows them), then the
 * server's first TASK_LIMIT rows are kept.
 */
export function rowsFrom(body, now = Date.now()) {
  const tasks = Array.isArray(body?.tasks) ? body.tasks.filter((t) => !t.job_id).slice(0, TASK_LIMIT) : [];
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

export const JOBS_NOTE = "Create or edit jobs in the Tidegap page or the Mac app.";

/** "paused", or "paused after 3 failures" when the server paused it. */
function pausedLine(j) {
  const n = Number(j.consecutive_failures);
  return String(j.pause_reason ?? "").startsWith("auto") && n > 0 ? `paused after ${n} failures` : "paused";
}

/** "next Fri 02:00 - last ok 03:12"; a running run says its status. */
function jobLine(j, now) {
  if (j.status === "paused") return pausedLine(j);
  const next = j.next_run;
  const nextText = !next
    ? ""
    : next.status === "running" || next.status === "submitted"
      ? next.status
      : `next ${runLabel(next.scheduled_for ?? next.earliest, now)}`.trim();
  const last = j.last_run;
  const lastText = last ? `last ${last.outcome} ${runLabel(last.completed_at ?? last.started_at, now)}`.trim() : "no run yet";
  return [nextText, lastText].filter(Boolean).join(" - ");
}

/**
 * The Jobs section from the summary and a /api/jobs result: { rows,
 * message? }, or null to hide it (a server without jobs counts, a 404 from
 * an older server, or no jobs).
 */
export function jobSection(summary, result, now = Date.now()) {
  if (!summary?.jobs || typeof summary.jobs !== "object") return null;
  if (result.state !== "ok") return result.status === 404 ? null : { rows: [], message: result.message };
  const jobs = Array.isArray(result.body?.jobs) ? result.body.jobs : [];
  if (jobs.length === 0) return null;
  return {
    rows: jobs.map((j) => ({
      id: j.job_id,
      title: String(j.title || j.job_id),
      status: j.status,
      line: jobLine(j, now),
      actions: { runNow: j.actions?.run_now === true, pause: j.actions?.pause === true, resume: j.actions?.resume === true },
    })),
  };
}

/**
 * A job's buttons: Run now (kept, disabled, on an active job that cannot run
 * now), then Pause or Resume as the server allows. Never Edit or Remove: the
 * extension may not author jobs.
 */
export function jobButtons(row) {
  const buttons = [];
  if (row.actions.runNow || row.status === "active") buttons.push({ action: "runJobNow", label: "Run now", disabled: !row.actions.runNow });
  if (row.actions.pause) buttons.push({ action: "pause", label: "Pause", disabled: false });
  if (row.actions.resume) buttons.push({ action: "resume", label: "Resume", disabled: false });
  return buttons;
}

/** The confirm question for the actions that need one. */
export const CONFIRM = Object.freeze({
  cancel: { question: "Cancel this task?", yes: "Yes, cancel", no: "Keep" },
  runNow: { question: "Run this task on the next tick?", yes: "Yes, run now", no: "Not now" },
  runJobNow: { question: "Run this job on the next tick?", yes: "Yes, run now", no: "Not now" },
});

/** The one line shown after an action succeeded; `item` is the server's list item. */
export function doneLine(action, item, now = Date.now()) {
  if (action === "cancel") return "Cancelled.";
  if (action === "runNow" || action === "runJobNow") return "Runs on the next tick.";
  if (action === "pause") return "Paused.";
  if (action === "resume") return "Resumed.";
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
