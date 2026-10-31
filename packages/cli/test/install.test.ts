import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AGENTS_BLOCK, TaskStore } from "@tidegap/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runInstall, type InstallOptions } from "../src/commands/install.js";
import type { ExecResult, PlatformExec } from "../src/platform/index.js";

// A test launcher that stands in for `[process.execPath, realpath(argv1)]`.
const LAUNCHER = ["/usr/bin/node", "/opt/tidegap/dist/index.js"];

describe("tidegap install (macOS, dry-run)", () => {
  it("produces a plist + helper script for --laptop", async () => {
    const r = await runInstall({
      mode: "laptop",
      platform: "macos",
      launcher: LAUNCHER,
      dbPath: "/Users/test/.tidegap/queue.sqlite",
      tickIntervalSec: 300,
      dryRun: true,
    });
    expect(r.platform).toBe("macos");
    expect(r.plistPath).toContain("Library/LaunchAgents/com.tidegap.tick.plist");
    expect(r.plistContent).toContain("<key>StartInterval</key>");
    expect(r.helperPath).toContain(".tidegap/laptop-wake.sh");
    expect(r.helperContent).toContain("register-wake");
    expect(r.nextSteps).not.toContain("launchctl load");
    expect(r.load).toBeNull();
  });

  it("pins the exact node interpreter + resolved script in ProgramArguments", async () => {
    const r = await runInstall({
      mode: "server",
      platform: "macos",
      launcher: LAUNCHER,
      dbPath: "/Users/test/.tidegap/queue.sqlite",
      dryRun: true,
    });
    // Both launcher elements appear as separate <string> tokens, before `tick`.
    expect(r.plistContent).toContain("<string>/usr/bin/node</string>");
    expect(r.plistContent).toContain("<string>/opt/tidegap/dist/index.js</string>");
    expect(r.plistContent).toContain("<string>tick</string>");
    expect(r.plistContent).toContain("<string>--once</string>");
    // The old hardcoded fallback must be gone.
    expect(r.plistContent).not.toContain("/usr/local/bin/tidegap");
    expect(r.launcher).toEqual(LAUNCHER);
  });

  it("resolves process.execPath + realpath(argv1) when no launcher override", async () => {
    const r = await runInstall({
      mode: "server",
      platform: "macos",
      dbPath: "/Users/test/.tidegap/queue.sqlite",
      dryRun: true,
    });
    // First element is the real node binary.
    expect(r.launcher[0]).toBe(process.execPath);
    expect(r.launcher.length).toBeGreaterThanOrEqual(1);
    expect(r.plistContent).toContain(`<string>${process.execPath}</string>`);
  });

  it("omits the wake helper for --server", async () => {
    const r = await runInstall({
      mode: "server",
      platform: "macos",
      launcher: LAUNCHER,
      dbPath: "/srv/.tidegap/queue.sqlite",
      dryRun: true,
    });
    expect(r.helperPath).toBe("");
    expect(r.helperContent).toBe("");
    expect(r.nextSteps).not.toContain("register-wake");
  });

  it("mentions the ~/.config/tidegap/env secrets path in next-steps", async () => {
    const r = await runInstall({
      mode: "server",
      platform: "macos",
      launcher: LAUNCHER,
      dbPath: "/srv/.tidegap/queue.sqlite",
      dryRun: true,
    });
    expect(r.envFilePath).toContain(".config/tidegap/env");
    expect(r.nextSteps).toContain(".config/tidegap/env");
    expect(r.nextSteps).toContain("ANTHROPIC_API_KEY");
  });
});

describe("tidegap install (linux, dry-run)", () => {
  it("produces a service + timer + helper for --laptop", async () => {
    const r = await runInstall({
      mode: "laptop",
      platform: "linux",
      launcher: LAUNCHER,
      dbPath: "/var/lib/tidegap/queue.sqlite",
      tickIntervalSec: 300,
      dryRun: true,
    });
    expect(r.platform).toBe("linux");
    expect(r.plistContent).toBe("");
    expect(r.servicePath).toContain(".config/systemd/user/tidegap-tick.service");
    expect(r.timerPath).toContain(".config/systemd/user/tidegap-tick.timer");
    expect(r.serviceContent).toContain(
      "ExecStart=/usr/bin/node /opt/tidegap/dist/index.js tick --db /var/lib/tidegap/queue.sqlite --once",
    );
    expect(r.serviceContent).not.toContain("/usr/local/bin/tidegap");
    expect(r.serviceContent).toContain("EnvironmentFile=-%h/.config/tidegap/env");
    expect(r.timerContent).toContain("OnUnitActiveSec=300s");
    expect(r.helperPath).toContain(".tidegap/laptop-wake.sh");
    expect(r.helperContent).toContain("register-wake");
    expect(r.nextSteps).toContain(
      "systemctl --user daemon-reload && systemctl --user enable --now tidegap-tick.timer",
    );
  });

  it("omits the wake helper for --server", async () => {
    const r = await runInstall({
      mode: "server",
      platform: "linux",
      launcher: LAUNCHER,
      dbPath: "/srv/.tidegap/queue.sqlite",
      dryRun: true,
    });
    expect(r.helperPath).toBe("");
    expect(r.helperContent).toBe("");
    expect(r.nextSteps).not.toContain("register-wake");
    expect(r.serviceContent).toContain("ExecStart=");
  });
});

