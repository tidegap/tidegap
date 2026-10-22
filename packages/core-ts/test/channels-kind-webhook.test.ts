/** Webhook kind (integrations plan U6): the three body formats, escaping, header lines. */

import { describe, expect, it } from "vitest";

import { KIND_DESCRIPTORS, keepsSecret, testPayload, validateFields } from "../src/index.js";
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
    // "Running again" is a not_ready body with recovered: true; an alert has no such field.
    expect(body("tidegap", { ...payload, event: "not_ready", level: "success", recovered: true })).toMatchObject({ event: "not_ready", level: "success", recovered: true });
    expect(body("tidegap")).not.toHaveProperty("recovered");
  });

  it("text: exactly {text}, with no live link or group mention", () => {
    const b = body("text");
    expect(Object.keys(b)).toEqual(["text"]);
    expect(b.text).not.toMatch(/<|>|@(everyone|channel)\b/);
    expect(b.text).toContain("&lt;users/all&gt;");
    expect(b.text).toContain("@​everyone");
    expect(b.text).not.toContain("](");
    expect(b.text).toContain("[click]\u200B(https://evil)");
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
    expect(text.text).toContain("\\[click\\]\\(https://evil\\)");
    expect(text.text).not.toMatch(/@(everyone|channel)\b/);
  });

  it("a signing secret goes on the spec as sign, headers merge with Content-Type", () => {
    const spec = http(webhook.format!(payload, { url: "https://x.test/h", secret: "s3cret", headers: "Authorization: Bearer x" }));
    expect(spec.sign).toEqual({ secret: "s3cret" });
    expect(spec.headers).toEqual({ Authorization: "Bearer x", "Content-Type": "application/json" });
    expect(http(webhook.format!(payload, { url: "https://x.test/h" })).sign).toBeUndefined();
  });

  it("format refuses headers that validate refuses instead of dropping them", () => {
    expect(() => webhook.format!(payload, { url: "https://x.test/h", headers: "Content-Type: text/evil" })).toThrow();
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
    for (const name of ["Content-Type", "content-type", "CONTENT-TYPE", "hOsT", "TRANSFER-ENCODING"]) expect(parseHeaders(`${name}: x`)).toBeUndefined();
    expect(parseHeaders("X-Bad\r\nInjected: 1")).toBeUndefined();
    expect(parseHeaders("X-A: b\rInjected: 1")).toBeUndefined();
    expect(parseHeaders("X-A: b\x00c")).toBeUndefined();
    expect(parseHeaders("X-A: b\x7fc")).toBeUndefined();
    expect(parseHeaders("A: b\r\nC: d")).toEqual({ A: "b", C: "d" });
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

describe("webhook keepWith addresses", () => {
  const url = webhook.fields.find((f) => f.name === "url")!;
  const ntfyServer = KIND_DESCRIPTORS.ntfy.fields.find((f) => f.name === "server")!;

  it("on a path host the path names the receiver: a new path, or the URL typed again, drops the secret", () => {
    const zap = "https://hooks.zapier.com/hooks/catch/123/abcdef/";
    expect(keepsSecret(url, zap, undefined)).toBe(true);
    expect(keepsSecret(url, zap, "https://hooks.zapier.com/hooks/catch/123/other/")).toBe(false);
    expect(keepsSecret(url, zap, zap)).toBe(false);
    expect(keepsSecret(url, "https://a.westus.logic.azure.com/workflows/1/x", "https://a.westus.logic.azure.com/workflows/2/x")).toBe(false);
    expect(keepsSecret(url, "https://hooks.slack.com/services/T/B/1", "https://hooks.slack.com.evil.test/services/T/B/1")).toBe(false);
    // A trailing dot is the same host, so the path rule still applies.
    expect(keepsSecret(url, "https://hooks.zapier.com./hooks/catch/A", "https://hooks.zapier.com./hooks/catch/B")).toBe(false);
    expect(keepsSecret(url, "https://Hooks.Zapier.com./hooks/catch/A", undefined)).toBe(true);
  });

  it("elsewhere the origin decides: a path or query edit keeps it, a new scheme, host or port drops it", () => {
    const own = "https://example.com/hooks/a";
    expect(keepsSecret(url, own, "https://example.com/hooks/b?x=1")).toBe(true);
    expect(keepsSecret(url, own, own)).toBe(true);
    expect(keepsSecret(url, own, "http://example.com/hooks/a")).toBe(false);
    expect(keepsSecret(url, own, "https://example.com:8443/hooks/a")).toBe(false);
    // A non-secret owner (ntfy server) compares its default when nothing is stored.
    expect(keepsSecret(ntfyServer, undefined, "https://ntfy.sh/")).toBe(true);
    expect(keepsSecret(ntfyServer, undefined, "https://push.example.com")).toBe(false);
  });
});
