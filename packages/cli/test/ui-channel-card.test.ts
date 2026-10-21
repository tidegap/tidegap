/** The shared channel card (integrations plan U4, KTD9): view-model per state, field errors, edit mode, rendering as text. */

import { describe, expect, it } from "vitest";

import { descriptorData, KIND_DESCRIPTORS, keepsSecret } from "@tidegap/core";

import { secretHint } from "../src/channels/channel-setup.js";

import { cardModel, cardNodes, clearedFields, DROPPED_HINT, eventChoices, formValues, keepsStored, missingField, prefillValues } from "../ui/channel-card.js";
import { ApiError } from "../ui/api.js";
import { cardOrder, connectError, telegramCard, telegramNodes } from "../ui/integrations.js";
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

  it("connecting: the form is disabled and busy, the button says Connecting…, Cancel waits", () => {
    const m = cardModel(webhook, null, { open: true, pending: "connect" }, NOW);
    expect(m).toMatchObject({ state: "connecting", pill: "Connecting…", busy: true });
    const out = render(m);
    expect(out.els.find((e) => e.tagName === "form")?.attrs["aria-busy"]).toBe("true");
    expect(out.els.find((e) => e.tagName === "fieldset" && e.attrs.class === "channel-fields")?.attrs.disabled).toBe("");
    expect(out.text).toContain("Connecting…");
    expect(out.els.find((e) => e.attrs["data-action"] === "cancel")?.attrs.disabled).toBe("");
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

  it("a Connect from the action row in flight: every action button is disabled and Connect says Connecting…", () => {
    const out = render(cardModel(webhook, status("disconnected"), { pending: "connect" }, NOW));
    const actions = out.els.filter((e) => e.tagName === "button" && ["connect", "edit", "remove"].includes(e.attrs["data-action"]));
    expect(actions.map((e) => e.attrs.disabled)).toEqual(["", "", ""]);
    expect(textOf(actions[0])).toBe("Connecting…");
  });

  it("another action in flight: every action button is disabled and that one shows its busy label", () => {
    const out = render(cardModel(webhook, status("connected"), { pending: "test" }, NOW));
    const actions = out.els.filter((e) => e.tagName === "button" && ["test", "disconnect", "edit", "remove"].includes(e.attrs["data-action"]));
    expect(actions.every((e) => e.attrs.disabled === "")).toBe(true);
    expect(actions.map(textOf)).toEqual(["Sending…", "Disconnect", "Edit", "Remove"]);
    const idle = render(cardModel(webhook, status("connected"), {}, NOW)).els.filter((e) => e.attrs["data-action"] === "test");
    expect(idle[0]?.attrs.disabled).toBeUndefined();
  });

  it("a settings save in flight: the event chips, the quiet switch and every action wait for it", () => {
    const out = render(cardModel(webhook, status("connected"), { pending: "settings" }, NOW));
    const boxes = out.els.filter((e) => e.tagName === "input" && e.attrs.type === "checkbox");
    expect(boxes.length).toBeGreaterThan(1);
    expect(boxes.every((e) => e.attrs.disabled === "")).toBe(true);
    const actions = out.els.filter((e) => e.tagName === "button" && e.attrs["data-action"]);
    expect(actions.every((e) => e.attrs.disabled === "")).toBe(true);
    expect(actions.map(textOf)).toEqual(["Send test", "Disconnect", "Edit", "Remove"]);
  });

  it("error: the sentence with its fix and the enabled-channel actions", () => {
    const m = cardModel(webhook, status("error", { error: "The receiver answered 404. Paste the URL again.", last: { at: new Date(NOW).toISOString(), ok: false, code: "http_404" } }), {}, NOW);
    expect(m).toMatchObject({ pill: "Error", error: "The receiver answered 404. Paste the URL again.", actions: ["test", "disconnect", "edit", "remove"] });
    expect(m.last).toMatch(/failed$/);
  });

  it("error in backoff: the last line says when the next try is, from the server's retry_at", () => {
    const last = (retryInMs: number) => ({ at: new Date(NOW - 60_000).toISOString(), ok: false, code: "network", fails: 3, retry_at: new Date(NOW + retryInMs).toISOString() });
    expect(cardModel(webhook, status("error", { last: last(3 * 60_000 + 1) }), {}, NOW).last).toMatch(/failed\. Retrying in 4 min\.$/);
    expect(cardModel(webhook, status("error", { last: last(30_000) }), {}, NOW).last).toMatch(/failed\. Retrying in 1 min\.$/);
    expect(cardModel(webhook, status("error", { last: last(-1_000) }), {}, NOW).last).toMatch(/failed$/);
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

  it("an optional stored secret has Clear; cleared, it says it is not kept and its name goes in `clear`", () => {
    const signed = { ...webhook, fields: [...webhook.fields, { name: "secret", label: "Signing secret", input: "password", secret: true, keepWith: "url" }] };
    const st = status("connected", { secrets: { url: "example.com …wxyz", secret: "…cret" } });
    const m = cardModel(signed, st, { editing: true }, NOW);
    const els = render(m).els;
    expect(byId(els, "ch-webhook-secret-clear")?.attrs["aria-pressed"]).toBe("false");
    expect(byId(els, "ch-webhook-url-clear")).toBeUndefined();
    expect(clearedFields(m)).toEqual([]);
    const cleared = cardModel(signed, st, { editing: true, clear: { secret: true } }, NOW);
    expect(cleared.fields.find((f) => f.name === "secret")).toMatchObject({ placeholder: DROPPED_HINT, cleared: true });
    expect(textOf(byId(render(cleared).els, "ch-webhook-secret-clear")!)).toBe("Keep");
    expect(clearedFields(cleared)).toEqual(["secret"]);
  });

  it("a keepWith secret stops saying Stored once its owner field holds a new address", () => {
    const tokened = { ...ntfy, fields: [...ntfy.fields, { name: "token", label: "Access token", input: "password", secret: true, keepWith: "server" }] };
    const st = { ...status("connected"), id: "ntfy", kind: "ntfy", fields: { server: "https://ntfy.example.com" }, secrets: { topic: "…6789", token: "…oken" } };
    const m = cardModel(tokened, st, { editing: true }, NOW);
    const token = m.fields.find((f) => f.name === "token")!;
    expect(token.placeholder).toBe("Stored …oken");
    expect(keepsStored(token.keep, "")).toBe(true);
    expect(keepsStored(token.keep, "https://ntfy.example.com/")).toBe(true);
    expect(keepsStored(token.keep, "https://other.example.com")).toBe(false);
    const els = render(m).els;
    const server = byId(els, "ch-ntfy-server")! as FakeElement & { value?: string; placeholder?: string };
    const input = byId(els, "ch-ntfy-token")! as FakeElement & { placeholder?: string };
    const clearBtn = byId(els, "ch-ntfy-token-clear")! as FakeElement & { hidden?: boolean };
    server.value = "https://other.example.com";
    server.dispatch("input");
    expect([input.placeholder, clearBtn.hidden]).toEqual([DROPPED_HINT, true]);
    server.value = "https://ntfy.example.com";
    server.dispatch("input");
    expect([input.placeholder, clearBtn.hidden]).toEqual(["Stored …oken", false]);
    const wh = cardModel({ ...webhook, fields: [...webhook.fields, { name: "secret", label: "Signing secret", input: "password", secret: true, keepWith: "url" }] },
      status("connected", { secrets: { url: "example.com …wxyz", secret: "…cret" } }), { editing: true }, NOW);
    const keep = wh.fields.find((f) => f.name === "secret")!.keep;
    expect([keepsStored(keep, "https://example.com/new"), keepsStored(keep, "https://evil.test/h")]).toEqual([true, false]);
    // The server compares origins: a scheme change alone drops the secret, so the card must not say Stored.
    expect(keepsStored(keep, "http://example.com/new")).toBe(false);
    const httpWh = cardModel({ ...webhook, fields: [...webhook.fields, { name: "secret", label: "Signing secret", input: "password", secret: true, keepWith: "url" }] },
      status("connected", { secrets: { url: "http://lan.local:8123 …wxyz", secret: "…cret" } }), { editing: true }, NOW);
    const httpKeep = httpWh.fields.find((f) => f.name === "secret")!.keep;
    expect([keepsStored(httpKeep, "http://lan.local:8123/hook"), keepsStored(httpKeep, "https://lan.local:8123/hook")]).toEqual([true, false]);
    const noHost = cardModel({ ...webhook, fields: [...webhook.fields, { name: "secret", label: "Signing secret", input: "password", secret: true, keepWith: "url" }] },
      status("connected", { secrets: { url: "stored", secret: "…cret" } }), { editing: true }, NOW);
    expect(keepsStored(noHost.fields.find((f) => f.name === "secret")!.keep, "https://example.com/x")).toBe(false);
  });

  it("the card's Stored/Not kept for a keepWith secret agrees with the server rule, path hosts included", () => {
    const real = descriptorData(KIND_DESCRIPTORS.webhook);
    const urlField = KIND_DESCRIPTORS.webhook.fields.find((f) => f.name === "url")!;
    const cases: [string, string[]][] = [
      ["https://hooks.zapier.com/hooks/catch/123/abcdef/", ["", "https://hooks.zapier.com/hooks/catch/123/abcdef/", "https://hooks.zapier.com/hooks/catch/123/zzz/", "https://example.com/x"]],
      ["https://prod-01.westus.logic.azure.com/workflows/aaa/triggers/manual/paths/invoke?sig=x", ["", "https://prod-01.westus.logic.azure.com/workflows/bbb/triggers/manual/paths/invoke?sig=y", "https://prod-02.westus.logic.azure.com/workflows/aaa"]],
      ["https://discord.com/api/webhooks/1/tok", ["https://discord.com/api/webhooks/2/tok", "https://canary.discord.com/api/webhooks/1/tok"]],
      ["https://example.com/hooks/tidegap", ["", "https://example.com/hooks/other?x=1", "http://example.com/hooks/tidegap", "https://hooks.zapier.com/hooks/tidegap"]],
    ];
    for (const [stored, typedValues] of cases) {
      const st = status("connected", { secrets: { url: secretHint(urlField, stored), secret: "…cret" } });
      const keep = cardModel(real, st, { editing: true }, NOW).fields.find((f) => f.name === "secret")!.keep;
      for (const typed of typedValues) {
        expect([stored, typed, keepsStored(keep, typed)]).toEqual([stored, typed, keepsSecret(urlField, stored, typed || undefined)]);
      }
    }
    // On a path host a new path is a new receiver; elsewhere a path edit keeps the secret.
    const zapier = cardModel(real, status("connected", { secrets: { url: secretHint(urlField, cases[0]![0]), secret: "…cret" } }), { editing: true }, NOW);
    expect(keepsStored(zapier.fields.find((f) => f.name === "secret")!.keep, "https://hooks.zapier.com/hooks/catch/123/zzz/")).toBe(false);
    expect(keepsSecret(urlField, "https://example.com/a", "https://example.com/b")).toBe(true);
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

  it("ntfy: the copy chip copies the topic the input holds now, not the generated one", () => {
    const values = prefillValues("ntfy");
    const out = render(cardModel(ntfy, null, { open: true, values }, NOW));
    const input = byId(out.els, "ch-ntfy-topic") as FakeElement & { value?: string };
    const chipOf = () => walk([input.parent!]).els.find((e) => e.attrs["data-copy"] === "topic");
    input.value = "my-own-topic";
    input.dispatch("input");
    expect(chipOf()?.attrs["aria-label"]).toBe("Copy topic: my-own-topic");
    input.value = "";
    input.dispatch("input");
    expect((chipOf() as FakeElement & { hidden?: boolean }).hidden).toBe(true);
  });

  it("presets: a new card starts on the first preset with its values; Other opens the disclosure", () => {
    const first = cardModel(email, null, { open: true }, NOW);
    expect(first.presets?.value).toBe("gmail");
    expect(first.fields.find((f) => f.name === "host")?.value).toBe("smtp.gmail.com");
    expect(first.advancedOpen).toBe(false);
    expect(cardModel(email, null, { open: true, preset: "" }, NOW).advancedOpen).toBe(true);
  });
});

describe("connectError: keyed on the route's code, not the HTTP status", () => {
  const err = (status: number, code: string, field?: string) => new ApiError(status, `${code} sentence`, { code, field });
  it("invalid and test_failed with a known field go under that field", () => {
    expect(connectError(err(400, "invalid", "url"), webhook, true)).toEqual({ fieldErrors: { url: "invalid sentence" } });
    expect(connectError(err(409, "test_failed", "url"), webhook, true)).toEqual({ fieldErrors: { url: "test_failed sentence" } });
  });
  it("any other code, an unknown field, or no form: one line for the form or the card", () => {
    expect(connectError(err(409, "telegram", "url"), webhook, true)).toEqual({ formError: "telegram sentence" });
    expect(connectError(err(409, "test_failed", "nope"), webhook, true)).toEqual({ formError: "test_failed sentence" });
    expect(connectError(err(502, "unreachable"), webhook, true)).toEqual({ formError: "unreachable sentence" });
    expect(connectError(err(409, "test_failed", "url"), webhook, false)).toEqual({ actionError: "test_failed sentence" });
    expect(connectError(new TypeError("fetch failed"), webhook, true)).toEqual({ formError: "Could not reach Tidegap. Try again." });
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
