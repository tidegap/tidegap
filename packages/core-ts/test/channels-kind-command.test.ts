/** Command kind: absolute path, argv lines, the Tidegap JSON on stdin. */

import { describe, expect, it } from "vitest";

import { KIND_DESCRIPTORS, validateFields, webhookBody } from "../src/index.js";
import type { NotificationPayload } from "../src/index.js";
import { commandArgs } from "../src/channels/kinds/command.js";

const command = KIND_DESCRIPTORS.command;
const done: NotificationPayload = { event: "task_done", level: "success", title: "Done: build", text: "Done: build", at: "2026-10-20T10:00:00.000Z" };

describe("command", () => {
  it("the spec carries the path, one argv item per line and the Tidegap JSON v1 as input", () => {
    const spec = command.format!(done, { path: "/usr/local/bin/on-tidegap", args: "--to\n  ops room  \n\n--quiet" });
    expect(spec).toEqual({ type: "command", path: "/usr/local/bin/on-tidegap", args: ["--to", "ops room", "--quiet"], input: webhookBody(done) });
    expect(JSON.parse((spec as { input: string }).input)).toMatchObject({ version: 1, event: "task_done" });
    expect(commandArgs(undefined)).toEqual([]);
  });

  it("the path must be absolute; more than 10 argument lines are refused; not on Windows", () => {
    expect(validateFields(command, { path: "bin/x" })).toMatchObject({ ok: false, field: "path", code: "invalid" });
    expect(validateFields(command, { path: "/bin/echo", args: Array.from({ length: 11 }, (_, i) => `a${i}`).join("\n") })).toMatchObject({ ok: false, field: "args", code: "too_long" });
    expect(validateFields(command, { path: "/bin/echo" }).ok).toBe(true);
    expect(command.platforms).toEqual(["darwin", "linux"]);
  });
});
