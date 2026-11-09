import { describe, expect, it } from "vitest";

import {
  firstErrorLine,
  osNotifyCommand,
  taskNotificationContent,
  WIN_NOTIFY_BODY_VAR,
  WIN_NOTIFY_TITLE_VAR,
} from "../src/index.js";

describe("osNotifyCommand", () => {
  const title = "Tidegap: done: summarize";
  const body = 'line "one"\n42 gCO2e';

  it("darwin passes the text to a fixed AppleScript as argv after --", () => {
    const hostile = '-e "x" & do shell script "id"';
    const mac = osNotifyCommand("darwin", hostile, body)!;
    expect(mac.cmd).toBe("osascript");
    expect(mac.args.slice(-3)).toEqual(["--", hostile, body]);
    const script = mac.args.slice(0, -3).join("\n");
    expect(script).toContain("item 1 of argv");
    expect(script).not.toContain("do shell script");
    expect(script).not.toContain("one");
    expect(mac.env).toBeUndefined();
  });

  it("linux uses notify-send with -- before the title and escapes body markup", () => {
    const linux = osNotifyCommand("linux", "-u critical", '<a href="x">y</a> & z')!;
    expect(linux.cmd).toBe("notify-send");
    expect(linux.args).toEqual(["--", "-u critical", '&lt;a href="x"&gt;y&lt;/a&gt; &amp; z']);
  });

  it("win32 keeps hostile text out of the script and passes it through env", () => {
    const hostileTitle = "it's ’quoted’ ‘x’";
    const hostileBody = "'; Remove-Item x; '";
    const win = osNotifyCommand("win32", hostileTitle, hostileBody)!;
    expect(win.cmd).toBe("powershell");
    const script = win.args[win.args.length - 1]!;
    expect(script).toContain("ToastNotification");
    expect(script).toContain(`$env:${WIN_NOTIFY_TITLE_VAR}`);
    expect(script).not.toContain("Remove-Item");
    expect(script).not.toContain("’");
    expect(script).not.toContain("it's");
    expect(win.env).toEqual({
      [WIN_NOTIFY_TITLE_VAR]: hostileTitle,
      [WIN_NOTIFY_BODY_VAR]: hostileBody,
    });
  });

  it("win32 base64 mode embeds only base64 literals and sets no env", () => {
    const win = osNotifyCommand("win32", "it’s", "'; Remove-Item x; '", { windowsText: "base64" })!;
    const script = win.args[win.args.length - 1]!;
    expect(win.env).toBeUndefined();
    expect(script).not.toContain("Remove-Item");
    expect(script).not.toContain("’");
    const literals = [...script.matchAll(/FromBase64String\('([^']*)'\)/g)].map((m) => m[1]!);
    expect(literals.map((l) => Buffer.from(l, "base64").toString("utf8"))).toEqual([
      "it’s",
      "'; Remove-Item x; '",
    ]);
    for (const l of literals) expect(l).toMatch(/^[A-Za-z0-9+/=]*$/);
  });

  it("returns null on an unsupported platform", () => {
    expect(osNotifyCommand("aix" as NodeJS.Platform, title, body)).toBeNull();
  });
});

describe("taskNotificationContent", () => {
  it("completed: title, redacted one-line preview, grams, show command", () => {
    const { title, body } = taskNotificationContent({
      taskId: "t-1",
      status: "completed",
      title: "Summarize\u001b[31m report",
      result: { text: `key sk-ant-${"a".repeat(30)}\n${"x".repeat(300)}` },
      receipt: { actualCarbonGCo2: 1.5 } as never,
    });
    expect(title).toBe("Tidegap: done: Summarize[31m report");
    expect(body).not.toContain("sk-ant-");
    expect(body).toContain("[REDACTED]");
    expect(body).toContain("…");
    expect(body).toContain("1.5 gCO2e");
    expect(body).toContain("tidegap queue show t-1");
    expect(body.split("\n")).toHaveLength(2);
  });

  it("failed: says failed and shows the first error line; falls back to the id", () => {
    const { title, body } = taskNotificationContent({
      taskId: "t-2",
      status: "failed",
      error: "\nrate limited\nstack...",
    });
    expect(title).toBe("Tidegap: failed: t-2");
    expect(body).toBe("rate limited\ntidegap queue show t-2");
  });

  it("failed with an empty error: says unknown error", () => {
    for (const error of [undefined, "", " \n\t\n"]) {
      expect(taskNotificationContent({ taskId: "t-3", status: "failed", error }).body).toBe("unknown error\ntidegap queue show t-3");
    }
  });
});

describe("firstErrorLine", () => {
  it("is the first non-empty line, made one line", () => {
    expect(firstErrorLine("\n  stopped: command time limit 5 min  \nstderr tail")).toBe("stopped: command time limit 5 min");
    expect(firstErrorLine("a\tb   c\r\nnext")).toBe("a b c");
  });

  it("cuts a long line to 140 characters with an ellipsis, as the failure notice does", () => {
    const line = firstErrorLine(`${"x".repeat(300)}\nmore`);
    expect(line).toBe(`${"x".repeat(140)}…`);
    expect(taskNotificationContent({ taskId: "t-4", status: "failed", error: `${"x".repeat(300)}\nmore` }).body.split("\n")[0]).toBe(line);
  });

  it("redacts a secret", () => {
    expect(firstErrorLine(`401 for key sk-ant-${"a".repeat(30)}`)).not.toContain("sk-ant-");
  });

  it("is undefined for an empty error", () => {
    for (const error of [undefined, "", "  ", "\n\n"]) expect(firstErrorLine(error)).toBeUndefined();
  });

  it("skips a line of only control characters (AE3)", () => {
    expect(firstErrorLine("\u0007\u0007\nclaude-code: limit reached")).toBe("claude-code: limit reached");
    expect(taskNotificationContent({ taskId: "t-5", status: "failed", error: "\u0007\u0007\nclaude-code: limit reached" }).body).toBe("claude-code: limit reached\ntidegap queue show t-5");
  });

  it("is undefined, and the notice says unknown error, when no line has visible text", () => {
    expect(firstErrorLine("\u0007\n\u001b\u0000\n")).toBeUndefined();
    expect(taskNotificationContent({ taskId: "t-6", status: "failed", error: "\u0007\n\u001b" }).body).toBe("unknown error\ntidegap queue show t-6");
  });

  it("takes its own cut", () => {
    expect(firstErrorLine(`${"y".repeat(250)}`, 200)).toBe(`${"y".repeat(200)}…`);
  });
});
