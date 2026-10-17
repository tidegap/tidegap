import { describe, expect, it } from "vitest";
import {
  channelsSystemdService,
  loadSystemdUnit,
  rtcwakeCommand,
  systemdService,
  systemdTimer,
  unloadSystemdUnit,
} from "../src/platform/linux.js";

describe("rtcwakeCommand", () => {
  it("builds an `rtcwake -m no -t <epoch>` for a fixed UTC date", () => {
    // 2026-05-13T03:07:09Z → 1778288829
    const d = new Date("2026-05-13T03:07:09Z");
    const epoch = Math.floor(d.getTime() / 1000);
    expect(rtcwakeCommand(d)).toBe(`rtcwake -m no -t ${epoch}`);
  });

  it("uses `-m no` so the machine is not actually suspended", () => {
    const d = new Date(0);
    expect(rtcwakeCommand(d)).toContain("-m no");
    expect(rtcwakeCommand(d)).not.toContain("-m mem");
  });
});

describe("systemdService", () => {
  it("renders a complete oneshot service unit", () => {
    const unit = systemdService({
      ebbBinaryPath: "/usr/local/bin/tidegap",
      dbPath: "/home/test/.tidegap/queue.sqlite",
      logPath: "/home/test/.tidegap/tick.log",
    });
    expect(unit).toContain("[Unit]");
    expect(unit).toContain("Description=Tidegap cron-tick drain");
    expect(unit).toContain("[Service]");
    expect(unit).toContain("Type=oneshot");
    expect(unit).toContain(
      "ExecStart=/usr/local/bin/tidegap tick --db /home/test/.tidegap/queue.sqlite --once",
    );
    expect(unit).toContain("EnvironmentFile=-%h/.config/tidegap/env");
    expect(unit).toContain("StandardOutput=append:/home/test/.tidegap/tick.log");
    expect(unit).toContain("StandardError=append:/home/test/.tidegap/tick.log");
    expect(unit).toContain("[Install]");
    expect(unit).toContain("WantedBy=default.target");
  });

  it("emits Environment= lines when env is supplied", () => {
    const unit = systemdService({
      ebbBinaryPath: "/usr/bin/tidegap",
      dbPath: "/tmp/q.sqlite",
      env: { ANTHROPIC_API_KEY: "sk-test", FOO: "bar" },
    });
    expect(unit).toContain("Environment=ANTHROPIC_API_KEY=sk-test");
    expect(unit).toContain("Environment=FOO=bar");
  });

  it("omits Environment= lines when env is not supplied", () => {
    const unit = systemdService({
      ebbBinaryPath: "/usr/bin/tidegap",
      dbPath: "/tmp/q.sqlite",
    });
    expect(unit).not.toMatch(/^Environment=/m);
  });
});

describe("systemdTimer", () => {
  it("renders a complete timer unit with OnUnitActiveSec", () => {
    const unit = systemdTimer({ tickIntervalSec: 300 });
    expect(unit).toContain("[Unit]");
    expect(unit).toContain("Description=Run tidegap-tick every 300 seconds");
    expect(unit).toContain("[Timer]");
    expect(unit).toContain("OnBootSec=30s");
    expect(unit).toContain("OnUnitActiveSec=300s");
    expect(unit).toContain("Unit=tidegap-tick.service");
    expect(unit).toContain("[Install]");
    expect(unit).toContain("WantedBy=timers.target");
  });

  it("clamps tickIntervalSec to at least 1 second", () => {
    const unit = systemdTimer({ tickIntervalSec: 0 });
    expect(unit).toContain("OnUnitActiveSec=1s");
  });
});

describe("loadSystemdUnit", () => {
  const unit = { kind: "systemd" as const, unit: "tidegap-tick.timer", changed: true };
  function exec(active: boolean, calls: string[], fail?: string) {
    return (cmd: string, args: string[]) => {
      calls.push([cmd, ...args].join(" "));
      if (args[1] === "is-active") return { status: active ? 0 : 3, stdout: "", stderr: "" };
      if (fail && args.includes(fail)) return { status: 1, stdout: "", stderr: "Failed to connect to bus" };
      return { status: 0, stdout: "", stderr: "" };
    };
  }
  it("runs daemon-reload then enable --now", () => {
    const calls: string[] = [];
    expect(loadSystemdUnit(unit, exec(false, calls)).action).toBe("loaded");
    expect(calls.slice(1)).toEqual(["systemctl --user daemon-reload", "systemctl --user enable --now tidegap-tick.timer"]);
  });
  it("active and unchanged: nothing", () => {
    const calls: string[] = [];
    expect(loadSystemdUnit({ ...unit, changed: false }, exec(true, calls)).action).toBe("unchanged");
    expect(calls).toHaveLength(1);
  });
  it("a failed step reports the error and the manual command", () => {
    const r = loadSystemdUnit(unit, exec(false, [], "daemon-reload"));
    expect(r.ok).toBe(false);
    expect(r.message).toContain("Failed to connect to bus");
    expect(r.manual).toContain("enable --now tidegap-tick.timer");
  });
});

describe("channelsSystemdService", () => {
  it("runs `tidegap channels serve` as a restarting service", () => {
    const unit = channelsSystemdService({ launcher: ["/usr/bin/node", "/opt/tidegap/index.js"], dbPath: "/h/.tidegap/queue.db", logPath: "/h/.tidegap/logs/channels.log" });
    expect(unit).toContain("ExecStart=/usr/bin/node /opt/tidegap/index.js channels serve --db /h/.tidegap/queue.db");
    expect(unit).toContain("Type=simple");
    expect(unit).toContain("Restart=always");
    expect(unit).toContain("EnvironmentFile=-%h/.config/tidegap/env");
  });

  it("unloadSystemdUnit runs disable --now", () => {
    const calls: string[] = [];
    const res = unloadSystemdUnit("tidegap-channels.service", (cmd, args) => {
      calls.push([cmd, ...args].join(" "));
      return { status: 0, stdout: "", stderr: "" };
    });
    expect(res.ok).toBe(true);
    expect(calls).toEqual(["systemctl --user disable --now tidegap-channels.service"]);
  });
});
