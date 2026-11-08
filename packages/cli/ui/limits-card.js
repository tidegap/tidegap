// Settings → Run limits (limits plan U12). One card: a table with one row
// for all runners and one per runner, one column per setting. Each cell
// shows the value a run gets and where it came from (task, setting, the
// runner's setting or the default). An editable cell opens in place: a
// duration (90s, 30m, 1.5h, 2d), "No limit" for a time limit, or a count
// for retries; Save stores it, "Use default" removes the line. The server's
// sentence shows next to the cell on a 400. `limitsModel` is the pure
// view-model; `limitsNodes` renders it through `h()`, text nodes only.

import { api, ApiError, errorText, SessionExpired } from "./api.js";
import { cardHead } from "./channel-card.js";
import { durationText, h } from "./dom.js";

export const SETTING_LABEL = {
  command_timeout: "Command time limit",
  llm_timeout: "LLM time limit",
  retries: "Retries",
  retry_delay: "Retry delay",
};

/** The source as a cell names it. */
export function sourceLabel(source) {
  if (source === "default") return "default";
  if (source === "setting") return "all runners";
  if (typeof source === "string" && source.startsWith("setting:")) return "this runner";
  return source || "";
}

/** A value object (`{value_s}` or `{value}`) as text. */
export function valueText(v) {
  if (!v) return "";
  return "value" in v ? String(v.value) : durationText(v.value_s);
}

const UNIT_S = { s: 1, m: 60, min: 60, h: 3_600, d: 86_400 };

/**
 * The typed text of a cell as the API value: seconds for a duration (a
 * number with `s`, `m`, `min`, `h` or `d`; a bare number is seconds, as in
 * the CLI), a whole count for retries. `{error}` when it does not parse; the
 * server checks the range and answers with its own sentence.
 */
export function parseCell(kind, text) {
  const t = String(text).trim().toLowerCase();
  if (kind === "count") return /^[0-9]+$/.test(t) ? { value: Number(t) } : { error: "Retries must be a whole number from 0 to 10." };
  const m = /^([0-9]+(?:\.[0-9]+)?)\s*(s|m|min|h|d)?$/.exec(t);
  if (!m) return { error: "Use a duration such as 90s, 30m, 1.5h or 2d." };
  return { value_s: Math.round(Number(m[1]) * UNIT_S[m[2] || "s"]) };
}

/** A stable id per cell: `all:retries`, `claude-code:llm_timeout`. */
export const cellId = (runner, setting) => `${runner ?? "all"}:${setting}`;

/**
 * The card's view-model. `view` is the GET/POST /api/settings/limits body
 * (null while loading); `ui` is {editing, draft, none, pending, errors, loadError}.
 * Pure: tests call it without a DOM.
 */
export function limitsModel(view, ui = {}) {
  if (!view) return { state: ui.loadError ? "error" : "loading", loadError: ui.loadError || "" };
  const settings = view.settings || [];
  const runners = [];
  for (const s of settings) for (const r of s.runners) if (!runners.includes(r.runner)) runners.push(r.runner);
  const errors = ui.errors || {};
  const cell = (s, runner) => {
    const id = cellId(runner, s.setting);
    const timeLimit = s.kind === "time_limit";
    let text;
    let source = "";
    let stored;
    let editable;
    if (runner === null) {
      // The all-runners row: the stored line, or the default when the setting has one runner.
      stored = s.all;
      editable = true;
      if (stored) {
        text = valueText(stored);
        source = "set here";
      } else {
        text = s.per_runner ? "not set" : valueText(s.runners[0]?.default);
        source = s.per_runner ? "" : "default";
      }
    } else {
      const r = s.runners.find((x) => x.runner === runner);
      if (!r) return { id, applies: false };
      stored = r.stored;
      editable = s.per_runner;
      text = valueText(r.effective);
      source = sourceLabel(r.source);
    }
    const editing = ui.editing === id;
    const none = editing ? !!ui.none : stored?.value_s === "none";
    return {
      id,
      applies: true,
      setting: s.setting,
      runner,
      kind: s.kind,
      label: `${SETTING_LABEL[s.setting] || s.setting}, ${runner ?? "all runners"}`,
      text,
      source,
      editable,
      stored: !!stored,
      timeLimit,
      editing,
      draft: editing ? (ui.draft ?? (stored && !none ? valueText(stored) : "")) : "",
      none: timeLimit && none,
      warning: timeLimit && none ? view.no_time_limit_warning || "" : "",
      error: errors[id] || "",
      pending: ui.pending === id,
    };
  };
  const rows = [
    { key: "all", label: "All runners", cells: settings.map((s) => cell(s, null)) },
    ...runners.map((runner) => ({ key: runner, label: runner, cells: settings.map((s) => cell(s, runner)) })),
  ];
  return {
    state: "ready",
    columns: settings.map((s) => ({ setting: s.setting, label: SETTING_LABEL[s.setting] || s.setting })),
    rows,
    ignored: (view.ignored || []).map((l) => `${l.key}=${l.value} is ignored: ${l.reason}`),
    busy: !!ui.pending,
  };
}

