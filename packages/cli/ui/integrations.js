// Settings → Integrations: a grid of channel cards (integrations plan U4).
// Every kind renders through the shared card in channel-card.js from its
// descriptor; Telegram uses the same shell with its pairing panel in the
// body. The page and the Mac app only: with any other token
// `/api/integrations` answers 403 and the Settings link stays hidden.
// Secrets are typed into masked fields, sent once and cleared on success;
// the server never returns them (only hints). Every string from the server
// renders as a text node.

import { api, ApiError, SessionExpired } from "./api.js";
import { cardHead, cardModel, cardNodes, eventControls, formValues, KIND_ORDER, missingField, osCardNodes, PILL, prefillValues } from "./channel-card.js";
import { copyChip, copyText } from "./copy.js";
import { closeDialog, confirmDialog, openDialog } from "./dialog.js";
import { h, s } from "./dom.js";
import { QrCode } from "./qr.js";
import { errorToast, toast } from "./toast.js";

export const DOCS_URL = "https://www.tidegap.com/docs#telegram-setup";
const BOTFATHER_URL = "https://t.me/BotFather";
const SERVE_COMMAND = "tidegap channels serve";
const POLL_PAIRING_MS = 2_000;
const POLL_IDLE_MS = 30_000;

const ACTION_LABEL = {
  connect: "Connect",
  "connect-again": "Connect again",
  "change-token": "Change token",
  "remove-token": "Remove token",
  cancel: "Cancel",
  test: "Send test message",
  "start-listener": "Start listener",
  disconnect: "Disconnect",
};

const ACTION_ROUTE = { connect: "pair", "connect-again": "pair", cancel: "pair/cancel", "start-listener": "listener/start", test: "test" };

const ACTION_STYLE = { connect: "btn-primary", "connect-again": "btn-primary", disconnect: "btn-danger", "remove-token": "btn-danger" };

const PRIMARY = new Set(["connect", "connect-again"]);

const OFFLINE = "Could not reach Tidegap. Retrying…";

const BUSY_LABEL = { connect: "Connecting…", "connect-again": "Connecting…", test: "Sending…", "start-listener": "Starting…", cancel: "Cancelling…" };

const LISTENER_LINE = {
  running: "Listener running",
  not_running: "Listener not running",
  conflict: "Another program reads this bot",
  unauthorized: "Telegram refused the token",
  manual: "Listener runs by hand on this computer",
};

/** Telegram state → the shared card's pill state. */
const TG_PILL = { not_configured: "not_set_up", token_saved: "disconnected", pairing: "pairing", paired: "connected", error: "error" };

/** The connected-first grid order: card keys (descriptor kinds, then "os" last). Pure. */
export function cardOrder(data) {
  const kinds = ["telegram", ...visibleKinds(data).map((d) => d.kind)];
  const connected = (k) => (k === "telegram" ? data?.telegram?.state === "paired" : channelOf(data, k)?.state === "connected");
  const rank = (k) => (KIND_ORDER.includes(k) ? KIND_ORDER.indexOf(k) : KIND_ORDER.length);
  return [...kinds.sort((a, b) => Number(connected(b)) - Number(connected(a)) || rank(a) - rank(b)), "os"];
}

/** Ready descriptors this page renders with the shared card (Telegram has its own body). */
export function visibleKinds(data) {
  return (data?.kinds || []).filter((d) => d.ready !== false && d.kind !== "telegram");
}

/** The ChannelStatus of `kind` (one channel per kind), or null. */
export function channelOf(data, kind) {
  return (data?.channels || []).find((c) => c.kind === kind) || null;
}

/** "9:59 left" for the time until `expiresAt` (ISO), never below 0:00. */
export function timeLeft(expiresAt, now) {
  const secs = Math.max(0, Math.ceil((Date.parse(expiresAt) - now) / 1000));
  return `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, "0")} left`;
}

