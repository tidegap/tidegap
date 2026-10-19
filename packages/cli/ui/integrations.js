// Settings → Integrations: the Telegram card (integrations plan U6). The page
// and the Mac app only: with any other token `/api/integrations` answers 403
// and the Settings link stays hidden. The bot token is typed into a password
// field, sent once and cleared; the server never returns it (only its last 4
// characters). Every string from the server renders as a text node.

import { api, ApiError, SessionExpired } from "./api.js";
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

const OFFLINE = "Could not reach Tidegap. Retrying…";

const BUSY_LABEL = { connect: "Connecting…", "connect-again": "Connecting…", test: "Sending…", "start-listener": "Starting…", cancel: "Cancelling…" };

const LISTENER_LINE = {
  running: "Listener running",
  not_running: "Listener not running",
  conflict: "Another program reads this bot",
  unauthorized: "Telegram refused the token",
  manual: "Listener runs by hand on this computer",
};

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
  const card = { state: st.state, line: "", sub: "", error: "", steps: false, tokenForm: false, actions: [] };
  switch (st.state) {
    case "pairing":
      card.line = "Waiting for the code";
      card.sub = bot ? `Send the code to ${bot}` : "";
      card.pairing = { code: st.pairing.code, link: st.pairing.link, left: timeLeft(st.pairing.expires_at, now) };
      card.actions = ["cancel"];
      break;
    case "paired": {
      const l = st.listener || { state: "not_running" };
      card.line = `Paired with ${st.chat?.label || "your chat"}`;
      card.sub = [bot, LISTENER_LINE[l.state] || ""].filter(Boolean).join(" · ");
      card.listener = l.state;
      if (l.state === "manual") card.manual = SERVE_COMMAND;
      else if (l.message && l.state !== "running") card.error = l.message;
      card.actions = ["test", ...(l.state === "not_running" ? ["start-listener"] : []), "change-token", "disconnect"];
      break;
    }
    case "token_saved":
      card.line = tokenLine;
      card.sub = bot;
      card.actions = ["connect", "change-token", "remove-token"];
      break;
    case "error":
      card.line = tokenLine || "Not connected";
      card.sub = bot;
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
  const card = h("section", { class: "integration-card", "aria-labelledby": "telegram-title" }, h("p", { class: "integration-sub" }, "Loading…"));
  const status = h("p", { class: "sr-only", role: "status" });
  const alert = h("p", { class: "integration-alert", role: "alert" });
  const root = h("div", { class: "view-inner view-settings" },
    h("h1", { class: "settings-title" }, "Settings"),
    h("h2", { class: "settings-section" }, "Integrations"),
    status, alert, card);
  view.replaceChildren(root);
  const m = { root, card, status, alert, data: null, key: "", editing: false, timer: null, gen: 0, tick: null, offline: false, onExpired };
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
      apply(m, out.telegram);
      if (m.offline && m.alert.textContent === OFFLINE) m.alert.textContent = "";
      m.offline = false;
    } catch (err) {
      if (gen !== m.gen) return;
      if (err instanceof SessionExpired) return void m.onExpired?.();
      if (err instanceof ApiError && err.status === 403) {
        m.card.replaceChildren(h("p", { class: "integration-sub" }, "Settings open in the page that tidegap ui prints and in the Mac app."));
        return;
      }
      m.offline = true;
      if (m.data) m.alert.textContent = OFFLINE;
    }
  }
  if (mounted !== m || gen !== m.gen) return;
  m.timer = setTimeout(() => void poll(m), m.data?.state === "pairing" ? POLL_PAIRING_MS : POLL_IDLE_MS);
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
  const el = m.card.querySelector(".pairing-left");
  if (el && m.data?.pairing) el.textContent = timeLeft(m.data.pairing.expires_at, Date.now());
}

/** Rebuild the card even when its state did not change (the token form opened or closed). */
function redraw(m, data = m.data) {
  m.key = "";
  apply(m, data);
}

/** Rebuild the card only when its state changed; keep focus on the same action. */
function apply(m, data) {
  if (mounted !== m) return;
  m.data = data;
  const vm = telegramCard(data, Date.now());
  const key = JSON.stringify({ ...vm, pairing: vm.pairing && { ...vm.pairing, left: "" }, editing: m.editing });
  if (key === m.key) return;
  const prevState = m.key ? JSON.parse(m.key).state : null;
  m.key = key;
  const focused = m.card.contains(document.activeElement) ? document.activeElement?.dataset?.action : null;
  // A rebuild while the token field holds text keeps the text and the focus.
  const field = m.card.querySelector("#telegram-token");
  const typed = field?.value ? { value: field.value, focus: document.activeElement === field } : null;
  m.card.replaceChildren(...cardNodes(m, vm));
  if (focused) m.card.querySelector(`[data-action="${focused}"]`)?.focus();
  const next = typed && m.card.querySelector("#telegram-token");
  if (next) {
    next.value = typed.value;
    if (typed.focus) next.focus();
  }
  if (prevState && prevState !== vm.state) m.status.textContent = vm.line;
}

