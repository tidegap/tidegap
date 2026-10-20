/** Slack kind (integrations plan U7): body, escaping, fixed host. */

import { describe, expect, it } from "vitest";

import { KIND_DESCRIPTORS, validateFields } from "../src/index.js";
import type { NotificationPayload } from "../src/index.js";

const slack = KIND_DESCRIPTORS.slack;
const payload: NotificationPayload = { event: "task_done", level: "success", title: "Done: <script> & co", text: "Done: <script> & co <!channel>", at: "2026-10-20T10:00:00.000Z" };

describe("slack", () => {
  it("text plus one mrkdwn section, &<> escaped in both", () => {
    const spec = slack.format!(payload, { url: "https://hooks.slack.com/services/T0/B0/x" });
    if (spec.type !== "http") throw new Error("not http");
    const b = JSON.parse(spec.body);
    expect(b.text).toBe("Done: &lt;script&gt; &amp; co &lt;!channel&gt;");
    expect(b.blocks).toEqual([{ type: "section", text: { type: "mrkdwn", text: `*Done: &lt;script&gt; &amp; co*\n${b.text}` } }]);
  });

  it("a long text fits Slack's 3,000-character section", () => {
    const spec = slack.format!({ ...payload, text: "a".repeat(5000) }, { url: "https://hooks.slack.com/services/T0/B0/x" });
    const b = JSON.parse(spec.type === "http" ? spec.body : "{}");
    expect(b.blocks[0].text.text).toHaveLength(3000);
    expect(b.blocks[0].text.text.endsWith("…")).toBe(true);
  });

  it("only hooks.slack.com/services or a loopback test sink", () => {
    const ok = (url: string) => validateFields(slack, { url }).ok;
    expect(ok("https://hooks.slack.com/services/T0/B0/abc")).toBe(true);
    expect(ok("http://127.0.0.1:4100/services/x")).toBe(true);
    expect(validateFields(slack, { url: "https://hooks.slack.com.evil.com/x" })).toEqual({ ok: false, field: "url", code: "invalid" });
    expect(ok("http://hooks.slack.com/services/T0/B0/abc")).toBe(false);
    expect(ok("https://hooks.slack.com/workflows/T0/A0/1/x")).toBe(false);
    expect(slack.fields[0]!.invalid).toMatch(/hooks\.slack\.com\/services/);
  });

  it("maps Slack's answers to sentences", () => {
    expect(slack.errors!.http_404!.text).toBe("Slack removed this webhook. Add a new one in your Slack app and paste it here.");
    expect(slack.errors!.auth!.field).toBe("url");
  });
});