/**
 * The card's view-model for one status (R1): what it says and which
 * buttons it offers. Pure: tests call it without a DOM.
 */
export function telegramCard(status, now = Date.now()) {
  const st = status || { state: "not_configured" };
  const tokenLine = st.token_hint ? `Token set, ends in ${st.token_hint}` : "";
  const bot = st.bot_username ? `@${st.bot_username}` : "";
  const card = { state: st.state, line: "", sub: "", error: "", bot: "", steps: false, tokenForm: false, actions: [] };
  switch (st.state) {
    case "pairing":
      card.line = "Waiting for the code";
      card.bot = bot;
      card.pairing = { code: st.pairing.code, command: `/pair ${st.pairing.code}`, link: st.pairing.link, left: timeLeft(st.pairing.expires_at, now) };
      card.actions = ["cancel"];
      break;
    case "paired": {
      const l = st.listener || { state: "not_running" };
      card.line = `Paired with ${st.chat?.label || "your chat"}`;
      card.bot = bot;
      card.sub = LISTENER_LINE[l.state] || "";
      card.listener = l.state;
      if (l.state === "manual") card.manual = SERVE_COMMAND;
      else if (l.message && l.state !== "running") card.error = l.message;
      card.actions = ["test", ...(l.state === "not_running" ? ["start-listener"] : []), "change-token", "disconnect"];
      break;
    }
    case "token_saved":
      card.line = tokenLine;
      card.bot = bot;
      card.profileError = st.profile_error || "";
      card.actions = ["connect", "change-token", "remove-token"];
      break;
    case "error":
      card.line = tokenLine || "Not connected";
      card.bot = bot;
      card.error = st.error || "";
      card.actions = ["connect-again", "change-token", "remove-token"];
      break;
    default:
      card.state = "not_configured";
      card.line = "Not connected";
      card.steps = true;
      card.tokenForm = true;
  }
  return card;
}

/** The QR code of `text` as SVG: black modules on a white plate with a 4-module quiet zone. */
export function qrSvg(text, label) {
  const qr = QrCode.encodeText(text, QrCode.Ecc.MEDIUM);
  const n = qr.size + 8;
  const svg = s("svg", { class: "qr", viewBox: `0 0 ${n} ${n}`, role: "img", "aria-label": label, "shape-rendering": "crispEdges" },
    s("rect", { width: n, height: n, fill: "#ffffff" }));
  for (let y = 0; y < qr.size; y++) {
    for (let x = 0; x < qr.size; x++) {
      if (!qr.getModule(x, y)) continue;
      let w = 1;
      while (x + w < qr.size && qr.getModule(x + w, y)) w++;
      svg.append(s("rect", { x: x + 4, y: y + 4, width: w, height: 1, fill: "#000000" }));
      x += w - 1;
    }
  }
  return svg;
}

// ── the view ────────────────────────────────────────────────────────────

let mounted = null;

/** Show the Settings link when this token may use the integrations routes. */
export async function initSettings() {
  const link = document.getElementById("nav-settings");
  if (!link) return;
  try {
    await api.integrations();
  } catch (err) {
    if (err instanceof ApiError && (err.status === 403 || err.status === 404)) return;
  }
  link.hidden = false;
}

export function settingsMounted() {
  return mounted !== null && mounted.root.isConnected;
}

/** Mount the Settings view in `view` and start polling; `onExpired` runs on a 401. */
export function mountSettings(view, { onExpired } = {}) {
  unmountSettings();
  const grid = h("div", { class: "integration-grid" }, h("p", { class: "integration-sub" }, "Loading…"));
  const status = h("p", { class: "sr-only", role: "status" });
  const alert = h("p", { class: "integration-alert", role: "alert" });
  const root = h("div", { class: "view-inner view-settings" },
    h("h1", { class: "settings-title" }, "Settings"),
    h("h2", { class: "settings-section" }, "Integrations"),
    status, alert, grid);
  view.replaceChildren(root);
  // `slots`: card key → {el, key}; `order`: the grid order, fixed until the next mount.
  const m = { root, grid, status, alert, data: null, slots: new Map(), order: null, ui: {}, editing: false, fieldError: "", timer: null, gen: 0, tick: null, offline: false, onExpired };
  mounted = m;
  void poll(m);
  m.tick = setInterval(() => countdown(m), 1000);
  return root;
}

