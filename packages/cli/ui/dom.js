// DOM and formatting helpers. Task strings (titles, prompts, results) are
// untrusted model or user text: they only ever reach the page as text
// nodes or attribute values, never as markup.

const SVG_NS = "http://www.w3.org/2000/svg";

/** Element builder: h("p", {class: "x"}, "text", child). */
export function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  setAttrs(el, attrs);
  append(el, children);
  return el;
}

/** SVG element builder. */
export function s(tag, attrs = {}, ...children) {
  const el = document.createElementNS(SVG_NS, tag);
  setAttrs(el, attrs);
  append(el, children);
  return el;
}

function setAttrs(el, attrs) {
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === null || v === false) continue;
    if (k === "class") el.setAttribute("class", Array.isArray(v) ? v.filter(Boolean).join(" ") : v);
    else if (k.startsWith("on") && typeof v === "function") el.addEventListener(k.slice(2), v);
    else if (k === "dataset") Object.assign(el.dataset, v);
    else if (k === "value" && "value" in el) el.value = v;
    else el.setAttribute(k, v === true ? "" : String(v));
  }
}

function append(el, children) {
  for (const c of children.flat(Infinity)) {
    if (c === undefined || c === null || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
}

/**
 * Replace `el`'s children unless the new ones are identical, so a redraw
 * with no change keeps the live nodes (and any click in flight on them).
 */
export function swapChildren(el, children) {
  const next = children.flat(Infinity).filter((c) => c !== null && c !== undefined && c !== false);
  const nodes = next.map((c) => (c instanceof Node ? c : document.createTextNode(String(c))));
  const same = el.childNodes.length === nodes.length && nodes.every((n, i) => n.isEqualNode(el.childNodes[i]));
  if (!same) el.replaceChildren(...nodes);
  return !same;
}

// ── time ────────────────────────────────────────────────────────────────

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const LOCALE = "en-GB";

export function parse(iso) {
  if (!iso) return NaN;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : NaN;
}

/** Local midnight of the day holding `ms`. */
export function dayStart(ms) {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/** Local midnight of the day after the one holding `ms` (DST-safe). */
export function nextDayStart(ms) {
  const d = new Date(dayStart(ms));
  d.setDate(d.getDate() + 1);
  return d.getTime();
}

/** Local midnight `n` days after today's. */
export function dayOffset(n, from = Date.now()) {
  const d = new Date(dayStart(from));
  d.setDate(d.getDate() + n);
  return d.getTime();
}

/** Whole local days from today to the day holding `ms` (0 = today). */
export function daysFromToday(ms, now = Date.now()) {
  return Math.round((dayStart(ms) - dayStart(now)) / DAY);
}

/** "14:00" */
export function hm(ms) {
  if (!Number.isFinite(ms)) return "";
  return new Date(ms).toLocaleTimeString(LOCALE, { hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
}

/** "Thu 15 Oct" */
export function dayLabel(ms) {
  return new Date(ms).toLocaleDateString(LOCALE, { weekday: "short", day: "numeric", month: "short" });
}

/** "Today", "Tomorrow", "Yesterday" or "Thu 15 Oct". */
export function relDay(ms, now = Date.now()) {
  const n = daysFromToday(ms, now);
  if (n === 0) return "Today";
  if (n === 1) return "Tomorrow";
  if (n === -1) return "Yesterday";
  return dayLabel(ms);
}

/** "Today 14:00", "Fri 18:00" (this week) or "Thu 29 Oct 14:00". */
export function when(ms, now = Date.now()) {
  if (!Number.isFinite(ms)) return "";
  const n = daysFromToday(ms, now);
  if (n === 0) return `today ${hm(ms)}`;
  if (n === 1) return `tomorrow ${hm(ms)}`;
  if (n > 1 && n < 7) {
    return `${new Date(ms).toLocaleDateString(LOCALE, { weekday: "short" })} ${hm(ms)}`;
  }
  return `${dayLabel(ms)} ${hm(ms)}`;
}

/** Deadline text: "by Fri 18:00", or "by end of Fri" for a midnight deadline. */
export function by(ms, now = Date.now()) {
  if (!Number.isFinite(ms)) return "";
  const d = new Date(ms);
  if (d.getHours() === 0 && d.getMinutes() === 0) {
    const day = relDay(ms - 1, now);
    return `by end of ${day === "Today" || day === "Tomorrow" ? day.toLowerCase() : day}`;
  }
  return `by ${when(ms, now)}`;
}

/** "just now", "4 min ago", "3 h ago", "2 days ago". */
export function ago(ms, now = Date.now()) {
  const d = now - ms;
  if (!Number.isFinite(d)) return "";
  const min = Math.round(d / 60000);
  if (min < 1) return "just now";
  if (min < 60) return `${min} min ago`;
  const hr = Math.round(min / 60);
  if (hr < 48) return `${hr} h ago`;
  return `${Math.round(hr / 24)} days ago`;
}

/**
 * `ago` for the dispatcher's last tick, minus the time the machine slept
 * since it. `ticker` is readiness `ticker` (`slept_s`); it applies only when
 * its `last_tick_at` is the tick shown, so a sleep reading of another tick
 * never shifts the age.
 */
export function agoAwake(lastMs, ticker, now = Date.now()) {
  const same = ticker && Number.isFinite(lastMs) && Date.parse(ticker.last_tick_at) === lastMs;
  const slept = same && Number.isFinite(ticker.slept_s) && ticker.slept_s > 0 ? ticker.slept_s * 1000 : 0;
  return ago(Math.min(lastMs + slept, now), now);
}

const pad2 = (n) => String(n).padStart(2, "0");

/** Value for <input type="date"> in local time. */
export function dateInput(ms) {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

/** Value for <input type="time"> in local time. */
export function timeInput(ms) {
  const d = new Date(ms);
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

/** Local date + time inputs to epoch ms (NaN when invalid). */
export function fromInputs(date, time) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date || "");
  const t = /^(\d{2}):(\d{2})$/.exec(time || "00:00");
  if (!m || !t) return NaN;
  return new Date(+m[1], +m[2] - 1, +m[3], +t[1], +t[2]).getTime();
}

// ── carbon bands ────────────────────────────────────────────────────────

/** Same thresholds as packages/core-ts/src/data/bands.json (g/kWh). */
const BAND_LIMITS = [
  [100, "very_clean"],
  [250, "clean"],
  [450, "average"],
  [700, "dirty"],
];

export function bandOf(g) {
  if (typeof g !== "number" || !Number.isFinite(g)) return null;
  for (const [max, band] of BAND_LIMITS) if (g < max) return band;
  return "very_dirty";
}

export const BAND_LABEL = {
  very_clean: "very clean",
  clean: "clean",
  average: "average",
  dirty: "dirty",
  very_dirty: "very dirty",
};

/** Band chip: colour plus the text label, so colour is never the only cue. */
export function bandChip(band, opts = {}) {
  if (!band) return null;
  return h("span", { class: `chip band band-${band}`, title: opts.title }, BAND_LABEL[band] || band);
}

/** "0.41 g" with two significant digits under 10 g. */
export function grams(g) {
  if (typeof g !== "number" || !Number.isFinite(g)) return "";
  if (g === 0) return "0 g";
  if (g < 0.01) return "<0.01 g";
  if (g < 10) return `${g.toFixed(g < 1 ? 2 : 1)} g`;
  return `${Math.round(g)} g`;
}

// ── task facts ──────────────────────────────────────────────────────────

export const PENDING = ["queued", "scheduled", "submitted", "running"];
export const FINISHED = ["completed", "failed", "cancelled"];

export function isFinished(t) {
  return FINISHED.includes(t.status);
}

export function isUnread(t) {
  return (t.status === "completed" || t.status === "failed") && !t.read_at;
}

export function title(t) {
  return t.display_title || t.title || t.task_id;
}

export const REPEAT_LABEL = {
  daily: "repeats daily",
  weekly: "repeats weekly",
  quota_reset: "repeats every reset",
};

/** "anthropic · sonnet-5" or "". */
export function providerModel(t) {
  const model = t.model ? shortModel(t.model) : "";
  return [t.provider, model].filter(Boolean).join(" · ");
}

/** "claude-sonnet-4-5-20250929" -> "sonnet-4-5". */
function shortModel(m) {
  return String(m).replace(/^claude-/, "").replace(/-\d{8}$/, "").replace(/-latest$/, "");
}

/** Short task id for monospace hints: first 8 characters. */
export function shortId(id) {
  return String(id).length > 12 ? `${String(id).slice(0, 8)}…` : String(id);
}

export function taskHref(id) {
  return `#/task/${encodeURIComponent(id)}`;
}

/** True when keyboard focus is in a text field, so single-key shortcuts stay off. */
export function typing(target = document.activeElement) {
  if (!target) return false;
  const tag = target.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || target.isContentEditable;
}

/**
 * One task event (`GET /api/tasks/<id>` `events[]`) as a text line:
 * "<when> <kind> by <actor> - <summary>". `when` formats the ISO time.
 */
export function eventLine(e, when = (iso) => iso) {
  const d = e && typeof e.details === "object" && e.details ? e.details : {};
  const from = d.from || {};
  const to = d.to || {};
  const t = (v) => (typeof v === "string" ? when(v) : "none");
  const parts = [];
  if (e.kind === "expedited") parts.push(`not before was ${t(from.not_before)}`);
  else if (e.kind === "rescheduled" || e.kind === "postponed") {
    if (typeof d.preset === "string") parts.push(d.preset.replace(/_/g, " "));
    parts.push(`${t(from.scheduled_for)} -> ${t(to.scheduled_for)}`);
  } else if (e.kind === "deferred") parts.push(`retry ${t(d.retry_at)}`);
  else if (e.kind === "replied" && typeof d.child_task_id === "string") parts.push(`reply ${shortId(d.child_task_id)}`);
  else if (e.kind === "failed" && typeof d.error === "string") parts.push(d.error);
  else if (typeof d.provider === "string") parts.push(typeof d.model === "string" ? `${d.provider} · ${shortModel(d.model)}` : d.provider);
  if (typeof d.reason === "string" && e.kind !== "deferred") parts.push(d.reason.replace(/_/g, " "));
  const head = `${t(e.at)} ${e.kind} by ${e.actor}`;
  return parts.length ? `${head} - ${parts.join("; ")}` : head;
}