describe("tidegap install (windows = template only)", () => {
  it("returns an honest schtasks template built from the launcher", async () => {
    const r = await runInstall({
      mode: "server",
      platform: "windows",
      launcher: ["C:\\Program Files\\nodejs\\node.exe", "C:\\tidegap\\index.js"],
      dbPath: "C:\\ProgramData\\tidegap\\queue.sqlite",
      dryRun: true,
    });
    expect(r.plistContent).toBe("");
    expect(r.nextSteps.toLowerCase()).toContain("schtasks");
    expect(r.nextSteps.toLowerCase()).toContain("not supported");
    // No leftover POSIX path, no "planned for v0.5".
    expect(r.nextSteps).not.toContain("/usr/local/bin/tidegap");
    expect(r.nextSteps).not.toContain("v0.5");
    expect(r.nextSteps).toContain("index.js");
  });
});

describe("tidegap install laptop helper script", () => {
  it("skips the header AND the separator row (tail -n +3, not +2)", async () => {
    const r = await runInstall({
      mode: "laptop",
      platform: "macos",
      launcher: LAUNCHER,
      dbPath: "/Users/test/.tidegap/queue.sqlite",
      dryRun: true,
    });
    // Regression: the old script used `tail -n +2`, feeding the table
    // separator row in as a bogus task id.
    expect(r.helperContent).toContain("tail -n +3");
    expect(r.helperContent).not.toContain("tail -n +2");
  });

  it("passes --db to BOTH queue list and register-wake", async () => {
    const r = await runInstall({
      mode: "laptop",
      platform: "linux",
      launcher: LAUNCHER,
      dbPath: "/custom/path/queue.db",
      dryRun: true,
    });
    // The custom db path is bound to $DB and threaded through both invocations.
    expect(r.helperContent).toContain(`DB='/custom/path/queue.db'`);
    expect(r.helperContent).toContain(`queue list --db "$DB"`);
    expect(r.helperContent).toContain(`register-wake --db "$DB"`);
  });

  it("shell-quotes each launcher token into a TIDEGAP array", async () => {
    const r = await runInstall({
      mode: "laptop",
      platform: "macos",
      launcher: LAUNCHER,
      dbPath: "/Users/test/.tidegap/queue.sqlite",
      dryRun: true,
    });
    expect(r.helperContent).toContain(`TIDEGAP=('/usr/bin/node' '/opt/tidegap/dist/index.js')`);
    expect(r.helperContent).toContain(`"\${TIDEGAP[@]}"`);
  });
});

describe("tidegap install through the @ebb-ai/cli shim", () => {
  it("warns that the unit would pin a script inside @ebb-ai/cli", async () => {
    const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = await import("node:fs");
    const { join } = await import("node:path");
    const { tmpdir } = await import("node:os");
    const { resolveLauncher } = await import("../src/commands/install.js");
    const root = mkdtempSync(join(tmpdir(), "tidegap-shim-"));
    const entry = join(root, "node_modules", "@ebb-ai", "cli", "node_modules", "@tidegap", "cli", "dist", "index.js");
    mkdirSync(join(entry, ".."), { recursive: true });
    writeFileSync(entry, "");
    const saved = process.argv[1]!;
    process.argv[1] = entry;
    try {
      const warnings: string[] = [];
      resolveLauncher(undefined, warnings);
      expect(warnings.some((w) => w.includes("@ebb-ai/cli") && w.includes("npm install -g @tidegap/cli"))).toBe(true);
    } finally {
      process.argv[1] = saved;
      rmSync(root, { recursive: true, force: true });
    }
  });
});

/** A fake `pmset` / `launchctl` / `systemctl`: records calls, answers from `reply`. */
function fakeExec(reply: (cmd: string, args: string[]) => Partial<ExecResult> = () => ({})): {
  exec: PlatformExec;
  calls: string[];
} {
  const calls: string[] = [];
  return {
    calls,
    exec: (cmd, args) => {
      calls.push([cmd, ...args].join(" "));
      return { status: 0, stdout: "", stderr: "", ...reply(cmd, args) };
    },
  };
}

