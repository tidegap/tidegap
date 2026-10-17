// Modal dialogs on one native <dialog>: reschedule (date and time), the
// Later menu (presets from the server's later_options), the row action
// menu, confirmations and the shortcut help. showModal() gives focus
// containment and Esc; focus goes back to where it was on close.

import {
  dateInput,
  dayLabel,
  fromInputs,
  h,
  hm,
  parse,
  relDay,
  timeInput,
  title,
  when,
} from "./dom.js";

const HOUR = 3_600_000;
let returnTo = null;
let returnId = null;
let onClose = null;

function dlg() {
  return document.getElementById("dialog");
}

export function dialogOpen() {
  return dlg().open;
}

/** Open the shared dialog with `content` (used by other panels). */
export function openDialog(content, opts) {
  open(content, opts);
}

function open(content, { label, wide = false, close } = {}) {
  const d = dlg();
  if (d.open) d.close();
  // A menu item that opens the next dialog keeps the original focus target.
  if (!returnTo?.isConnected) {
    returnTo = document.activeElement;
    // Inside the drawer the drawer itself is the fallback; on a row, the row.
    returnId = returnTo?.closest?.("#drawer") ? null : returnTo?.closest?.("[data-task-id]")?.dataset.taskId || null;
  }
  onClose?.();
  onClose = close || null;
  d.className = `dialog${wide ? " dialog-wide" : ""}`;
  d.replaceChildren(...content);
  if (label) d.setAttribute("aria-label", label);
  else d.removeAttribute("aria-label");
  d.showModal();
  const first = d.querySelector("[autofocus], .menu-item, input, button");
  first?.focus();
}

export function closeDialog() {
  const d = dlg();
  if (d.open) d.close();
}

export function initDialog() {
  const d = dlg();
  d.addEventListener("close", () => {
    // close fires after the fact; a dialog opened meanwhile owns the box now.
    if (d.open) return;
    const fn = onClose;
    onClose = null;
    d.replaceChildren();
    if (returnTo?.isConnected) returnTo.focus();
    else if (returnId) {
      // The row was rebuilt while the dialog was open (an action, a stream
      // event): focus its replacement, else the view.
      const row = [...document.querySelectorAll("#view .row[data-task-id]")].find((r) => r.dataset.taskId === returnId);
      (row || document.getElementById("view"))?.focus();
    } else {
      const drawer = document.getElementById("drawer");
      if (drawer && !drawer.hidden) drawer.querySelector(".drawer-close, button")?.focus();
    }
    returnTo = null;
    returnId = null;
    fn?.();
  });
  // A click on the backdrop (the dialog box itself, outside its content) closes.
  d.addEventListener("click", (e) => {
    if (e.target === d) d.close();
  });
  // Arrow keys move through menu items.
  d.addEventListener("keydown", (e) => {
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    const items = [...d.querySelectorAll(".menu-item:not([disabled])")];
    if (items.length === 0) return;
    e.preventDefault();
    const i = items.indexOf(document.activeElement);
    const next = e.key === "ArrowDown" ? (i + 1) % items.length : (i - 1 + items.length) % items.length;
    items[next].focus();
  });
}

function head(text, sub) {
  return h("header", { class: "dialog-head" },
    h("h2", { id: "dialog-title", class: "dialog-title" }, text),
    sub ? h("p", { class: "dialog-sub" }, sub) : null);
}

/** Day bounds as ISO instants in the browser's zone; today starts now. */
export function dayBounds(dayStartMs, now = Date.now()) {
  const next = new Date(dayStartMs);
  next.setDate(next.getDate() + 1);
  const start = Math.max(dayStartMs, now);
  const end = next.getTime();
  if (end - start < HOUR) return null;
  return { day_start: new Date(start).toISOString(), day_end: new Date(end).toISOString() };
}

/**
 * Reschedule dialog. `onSubmit(target, summary)` gets the API body:
 * {at}, {day_start, day_end} or {deadline}.
 */
