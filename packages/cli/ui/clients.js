// "Connected apps": list the browser extension and Mac app clients, mint a
// token for a new one (shown once), and revoke one. Page token only: with a
// client token `/api/clients` answers 403 and the button stays hidden.
// Client names are user text and render as text nodes only.

import { api, ApiError } from "./api.js";
import { closeDialog, confirmDialog, openDialog } from "./dialog.js";
import { ago, h, parse } from "./dom.js";
import { errorToast, toast } from "./toast.js";

const KIND_LABEL = { extension: "Browser extension", macos: "Mac app" };

/** Show the Apps button when this token may manage clients. */
export async function initClients() {
  const btn = document.getElementById("apps-btn");
  if (!btn) return;
  try {
    await api.clients();
  } catch (err) {
    if (err instanceof ApiError && err.status === 403) return;
  }
  btn.hidden = false;
  btn.addEventListener("click", () => void openApps());
}

function tokenBox(minted) {
  const field = h("input", { class: "input token-field", readonly: true, value: minted.token, "aria-label": "Client token" });
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(minted.token);
      toast("Token copied");
    } catch {
      field.select();
    }
  };
  return h("section", { class: "token-box", role: "status" },
    h("p", { class: "dialog-body" }, `Token for "${minted.client.name}". Paste it into the extension's options. It is shown only now.`),
    h("div", { class: "field-row" },
      field,
      h("button", { type: "button", class: "btn btn-primary", onclick: () => void copy() }, "Copy")));
}

function clientRow(c) {
  const created = parse(c.created_at);
  return h("li", { class: "app-row" },
    h("span", { class: "app-name" }, c.name),
    h("span", { class: "app-meta" }, `${KIND_LABEL[c.kind] || c.kind} · added ${Number.isFinite(created) ? ago(created) : "?"}`),
    h("button", { type: "button", class: "btn btn-sm", onclick: () => void revoke(c) }, "Revoke"));
}

async function openApps(minted) {
  let clients = [];
  let failed = "";
  try {
    clients = (await api.clients()).clients;
  } catch (err) {
    failed = err.message;
  }
  const name = h("input", { class: "input", id: "app-name", name: "name", maxlength: "64", required: true, placeholder: "Chrome on this Mac", autofocus: !minted });
  const submit = h("button", { type: "submit", class: "btn btn-primary" }, "Connect an app");
  const form = h("form", { class: "dialog-form" },
    h("header", { class: "dialog-head" }, h("h2", { id: "dialog-title", class: "dialog-title" }, "Connected apps"),
      h("p", { class: "dialog-sub" }, "Apps with a token can see, postpone, cancel and run tasks now on this Mac, but cannot create tasks; the Mac app can also reply to a finished task. Revoke one to lock it out at once.")),
    minted ? tokenBox(minted) : null,
    failed ? h("p", { class: "dialog-body" }, failed)
      : clients.length ? h("ul", { class: "app-list" }, clients.map(clientRow))
        : h("p", { class: "dialog-body" }, "No apps connected."),
    h("label", { class: "field", for: "app-name" }, h("span", { class: "field-label" }, "New app name"), name),
    h("footer", { class: "dialog-foot" },
      h("button", { type: "button", class: "btn btn-ghost", onclick: closeDialog }, "Close"),
      submit));
  // One press, one token: a second submit while the first is in flight is ignored.
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    if (submit.disabled) return;
    submit.disabled = true;
    try {
      const out = await api.addClient({ name: name.value, kind: "extension" });
      await openApps(out);
    } catch (err) {
      errorToast(err.message);
    } finally {
      submit.disabled = false;
    }
  });
  openDialog([form], { label: "Connected apps", wide: true });
}

async function revoke(c) {
  const ok = await confirmDialog({
    heading: `Revoke ${c.name}?`,
    body: "Its token stops working on the next request. Connect it again to get a new one.",
    confirm: "Revoke",
    danger: true,
  });
  if (!ok) return void openApps();
  try {
    await api.revokeClient(c.id);
    toast(`Revoked ${c.name}`);
  } catch (err) {
    errorToast(err.message);
  }
  await openApps();
}
