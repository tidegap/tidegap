// One card for every notification channel (integrations plan U4, KTD9).
// A kind supplies only data: its descriptor (fields, steps, presets, docs
// anchor) from GET /api/integrations. `cardModel` is the pure view-model;
// `cardNodes` renders it through `h()`, text nodes only. Telegram reuses the
// shell pieces (`cardHead`, `eventControls`) with its pairing panel in the body.

import { copyChip } from "./copy.js";
import { h, parse, when } from "./dom.js";

export const DOCS_BASE = "https://www.tidegap.com/docs#";

/** The event selector's chips, in `EVENT_KINDS` order (R9). */
export const EVENT_LABELS = {
  task_done: "Task finished",
  task_failed: "Task failed",
  clean_window: "Clean window starts",
  not_ready: "Tasks cannot run",
  digest: "Daily summary",
};

export const QUIET_LABEL = "Quiet at night (22:00–09:00)";

/** Pill text per card state (design note). */
export const PILL = {
  not_set_up: "Not set up",
  connecting: "Connecting…",
  pairing: "Waiting for Telegram",
  connected: "Connected",
  disconnected: "Disconnected",
  error: "Error",
};

export const ACTION_LABEL = { connect: "Connect", test: "Send test", disconnect: "Disconnect", edit: "Edit", remove: "Remove" };

/** The label of an action button while its request is in flight. */
export const BUSY_LABEL = { connect: "Connecting…", test: "Sending…", disconnect: "Disconnecting…", remove: "Removing…" };

/** Grid order after the connected cards (design note); unknown kinds go before "This computer". */
export const KIND_ORDER = ["telegram", "email", "slack", "discord", "ntfy", "pushover", "webhook", "shortcuts"];

/** A field the page fills before the first Connect and shows in clear text until then (R6). */
const PREFILL = { ntfy: { topic: () => `tidegap-${randomId(12)}` } };

/** `n` lowercase letters and digits from `crypto.getRandomValues`. */
export function randomId(n) {
  const abc = "abcdefghijklmnopqrstuvwxyz0123456789";
  const bytes = new Uint8Array(n);
  globalThis.crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => abc[b % abc.length]).join("");
}

/** Values the page generates for a kind's empty form, once per card. */
export function prefillValues(kind) {
  const gen = PREFILL[kind];
  return gen ? Object.fromEntries(Object.entries(gen).map(([k, f]) => [k, f()])) : {};
}

/** Placeholder of a stored secret: the server's hint ("…abcd", "<host> …abcd" or "stored"), never the value. */
export function storedHint(hint) {
  return hint === "stored" ? "Stored" : `Stored ${hint}`;
}

/** "Last message today 10:42 ✓" from a `last` delivery record. */
export function lastLine(last, now = Date.now()) {
  if (!last?.at) return "";
  const at = when(parse(last.at), now);
  return last.ok ? `Last message ${at} ✓` : `Last message ${at} failed`;
}

/**
 * The card's view-model. `descriptor` is a kind from GET /api/integrations,
 * `status` its ChannelStatus or null (not set up), `ui` the page's state of
 * the card: {open, editing, busy, pending, values, show, fieldErrors,
 * formError, actionError, advanced, digest}. `busy` is a Connect in flight,
 * `pending` the name of another action in flight. Pure: tests call it
 * without a DOM.
 */
