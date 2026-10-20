/** The channels listener unit and the `tidegap channels` registration (coherence U15). */

import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createInstallListener } from "../src/channels/telegram-setup.js";
import { channelsLine } from "../src/commands/status.js";
import { buildProgram } from "../src/index.js";
import { listenerUnitStatus, type ExecResult } from "../src/platform/index.js";

function fakeExec(reply: (cmd: string, args: string[]) => Partial<ExecResult> = () => ({})) {
  const calls: string[] = [];
  const exec = (cmd: string, args: string[]): ExecResult => {
    calls.push([cmd, ...args].join(" "));
    return { status: 0, stdout: "", stderr: "", ...reply(cmd, args) };
  };
  return { exec, calls };
}

describe("createInstallListener", () => {
  let home: string;
  const launcher = ["/usr/bin/node", "/opt/tidegap/index.js"];
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "tidegap-channels-unit-"));
  });
  afterEach(() => rmSync(home, { recursive: true, force: true }));

  it("macOS: load writes the KeepAlive plist and bootstraps it; unload boots it out and removes it", async () => {
    // Not loaded yet: `launchctl print` fails.
    const { exec, calls } = fakeExec((_cmd, args) => (args[0] === "print" ? { status: 113 } : {}));
    const out: string[] = [];
    const hook = createInstallListener({ platform: "darwin", home, exec, uid: 501, launcher, dbPath: "/q.db", out: (l) => out.push(l) });
    await hook("load");
    const plist = join(home, "Library", "LaunchAgents", "com.tidegap.channels.plist");
    const xml = readFileSync(plist, "utf8");
    expect(xml).toContain("<key>KeepAlive</key>");
    expect(xml).toContain("<string>serve</string>");
    expect(calls).toContain(`launchctl bootstrap gui/501 ${plist}`);
    expect(out[0]).toContain("Loaded com.tidegap.channels");
    expect(listenerUnitStatus("darwin", home)).toBe("installed");

    const loaded = fakeExec();
    await createInstallListener({ platform: "darwin", home, exec: loaded.exec, uid: 501, out: () => {} })("unload");
    expect(loaded.calls).toEqual(["launchctl print gui/501/com.tidegap.channels", "launchctl bootout gui/501/com.tidegap.channels"]);
    expect(existsSync(plist)).toBe(false);
  });

  it("macOS: an unchanged, loaded plist is left alone", async () => {
    const first = fakeExec((_cmd, args) => (args[0] === "print" ? { status: 113 } : {}));
    await createInstallListener({ platform: "darwin", home, exec: first.exec, uid: 501, launcher, dbPath: "/q.db", out: () => {} })("load");
    const again = fakeExec();
    await createInstallListener({ platform: "darwin", home, exec: again.exec, uid: 501, launcher, dbPath: "/q.db", out: () => {} })("load");
    expect(again.calls).toEqual(["launchctl print gui/501/com.tidegap.channels"]);
  });

  it("Linux: load writes tidegap-channels.service and enables it; unload disables it", async () => {
    const { exec, calls } = fakeExec((_cmd, args) => (args[1] === "is-active" ? { status: 3 } : {}));
    await createInstallListener({ platform: "linux", home, exec, launcher, dbPath: "/q.db", out: () => {} })("load");
    const unit = join(home, ".config", "systemd", "user", "tidegap-channels.service");
    expect(readFileSync(unit, "utf8")).toContain("channels serve --db /q.db");
    expect(calls).toEqual([
      "systemctl --user is-active tidegap-channels.service",
      "systemctl --user daemon-reload",
      "systemctl --user enable --now tidegap-channels.service",
    ]);
    const off = fakeExec();
    await createInstallListener({ platform: "linux", home, exec: off.exec, out: () => {} })("unload");
    expect(off.calls).toEqual(["systemctl --user disable --now tidegap-channels.service"]);
    expect(existsSync(unit)).toBe(false);
  });

  it("Windows: load prints the serve command and runs nothing", async () => {
    const { exec, calls } = fakeExec();
    const out: string[] = [];
    await createInstallListener({ platform: "win32", home, exec, launcher, out: (l) => out.push(l) })("load");
    expect(calls).toEqual([]);
    expect(out[0]).toContain("tidegap channels serve");
  });
});

describe("tidegap channels registration", () => {
  it("lists add, connect, disconnect, kinds, list, remove, serve, set and test", () => {
    const channels = buildProgram().commands.find((c) => c.name() === "channels");
    expect(channels?.commands.map((c) => c.name()).sort()).toEqual(["add", "connect", "disconnect", "kinds", "list", "remove", "serve", "set", "test"]);
    const add = channels!.commands.find((c) => c.name() === "add")!;
    expect(add.options.map((o) => o.long)).toContain("--no-load");
    const serve = channels!.commands.find((c) => c.name() === "serve")!;
    expect(serve.options.map((o) => o.long)).toEqual(expect.arrayContaining(["--once", "--db"]));
    const list = channels!.commands.find((c) => c.name() === "list")!;
    expect(list.options.map((o) => o.long)).toContain("--json");
  });
});

describe("tidegap status channels line", () => {
  it("is absent with no channel and no unit, and names the listener otherwise", () => {
    expect(channelsLine(0, "not_installed")).toBeNull();
    expect(channelsLine(1, "installed")).toBe("Channels:   telegram 1 paired; listener unit installed");
    expect(channelsLine(1, "not_installed")).toContain("listener unit not installed");
  });
});
