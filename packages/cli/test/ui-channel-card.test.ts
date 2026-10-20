/** The shared channel card (integrations plan U4, KTD9): view-model per state, field errors, edit mode, rendering as text. */

import { describe, expect, it } from "vitest";

import { cardModel, cardNodes, eventChoices, formValues, missingField, prefillValues } from "../ui/channel-card.js";
import { cardOrder, telegramCard, telegramNodes } from "../ui/integrations.js";
import { FakeElement, installFakeDom, textOf, walk } from "./fixtures/fake-dom.js";

installFakeDom();

const NOW = Date.parse("2026-10-19T10:00:00Z");

const webhook = {
  kind: "webhook",
  label: "Webhook",
  description: "A JSON POST to any URL you own.",
  ready: true,
  fields: [
    { name: "url", label: "Webhook URL", input: "url", required: true, secret: true, placeholder: "https://example.com/hooks/tidegap" },
    { name: "format", label: "Body format", input: "select", default: "tidegap", options: [{ value: "tidegap", label: "Tidegap JSON" }, { value: "text", label: "Plain text" }] },
    { name: "headers", label: "Custom headers", input: "textarea", secret: true, advanced: true },
  ],
  steps: [{ text: "Copy the URL.", link: "https://example.com/docs" }, { text: "Paste it here." }],
  defaultEvents: ["task_done", "task_failed"],
  docsAnchor: "notify-webhook",
  worksWith: "Teams and Google Chat.",
};

const ntfy = {
  kind: "ntfy",
  label: "ntfy",
  description: "Push to your phone.",
  ready: true,
  fields: [
    { name: "server", label: "Server", input: "url", default: "https://ntfy.sh" },
    { name: "topic", label: "Topic", input: "text", required: true, secret: true },
  ],
  steps: [],
  defaultEvents: ["task_done"],
  docsAnchor: "notify-ntfy",
};

const email = {
  kind: "email",
  label: "Email",
  description: "Mail through your SMTP account.",
  ready: true,
  fields: [
    { name: "host", label: "SMTP host", input: "text", required: true, advanced: true },
    { name: "user", label: "Address", input: "text", required: true },
    { name: "password", label: "Password", input: "password", required: true, secret: true },
  ],
  presets: [{ id: "gmail", label: "Gmail", values: { host: "smtp.gmail.com" } }],
  steps: [],
  defaultEvents: ["task_failed"],
  docsAnchor: "notify-email",
};

const status = (state: string, extra: Record<string, unknown> = {}) => ({
  id: "webhook",
  kind: "webhook",
  state,
  target: "example.com ··wxyz",
  fields: { format: "text" },
  secrets: { url: "example.com …wxyz" },
  events: ["task_done"],
  quiet: "off",
  last: { at: new Date(NOW - 60_000).toISOString(), ok: true },
  ...extra,
});

const noop = new Proxy({}, { get: () => () => {} });
const render = (model: ReturnType<typeof cardModel>) => walk(cardNodes(model, noop));
const byId = (els: FakeElement[], id: string) => els.find((e) => e.attrs.id === id);
const buttons = (els: FakeElement[]) => els.filter((e) => e.tagName === "button" && e.attrs["data-action"]).map((e) => e.attrs["data-action"]);