/** The request body for a cell's Save (`value` = the parsed cell or null to clear). */
export function saveBody(cell, value) {
  const key = cell.kind === "count" ? "value" : "value_s";
  return { setting: cell.setting, runner: cell.runner, [key]: value === null ? null : value[key] };
}

/** The sentence the live region announces after a save. */
export function savedText(cell, value) {
  const what = `${SETTING_LABEL[cell.setting] || cell.setting} for ${cell.runner ?? "all runners"}`;
  if (value === null) return `${what} follows the next layer again.`;
  return `${what} set to ${valueText(value)}.`;
}

// ── rendering ───────────────────────────────────────────────────────────

/** The card's nodes. `on` = {retry(), edit(id), draft(text), none(bool), save(cell), clear(cell), cancel()}. */
export function limitsNodes(model, on) {
  const nodes = [cardHead("limits", "Run limits", "info", "")];
  if (model.state === "loading") return [...nodes, h("p", { class: "integration-sub" }, "Loading…")];
  if (model.state === "error") {
    return [...nodes,
      h("p", { class: "integration-error", role: "alert" }, model.loadError),
      h("div", { class: "integration-actions" }, h("button", { type: "button", class: "btn btn-sm", "data-action": "retry", onclick: () => on.retry() }, "Retry"))];
  }
  nodes.push(h("p", { class: "integration-sub" }, "Each cell shows what a run gets now and where it comes from. A task's or job's own value wins over these."));
  const head = h("tr", {}, h("th", { scope: "col" }, "Runner"), model.columns.map((c) => h("th", { scope: "col" }, c.label)));
  const body = model.rows.map((row) => h("tr", { dataset: { runner: row.key } },
    h("th", { scope: "row" }, row.label),
    row.cells.map((c) => h("td", { dataset: { cell: c.id } }, c.applies ? cellNodes(c, on, model.busy) : h("span", { class: "muted", "aria-label": "does not apply" }, "—")))));
  nodes.push(h("div", { class: "limits-scroll", tabindex: "0", role: "region", "aria-label": "Run limits" },
    h("table", { class: "limits-table" }, h("thead", {}, head), h("tbody", {}, body))));
  if (model.ignored.length) nodes.push(h("ul", { class: "limits-ignored", role: "note" }, model.ignored.map((t) => h("li", {}, t))));
  return nodes;
}

function cellNodes(c, on, busy) {
  const shown = [h("span", { class: "limits-value mono" }, c.text), c.source ? h("span", { class: "limits-source" }, ` (${c.source})`) : null];
  if (!c.editing) {
    return [h("span", { class: "limits-cell" }, shown,
      c.editable ? h("button", { type: "button", class: "btn btn-sm btn-ghost", "data-action": "edit", "aria-label": `Edit ${c.label}`, disabled: busy || undefined, onclick: () => on.edit(c.id) }, "Edit") : null),
      c.warning ? h("p", { class: "limits-warning" }, c.warning) : null,
      c.error ? h("p", { class: "integration-error", role: "alert" }, c.error) : null];
  }
  const errId = `limits-err-${c.id.replace(/[^a-z0-9_-]/gi, "-")}`;
  const input = h("input", {
    type: "text", class: "input limits-input", value: c.draft, inputmode: c.kind === "count" ? "numeric" : "text",
    placeholder: c.kind === "count" ? "0 to 10" : "30m", "aria-label": c.label, disabled: c.none || c.pending || undefined,
    ...(c.error ? { "aria-describedby": errId } : {}),
  });
  input.addEventListener("input", () => on.draft(input.value));
  const form = h("form", { class: "limits-edit", novalidate: true },
    input,
    c.timeLimit ? h("label", { class: "limits-none" }, noneBox(c, on), " No limit") : null,
    h("span", { class: "limits-buttons" },
      h("button", { type: "submit", class: "btn btn-sm btn-primary", "data-action": "save", disabled: c.pending || undefined }, c.pending ? "Saving…" : "Save"),
      c.stored ? h("button", { type: "button", class: "btn btn-sm", "data-action": "clear", disabled: c.pending || undefined, onclick: () => on.clear(c) }, "Use default") : null,
      h("button", { type: "button", class: "btn btn-sm btn-ghost", "data-action": "cancel", disabled: c.pending || undefined, onclick: () => on.cancel() }, "Cancel")));
  form.addEventListener("submit", (e) => {
    e.preventDefault();
    on.save(c, input.value);
  });
  return [form,
    c.warning ? h("p", { class: "limits-warning" }, c.warning) : null,
    c.error ? h("p", { class: "integration-error", id: errId, role: "alert" }, c.error) : null];
}