export function cardModel(descriptor, status, ui = {}, now = Date.now()) {
  const kind = descriptor.kind;
  const base = status ? status.state || "connected" : "not_set_up";
  const editing = !!(status && ui.editing);
  const formOpen = editing || (!status && !!ui.open);
  const actions = [];
  if (status && !editing) {
    if (base === "disconnected") actions.push("connect");
    if (base === "connected" || base === "error") actions.push("test", "disconnect");
    actions.push("edit", "remove");
  }
  const stored = status?.secrets || {};
  const fieldErrors = ui.fieldErrors || {};
  const reveal = !status ? Object.keys(PREFILL[kind] || {}) : [];
  const presetId = ui.preset ?? (status ? "" : descriptor.presets?.[0]?.id ?? "");
  const preset = descriptor.presets?.find((p) => p.id === presetId);
  const fields = (descriptor.fields || []).map((f) => {
    const hint = f.secret && stored[f.name] ? stored[f.name] : "";
    const value = ui.values?.[f.name] ?? (f.secret ? "" : preset?.values[f.name] ?? status?.fields?.[f.name] ?? f.default ?? "");
    const clear = reveal.includes(f.name);
    return {
      name: f.name,
      id: `ch-${kind}-${f.name}`,
      label: f.label,
      input: f.input,
      secret: !!f.secret,
      // A stored secret left empty keeps its value (R8), so it is not required.
      required: !!f.required && !hint && !(status && !f.secret && status.fields?.[f.name] !== undefined),
      placeholder: hint ? storedHint(hint) : f.placeholder || "",
      value: String(value),
      masked: !!f.secret && !clear && !ui.show?.[f.name],
      toggle: !!f.secret && !clear,
      copy: clear,
      options: f.options || null,
      help: f.help || "",
      advanced: !!f.advanced,
      error: fieldErrors[f.name] || "",
      min: f.min,
      max: f.max,
    };
  });
  const showEvents = !editing && (base === "connected" || base === "error");
  return {
    kind,
    title: descriptor.label,
    description: descriptor.description || "",
    state: ui.busy ? "connecting" : base,
    pill: PILL[ui.busy ? "connecting" : base],
    busy: !!ui.busy,
    // Every action button is disabled while any request of this card is in flight.
    pending: ui.busy ? "connect" : ui.pending || "",
    setUp: !!status,
    target: status?.target || "",
    warning: status?.warning === "cleartext" && !editing ? "Messages to this address travel unencrypted (plain http)." : "",
    last: lastLine(status?.last, now),
    error: base === "error" && !editing ? status?.error || "The last message did not arrive. Press Send test to check, or Edit to fix the settings." : "",
    formOpen,
    editing,
    steps: formOpen && !editing ? (descriptor.steps || []).slice(0, 4) : [],
    worksWith: formOpen ? descriptor.worksWith || "" : "",
    presets: formOpen && descriptor.presets?.length ? { value: presetId, options: descriptor.presets, note: preset?.note || "" } : null,
    fields: formOpen ? fields : [],
    advancedOpen: fields.some((f) => f.advanced && f.error) || (ui.advanced ?? (!!descriptor.presets?.length && !preset)),
    formError: formOpen ? ui.formError || "" : "",
    actions,
    actionError: ui.actionError || "",
    events: showEvents ? eventChoices(status.events, ui.digest) : null,
    quiet: showEvents ? status.quiet === "night" : null,
    docs: descriptor.docsAnchor ? `${DOCS_BASE}${descriptor.docsAnchor}` : "",
  };
}

/** The event chips: every kind but `digest` until the server offers the daily summary. */
export function eventChoices(selected = [], digest = false) {
  return Object.keys(EVENT_LABELS)
    .filter((k) => k !== "digest" || digest)
    .map((k) => ({ kind: k, label: EVENT_LABELS[k], checked: selected.includes(k) }));
}

/**
 * The first required field left empty, as `{field, message}`, or null.
 * `values` are the form's trimmed strings by field name.
 */
export function missingField(model, values) {
  const f = model.fields.find((x) => x.required && !String(values[x.name] ?? "").trim());
  return f ? { field: f.name, message: `Enter the ${f.label.replace(/^[A-Z](?=[a-z])/, (c) => c.toLowerCase())}.` } : null;
}

/** The form's non-empty values: an empty field keeps its stored value on the server (R7, R8). */
export function formValues(model, read) {
  const out = {};
  for (const f of model.fields) {
    const v = String(read(f.name) ?? "").trim();
    if (v) out[f.name] = v;
  }
  return out;
}

// ── rendering ───────────────────────────────────────────────────────────

/** Title row: heading (focus target after an action) and the state pill. */
export function cardHead(kind, title, state, pill) {
  return h("header", { class: "integration-head" },
    h("h3", { id: `${kind}-title`, class: "integration-title", tabindex: "-1" }, title),
    h("span", { class: "integration-state", dataset: { state } }, pill));
}