export function unmountSettings() {
  if (!mounted) return;
  clearTimeout(mounted.timer);
  clearInterval(mounted.tick);
  mounted = null;
}

async function poll(m) {
  if (mounted !== m) return;
  // An action or a newer poll bumps `gen`: this poll's answer is stale then, and its chain ends.
  const gen = m.gen;
  if (!document.hidden) {
    try {
      const out = await api.integrations();
      if (gen !== m.gen) return;
      apply(m, out);
      if (m.offline && m.alert.textContent === OFFLINE) m.alert.textContent = "";
      m.offline = false;
    } catch (err) {
      if (gen !== m.gen) return;
      if (err instanceof SessionExpired) return void m.onExpired?.();
      if (err instanceof ApiError && err.status === 403) {
        m.grid.replaceChildren(h("p", { class: "integration-sub" }, "Settings open in the page that tidegap ui prints and in the Mac app."));
        return;
      }
      m.offline = true;
      if (m.data) m.alert.textContent = OFFLINE;
    }
  }
  if (mounted !== m || gen !== m.gen) return;
  m.timer = setTimeout(() => void poll(m), m.data?.telegram?.state === "pairing" ? POLL_PAIRING_MS : POLL_IDLE_MS);
}

/** Drop any poll in flight and its schedule (an action's answer is newer). */
function stopPolls(m) {
  m.gen++;
  clearTimeout(m.timer);
}

/** Poll again now (after an action), then on the usual schedule. */
function repoll(m) {
  stopPolls(m);
  void poll(m);
}

function countdown(m) {
  const el = m.slots.get("telegram")?.el.querySelector(".pairing-left");
  if (el && m.data?.telegram?.pairing) el.textContent = timeLeft(m.data.telegram.pairing.expires_at, Date.now());
}

/** Lay out the grid on the first answer, add new kinds before "This computer", then draw every card. */
function apply(m, data) {
  if (mounted !== m) return;
  m.data = data;
  const keys = cardOrder(data);
  if (!m.order) {
    m.order = [];
    m.grid.replaceChildren();
  }
  for (const key of keys) {
    if (m.order.includes(key)) continue;
    const el = h("section", { class: "integration-card", "aria-labelledby": `${key}-title`, dataset: { kind: key } });
    const os = m.slots.get("os")?.el;
    if (os) m.grid.insertBefore(el, os);
    else m.grid.append(el);
    m.slots.set(key, { el, key: "" });
    m.order.push(key);
  }
  for (const key of [...m.order]) {
    if (keys.includes(key)) draw(m, key);
    else {
      m.slots.get(key)?.el.remove();
      m.slots.delete(key);
      m.order.splice(m.order.indexOf(key), 1);
    }
  }
}

/** A Telegram answer (`{telegram}` routes) into the page data. */
function applyTelegram(m, telegram, force = false) {
  if (mounted !== m) return;
  if (force) m.slots.get("telegram").key = "";
  apply(m, { ...m.data, telegram });
}

/** Rebuild the Telegram card even when its state did not change (the token form opened or closed). */
function redraw(m, telegram = m.data?.telegram) {
  applyTelegram(m, telegram, true);
}

/**
 * Rebuild one card when its view-model changed. Typed values and focus
 * survive the rebuild; `clear` drops typed values (after a success, so the
 * page holds no secret), `force` rebuilds an unchanged model.
 */