function noneBox(c, on) {
  const box = h("input", { type: "checkbox", checked: c.none, disabled: c.pending || undefined });
  box.addEventListener("change", () => on.none(box.checked));
  return box;
}

// ── the live card ───────────────────────────────────────────────────────

/** Fill `el` (a section) with the card and load it. `status` is the view's one polite live region. */
export function mountLimitsCard(el, { onExpired, status } = {}) {
  /** @type {{el: any, status: any, view: any, ui: Record<string, any>, onExpired: any, on: any}} */
  const c = { el, status, view: null, ui: {}, onExpired, on: null };
  c.on = handlers(c);
  void load(c);
  return c;
}

async function load(c) {
  c.ui = { loadError: "" };
  draw(c);
  try {
    c.view = await api.limits();
  } catch (err) {
    if (err instanceof SessionExpired) return void c.onExpired?.();
    c.ui.loadError = err instanceof ApiError && err.status === 403
      ? "Settings open in the page that tidegap ui prints and in the Mac app."
      : err instanceof ApiError && err.status === 404
        ? "This server has no run-limit settings; update Tidegap."
        : "Could not load the run limits.";
  }
  draw(c);
}

async function send(c, cell, value) {
  if (c.ui.pending) return;
  c.ui = { ...c.ui, pending: cell.id, errors: { ...c.ui.errors, [cell.id]: "" } };
  draw(c);
  try {
    c.view = await api.setLimit(saveBody(cell, value));
    c.ui = {};
    if (c.status) c.status.textContent = savedText(cell, value);
  } catch (err) {
    if (err instanceof SessionExpired) return void c.onExpired?.();
    c.ui = { ...c.ui, pending: null, errors: { ...c.ui.errors, [cell.id]: errorText(err) } };
  }
  draw(c);
  // The first control that can take focus: with No limit ticked the duration input is disabled.
  const at = `[data-cell="${cell.id}"]`;
  c.el.querySelector(`${at} input:not([disabled]), ${at} button:not([disabled])`)?.focus();
}

function handlers(c) {
  return {
    retry: () => void load(c),
    edit: (id) => {
      const cell = findCell(c, id);
      c.ui = { editing: id, none: !!cell?.none, errors: {} };
      draw(c);
      c.el.querySelector(`[data-cell="${id}"] input`)?.focus();
    },
    // No draw on typing: the input keeps its own value and caret.
    draft: (text) => {
      c.ui.draft = text;
    },
    none: (on) => {
      c.ui.none = on;
      draw(c);
    },
    save: (cell, text) => {
      if (cell.none) return void send(c, cell, { value_s: "none" });
      if (String(text).trim() === "") return void send(c, cell, null);
      const parsed = parseCell(cell.kind, text);
      if (parsed.error) {
        c.ui = { ...c.ui, draft: text, errors: { ...c.ui.errors, [cell.id]: parsed.error } };
        return void draw(c);
      }
      void send(c, cell, parsed);
    },
    clear: (cell) => void send(c, cell, null),
    cancel: () => {
      c.ui = {};
      draw(c);
    },
  };
}

function findCell(c, id) {
  const model = limitsModel(c.view, {});
  for (const row of model.rows || []) for (const cell of row.cells) if (cell.id === id) return cell;
  return null;
}

function draw(c) {
  c.el.replaceChildren(...limitsNodes(limitsModel(c.view, c.ui), c.on).flat());
}
