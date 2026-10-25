import { api, pageUrl } from "../lib/api.js";
import { ext } from "../lib/browser.js";
import { fill, h } from "../lib/dom.js";
import { loadSettings } from "../lib/settings.js";
import { CONFIRM, doneLine, headerLine, jobButtons, jobSection, limitsLine, readinessLine, rowButtons, rowsFrom, statusFor } from "./model.js";

const $ = (id) => document.getElementById(id);
let settings = null;
let rows = [];
let jobRows = [];
/**
 * Per-row UI state: "later" | "cancel" | "runNow" | "runJobNow", or none.
 * Task rows are keyed by task id, job rows by `job:<id>`.
 */
const pending = new Map();
/** True while an action request is in flight; every action button is disabled then. */
let busy = false;

const jobKey = (row) => `job:${row.id}`;

function showStatus(result) {
  const st = statusFor(result);
  const box = $("status");
  box.hidden = false;
  box.className = `bad status-${st.kind}`;
  fill(box, h("p", {}, st.text), st.options ? h("button", { type: "button", class: "link", onclick: () => ext.runtime.openOptionsPage() }, "Open options") : null);
  $("queue").hidden = true;
  $("jobs").hidden = true;
  $("readiness").hidden = true;
  $("limits").hidden = true;
}

function clearStatus() {
  $("status").hidden = true;
  $("queue").hidden = false;
}

function message(text, bad = false, id = "action-msg") {
  const el = $(id);
  el.hidden = !text;
  el.textContent = text ?? "";
  el.className = bad ? "bad" : "";
}

function toggle(key, open) {
  if (pending.get(key) === open) pending.delete(key);
  else pending.set(key, open);
  render();
}

const CALLS = {
  later: (row, choice) => api.postpone(settings, row.id, choice),
  cancel: (row) => api.cancel(settings, row.id),
  runNow: (row) => api.runNow(settings, row.id),
  pause: (row) => api.pauseJob(settings, row.id),
  resume: (row) => api.resumeJob(settings, row.id),
  runJobNow: (row) => api.runJobNow(settings, row.id),
};

/** `key` is the row's pending key; `msgId` the status line it reports in. */
async function act(row, action, { choice, key = row.id, msgId = "action-msg" } = {}) {
  if (busy) return;
  busy = true;
  message("Working…", false, msgId);
  render();
  try {
    const result = await CALLS[action](row, choice);
    if (result.state !== "ok") {
      message(result.message, true, msgId);
      // Another client changed the item (409) or removed it (404): replace the stale row.
      if (result.status === 409 || result.status === 404) await refresh({ keepMessage: true });
      return;
    }
    pending.delete(key);
    message(doneLine(action, result.body), false, msgId);
    await refresh({ keepMessage: true });
    ext.runtime.sendMessage({ type: "poll" }).catch(() => {});
  } finally {
    busy = false;
    render();
  }
}

function laterList(row) {
  return h(
    "ul",
    { class: "later-options" },
    row.later.map((o) =>
      h(
        "li",
        {},
        h(
          "button",
          { type: "button", "data-preset": o.preset, disabled: !o.available || busy, onclick: () => act(row, "later", { choice: { preset: o.preset } }) },
          o.label,
          o.when ? h("span", { class: "muted" }, ` ${o.when}`) : null,
        ),
        o.available ? null : h("span", { class: "reason" }, o.reason),
      ),
    ),
  );
}

function confirmBox(row, action, opts = {}) {
  const c = CONFIRM[action];
  const key = opts.key ?? row.id;
  return h(
    "div",
    { class: "confirm", "data-confirm": action },
    h("span", {}, c.question),
    h("button", { type: "button", class: "yes", disabled: busy, onclick: () => act(row, action, opts) }, c.yes),
    h("button", { type: "button", class: "no", onclick: () => toggle(key, action) }, c.no),
  );
}

/** One list item: title, meta line, the action buttons, then any open panel. */
function rowItem(attr, row, meta, buttons, onButton, ...panels) {
  const open = pending.get(attr === "data-job" ? jobKey(row) : row.id);
  return h(
    "li",
    { [attr]: row.id },
    h("span", { class: "row-title", title: row.title }, row.title),
    h("span", { class: "row-meta" }, meta),
    h(
      "div",
      { class: "row-actions" },
      buttons.map((b) =>
        h(
          "button",
          { type: "button", "data-action": b.action, disabled: b.disabled || busy, "aria-expanded": b.action === "later" ? String(open === "later") : undefined, onclick: () => onButton(b.action) },
          b.label,
        ),
      ),
    ),
    ...panels,
  );
}

function renderRows() {
  fill(
    $("rows"),
    rows.map((r) => {
      const open = pending.get(r.id);
      return rowItem(
        "data-task",
        r,
        r.when || r.status,
        rowButtons(r),
        (action) => toggle(r.id, action),
        open === "later" && r.later ? laterList(r) : null,
        open === "cancel" || open === "runNow" ? confirmBox(r, open) : null,
      );
    }),
  );
  $("empty").hidden = rows.length > 0;
}

/** Job rows: Run now asks first (the task's confirm box); Pause and Resume act at once. */
function renderJobs() {
  fill(
    $("job-rows"),
    jobRows.map((r) => {
      const key = jobKey(r);
      const open = pending.get(key);
      return rowItem(
        "data-job",
        r,
        r.line,
        jobButtons(r),
        (action) => (CONFIRM[action] ? toggle(key, action) : act(r, action, { key, msgId: "jobs-msg" })),
        open && CONFIRM[open] ? confirmBox(r, open, { key, msgId: "jobs-msg" }) : null,
      );
    }),
  );
}

function render() {
  renderRows();
  renderJobs();
}

async function refresh({ keepMessage = false } = {}) {
  // A server older than the job routes answers 404 on /api/jobs; jobSection hides the section then.
  const [summary, list, jobs] = await Promise.all([api.summary(settings), api.activeTasks(settings), api.jobs(settings)]);
  const failed = [summary, list].find((r) => r.state !== "ok");
  if (failed) return showStatus(failed);
  clearStatus();
  if (!keepMessage) {
    message("");
    message("", false, "jobs-msg");
  }
  $("window").textContent = headerLine(summary.body);
  const line = readinessLine(summary.body);
  $("readiness").hidden = !line;
  $("readiness").textContent = line ?? "";
  const limits = limitsLine(summary.body);
  $("limits").hidden = !limits;
  $("limits").textContent = limits ?? "";
  rows = rowsFrom(list.body);
  const section = jobSection(summary.body, jobs);
  jobRows = section?.rows ?? [];
  $("jobs").hidden = !section;
  if (section?.message) message(section.message, true, "jobs-msg");
  const keys = new Set([...rows.map((r) => r.id), ...jobRows.map(jobKey)]);
  for (const key of pending.keys()) if (!keys.has(key)) pending.delete(key);
  render();
}

async function init() {
  settings = await loadSettings();
  $("options").addEventListener("click", () => ext.runtime.openOptionsPage());
  $("open").addEventListener("click", () => {
    if (settings.token) ext.tabs.create({ url: pageUrl(settings) });
    else ext.runtime.openOptionsPage();
  });
  $("manage-jobs").addEventListener("click", () => ext.tabs.create({ url: pageUrl({ ...settings, view: "jobs" }) }));
  // Refresh the badge too; the popup does not wait for it.
  ext.runtime.sendMessage({ type: "poll" }).catch(() => {});
  await refresh();
}

init();