describe("cardModel: the action set per state (design note)", () => {
  it("not set up: collapsed with Set up; opening shows steps, fields and one Connect", () => {
    const closed = cardModel(webhook, null, {}, NOW);
    expect(closed).toMatchObject({ state: "not_set_up", pill: "Not set up", formOpen: false, actions: [], fields: [] });
    expect(buttons(render(closed).els)).toEqual(["open"]);
    const open = cardModel(webhook, null, { open: true }, NOW);
    expect(open.steps).toHaveLength(2);
    expect(open.fields.map((f) => f.name)).toEqual(["url", "format", "headers"]);
    const out = render(open);
    expect(out.els.filter((e) => e.attrs.type === "submit").map(textOf)).toEqual(["Connect"]);
    expect(out.els.find((e) => e.tagName === "form")?.attrs.novalidate).toBe("");
  });

  it("connecting: the form is disabled and busy, the button says Connecting…", () => {
    const m = cardModel(webhook, null, { open: true, busy: true }, NOW);
    expect(m).toMatchObject({ state: "connecting", pill: "Connecting…", busy: true });
    const out = render(m);
    expect(out.els.find((e) => e.tagName === "form")?.attrs["aria-busy"]).toBe("true");
    expect(out.els.find((e) => e.tagName === "fieldset" && e.attrs.class === "channel-fields")?.attrs.disabled).toBe("");
    expect(out.text).toContain("Connecting…");
  });

  it("connected: target, last delivery, events, quiet switch, and Send test, Disconnect, Edit, Remove", () => {
    const m = cardModel(webhook, status("connected"), {}, NOW);
    expect(m).toMatchObject({ pill: "Connected", target: "example.com ··wxyz", actions: ["test", "disconnect", "edit", "remove"], quiet: false });
    expect(m.last).toMatch(/^Last message today \d\d:\d\d ✓$/);
    expect(m.events?.filter((e) => e.checked).map((e) => e.kind)).toEqual(["task_done"]);
    const out = render(m);
    expect(out.text).toContain("Send me");
    expect(byId(out.els, "webhook-quiet")?.attrs.role).toBe("switch");
  });

  it("a plain-http target outside the user's network carries the cleartext warning", () => {
    expect(cardModel(webhook, status("connected", { warning: "cleartext" }), {}, NOW).warning).toMatch(/unencrypted/);
    expect(cardModel(webhook, status("connected"), {}, NOW).warning).toBe("");
  });

  it("disconnected: a primary Connect plus Edit and Remove; no events", () => {
    const m = cardModel(webhook, status("disconnected"), {}, NOW);
    expect(m).toMatchObject({ pill: "Disconnected", actions: ["connect", "edit", "remove"], events: null });
    const connect = render(m).els.find((e) => e.attrs["data-action"] === "connect");
    expect(connect?.attrs.class).toContain("btn-primary");
  });

  it("error: the sentence with its fix and the enabled-channel actions", () => {
    const m = cardModel(webhook, status("error", { error: "The receiver answered 404. Paste the URL again.", last: { at: new Date(NOW).toISOString(), ok: false, code: "http_404" } }), {}, NOW);
    expect(m).toMatchObject({ pill: "Error", error: "The receiver answered 404. Paste the URL again.", actions: ["test", "disconnect", "edit", "remove"] });
    expect(m.last).toMatch(/failed$/);
  });
});

describe("fields", () => {
  it("a 409 with field url: the input has aria-invalid and the sentence right under it", () => {
    const m = cardModel(webhook, null, { open: true, fieldErrors: { url: "The receiver answered 404. Copy the URL again." } }, NOW);
    const out = render(m);
    const input = byId(out.els, "ch-webhook-url")!;
    expect(input.attrs).toMatchObject({ "aria-invalid": "true", "aria-describedby": "ch-webhook-url-error", type: "password" });
    expect(textOf(byId(out.els, "ch-webhook-url-error")!)).toBe("The receiver answered 404. Copy the URL again.");
  });

  it("edit mode: a stored secret shows its hint as placeholder and is not required; non-secret values are filled in", () => {
    const m = cardModel(webhook, status("connected"), { editing: true }, NOW);
    const url = m.fields.find((f) => f.name === "url")!;
    expect(url).toMatchObject({ placeholder: "Stored example.com …wxyz", required: false, value: "" });
    expect(m.fields.find((f) => f.name === "format")?.value).toBe("text");
    expect(m.actions).toEqual([]);
    expect(m.steps).toEqual([]);
    expect(missingField(m, {})).toBeNull();
  });

  it("a secret has a Show toggle; shown, it is a plain url input", () => {
    expect(render(cardModel(webhook, null, { open: true }, NOW)).els.some((e) => e.attrs.id === "ch-webhook-url-show")).toBe(true);
    const shown = cardModel(webhook, null, { open: true, show: { url: true } }, NOW);
    expect(byId(render(shown).els, "ch-webhook-url")?.attrs.type).toBe("url");
  });

  it("the headers textarea is masked and sits under the collapsed disclosure", () => {
    const out = render(cardModel(webhook, null, { open: true }, NOW));
    const details = out.els.find((e) => e.tagName === "details")!;
    expect(details.attrs.open).toBeUndefined();
    expect(walk([details]).els.find((e) => e.tagName === "textarea")?.attrs.class).toContain("masked");
  });

  it("missingField and formValues: a required empty field is named; empty values are left out", () => {
    const m = cardModel(webhook, null, { open: true }, NOW);
    expect(missingField(m, { url: "  " })).toEqual({ field: "url", message: "Enter the webhook URL." });
    expect(formValues(m, (n: string) => ({ url: " https://x.test/h ", format: "", headers: "" })[n])).toEqual({ url: "https://x.test/h" });
  });

  it("ntfy: the page generates the topic and shows it in clear with a copy chip until the first Connect", () => {
    const values = prefillValues("ntfy");
    expect(values.topic).toMatch(/^tidegap-[a-z0-9]{12}$/);
    expect(prefillValues("ntfy").topic).not.toBe(values.topic);
    const out = render(cardModel(ntfy, null, { open: true, values }, NOW));
    expect(byId(out.els, "ch-ntfy-topic")?.attrs).toMatchObject({ type: "text", value: values.topic });
    expect(out.els.some((e) => e.attrs["data-copy"] === "topic")).toBe(true);
    const connected = cardModel(ntfy, { ...status("connected"), kind: "ntfy", secrets: { topic: "stored" } }, { editing: true }, NOW);
    expect(connected.fields.find((f) => f.name === "topic")).toMatchObject({ masked: true, copy: false, placeholder: "Stored" });
  });

  it("presets: a new card starts on the first preset with its values; Other opens the disclosure", () => {
    const first = cardModel(email, null, { open: true }, NOW);
    expect(first.presets?.value).toBe("gmail");
    expect(first.fields.find((f) => f.name === "host")?.value).toBe("smtp.gmail.com");
    expect(first.advancedOpen).toBe(false);
    expect(cardModel(email, null, { open: true, preset: "" }, NOW).advancedOpen).toBe(true);
  });
});

