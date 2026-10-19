import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { descriptorData, EVENT_KINDS, KIND_DESCRIPTORS, payloadFor, TaskStore, validateFields, webhookBody } from "../src/index.js";
import type { Channel, KindDescriptor, TaskRecord } from "../src/index.js";

const descriptor = (fields: KindDescriptor["fields"]): KindDescriptor => ({
  kind: "webhook",
  label: "Test",
  description: "",
  ready: true,
  fields,
  steps: [],
  defaultEvents: [],
  docsAnchor: "notify-webhook",
});

describe("kind registry", () => {
  const all = Object.values(KIND_DESCRIPTORS);

  it("every descriptor has a unique kind, at most four steps, a notify-<kind> anchor and default events from EVENT_KINDS", () => {
    expect(new Set(all.map((d) => d.kind)).size).toBe(all.length);
    for (const [key, d] of Object.entries(KIND_DESCRIPTORS)) {
      expect(d.kind).toBe(key);
      expect(d.steps.length).toBeLessThanOrEqual(4);
      expect(d.docsAnchor).toBe(`notify-${d.kind}`);
      for (const e of d.defaultEvents) expect(EVENT_KINDS).toContain(e);
    }
  });

  it("every ready kind but Telegram formats; stubs are not ready", () => {
    for (const d of all) {
      if (d.kind === "telegram") continue;
      expect(typeof d.format === "function").toBe(d.ready);
    }
    expect(all.filter((d) => d.ready).map((d) => d.kind)).toEqual(["telegram", "webhook"]);
  });

  it("descriptor data drops format and survives JSON", () => {
    const data = descriptorData(KIND_DESCRIPTORS.webhook);
    expect("format" in data).toBe(false);
    expect(JSON.parse(JSON.stringify(data))).toEqual(data);
  });
});

describe("validateFields", () => {
  const d = descriptor([
    { name: "url", label: "URL", input: "url", required: true, secret: true },
    { name: "format", label: "Format", input: "select", default: "tidegap", options: [{ value: "tidegap", label: "Tidegap" }, { value: "text", label: "Text" }] },
    { name: "priority", label: "Priority", input: "number", min: 1, max: 5 },
    { name: "name", label: "Name", input: "text", pattern: "[a-z]+" },
    { name: "headers", label: "Headers", input: "textarea", secret: true },
  ]);

  it("a required field left empty → required", () => {
    expect(validateFields(d, { url: "  " })).toEqual({ ok: false, field: "url", code: "required" });
    expect(validateFields(d, {})).toEqual({ ok: false, field: "url", code: "required" });
  });

  it("a select value outside the options → invalid", () => {
    expect(validateFields(d, { url: "https://x.test/", format: "teams" })).toEqual({ ok: false, field: "format", code: "invalid" });
  });

  it("a 3,000-character URL → too_long", () => {
    expect(validateFields(d, { url: `https://x.test/${"a".repeat(3000)}` })).toEqual({ ok: false, field: "url", code: "too_long" });
  });

  it("secret fields come back in secrets, never in values; empty takes the default", () => {
    const r = validateFields(d, { url: "https://x.test/h", priority: "3", headers: "Authorization: Bearer x", extra: "ignored" });
    expect(r).toEqual({ ok: true, values: { format: "tidegap", priority: 3 }, secrets: { url: "https://x.test/h", headers: "Authorization: Bearer x" } });
  });

  it("number range, pattern, URL parse, line breaks and textarea line cap are checked", () => {
    const base = { url: "https://x.test/" };
    expect(validateFields(d, { ...base, priority: 9 })).toMatchObject({ field: "priority", code: "invalid" });
    expect(validateFields(d, { ...base, name: "Abc" })).toMatchObject({ field: "name", code: "invalid" });
    expect(validateFields(d, { url: "not a url" })).toMatchObject({ field: "url", code: "invalid" });
    expect(validateFields(d, { ...base, name: "ab\ncd" })).toMatchObject({ field: "name", code: "invalid" });
    expect(validateFields(d, { ...base, headers: Array.from({ length: 11 }, (_, i) => `X-H${i}: v`).join("\n") })).toMatchObject({ field: "headers", code: "too_long" });
    expect(validateFields(d, { ...base, priority: { n: 1 } })).toMatchObject({ field: "priority", code: "invalid" });
    expect(validateFields(d, { ...base, priority: "0x3" })).toMatchObject({ field: "priority", code: "invalid" });
    expect(validateFields(d, { ...base, name: "ab\u0085cd" })).toMatchObject({ field: "name", code: "invalid" });
  });

  it("every descriptor default passes its own field's checks", () => {
    for (const d of Object.values(KIND_DESCRIPTORS)) {
      const input = Object.fromEntries(d.fields.filter((f) => f.default !== undefined).map((f) => [f.name, f.default]));
      const r = validateFields({ ...d, fields: d.fields.map((f) => ({ ...f, required: false, default: undefined })) }, input);
      expect(r.ok).toBe(true);
    }
  });
});

describe("webhook (reference kind, tidegap format)", () => {
  it("posts the Tidegap JSON body, version 1, to the URL", () => {
    const task = { taskId: "t-1", status: "completed", enqueuedAt: "2026-10-17T10:00:00Z", completedAt: "2026-10-17T11:00:00Z", region: "DE", title: "Weekly digest" } as TaskRecord<unknown>;
    const payload = payloadFor({ kind: "task_done", task });
    const spec = KIND_DESCRIPTORS.webhook.format!(payload, { url: "https://x.test/h" });
    expect(spec).toEqual({ type: "http", method: "POST", url: "https://x.test/h", headers: { "Content-Type": "application/json" }, body: webhookBody(payload) });
    const body = JSON.parse(spec.type === "http" ? spec.body : "{}");
    expect(body).toEqual({ version: 1, event: "task_done", level: "success", title: "Done: Weekly digest", text: payload.text, at: "2026-10-17T11:00:00Z", task: payload.task });
  });
});

describe("ledger channel kinds", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "tidegap-registry-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("a slack row round-trips; an unknown kind fax is still skipped", () => {
    const store = new TaskStore({ dbPath: join(dir, "ledger.db") });
    const slack: Channel = { id: "slack", kind: "slack", enabled: true, events: ["task_failed", "digest"], config: { quiet: "night" }, createdAt: "2026-10-19T10:00:00.000Z" };
    store.insertChannel(slack);
    store.insertChannel({ ...slack, id: "fax", kind: "fax" as Channel["kind"] });
    expect(store.listChannels()).toEqual([slack]);
    store.close();
  });
});
