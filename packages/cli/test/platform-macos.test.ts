import { describe, expect, it } from "vitest";
import {
  detectInstallMode,
  formatPmsetDate,
  loadLaunchAgent,
  launchdPlist,
  pmsetCommand,
} from "../src/platform/macos.js";

describe("formatPmsetDate", () => {
  it("pads single-digit components and uses MM/dd/yy HH:mm:ss", () => {
    expect(formatPmsetDate(new Date("2026-05-13T03:07:09Z"))).toMatch(
      /^\d{2}\/\d{2}\/26 \d{2}:\d{2}:\d{2}$/,
    );
  });

  it("is stable for a fixed UTC input in any local timezone", () => {
    const d = new Date(2026, 4, 13, 3, 7, 9);
    expect(formatPmsetDate(d)).toBe("05/13/26 03:07:09");
  });
});

describe("pmsetCommand", () => {
  it("builds the exact shell-quoted command", () => {
    const d = new Date(2026, 4, 13, 3, 7, 9);
    expect(pmsetCommand(d)).toBe('pmset schedule wake "05/13/26 03:07:09"');
  });
});

describe("launchdPlist", () => {
  it("renders a complete plist for laptop install", () => {
    const xml = launchdPlist({
      tickIntervalSec: 300,
      ebbBinaryPath: "/usr/local/bin/tidegap",
      dbPath: "/Users/test/.tidegap/queue.sqlite",
      logPath: "/Users/test/.tidegap/tick.log",
    });
    expect(xml).toContain("<key>Label</key>");
    expect(xml).toContain("<string>com.tidegap.tick</string>");
    expect(xml).toContain("<string>/usr/local/bin/tidegap</string>");
    expect(xml).toContain("<string>tick</string>");
    expect(xml).toContain("<string>--once</string>");
    expect(xml).toContain("<integer>300</integer>");
    expect(xml).toContain("<true/>");
    expect(xml).toContain("/Users/test/.tidegap/queue.sqlite");
    expect(xml).toContain("/Users/test/.tidegap/tick.log");
  });

  it("XML-escapes paths that contain & < > characters", () => {
    const xml = launchdPlist({
      tickIntervalSec: 60,
      ebbBinaryPath: "/usr/bin/tidegap",
      dbPath: "/tmp/a&b/<x>/queue.sqlite",
    });
    expect(xml).toContain("a&amp;b");
    expect(xml).toContain("&lt;x&gt;");
    expect(xml).not.toContain("<x>");
    expect(xml).not.toContain("a&b/");
  });

  it("emits an EnvironmentVariables block when env is supplied", () => {
    const xml = launchdPlist({
      tickIntervalSec: 60,
      ebbBinaryPath: "/usr/bin/tidegap",
      dbPath: "/tmp/q.sqlite",
      env: { ANTHROPIC_API_KEY: "sk-test", FOO: "bar" },
    });
    expect(xml).toContain("<key>EnvironmentVariables</key>");
    expect(xml).toContain("<key>ANTHROPIC_API_KEY</key>");
    expect(xml).toContain("<string>sk-test</string>");
    expect(xml).toContain("<key>FOO</key>");
  });

  it("omits EnvironmentVariables when env is not supplied", () => {
    const xml = launchdPlist({
      tickIntervalSec: 60,
      ebbBinaryPath: "/usr/bin/tidegap",
      dbPath: "/tmp/q.sqlite",
    });
    expect(xml).not.toContain("<key>EnvironmentVariables</key>");
  });

  it("clamps tickIntervalSec to at least 1 second", () => {
    const xml = launchdPlist({
      tickIntervalSec: 0,
      ebbBinaryPath: "/usr/bin/tidegap",
      dbPath: "/tmp/q.sqlite",
    });
    expect(xml).toContain("<integer>1</integer>");
  });
});

describe("detectInstallMode (macOS)", () => {
  const out = (stdout: string, status: number | null = 0) => () => ({ status, stdout, stderr: "" });
  it("an InternalBattery line means laptop", () => {
    expect(detectInstallMode(out("Now drawing from 'Battery Power'\n -InternalBattery-0 (id=4653155)\t80%"))).toEqual({
      mode: "laptop",
      reason: "this Mac has a battery",
    });
  });
  it("no battery means server", () => {
    expect(detectInstallMode(out("Now drawing from 'AC Power'")).mode).toBe("server");
  });
  it("pmset that cannot run means server", () => {
    expect(detectInstallMode(out("", null))).toEqual({ mode: "server", reason: "could not read the battery state (pmset)" });
  });
});

describe("loadLaunchAgent", () => {
  const unit = { kind: "launchd" as const, label: "com.tidegap.tick", plistPath: "/h/a.plist", uid: 501, changed: true, busy: false };
  function exec(loaded: boolean, calls: string[]) {
    return (cmd: string, args: string[]) => {
      calls.push([cmd, ...args].join(" "));
      if (args[0] === "print") return { status: loaded ? 0 : 113, stdout: "", stderr: "" };
      if (args[0] === "bootout" && !loaded) return { status: 3, stderr: "No such process", stdout: "" };
      return { status: 0, stdout: "", stderr: "" };
    };
  }
  it("not loaded: bootout (its error ignored), then bootstrap", () => {
    const calls: string[] = [];
    const r = loadLaunchAgent(unit, exec(false, calls));
    expect(r).toMatchObject({ ok: true, action: "loaded" });
    expect(calls).toEqual([
      "launchctl print gui/501/com.tidegap.tick",
      "launchctl bootout gui/501/com.tidegap.tick",
      "launchctl bootstrap gui/501 /h/a.plist",
    ]);
  });
  it("loaded and unchanged: nothing", () => {
    const calls: string[] = [];
    expect(loadLaunchAgent({ ...unit, changed: false }, exec(true, calls)).action).toBe("unchanged");
    expect(calls).toHaveLength(1);
  });
  it("loaded, changed and busy: deferred with the manual command", () => {
    const calls: string[] = [];
    const r = loadLaunchAgent({ ...unit, busy: true }, exec(true, calls));
    expect(r.action).toBe("deferred");
    expect(r.manual).toBe("launchctl bootout gui/501/com.tidegap.tick; launchctl bootstrap gui/501 /h/a.plist");
    expect(calls).toHaveLength(1);
  });
});
