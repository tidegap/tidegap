/** Webhook kind (integrations plan U6): the three body formats, escaping, header lines. */

import { describe, expect, it } from "vitest";

import { KIND_DESCRIPTORS, testPayload, validateFields } from "../src/index.js";
import type { DeliverySpec, NotificationPayload } from "../src/index.js";
import { parseHeaders } from "../src/channels/kinds/webhook.js";

const webhook = KIND_DESCRIPTORS.webhook;
const EVIL = "[click](https://evil) @everyone @channel <users/all> <!channel>";
const payload: NotificationPayload = { event: "task_failed", level: "error", title: EVIL, text: `Failed: ${EVIL}`, at: "2026-10-20T10:00:00.000Z" };

const http = (spec: DeliverySpec) => {
  if (spec.type !== "http") throw new Error("not http");
  return spec;
};
const body = (format: string, p = payload) => JSON.parse(http(webhook.format!(p, { url: "https://x.test/h", format })).body);

describe("webhook formats", () => {
  it("tidegap: version 1 and the raw payload; the test message has event \"test\"", () => {
    expect(body("tidegap")).toEqual({ version: 1, event: "task_failed", level: "error", title: EVIL, text: payload.text, at: payload.at });
    expect(body("tidegap", testPayload(new Date(0)))).toMatchObject({ version: 1, event: "test", level: "info" });
  });

  it("text: exactly {text}, with no live link or group mention", () => {
    const b = body("text");
    expect(Object.keys(b)).toEqual(["text"]);
    expect(b.text).not.toMatch(/<|>|@(everyone|channel)\b/);
    expect(b.text).toContain("&lt;users/all&gt;");
    expect(b.text).toContain("@​everyone");
  });

  it("teams: an Adaptive Card 1.4 message whose TextBlocks carry no live link or mention", () => {
    const b = body("teams");
    expect(b.type).toBe("message");
    const [att] = b.attachments;
    expect(att.contentType).toBe("application/vnd.microsoft.card.adaptive");
    expect(att.content).toMatchObject({ type: "AdaptiveCard", version: "1.4", $schema: "http://adaptivecards.io/schemas/adaptive-card.json" });
    const [title, text] = att.content.body;
    expect([title.type, text.type, title.wrap, text.wrap]).toEqual(["TextBlock", "TextBlock", true, true]);
    expect(title.text).toContain("\\[click\\]\\(https://evil\\)");
    expect(title.text).not.toMatch(/@(everyone|channel)\b/);
  });

  it("a signing secret goes on the spec as sign, headers merge under Content-Type", () => {
    const spec = http(webhook.format!(payload, { url: "https://x.test/h", secret: "s3cret", headers: "Authorization: Bearer x\nContent-Type: text/evil" }));
    expect(spec.sign).toEqual({ secret: "s3cret" });
    expect(spec.headers).toEqual({ Authorization: "Bearer x", "Content-Type": "application/json" });
    expect(http(webhook.format!(payload, { url: "https://x.test/h" })).sign).toBeUndefined();
  });
});

describe("webhook fields", () => {
  it("format defaults to tidegap; secret and headers are secrets", () => {
    const res = validateFields(webhook, { url: "https://x.test/h", secret: "s", headers: "A: b" });
    expect(res).toEqual({ ok: true, values: { format: "tidegap" }, secrets: { url: "https://x.test/h", secret: "s", headers: "A: b" } });
    expect(validateFields(webhook, { url: "https://x.test/h", format: "xml" })).toEqual({ ok: false, field: "format", code: "invalid" });
  });

  it("header lines follow KTD13", () => {
    expect(parseHeaders("Authorization: Bearer x")).toEqual({ Authorization: "Bearer x" });
    expect(parseHeaders("Host: evil")).toBeUndefined();
    expect(parseHeaders("X-Tidegap-Signature: forged")).toBeUndefined();
    expect(parseHeaders("X-Bad\r\nInjected: 1")).toBeUndefined();
    expect(parseHeaders("no colon")).toBeUndefined();
    expect(parseHeaders("X-Name: café")).toBeUndefined();
    expect(parseHeaders(Array.from({ length: 11 }, (_, i) => `X-${i}: v`).join("\n"))).toBeUndefined();
    expect(parseHeaders(Array.from({ length: 10 }, (_, i) => `X-${i}: v`).join("\n\n"))).toBeDefined();
    expect(webhook.validate!({ headers: "Host: evil" })).toMatchObject({ field: "headers" });
    expect(webhook.validate!({ headers: "A: b" })).toBeUndefined();
  });

  it("the steps document the test event", () => {
    expect(webhook.steps.map((s) => s.text).join(" ")).toContain('"event": "test"');
  });
});