function draw(m, key, { clear = false, force = false } = {}) {
  const slot = m.slots.get(key);
  if (!slot || !m.data) return;
  let vmKey;
  let build;
  if (key === "telegram") {
    const vm = telegramCard(m.data.telegram, Date.now());
    const ch = channelOf(m.data, "telegram");
    vmKey = JSON.stringify({ ...vm, pairing: vm.pairing && { ...vm.pairing, left: "" }, editing: m.editing, fieldError: m.fieldError, ch, ui: m.ui.telegram });
    build = () => telegramNodes(m, vm);
    const prev = slot.key ? JSON.parse(slot.key).state : null;
    if (vmKey !== slot.key && prev && prev !== vm.state) m.status.textContent = vm.line;
  } else if (key === "os") {
    vmKey = JSON.stringify(m.data.os ?? null);
    build = () => osCardNodes(m.data.os);
  } else {
    const desc = visibleKinds(m.data).find((d) => d.kind === key);
    const model = cardModel(desc, channelOf(m.data, key), { ...uiOf(m, key), digest: !!m.data.digest }, Date.now());
    vmKey = JSON.stringify(model);
    build = () => cardNodes(model, handlers(m, key));
  }
  if (!force && vmKey === slot.key) return;
  slot.key = vmKey;
  rebuild(slot.el, build(), clear);
}

function rebuild(el, nodes, clear) {
  const active = el.contains(document.activeElement) ? document.activeElement : null;
  const focus = active?.id ? `#${CSS.escape(active.id)}` : active?.dataset?.action ? `[data-action="${active.dataset.action}"]` : null;
  const typed = clear ? [] : [...el.querySelectorAll("input:not([type=checkbox]), textarea, select")].filter((i) => i.id && i.value).map((i) => [i.id, i.value]);
  el.replaceChildren(...nodes.filter(Boolean));
  for (const [id, value] of typed) {
    const n = el.querySelector(`#${CSS.escape(id)}`);
    if (n) n.value = value;
  }
  if (focus) el.querySelector(focus)?.focus();
}

function uiOf(m, key) {
  return (m.ui[key] ??= {});
}

function focusIn(m, key, selector) {
  m.slots.get(key)?.el.querySelector(selector)?.focus();
}

const focusHeading = (m, key) => focusIn(m, key, `#${key}-title`);

function focusInvalid(m, key) {
  const el = m.slots.get(key)?.el;
  (el?.querySelector('[aria-invalid="true"]') || el?.querySelector('[data-action="connect-channel"]'))?.focus();
}

/** Replace (or add) a channel in the page data. */
function putChannel(m, channel) {
  if (!channel) return;
  m.data = { ...m.data, channels: [...(m.data.channels || []).filter((c) => c.id !== channel.id), channel] };
}

function errorText(err) {
  return err instanceof ApiError && err.message ? err.message : "Could not reach Tidegap. Try again.";
}

// ── the shared card's handlers ──────────────────────────────────────────

const CHANNEL_BUSY = { test: "Sending…", disconnect: "Disconnecting…", remove: "Removing…" };

function handlers(m, kind) {
  const ui = uiOf(m, kind);
  return {
    open: () => {
      ui.open = true;
      ui.values ??= prefillValues(kind);
      draw(m, kind);
      focusIn(m, kind, "form input, form select, form textarea");
    },
    cancel: () => {
      Object.assign(ui, { open: false, editing: false, fieldErrors: {}, formError: "", values: undefined, show: {} });
      draw(m, kind, { clear: true });
      focusHeading(m, kind);
    },
    submit: (form) => void connectForm(m, kind, form),
    action: (action, button) => void channelAction(m, kind, action, button),
    events: (events) => void saveSettings(m, kind, { events }),
    quiet: (on) => void saveSettings(m, kind, { quiet: on ? "night" : "off" }),
    show: (name) => {
      ui.show = { ...ui.show, [name]: !ui.show?.[name] };
      draw(m, kind);
    },
    advanced: (open) => {
      ui.advanced = open;
    },
    preset: (id, form) => {
      Object.assign(ui, { preset: id, advanced: undefined });
      const preset = visibleKinds(m.data).find((d) => d.kind === kind)?.presets?.find((p) => p.id === id);
      for (const [name, value] of Object.entries(preset?.values || {})) {
        const el = form?.elements.namedItem(name);
        if (el) el.value = String(value);
      }
      draw(m, kind);
    },
  };
}