/** The card's nodes for a view-model; `m` holds the view's state (editing, regions). */
export function cardNodes(m, vm) {
  const head = h("header", { class: "integration-head" },
    h("h3", { id: "telegram-title", class: "integration-title" }, "Telegram"),
    h("span", { class: "integration-state", dataset: { state: vm.state } }, vm.line));
  const nodes = [head];
  if (vm.sub) nodes.push(h("p", { class: "integration-sub" }, vm.sub));
  nodes.push(h("p", { class: "integration-sub" }, "Get a message when a task finishes, and run /queue, /cancel or /later from the chat."));
  if (vm.error) nodes.push(h("p", { class: "integration-error", id: "telegram-error" }, vm.error));
  if (vm.steps || m.editing) nodes.push(steps());
  if (vm.tokenForm || m.editing) nodes.push(tokenForm(m, vm));
  if (vm.pairing) nodes.push(pairingPanel(vm.pairing));
  if (vm.manual) nodes.push(manualLine(vm.manual));
  const buttons = vm.actions.filter((a) => !(m.editing && a === "change-token"));
  if (buttons.length) {
    nodes.push(h("div", { class: "integration-actions" }, buttons.map((a) =>
      h("button", {
        type: "button",
        class: ["btn", ACTION_STYLE[a]],
        "data-action": a,
        onclick: (e) => void run(m, a, e.currentTarget),
      }, ACTION_LABEL[a]))));
  }
  nodes.push(h("p", { class: "integration-docs" }, h("a", { href: DOCS_URL, target: "_blank", rel: "noopener noreferrer" }, "Telegram setup guide")));
  return nodes;
}

function steps() {
  return h("ol", { class: "integration-steps", id: "telegram-steps" },
    h("li", {}, "Open ", h("a", { href: BOTFATHER_URL, target: "_blank", rel: "noopener noreferrer" }, "@BotFather"), " in Telegram."),
    h("li", {}, "Send ", h("code", {}, "/newbot"), " and pick a name. Use a new bot for Tidegap only."),
    h("li", {}, "Copy the token it sends and paste it here."));
}

function tokenForm(m, vm) {
  const describedBy = ["telegram-steps", vm.error ? "telegram-error" : null].filter(Boolean).join(" ");
  const input = h("input", {
    class: "input token-field",
    id: "telegram-token",
    name: "token",
    type: "password",
    autocomplete: "off",
    spellcheck: "false",
    required: true,
    "aria-describedby": describedBy,
    placeholder: "123456789:AA…",
  });
  const save = h("button", { type: "submit", class: "btn btn-primary", "data-action": "save-token" }, "Save token");
  const form = h("form", { class: "token-form" },
    h("label", { class: "field", for: "telegram-token" }, h("span", { class: "field-label" }, "Bot token"),
      h("div", { class: "field-row" }, input, save,
        m.editing ? h("button", { type: "button", class: "btn btn-ghost", onclick: () => { m.editing = false; redraw(m); } }, "Cancel") : null)));
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    if (save.disabled) return;
    save.disabled = true;
    save.textContent = "Saving…";
    stopPolls(m);
    const token = input.value;
    // The token leaves the page's memory as soon as the request is sent.
    input.value = "";
    try {
      const out = await api.saveTelegramToken(token);
      m.editing = false;
      m.alert.textContent = "";
      m.status.textContent = "Token saved.";
      redraw(m, out.telegram);
    } catch (err) {
      failed(m, err);
    } finally {
      save.disabled = false;
      save.textContent = "Save token";
    }
    repoll(m);
  });
  return form;
}

function pairingPanel(p) {
  return h("div", { class: "pairing" },
    h("div", { class: "pairing-text" },
      h("p", { class: "integration-sub" }, "Open the link on the phone or scan the code. Or send this code to the bot:"),
      h("p", { class: "pairing-code", "aria-label": `Code ${p.code.split("").join(" ")}` }, p.code),
      h("p", {}, h("a", { class: "btn", href: p.link, target: "_blank", rel: "noopener noreferrer" }, "Open in Telegram")),
      h("p", { class: "pairing-left" }, p.left)),
    qrSvg(p.link, `QR code for ${p.link}`));
}

function manualLine(command) {
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(command);
      toast("Command copied");
    } catch {
      errorToast("Could not copy. Select the command and copy it.");
    }
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
    else apply(m, out.telegram);
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
  m.card.querySelector("#telegram-token")?.focus();
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
    apply(m, (await api.telegram("disconnect", { forget_token: forgetToken })).telegram);
    m.status.textContent = forgetToken ? "Disconnected. The token is deleted." : "Disconnected.";
  } catch (err) {
    failed(m, err);
  }
  repoll(m);
}