/** The "Send me" chips and the quiet switch; each change calls `on.events(list)` or `on.quiet(bool)`. */
export function eventControls(kind, events, quiet, on) {
  const boxes = events.map((e) => h("input", { type: "checkbox", name: "event", value: e.kind, checked: e.checked, id: `${kind}-event-${e.kind}` }));
  const changed = () => on.events(boxes.filter((b) => b.checked).map((b) => b.value));
  for (const b of boxes) b.addEventListener("change", changed);
  const sw = h("input", { type: "checkbox", role: "switch", id: `${kind}-quiet`, checked: quiet });
  sw.addEventListener("change", () => on.quiet(sw.checked));
  return [
    h("fieldset", { class: "event-chips" },
      h("legend", { class: "field-label" }, "Send me"),
      events.map((e, i) => h("label", { class: "event-chip", for: boxes[i].id }, boxes[i], h("span", {}, e.label)))),
    h("label", { class: "check quiet-switch", for: sw.id }, sw, h("span", {}, QUIET_LABEL)),
  ];
}

/** Secondary (or primary Connect) action buttons; all disabled while `pending` (an action name) is in flight. */
export function actionRow(actions, onAction, pending = "") {
  if (!actions.length) return null;
  return h("div", { class: "integration-actions" }, actions.map((a) =>
    h("button", {
      type: "button",
      class: ["btn", a === "connect" ? "btn-primary" : "btn-sm", a === "remove" && "btn-danger"],
      "data-action": a,
      disabled: !!pending,
      onclick: () => onAction(a),
    }, pending === a ? BUSY_LABEL[a] : ACTION_LABEL[a])));
}

/**
 * The card's nodes. `on` = {submit(form), action(name), open(),
 * cancel(), events(list), quiet(bool), show(field), preset(id, form),
 * advanced(open)}.
 */
export function cardNodes(model, on) {
  const k = model.kind;
  const nodes = [cardHead(k, model.title, model.state, model.pill)];
  if (model.target) nodes.push(h("p", { class: "integration-target" }, model.target));
  if (!model.setUp || model.formOpen) nodes.push(h("p", { class: "integration-sub" }, model.description));
  if (model.last) nodes.push(h("p", { class: "integration-sub", dataset: { last: "" } }, model.last));
  if (model.warning) nodes.push(h("p", { class: "integration-sub", dataset: { warning: "" } }, model.warning));
  if (model.error) nodes.push(h("p", { class: "integration-error", id: `${k}-error` }, model.error));
  if (!model.setUp && !model.formOpen) {
    nodes.push(h("button", { type: "button", class: "btn btn-sm", "aria-expanded": "false", "data-action": "open", onclick: () => on.open() }, "Set up"));
  }
  if (model.formOpen) nodes.push(form(model, on));
  if (model.events) nodes.push(...eventControls(k, model.events, model.quiet, on));
  nodes.push(actionRow(model.actions, on.action, model.pending));
  if (model.actionError) nodes.push(h("p", { class: "integration-error", id: `${k}-action-error`, role: "alert" }, model.actionError));
  if (model.docs) nodes.push(h("p", { class: "integration-docs" }, h("a", { href: model.docs, target: "_blank", rel: "noopener noreferrer" }, `${model.title} setup guide`)));
  return nodes;
}

function form(model, on) {
  const k = model.kind;
  const plain = model.fields.filter((f) => !f.advanced);
  const advanced = model.fields.filter((f) => f.advanced);
  const connect = h("button", { type: "submit", class: "btn btn-primary btn-block", "data-action": "connect-channel", disabled: model.busy }, model.busy ? "Connecting…" : "Connect");
  const body = h("fieldset", { class: "channel-fields", disabled: model.busy },
    model.steps.length ? h("ol", { class: "integration-steps", id: `${k}-steps` }, model.steps.map(step)) : null,
    model.worksWith ? h("p", { class: "integration-sub" }, `Works with ${model.worksWith}`) : null,
    model.presets ? presetSelect(model, on) : null,
    plain.map((f) => field(f, on)),
    advanced.length ? disclosure(model, advanced, on) : null);
  const el = h("form", { class: "channel-form", novalidate: true, "aria-busy": model.busy ? "true" : "false", dataset: { kind: k } },
    body,
    model.formError ? h("p", { class: "integration-error", id: `${k}-form-error`, role: "alert" }, model.formError) : null,
    h("div", { class: "integration-actions" }, connect,
      h("button", { type: "button", class: "btn btn-ghost", "data-action": "cancel", onclick: () => on.cancel() }, "Cancel")));
  el.addEventListener("submit", (e) => {
    e.preventDefault();
    on.submit(el);
  });
  el.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      e.preventDefault();
      on.cancel();
    }
  });
  return el;
}