/** Enter or Connect in the form: check required fields here, then one call that tests, saves and enables (R1). */
function connectForm(m, kind, form) {
  const ui = uiOf(m, kind);
  if (ui.busy) return;
  const model = cardModel(visibleKinds(m.data).find((d) => d.kind === kind), channelOf(m.data, kind), ui);
  const read = (name) => form.elements.namedItem(name)?.value;
  const missing = missingField(model, Object.fromEntries(model.fields.map((f) => [f.name, read(f.name)])));
  if (missing) {
    Object.assign(ui, { fieldErrors: { [missing.field]: missing.message }, formError: "" });
    draw(m, kind);
    return void focusInvalid(m, kind);
  }
  return connect(m, kind, formValues(model, read));
}

async function connect(m, kind, fields) {
  const ui = uiOf(m, kind);
  if (ui.busy) return;
  const desc = visibleKinds(m.data).find((d) => d.kind === kind);
  Object.assign(ui, { busy: true, fieldErrors: {}, formError: "", actionError: "" });
  stopPolls(m);
  draw(m, kind);
  try {
    const out = await api.connectChannel({ kind, fields });
    Object.assign(ui, { busy: false, open: false, editing: false, values: undefined, show: {} });
    putChannel(m, out.channel);
    draw(m, kind, { clear: true });
    m.status.textContent = out.channel?.target ? `Connected to ${out.channel.target}` : `${desc.label} connected`;
    focusHeading(m, kind);
  } catch (err) {
    ui.busy = false;
    if (err instanceof SessionExpired) return void m.onExpired?.();
    const formShown = ui.open || ui.editing;
    if (formShown && err.field && desc.fields.some((f) => f.name === err.field)) ui.fieldErrors = { [err.field]: errorText(err) };
    else if (formShown) ui.formError = errorText(err);
    else ui.actionError = errorText(err);
    draw(m, kind);
    if (formShown) focusInvalid(m, kind);
  } finally {
    repoll(m);
  }
}

async function channelAction(m, kind, action, button) {
  const ui = uiOf(m, kind);
  const channel = channelOf(m.data, kind);
  const desc = visibleKinds(m.data).find((d) => d.kind === kind);
  if (action === "connect") return connect(m, kind, {});
  if (action === "edit") {
    Object.assign(ui, { editing: true, fieldErrors: {}, formError: "", actionError: "" });
    draw(m, kind);
    return void focusIn(m, kind, "form input, form select, form textarea");
  }
  if (!channel || button.disabled) return;
  if (action === "remove") {
    const ok = await confirmDialog({
      heading: `Remove ${desc.label}?`,
      body: "Tidegap deletes this channel's settings and secrets and stops sending to it.",
      confirm: "Remove",
      danger: true,
    });
    if (!ok) return;
  }
  const label = button.textContent;
  button.disabled = true;
  if (CHANNEL_BUSY[action]) button.textContent = CHANNEL_BUSY[action];
  ui.actionError = "";
  stopPolls(m);
  try {
    const out = await api.channel(channel.id, action);
    if (action === "test") {
      putChannel(m, out?.channel);
      draw(m, kind);
      toast("Test message sent.");
      m.status.textContent = "Test message sent.";
    } else if (action === "remove") {
      m.data = { ...m.data, channels: (m.data.channels || []).filter((c) => c.id !== channel.id) };
      Object.assign(ui, { open: false, editing: false });
      draw(m, kind, { clear: true });
      m.status.textContent = `${desc.label} removed.`;
      focusHeading(m, kind);
    } else {
      putChannel(m, out?.channel);
      draw(m, kind);
      m.status.textContent = `${desc.label} disconnected. The settings are kept.`;
      focusHeading(m, kind);
    }
  } catch (err) {
    if (err instanceof SessionExpired) return void m.onExpired?.();
    ui.actionError = errorText(err);
    draw(m, kind, { force: true });
  } finally {
    if (button.isConnected) {
      button.disabled = false;
      button.textContent = label;
    }
    repoll(m);
  }
}