/** launchctl that reports the agent as not loaded until it is bootstrapped. */
function launchd(opts: { loaded?: boolean; battery?: boolean; bootstrapFails?: string } = {}) {
  let loaded = opts.loaded ?? false;
  return fakeExec((cmd, args) => {
    if (cmd === "pmset") {
      return { stdout: opts.battery ? " -InternalBattery-0 (id=1)\t87%; charging" : "Now drawing from 'AC Power'" };
    }
    if (cmd === "launchctl" && args[0] === "print") return { status: loaded ? 0 : 113 };
    if (cmd === "launchctl" && args[0] === "bootout") {
      if (!loaded) return { status: 3, stderr: "Boot-out failed: 3: No such process" };
      loaded = false;
      return {};
    }
    if (cmd === "launchctl" && args[0] === "bootstrap") {
      if (opts.bootstrapFails) return { status: 5, stderr: opts.bootstrapFails };
      loaded = true;
      return {};
    }
    return {};
  });
}

describe("tidegap install: default mode and load", () => {
  let home: string;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "tidegap-install-"));
  });
  afterEach(() => rmSync(home, { recursive: true, force: true }));

  const base = (extra: Partial<InstallOptions> = {}): InstallOptions => ({
    platform: "macos",
    launcher: LAUNCHER,
    home,
    dbPath: join(home, ".tidegap", "queue.db"),
    uid: 501,
    ...extra,
  });
  const plist = () => join(home, "Library", "LaunchAgents", "com.tidegap.tick.plist");

  it("picks --laptop on a Mac with a battery and says why", async () => {
    const { exec } = launchd({ battery: true });
    const r = await runInstall(base({ exec }));
    expect(r.mode).toBe("laptop");
    expect(r.nextSteps).toContain("Picked --laptop: this Mac has a battery.");
    expect(r.helperPath).not.toBe("");
  });

  it("picks --server on a desktop Mac", async () => {
    const { exec } = launchd({ battery: false });
    const r = await runInstall(base({ exec }));
    expect(r.mode).toBe("server");
    expect(r.nextSteps).toContain("Picked --server: this Mac has no battery.");
  });

  it("picks --server on Linux", async () => {
    const { exec, calls } = fakeExec((cmd, args) => (args[1] === "is-active" ? { status: 3 } : {}));
    const r = await runInstall(base({ platform: "linux", exec }));
    expect(r.mode).toBe("server");
    expect(r.nextSteps).toContain("Picked --server: this machine is not a Mac.");
    expect(calls).not.toContain("pmset -g batt");
  });

  it("an explicit flag skips the battery probe", async () => {
    const { exec, calls } = launchd({ battery: true });
    const r = await runInstall(base({ mode: "server", exec }));
    expect(r.mode).toBe("server");
    expect(r.nextSteps).not.toContain("Picked");
    expect(calls.some((c) => c.startsWith("pmset"))).toBe(false);
  });

  it("boots out then bootstraps into gui/<uid>, ignoring 'not loaded', and ends with status lines", async () => {
    const { exec, calls } = launchd();
    const r = await runInstall(base({ mode: "server", exec }));
    expect(r.exitCode).toBe(0);
    const boot = calls.filter((c) => c.startsWith("launchctl bootout") || c.startsWith("launchctl bootstrap"));
    expect(boot).toEqual(["launchctl bootout gui/501/com.tidegap.tick", `launchctl bootstrap gui/501 ${plist()}`]);
    expect(r.nextSteps).toContain("Loaded com.tidegap.tick");
    expect(r.nextSteps).not.toContain("launchctl load");
    // Loaded and never ticked: a fresh install is not a warning.
    expect(r.nextSteps).toContain("Daemon:     installed and loaded");
    expect(r.nextSteps).not.toContain("Tasks will not run");
    // The status lines come last before the agent block (R36).
    const status = r.nextSteps.slice(0, r.nextSteps.indexOf("Make your agent prefer Tidegap"));
    expect(status.trimEnd().split("\n").at(-1)).toMatch(/^Tasks will run\.$/);
  });

  it("leaves an agent loaded with a byte-identical plist alone", async () => {
    await runInstall(base({ mode: "server", load: false }));
    const { exec, calls } = launchd({ loaded: true });
    const r = await runInstall(base({ mode: "server", exec }));
    expect(calls.some((c) => c.includes("bootout"))).toBe(false);
    expect(r.load?.action).toBe("unchanged");
  });

  it("does not reload a changed plist while a task is running and prints the manual command", async () => {
    mkdirSync(join(home, "Library", "LaunchAgents"), { recursive: true });
    writeFileSync(plist(), "<old/>");
    mkdirSync(join(home, ".tidegap"), { recursive: true });
    const store = new TaskStore({ dbPath: join(home, ".tidegap", "queue.db") });
    store.upsert({ taskId: "t-run", status: "running", enqueuedAt: new Date().toISOString(), region: "DE" });
    store.close();
    const { exec, calls } = launchd({ loaded: true });
    const r = await runInstall(base({ mode: "server", exec }));
    expect(calls.some((c) => c.includes("bootout"))).toBe(false);
    expect(r.load?.action).toBe("deferred");
    expect(r.nextSteps).toContain(`launchctl bootout gui/501/com.tidegap.tick; launchctl bootstrap gui/501 ${plist()}`);
    // The plist on disk is now current, but launchd still runs the old one: the next install reloads.
    const store2 = new TaskStore({ dbPath: join(home, ".tidegap", "queue.db") });
    store2.upsert({ taskId: "t-run", status: "completed", enqueuedAt: new Date().toISOString(), region: "DE" });
    store2.close();
    const next = launchd({ loaded: true });
    const again = await runInstall(base({ mode: "server", exec: next.exec }));
    expect(again.load?.action).toBe("loaded");
    expect(next.calls.some((c) => c.startsWith("launchctl bootstrap"))).toBe(true);
    const third = launchd({ loaded: true });
    expect((await runInstall(base({ mode: "server", exec: third.exec }))).load?.action).toBe("unchanged");
  });

  it("exits 1 with the launchctl error and the manual command when bootstrap fails", async () => {
    const { exec } = launchd({ bootstrapFails: "Bootstrap failed: 5: Input/output error" });
    const r = await runInstall(base({ mode: "server", exec }));
    expect(r.exitCode).toBe(1);
    expect(r.nextSteps).toContain("Bootstrap failed: 5: Input/output error");
    expect(r.nextSteps).toContain(`launchctl bootstrap gui/501 ${plist()}`);
  });

  it("--no-load writes the plist and runs no launchctl command", async () => {
    const { exec, calls } = launchd();
    const r = await runInstall(base({ mode: "server", load: false, exec }));
    expect(existsSync(plist())).toBe(true);
    expect(calls.filter((c) => c.startsWith("launchctl") && !c.startsWith("launchctl print"))).toEqual([]);
    expect(r.load).toBeNull();
    expect(r.nextSteps).toContain("Not loaded (--no-load)");
  });

  it("Linux runs daemon-reload then enable --now tidegap-tick.timer", async () => {
    const { exec, calls } = fakeExec((cmd, args) => (args[1] === "is-active" && calls.length < 2 ? { status: 3 } : {}));
    const r = await runInstall(base({ platform: "linux", mode: "server", exec }));
    expect(r.exitCode).toBe(0);
    const sys = calls.filter((c) => c.startsWith("systemctl") && !c.includes("is-active"));
    expect(sys).toEqual(["systemctl --user daemon-reload", "systemctl --user enable --now tidegap-tick.timer"]);
    expect(r.nextSteps).toContain("Enabled tidegap-tick.timer");
  });

  const HOST_LINE = "For a host's own files: tidegap jobs snippet --host <generic|claude|opencode|codex|cursor|gemini>";

  it("ends a real install with the agent block on macOS, Linux and the Windows fallback (R36)", async () => {
    const mac = await runInstall(base({ mode: "server", exec: launchd().exec }));
    const linux = await runInstall(base({ platform: "linux", mode: "server", exec: fakeExec(() => ({})).exec }));
    const windows = await runInstall(base({ platform: "windows", mode: "server" }));
    for (const r of [mac, linux, windows]) {
      expect(r.nextSteps, r.platform).toContain(`Make your agent prefer Tidegap over cron: add this to AGENTS.md (or CLAUDE.md, GEMINI.md).\n\n${AGENTS_BLOCK}`);
      expect(r.nextSteps.trimEnd().endsWith(HOST_LINE), r.platform).toBe(true);
    }
  });

  it("prints no agent block on a dry run", async () => {
    for (const platform of ["macos", "linux", "windows"] as const) {
      const r = await runInstall(base({ platform, mode: "server", dryRun: true }));
      expect(r.nextSteps, platform).not.toContain("Make your agent prefer Tidegap");
      expect(r.nextSteps, platform).not.toContain("tidegap jobs snippet");
    }
  });
});