export function rescheduleDialog(task, onSubmit) {
  const now = Date.now();
  const current = parse(task.scheduled_for);
  const base = Number.isFinite(current) && current > now ? current : now + HOUR;
  const date = h("input", { type: "date", class: "input", id: "rs-date", value: dateInput(base), min: dateInput(now), required: true });
  const time = h("input", { type: "time", class: "input", id: "rs-time", value: timeInput(base), step: "300" });
  const modes = [
    ["at", "At this time", "Runs at the exact time. No carbon choice."],
    ["day", "Cleanest hour that day", "tidegap picks the cleanest forecast hour on that day."],
    ["deadline", "Cleanest hour before", "tidegap picks the cleanest hour between now and this time."],
  ];
  const err = h("p", { class: "form-error", role: "alert", hidden: true });
  const radios = modes.map(([value, label, hint], i) =>
    h("label", { class: "radio" },
      h("input", { type: "radio", name: "rs-mode", value, checked: i === 0 ? true : undefined }),
      h("span", { class: "radio-body" }, h("span", { class: "radio-label" }, label), h("span", { class: "radio-hint" }, hint))));
  const timeField = h("label", { class: "field" }, h("span", { class: "field-label" }, "Time"), time);
  const form = h("form", { class: "dialog-form", method: "dialog" },
    head("Reschedule", title(task)),
    h("fieldset", { class: "radios" }, h("legend", { class: "sr-only" }, "How to schedule"), radios),
    h("div", { class: "field-row" },
      h("label", { class: "field" }, h("span", { class: "field-label" }, "Date"), date),
      timeField),
    err,
    h("footer", { class: "dialog-foot" },
      h("button", { type: "button", class: "btn btn-ghost", onclick: closeDialog }, "Cancel"),
      h("button", { type: "submit", class: "btn btn-primary" }, "Reschedule")));
  const mode = () => form.querySelector('input[name="rs-mode"]:checked').value;
  form.addEventListener("change", () => {
    timeField.hidden = mode() === "day";
  });
  form.addEventListener("submit", (e) => {
    e.preventDefault();
    const m = mode();
    const ms = fromInputs(date.value, m === "day" ? "00:00" : time.value);
    const fail = (msg) => {
      err.textContent = msg;
      err.hidden = false;
    };
    if (!Number.isFinite(ms)) return fail("Pick a valid date and time.");
    let target, summary;
    if (m === "day") {
      const b = dayBounds(ms);
      if (!b) return fail("That day is over. Pick a later day.");
      target = b;
      summary = `Moved to ${dayName(ms)}`;
    } else {
      if (ms < Date.now()) return fail("That time has passed.");
      target = m === "at" ? { at: new Date(ms).toISOString() } : { deadline: new Date(ms).toISOString() };
      summary = m === "at" ? "Rescheduled" : `Due by ${when(ms)}`;
    }
    closeDialog();
    onSubmit(target, summary, ms);
  });
  open([form], { label: "Reschedule" });
}

/**
 * What a disabled Later item says. "Needs the reset time" also says how to
 * give it, because the page has no reset field.
 */
export function laterReason(task, option) {
  if (option.preset === "after_limit_reset" && option.reason === "needs the reset time") {
    return `Tell your agent the reset time, or run \`tidegap queue later ${task.task_id} --until after-limit-reset --reset-at HH:MM\``;
  }
  return option.reason || "not available";
}

/**
 * Later menu (coherence U9): the server's `later_options` with their start
 * times, unavailable ones disabled with the reason, then Pick a time.
 */
export function laterDialog(task, { postpone, pick }) {
  const items = (task.later_options || []).map((o) => {
    const at = parse(o.not_before);
    const item = menuItem("⏲", o.label, o.available && Number.isFinite(at) ? when(at) : null, () => postpone(o), !o.available);
    if (!o.available) item.append(h("span", { class: "menu-reason" }, laterReason(task, o)));
    return item;
  });
  items.push(menuItem("…", "Pick a time…", "exact time or deadline", pick));
  open([head("Later", title(task)), h("div", { class: "menu menu-later", role: "menu" }, items)], { label: "Later" });
}