/** Event chips and the quiet switch save on change (R9, R10); a failure redraws the stored values. */
async function saveSettings(m, key, patch) {
  const channel = channelOf(m.data, key);
  if (!channel) return;
  const ui = uiOf(m, key);
  stopPolls(m);
  try {
    putChannel(m, (await api.channel(channel.id, "settings", patch)).channel);
    ui.actionError = "";
    m.status.textContent = "Saved";
  } catch (err) {
    if (err instanceof SessionExpired) return void m.onExpired?.();
    ui.actionError = errorText(err);
  }
  draw(m, key, { force: true });
  repoll(m);
}

// ── Telegram on the shared shell ────────────────────────────────────────

/** The Telegram card's nodes for a view-model; `m` holds the view's state (editing, regions, data). */
export function telegramNodes(m, vm) {
  const pill = vm.error && vm.state === "paired" ? "error" : TG_PILL[vm.state] || "not_set_up";
  const nodes = [cardHead("telegram", "Telegram", pill, vm.state === "token_saved" ? "Not connected" : PILL[pill])];
  if (vm.state !== "not_configured") nodes.push(h("p", { class: "integration-target" }, vm.line));
  if (vm.sub) nodes.push(h("p", { class: "integration-sub" }, vm.sub));
  nodes.push(h("p", { class: "integration-sub" }, "Get a message when a task finishes, and run /queue, /cancel or /later from the chat."));
  if (vm.bot) nodes.push(h("p", { class: "copy-row" }, h("span", { class: "copy-name" }, "Bot"), copyChip(vm.bot, "bot username")));
  if (vm.profileError) nodes.push(h("p", { class: "integration-sub", id: "telegram-profile-error" }, vm.profileError));
  if (vm.error) nodes.push(h("p", { class: "integration-error", id: "telegram-error" }, vm.error));
  if (vm.steps || m.editing) nodes.push(steps());
  if (vm.tokenForm || m.editing) nodes.push(tokenForm(m, vm));
  if (vm.pairing) nodes.push(pairingPanel(vm.pairing));
  if (vm.manual) nodes.push(manualLine(vm.manual));
  const ch = vm.state === "paired" ? channelOf(m.data, "telegram") : null;
  if (ch) {
    nodes.push(...eventControls("telegram", eventChoicesFor(m, ch), ch.quiet === "night", {
      events: (events) => void saveSettings(m, "telegram", { events }),
      quiet: (on) => void saveSettings(m, "telegram", { quiet: on ? "night" : "off" }),
    }));
  }
  const buttons = vm.actions.filter((a) => !(m.editing && a === "change-token"));
  if (buttons.length) {
    nodes.push(h("div", { class: "integration-actions" }, buttons.map((a) =>
      h("button", {
        type: "button",
        class: ["btn", ACTION_STYLE[a], !PRIMARY.has(a) && "btn-sm"],
        "data-action": a,
        onclick: (e) => void run(m, a, e.currentTarget),
      }, ACTION_LABEL[a]))));
  }
  const actionError = m.ui?.telegram?.actionError;
  if (actionError) nodes.push(h("p", { class: "integration-error", role: "alert" }, actionError));
  if (vm.bot) {
    nodes.push(h("p", { class: "integration-sub avatar-hint" },
      h("a", { href: "/tidegap-avatar.png", download: "tidegap-avatar.png" }, "Download avatar"),
      " (512×512 PNG). In ", copyChip("@BotFather", "BotFather username"), ": ", h("code", {}, "/setuserpic"), " → choose this file."));
  }
  nodes.push(h("p", { class: "integration-docs" }, h("a", { href: DOCS_URL, target: "_blank", rel: "noopener noreferrer" }, "Telegram setup guide")));
  return nodes;
}

