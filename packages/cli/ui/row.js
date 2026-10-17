// One task row, shared by Agenda, Journal and the Timeline list.
//
// [dot][time][band][title + badges / second line][provider · model][actions]
//
// Buttons carry data-action; app.js handles them for every view through one
// delegated listener, so rows hold no closures over task data.

import {
  by,
  bandChip,
  dayLabel,
  bandOf,
  h,
  hm,
  isUnread,
  parse,
  providerModel,
  REPEAT_LABEL,
  taskHref,
  title,
  when,
} from "./dom.js";
import { forecastAt } from "./state.js";

/** Band for a task: forecast at its scheduled hour, else the receipt intensity. */
function taskBand(t) {
  const at = parse(t.scheduled_for);
  if (t.status !== "completed" && Number.isFinite(at)) {
    const p = forecastAt(t.region, at);
    if (p) return { band: p.band, g: p.g, from: "forecast" };
  }
  const band = bandOf(t.intensity_g_per_kwh);
  return band ? { band, g: t.intensity_g_per_kwh, from: "receipt" } : null;
}

const REPEAT_SHORT = { daily: "daily", weekly: "weekly", quota_reset: "every reset" };

/** Badges after the title: repeat rule and quota reset. */
export function badges(t) {
  const out = [];
  if (t.repeat && t.repeat !== "none") {
    out.push(h("span", { class: "badge badge-repeat", title: REPEAT_LABEL[t.repeat] }, `↻ ${REPEAT_SHORT[t.repeat] || t.repeat}`));
  }
  if (t.deadline_kind === "quota_reset") {
    out.push(h("span", { class: "badge badge-quota", title: `Runs before the ${t.quota_provider || ""} quota resets` }, `⏱ ${t.quota_provider ? `${t.quota_provider} reset` : "quota reset"}`));
  }
  return out;
}

function iconButton(action, label, glyph, extra = {}) {
  return h("button", { type: "button", class: "row-btn", "data-action": action, "aria-label": label, title: label, tabindex: "-1", ...extra }, glyph);
}

/** Action buttons for a row, from the server's `actions` (KTD2). */
function rowActions(t, ctx) {
  const a = t.actions || {};
  const out = [];
  if (ctx === "attention" && t.status === "failed") {
    if (a.markRead) out.push(h("button", { type: "button", class: "btn btn-sm", "data-action": "read", tabindex: "-1" }, "Dismiss"));
    out.push(h("a", { class: "btn btn-sm", href: taskHref(t.task_id), tabindex: "-1" }, "Open"));
    out.push(iconButton("menu", "More actions", "⋯", { class: "row-btn row-more", "aria-haspopup": "dialog" }));
    return out;
  }
  if (ctx === "attention") {
    if (a.runNow) out.push(h("button", { type: "button", class: "btn btn-sm btn-primary", "data-action": "run-now", tabindex: "-1" }, "Run now"));
    out.push(iconButton("menu", "More actions", "⋯", { class: "row-btn row-more", "aria-haspopup": "dialog" }));
    return out;
  }
  const hover = [];
  if (a.runNow) hover.push(iconButton("run-now", "Run now (n)", "▶"));
  if (a.reschedule) hover.push(iconButton("later", "Later… (m)", "⏲"));
  if (a.cancel) hover.push(iconButton("cancel", "Cancel (c)", "✕", { class: "row-btn row-btn-danger" }));
  if (hover.length) out.push(h("span", { class: "row-hover" }, hover));
  out.push(iconButton("menu", "More actions", "⋯", { class: "row-btn row-more", "aria-haspopup": "dialog" }));
  return out;
}

/**
 * Build one row.
 *   ctx: "agenda" | "attention" | "journal" | "timeline"
 *   time: text for the time column (default: scheduled hour)
 *   meta: second-line parts (strings or nodes)
 */
export function taskRow(t, { ctx = "agenda", time, meta = [], band = taskBand(t), selected = false } = {}) {
  const op = t._op;
  const draggable = ctx !== "journal" && t.actions?.reschedule && !op;
  const unread = isUnread(t);
  const li = h("li", {
    class: [
      "row",
      `row-${t.status}`,
      op && "row-pending",
      selected && "row-selected",
      unread && "row-unread",
    ],
    "data-task-id": t.task_id,
    tabindex: "0",
    draggable: draggable ? "true" : undefined,
    "aria-label": `${title(t)}, ${t.status}`,
  });
  li.append(
    h("span", { class: "row-dot", "aria-hidden": "true" }),
    h("span", { class: "row-time" }, time ?? hm(parse(t.scheduled_for))),
    h("span", { class: "row-band" }, band ? bandChip(band.band, { title: `${Math.round(band.g)} gCO2/kWh (${band.from})` }) : null),
    h("span", { class: "row-main" },
      h("span", { class: "row-line1" },
        h("a", { class: "row-title", href: taskHref(t.task_id), tabindex: "-1", draggable: "false" }, title(t)),
        badges(t)),
      h("span", { class: "row-line2" }, joinMeta(op ? [h("span", { class: "row-op" }, op.label || "Saving…"), ...meta] : meta))),
    h("span", { class: "row-pm" }, providerModel(t)),
    h("span", { class: "row-actions" }, op ? h("span", { class: "spinner", role: "img", "aria-label": op.label || "Saving" }) : rowActions(t, ctx)),
  );
  if (unread) li.querySelector(".row-dot").setAttribute("title", "Unread");
  return li;
}

/** Projected (not yet existing) occurrence of a series. */
export function projectedRow(series, ms, showDay = false) {
  const head = series.head;
  return h("li", { class: "row row-projected", "aria-label": `${title(head)}, projected occurrence` },
    h("span", { class: "row-dot", "aria-hidden": "true" }),
    h("span", { class: "row-time" }, showDay ? shortDay(ms) : `~${hm(ms - 3_600_000)}`),
    h("span", { class: "row-band" }),
    h("span", { class: "row-main" },
      h("span", { class: "row-line1" },
        h("span", { class: "row-title" }, title(head)),
        h("span", { class: "badge badge-repeat" }, `↻ ${REPEAT_SHORT[series.repeat] || series.repeat}`)),
      h("span", { class: "row-line2", title: "Created when the previous run finishes" }, joinMeta(["projected", by(ms)]))),
    h("span", { class: "row-pm" }, providerModel(head)),
    h("span", { class: "row-actions" }),
  );
}

/** "Thu 22" */
export function shortDay(ms) {
  return dayLabel(ms).split(" ").slice(0, 2).join(" ");
}

/** Join second-line parts with a middle dot. */
export function joinMeta(parts) {
  const out = [];
  for (const p of parts.filter((x) => x !== undefined && x !== null && x !== false && x !== "")) {
    if (out.length) out.push(h("span", { class: "sep", "aria-hidden": "true" }, " · "));
    out.push(p);
  }
  return out;
}

/** Status word with its tone, for second lines. */
export function statusTag(t) {
  const label = { submitted: "in provider batch", running: "running" }[t.status] || t.status;
  return h("span", { class: `tag tag-${t.status}` }, label);
}