/** Row "⋯" menu: every action for touch and narrow screens. */
export function actionMenu(task, handlers) {
  const a = task.actions || {};
  const items = [menuItem("→", "Open", "details, result, reply", handlers.open)];
  if (a.runNow) items.push(menuItem("▶", "Run now", "n", handlers.runNow));
  if (a.reschedule) {
    items.push(menuItem("⏲", "Later…", "m", handlers.later));
    items.push(menuItem("⏲", "Reschedule…", "r", handlers.reschedule));
  }
  if (a.markRead) items.push(menuItem("●", task.read_at ? "Mark unread" : "Mark read", "u", handlers.toggleRead));
  if (a.cancel) items.push(menuItem("✕", "Cancel", "c", handlers.cancel, false, "danger"));
  if (a.stopSeries) items.push(menuItem("⊘", "Stop series", "C", handlers.stopSeries, false, "danger"));
  open([head(title(task)), h("div", { class: "menu", role: "menu" }, items)], { label: "Task actions" });
}

function menuItem(glyph, label, hint, run, disabled = false, tone = "") {
  return h("button", {
    type: "button",
    class: ["menu-item", tone && `menu-${tone}`],
    role: "menuitem",
    disabled: disabled ? true : undefined,
    onclick: () => {
      closeDialog();
      run();
    },
  },
  h("span", { class: "menu-glyph", "aria-hidden": "true" }, glyph),
  h("span", { class: "menu-label" }, label),
  hint ? h("span", { class: "menu-hint" }, hint) : null);
}

/** Confirmation; resolves true on confirm. */
export function confirmDialog({ heading, body, confirm, danger = false }) {
  return new Promise((resolve) => {
    let ok = false;
    const form = h("form", { class: "dialog-form", method: "dialog" },
      head(heading),
      body ? h("p", { class: "dialog-body" }, body) : null,
      h("footer", { class: "dialog-foot" },
        h("button", { type: "button", class: "btn btn-ghost", onclick: closeDialog }, "Keep"),
        h("button", { type: "submit", class: `btn ${danger ? "btn-danger-solid" : "btn-primary"}`, autofocus: true }, confirm)));
    form.addEventListener("submit", (e) => {
      e.preventDefault();
      ok = true;
      closeDialog();
    });
    open([form], { label: heading, close: () => resolve(ok) });
  });
}

const SHORTCUTS = [
  ["j / ↓", "next row"],
  ["k / ↑", "previous row"],
  ["Enter", "open detail"],
  ["Esc", "close dialog, drawer or drag"],
  ["c", "cancel (with Undo)"],
  ["C", "stop series"],
  ["r", "reschedule"],
  ["m", "later (presets)"],
  ["n", "run now"],
  ["u", "mark read / unread"],
  ["R", "reply (completed task)"],
  ["1 2 3", "Agenda, Timeline, Journal"],
  ["/", "Journal filters"],
  ["?", "this help"],
];

export function helpDialog() {
  open([
    head("Keyboard shortcuts"),
    h("dl", { class: "keys" }, SHORTCUTS.map(([k, v]) => [h("dt", {}, k.split(" ").map((x) => (x === "/" && k !== "/" ? " / " : h("kbd", {}, x)))), h("dd", {}, v)])),
    h("footer", { class: "dialog-foot" }, h("button", { type: "button", class: "btn", onclick: closeDialog, autofocus: true }, "Close")),
  ], { label: "Keyboard shortcuts", wide: true });
}

/** Confirmation text: "Moved to Fri 16 Oct · runs 03:00" or "Rescheduled · runs tomorrow 10:30". */
export function movedText(t, fallback, dayKnown = false) {
  const at = parse(t?.scheduled_for);
  if (!Number.isFinite(at)) return fallback;
  return `${fallback} · runs ${dayKnown ? hm(at) : when(at)}`;
}

/** "Tomorrow · Fri 16 Oct" or "Sat 17 Oct". */
export function dayName(ms) {
  const rel = relDay(ms);
  return rel === dayLabel(ms) ? rel : `${rel} · ${dayLabel(ms)}`;
}