function eventChoicesFor(m, ch) {
  return cardModel({ kind: "telegram", label: "Telegram", fields: [] }, { ...ch, state: "connected" }, { digest: !!m.data?.digest }).events;
}

function steps() {
  return h("ol", { class: "integration-steps", id: "telegram-steps" },
    h("li", {}, "Open ", copyChip("@BotFather", "BotFather username"), " in Telegram (", h("a", { href: BOTFATHER_URL, target: "_blank", rel: "noopener noreferrer" }, "open"), ")."),
    h("li", {}, "Send ", h("code", {}, "/newbot"), " and pick a name. Use a new bot for Tidegap only."),
    h("li", {}, "Copy the token it sends and paste it here."));
}

function tokenForm(m, vm) {
  const describedBy = ["telegram-steps", m.fieldError ? "telegram-field-error" : null].filter(Boolean).join(" ");
  const input = h("input", {
    class: "input token-field",
    id: "telegram-token",
    name: "token",
    type: "password",
    autocomplete: "off",
    spellcheck: "false",
    required: true,
    "aria-describedby": describedBy,
    "aria-invalid": m.fieldError ? "true" : "false",
    placeholder: "123456789:AA…",
  });
  const save = h("button", { type: "submit", class: "btn btn-primary", "data-action": "connect-token" }, "Connect");
  const form = h("form", { class: "token-form" },
    h("label", { class: "field", for: "telegram-token" }, h("span", { class: "field-label" }, "Bot token"),
      h("div", { class: "field-row" }, input, save,
        m.editing ? h("button", { type: "button", class: "btn btn-ghost", onclick: () => { m.editing = false; m.fieldError = ""; redraw(m); } }, "Cancel") : null),
      m.fieldError ? h("span", { class: "integration-error", id: "telegram-field-error", role: "alert" }, m.fieldError) : null));
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    if (save.disabled) return;
    save.disabled = true;
    save.textContent = "Connecting…";
    stopPolls(m);
    const token = input.value;
    // The token leaves the page's memory as soon as the request is sent.
    input.value = "";
    try {
      // One step: save the token (tests it, sets the bot profile), then pair.
      let out = await api.saveTelegramToken(token);
      m.fieldError = "";
      m.editing = false;
      m.alert.textContent = "";
      if (out.telegram?.state !== "paired") {
        try {
          out = await api.telegram("pair");
        } catch (err) {
          redraw(m, out.telegram);
          return failed(m, err);
        }
      }
      m.status.textContent = "Connected. Send the code to the bot.";
      redraw(m, out.telegram);
    } catch (err) {
      if (err instanceof SessionExpired) return void m.onExpired?.();
      m.fieldError = err instanceof ApiError && err.message ? err.message : "Could not reach Tidegap. Try again.";
      redraw(m);
    } finally {
      save.disabled = false;
      save.textContent = "Connect";
      repoll(m);
    }
  });
  return form;
}

function pairingPanel(p) {
  return h("div", { class: "pairing" },
    h("div", { class: "pairing-text" },
      h("p", { class: "integration-sub" }, "Open the link on the phone or scan the code. Or send the code to the bot. Click a value to copy it."),
      h("div", { class: "copy-row" }, h("span", { class: "copy-name" }, "Code"),
        copyChip(p.code, "pairing code", { shown: p.code, className: "pairing-code" })),
      h("div", { class: "copy-row" }, h("span", { class: "copy-name" }, "Command"), copyChip(p.command, "pair command")),
      h("div", { class: "copy-row" }, h("span", { class: "copy-name" }, "Link"), copyChip(p.link, "deep link"),
        h("a", { class: "btn btn-sm", href: p.link, target: "_blank", rel: "noopener noreferrer" }, "Open in Telegram")),
      h("p", { class: "pairing-left" }, p.left)),
    qrSvg(p.link, `QR code for ${p.link}`));
}