/** Advanced fields under a collapsed "Server and addresses" disclosure; its open state survives a rebuild. */
function disclosure(model, fields, on) {
  const el = h("details", { class: "channel-advanced", open: model.advancedOpen }, h("summary", {}, "Server and addresses"), fields.map((f) => field(f, on)));
  el.addEventListener("toggle", () => on.advanced?.(el.open));
  return el;
}

function step(s) {
  return h("li", {}, s.text, s.link ? [" (", h("a", { href: s.link, target: "_blank", rel: "noopener noreferrer" }, "open"), ")"] : null);
}

function presetSelect(model, on) {
  const id = `ch-${model.kind}-preset`;
  const sel = h("select", { class: "select", id, name: "_preset" },
    model.presets.options.map((p) => h("option", { value: p.id, selected: p.id === model.presets.value }, p.label)),
    h("option", { value: "", selected: !model.presets.value }, "Other"));
  sel.addEventListener("change", () => on.preset(sel.value, sel.form));
  return h("label", { class: "field", for: id }, h("span", { class: "field-label" }, "Provider"), sel,
    model.presets.note ? h("span", { class: "integration-sub" }, model.presets.note) : null);
}

function field(f, on) {
  const errId = `${f.id}-error`;
  const attrs = {
    id: f.id,
    name: f.name,
    required: f.required,
    placeholder: f.placeholder,
    "aria-invalid": f.error ? "true" : "false",
    "aria-describedby": f.error ? errId : null,
    autocomplete: "off",
    spellcheck: "false",
  };
  let input;
  if (f.input === "select") {
    input = h("select", { ...attrs, class: "select" }, (f.options || []).map((o) => h("option", { value: o.value, selected: o.value === f.value }, o.label)));
  } else if (f.input === "textarea") {
    input = h("textarea", { ...attrs, class: ["input", "channel-textarea", f.masked && "masked"], rows: 3 });
    input.value = f.value;
  } else {
    const type = f.masked ? "password" : f.input === "number" ? "number" : f.input === "url" ? "url" : "text";
    input = h("input", { ...attrs, class: ["input", (f.secret || f.input === "url") && "mono"], type, value: f.value, min: f.min, max: f.max });
  }
  const row = h("div", { class: "field-row" }, input,
    f.toggle ? h("button", { type: "button", class: "btn btn-sm", id: `${f.id}-show`, "data-action": "show", "aria-pressed": f.masked ? "false" : "true", "aria-controls": f.id, onclick: () => on.show(f.name) }, f.masked ? "Show" : "Hide") : null,
    f.copy && f.value ? copyChip(f.value, f.label.toLowerCase()) : null);
  return h("label", { class: "field", for: f.id },
    h("span", { class: "field-label" }, f.label),
    row,
    f.help ? h("span", { class: "integration-sub" }, f.help) : null,
    f.error ? h("span", { class: "integration-error", id: errId, role: "alert" }, f.error) : null);
}

/** "This computer": OS toasts, the Mac app and the extension keep their own settings (R14). */
export function osCardNodes(os) {
  return [
    cardHead("os", "This computer", "info", os ? (os.enabled ? "On" : "Off") : ""),
    os ? h("p", { class: "integration-sub" }, os.enabled ? "Desktop notifications are on." : "Desktop notifications are off.") : null,
    h("p", { class: "integration-sub" }, "The Mac app sets its notifications in its own Settings. The browser extension sets them on its options page."),
  ];
}
