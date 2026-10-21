/** ntfy kind (integrations plan U9): publish URL, headers, priority, topic rule. */

import { describe, expect, it } from "vitest";

import { KIND_DESCRIPTORS, validateFields } from "../src/index.js";
import type { NotificationPayload } from "../src/index.js";
import { clipBytes, headerText } from "../src/channels/kinds/ntfy.js";

const ntfy = KIND_DESCRIPTORS.ntfy;
const at = "2026-10-20T10:00:00.000Z";
const failed: NotificationPayload = { event: "task_failed", level: "error", title: "Failed: build", text: "Failed: build\nexit 1", at };
const spec = (p: NotificationPayload, values: Record<string, string> = {}) => {
  const s = ntfy.format!(p, { server: "https://ntfy.sh", topic: "tidegap-abc", priority: "auto", ...values });
  if (s.type !== "http") throw new Error("not http");
  return s;
};

describe("ntfy", () => {
  it("POSTs the text to <server>/<topic> with Title, Priority and Tags", () => {
    const s = spec(failed);
    expect(s.url).toBe("https://ntfy.sh/tidegap-abc");
    expect(s.body).toBe(failed.text);
    expect(s.headers).toEqual({ "Content-Type": "text/plain; charset=utf-8", Title: "Failed: build", Priority: "4", Tags: "x" });
    expect(spec(failed, { server: "https://push.example.com/ntfy/" }).url).toBe("https://push.example.com/ntfy/tidegap-abc");
  });

  it("priority by event, unless the override field names one", () => {
    const p = (event: NotificationPayload["event"], level: NotificationPayload["level"], priority = "auto") => spec({ ...failed, event, level }, { priority }).headers.Priority;
    expect([p("task_failed", "error"), p("not_ready", "warning"), p("task_done", "success"), p("clean_window", "info"), p("digest", "info"), p("test", "info")]).toEqual(["4", "4", "3", "2", "2", "3"]);
    expect(p("digest", "info", "5")).toBe("5");
  });

  it("a token is a Bearer header; none without one", () => {
    expect(spec(failed, { token: "tk_abc" }).headers.Authorization).toBe("Bearer tk_abc");
    expect(spec(failed).headers.Authorization).toBeUndefined();
  });

  it("a title outside printable ASCII is an RFC 2047 word; a long body is cut under 4,000 bytes", () => {
    expect(headerText("Done: café")).toBe(`=?UTF-8?B?${Buffer.from("Done: café").toString("base64")}?=`);
    expect(headerText("line\nbreak")).toMatch(/^=\?UTF-8\?B\?/);
    const cut = clipBytes("é".repeat(3000), 4000);
    expect(Buffer.byteLength(cut)).toBeLessThanOrEqual(4000);
    expect(cut.endsWith("…")).toBe(true);
  });

  it("the 4,000-byte cap counts bytes, not characters: 3- and 4-byte characters are cut on a character boundary", () => {
    const body = (text: string) => spec({ ...failed, text }).body;
    const bytes = (t: string) => Buffer.byteLength(t, "utf8");
    // 4-byte characters: 1000 fit exactly (no cut), 1001 are cut to 999 characters + "…" = 3999 bytes.
    expect(body("😀".repeat(1000))).toBe("😀".repeat(1000));
    const emoji = body("😀".repeat(1001));
    expect([bytes(emoji), emoji]).toEqual([3999, `${"😀".repeat(999)}…`]);
    // 3-byte characters: 1333 fit (3999 bytes), 1334 are cut to 1332 characters + "…" = 3999 bytes.
    expect(body("€".repeat(1333))).toBe("€".repeat(1333));
    const euro = body("€".repeat(1334));
    expect([bytes(euro), euro]).toEqual([3999, `${"€".repeat(1332)}…`]);
    for (const text of [emoji, euro]) {
      expect(bytes(text)).toBeLessThanOrEqual(4000);
      expect(text).not.toContain("\uFFFD");
      expect(Buffer.from(text, "utf8").toString("utf8")).toBe(text);
    }
  });

  it("429 has its own sentence and no field", () => {
    expect(ntfy.errors!.rate_limited).toEqual({ text: "The ntfy server limits messages. Wait a few minutes, or use an account token or your own server." });
  });

  it("topic rule; server defaults to ntfy.sh; token, topic are secrets", () => {
    expect(validateFields(ntfy, { topic: "my topic" })).toEqual({ ok: false, field: "topic", code: "invalid" });
    expect(validateFields(ntfy, { topic: "x".repeat(65) })).toEqual({ ok: false, field: "topic", code: "invalid" });
    expect(validateFields(ntfy, { topic: "tidegap-abc" })).toEqual({ ok: true, values: { server: "https://ntfy.sh", priority: "auto" }, secrets: { topic: "tidegap-abc" } });
    expect(validateFields(ntfy, { topic: "t", token: "tk with space" })).toMatchObject({ ok: false, field: "token" });
    expect(ntfy.fields.find((f) => f.name === "token")?.keepWith).toBe("server");
  });

  it("target: server host and the topic hint", () => {
    expect(ntfy.target!({ server: "https://ntfy.sh" }, { topic: "…wxyz" })).toBe("ntfy.sh topic …wxyz");
  });

  it("403 asks for a new token", () => {
    expect(ntfy.errors!.auth).toEqual({ field: "token", text: "ntfy refused the access token. Create a new one in your ntfy account." });
  });
});