function manualLine(command) {
  const copy = async () => {
    if (await copyText(command)) toast("Command copied");
    else errorToast("Could not copy. Select the command and copy it.");
  };
  return h("div", { class: "integration-manual" },
    h("p", { class: "integration-sub" }, "This computer has no listener service. Keep this running in a terminal:"),
    h("div", { class: "field-row" }, h("code", { class: "manual-command" }, command),
      h("button", { type: "button", class: "btn btn-sm", "data-action": "copy-command", onclick: () => void copy() }, "Copy")));
}

function failed(m, err) {
  if (err instanceof SessionExpired) return void m.onExpired?.();
  m.alert.textContent = err instanceof ApiError && err.message ? err.message : "Could not reach Tidegap. Try again.";
}

async function run(m, action, button) {
  if (action === "change-token") return changeToken(m);
  if (action === "remove-token") return removeToken(m);
  if (action === "disconnect") return disconnect(m);
  if (button.disabled) return;
  button.disabled = true;
  stopPolls(m);
  if (BUSY_LABEL[action]) button.textContent = BUSY_LABEL[action];
  m.alert.textContent = "";
  try {
    const out = await api.telegram(ACTION_ROUTE[action]);
    if (action === "test") toast("Test message sent. Check Telegram.");
    else applyTelegram(m, out.telegram);
  } catch (err) {
    failed(m, err);
  } finally {
    button.disabled = false;
    button.textContent = ACTION_LABEL[action];
  }
  repoll(m);
}

async function changeToken(m) {
  if (m.data?.state === "paired") {
    const ok = await confirmDialog({
      heading: "Change the bot token?",
      body: "A token for a different bot removes the paired chat; connect again after saving. A new token for the same bot keeps it.",
      confirm: "Change token",
    });
    if (!ok) return;
  }
  m.editing = true;
  redraw(m);
  focusIn(m, "telegram", "#telegram-token");
}

async function removeToken(m) {
  const ok = await confirmDialog({
    heading: "Remove the bot token?",
    body: "Tidegap deletes the token from ~/.config/tidegap/env and stops sending Telegram messages.",
    confirm: "Remove token",
    danger: true,
  });
  if (ok) await disconnectNow(m, true);
}

function disconnect(m) {
  const forget = h("input", { type: "checkbox", id: "forget-token", name: "forget" });
  const form = h("form", { class: "dialog-form", method: "dialog" },
    h("header", { class: "dialog-head" }, h("h2", { id: "dialog-title", class: "dialog-title" }, "Disconnect Telegram?"),
      h("p", { class: "dialog-sub" }, "The chat stops getting messages and the listener stops. Connect again at any time.")),
    h("label", { class: "check", for: "forget-token" }, forget, h("span", {}, "Also delete the token")),
    h("footer", { class: "dialog-foot" },
      h("button", { type: "button", class: "btn btn-ghost", onclick: closeDialog }, "Keep"),
      h("button", { type: "submit", class: "btn btn-danger-solid", autofocus: true }, "Disconnect")));
  form.addEventListener("submit", (e) => {
    e.preventDefault();
    const forgetToken = forget.checked;
    closeDialog();
    void disconnectNow(m, forgetToken);
  });
  openDialog([form], { label: "Disconnect Telegram?" });
}

async function disconnectNow(m, forgetToken) {
  stopPolls(m);
  try {
    applyTelegram(m, (await api.telegram("disconnect", { forget_token: forgetToken })).telegram);
    m.status.textContent = forgetToken ? "Disconnected. The token is deleted." : "Disconnected.";
  } catch (err) {
    failed(m, err);
  }
  repoll(m);
}
