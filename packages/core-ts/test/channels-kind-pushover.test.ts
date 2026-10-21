/** Pushover kind (integrations plan U10): fixed API URL, form body, limits, key rule. */

import { describe, expect, it } from "vitest";

import { KIND_DESCRIPTORS, validateFields } from "../src/index.js";
import type { NotificationPayload } from "../src/index.js";

const pushover = KIND_DESCRIPTORS.pushover;
const KEY = "u".repeat(30);
const TOKEN = "a".repeat(30);
const at = "2026-10-20T10:00:00.000Z";
const done: NotificationPayload = { event: "task_done", level: "success", title: "Done: build", text: "Done: build\n3.1 g", at };
const form = (p: NotificationPayload) => {
  const s = pushover.format!(p, { user_key: KEY, app_token: TOKEN });
  if (s.type !== "http") throw new Error("not http");
  return { spec: s, body: new URLSearchParams(s.body) };
};

describe("pushover", () => {
  it("a form POST to api.pushover.net/1/messages.json with token, user, title, message, priority and timestamp", () => {
    const { spec, body } = form(done);
    expect(spec.url).toBe("https://api.pushover.net/1/messages.json");
    expect(spec.headers["Content-Type"]).toBe("application/x-www-form-urlencoded");
    expect(Object.fromEntries(body)).toEqual({ token: TOKEN, user: KEY, title: "Done: build", message: done.text, priority: "0", timestamp: "1792490400" });
    expect(form({ ...done, event: "digest", level: "info" }).body.get("priority")).toBe("-1");
  });

  it("a 2,000-character message is cut to 1,024; a long title to 250", () => {
    const { body } = form({ ...done, title: "t".repeat(400), text: "x".repeat(2000) });
    expect(body.get("message")).toHaveLength(1024);
    expect(body.get("message")!.endsWith("…")).toBe(true);
    expect(body.get("title")).toHaveLength(250);
  });

  it("keys are 30 letters and digits; both are secret and required", () => {
    expect(validateFields(pushover, { user_key: KEY, app_token: TOKEN })).toEqual({ ok: true, values: {}, secrets: { user_key: KEY, app_token: TOKEN } });
    expect(validateFields(pushover, { user_key: "short", app_token: TOKEN })).toEqual({ ok: false, field: "user_key", code: "invalid" });
    expect(validateFields(pushover, { user_key: KEY, app_token: `${TOKEN.slice(1)}-` })).toEqual({ ok: false, field: "app_token", code: "invalid" });
    expect(validateFields(pushover, { user_key: KEY })).toEqual({ ok: false, field: "app_token", code: "required" });
  });

  it("errors map user and token refusals to their fields; the target is the user key hint", () => {
    expect(pushover.errors?.pushover_user?.field).toBe("user_key");
    expect(pushover.errors?.pushover_token?.field).toBe("app_token");
    expect(pushover.target?.({}, { user_key: "…uuuu" })).toBe("user …uuuu");
  });
});