describe("events", () => {
  it("the daily summary chip appears only when the server offers it", () => {
    expect(eventChoices(["task_done"]).map((e) => e.kind)).toEqual(["task_done", "task_failed", "clean_window", "not_ready"]);
    expect(eventChoices([], true).at(-1)).toEqual({ kind: "digest", label: "Daily summary", checked: false });
  });
});

describe("rendering", () => {
  it("markup in a target or an error renders as text: no element is made from it", () => {
    const evil = "<img src=x onerror=alert(1)>";
    const out = render(cardModel(webhook, status("error", { target: evil, error: evil }), {}, NOW));
    expect(out.els.map((e) => e.tagName)).not.toContain("img");
    expect(out.text.filter((t) => t === evil)).toHaveLength(2);
  });

  it("every button is at least the 28 px .btn-sm or a full .btn", () => {
    const out = render(cardModel(webhook, status("connected"), {}, NOW));
    for (const b of out.els.filter((e) => e.tagName === "button")) expect(b.attrs.class).toMatch(/\bbtn\b|copy-chip/);
  });
});

describe("Telegram on the shared shell", () => {
  it("not configured: one primary button labeled Connect and no Save token button", () => {
    const out = walk(telegramNodes({ editing: false }, telegramCard({ state: "not_configured" }, NOW)));
    const btns = out.els.filter((e) => e.tagName === "button" && !e.attrs["data-copy"]);
    expect(btns.map(textOf)).toEqual(["Connect"]);
    expect(btns[0]!.attrs.class).toContain("btn-primary");
    expect(out.text.join(" ")).not.toMatch(/Save token/);
    expect(out.els.find((e) => e.tagName === "span" && e.dataset.state)?.dataset.state).toBe("not_set_up");
  });

  it("paired with a channel row: the event chips and quiet switch save through settings", () => {
    const data = { channels: [{ id: "telegram-7", kind: "telegram", state: "connected", events: ["task_failed"], quiet: "night" }] };
    const vm = telegramCard({ state: "paired", chat: { channel_id: "telegram-7", label: "@vit" }, listener: { state: "running" } }, NOW);
    const out = walk(telegramNodes({ editing: false, data }, vm));
    expect(byId(out.els, "telegram-event-task_failed")?.attrs.checked).toBe("");
    expect(byId(out.els, "telegram-event-task_done")?.attrs.checked).toBeUndefined();
    expect(byId(out.els, "telegram-quiet")?.attrs.checked).toBe("");
  });
});

describe("cardOrder", () => {
  it("connected cards first, then the fixed order, and This computer last", () => {
    const data = {
      telegram: { state: "not_configured" },
      kinds: [webhook, ntfy, email, { ...webhook, kind: "slack", ready: false }],
      channels: [{ id: "webhook", kind: "webhook", state: "connected" }],
    };
    expect(cardOrder(data)).toEqual(["webhook", "telegram", "email", "ntfy", "os"]);
    expect(cardOrder({ telegram: { state: "paired" } })).toEqual(["telegram", "os"]);
  });
});
