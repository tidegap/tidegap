import { api, pageUrl } from "../lib/api.js";
import { ext } from "../lib/browser.js";
import { fill, h } from "../lib/dom.js";
import { loadSettings } from "../lib/settings.js";
import { CONFIRM, doneLine, headerLine, limitsLine, readinessLine, rowButtons, rowsFrom, statusFor } from "./model.js";

const $ = (id) => document.getElementById(id);
let settings = null;
let rows = [];
/** Per-row UI state: { open: "later" | "cancel" | "runNow" } or none. */
const pending = new Map();
let busy = false;

function showStatus(result) {
  const st = statusFor(result);
  const box = $("status");
  box.hidden = false;
  box.className = `bad status-${st.kind}`;
  fill(box, h("p", {}, st.text), st.options ? h("button", { type: "button", class: "link", onclick: () => ext.runtime.openOptionsPage() }, "Open options") : null);
  $("queue").hidden = true;
  $("readiness").hidden = true;
  $("limits").hidden = true;
}

function clearStatus() {
  $("status").hidden = true;
  $("queue").hidden = false;
}

function message(text, bad = false) {
  const el = $("action-msg");
  el.hidden = !text;
  el.textContent = text ?? "";
  el.className = bad ? "bad" : "";
}

function toggle(id, open) {
  if (pending.get(id) === open) pending.delete(id);
  else pending.set(id, open);
  renderRows();
}

async function act(row, action, choice) {
  if (busy) return;
  busy = true;
  message("Working…");
  try {
    const result =
      action === "later" ? await api.postpone(settings, row.id, choice) : action === "cancel" ? await api.cancel(settings, row.id) : await api.runNow(settings, row.id);
    if (result.state !== "ok") {
      message(result.message, true);
      return;
    }
    pending.delete(row.id);
    message(doneLine(action, result.body));
    await refresh({ keepMessage: true });
    ext.runtime.sendMessage({ type: "poll" }).catch(() => {});
  } finally {
    busy = false;
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
          { type: "button", "data-preset": o.preset, disabled: !o.available, onclick: () => act(row, "later", { preset: o.preset }) },
          o.label,
          o.when ? h("span", { class: "muted" }, ` ${o.when}`) : null,
        ),
        o.available ? null : h("span", { class: "reason" }, o.reason),
      ),
    ),
  );
}

function confirmBox(row, action) {
  const c = CONFIRM[action];
  return h(
    "div",
    { class: "confirm", "data-confirm": action },
    h("span", {}, c.question),
    h("button", { type: "button", class: "yes", onclick: () => act(row, action) }, c.yes),
    h("button", { type: "button", class: "no", onclick: () => toggle(row.id, action) }, c.no),
  );
}

function renderRows() {
  fill(
    $("rows"),
    rows.map((r) => {
      const open = pending.get(r.id);
      return h(
        "li",
        { "data-task": r.id },
        h("span", { class: "row-title", title: r.title }, r.title),
        h("span", { class: "row-meta" }, r.when || r.status),
        h(
          "div",
          { class: "row-actions" },
          rowButtons(r).map((b) =>
            h("button", { type: "button", "data-action": b.action, disabled: b.disabled, "aria-expanded": b.action === "later" ? String(open === "later") : undefined, onclick: () => toggle(r.id, b.action) }, b.label),
          ),
        ),
        open === "later" && r.later ? laterList(r) : null,
        open === "cancel" || open === "runNow" ? confirmBox(r, open) : null,
      );
    }),
  );
  $("empty").hidden = rows.length > 0;
}

async function refresh({ keepMessage = false } = {}) {
  const [summary, list] = await Promise.all([api.summary(settings), api.activeTasks(settings)]);
  const failed = [summary, list].find((r) => r.state !== "ok");
  if (failed) return showStatus(failed);
  clearStatus();
  if (!keepMessage) message("");
  $("window").textContent = headerLine(summary.body);
  const line = readinessLine(summary.body);
  $("readiness").hidden = !line;
  $("readiness").textContent = line ?? "";
  const limits = limitsLine(summary.body);
  $("limits").hidden = !limits;
  $("limits").textContent = limits ?? "";
  rows = rowsFrom(list.body);
  for (const id of pending.keys()) if (!rows.some((r) => r.id === id)) pending.delete(id);
  renderRows();
}

async function init() {
  settings = await loadSettings();
  $("options").addEventListener("click", () => ext.runtime.openOptionsPage());
  $("open").addEventListener("click", () => {
    if (settings.token) ext.tabs.create({ url: pageUrl(settings) });
    else ext.runtime.openOptionsPage();
  });
  // Refresh the badge too; the popup does not wait for it.
  ext.runtime.sendMessage({ type: "poll" }).catch(() => {});
  await refresh();
}

init();
