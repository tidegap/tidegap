/** Shortcuts kind (integrations plan U12): name rule, macOS only, spec. */

import { describe, expect, it } from "vitest";

import { KIND_DESCRIPTORS, validateFields } from "../src/index.js";
import type { NotificationPayload } from "../src/index.js";

const shortcuts = KIND_DESCRIPTORS.shortcuts;
const done: NotificationPayload = { event: "task_done", level: "success", title: "Done: build", text: "Done: build\n3.1 g", at: "2026-10-20T10:00:00.000Z" };

describe("shortcuts", () => {
  it("macOS only; the spec is the name and the message text", () => {
    expect(shortcuts.platforms).toEqual(["darwin"]);
    expect(shortcuts.format!(done, { name: "Tidegap" })).toEqual({ type: "shortcut", name: "Tidegap", input: done.text });
  });

  it("a name with a newline, one starting with -, an empty one or one over 100 characters is refused", () => {
    expect(validateFields(shortcuts, { name: "Notify me" })).toMatchObject({ ok: true, values: { name: "Notify me" } });
    expect(validateFields(shortcuts, { name: "Ünïcode 🔔 name" }).ok).toBe(true);
    for (const name of ["a\nb", "--help", " -x", "-"]) expect(validateFields(shortcuts, { name })).toMatchObject({ ok: false, field: "name", code: "invalid" });
    expect(validateFields(shortcuts, { name: "" })).toMatchObject({ ok: false, code: "required" });
    expect(validateFields(shortcuts, { name: "x".repeat(101) })).toMatchObject({ ok: false, code: "too_long" });
  });
});
