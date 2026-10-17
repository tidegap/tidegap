/**
 * Linux platform helpers — `systemd-inhibit`, `rtcwake`, and
 * user-systemd unit-file generation.
 *
 * Like the macOS module, these wrap shell-outs and string-templating.
 * The only side-effects are spawning subprocesses; nothing here writes
 * a file. The `install` command places the unit files on disk.
 */

import { spawn } from "node:child_process";

import type { LoadResult, PlatformExec } from "./index.js";

/**
 * Spawn `systemd-inhibit --what=idle` so the system stays awake.
 * Returns a kill() function. If `systemd-inhibit` is not available,
 * the returned kill() is a no-op.
 *
 * Note: many Linux desktops will honour this; headless servers may
 * have no idle-sleep policy at all, in which case the inhibit is a
 * functional no-op.
 */
export async function caffeinateWhilePending(
  durationSec: number,
): Promise<() => void> {
  const seconds = Math.max(1, Math.floor(durationSec));
  const args = [
    "--what=idle",
    "--why=Tidegap pending tasks",
    "--mode=block",
    "sleep",
    String(seconds),
  ];
  let child: ReturnType<typeof spawn> | undefined;
  try {
    child = spawn("systemd-inhibit", args, {
      stdio: "ignore",
      detached: false,
    });
    child.on("error", () => {
      // systemd-inhibit missing — no-op.
    });
  } catch {
    // unavailable; return a no-op killer.
  }
  return () => {
    if (child && child.exitCode === null && !child.killed) {
      try {
        child.kill("SIGTERM");
      } catch {
        // ignore
      }
    }
  };
}

/**
 * Build the exact `rtcwake -m no -t <epoch-seconds>` command for a
 * given date. `-m no` tells rtcwake to *only* arm the RTC alarm without
 * suspending the machine itself.
 */
export function rtcwakeCommand(at: Date): string {
  const epoch = Math.floor(at.getTime() / 1000);
  return `rtcwake -m no -t ${epoch}`;
}

/**
 * Run `rtcwake -m no -t <epoch>`. Needs CAP_SYS_TIME / root. If we are
 * euid 0 we run it directly; otherwise we try `sudo -n` (non-interactive
 * — succeeds only if a sudoers rule pre-authorizes it without a password)
 * and, on failure, hand the caller a non-ok result so it can print the
 * exact sudoers one-liner.
 */
export async function rtcwakeScheduleWake(
  at: Date,
): Promise<{ command: string; ok: boolean; stderr: string }> {
  const command = rtcwakeCommand(at);
  const uid = typeof process.getuid === "function" ? process.getuid() : -1;
  const epoch = Math.floor(at.getTime() / 1000);
  const bare = ["-m", "no", "-t", String(epoch)];
  const [bin, args] =
    uid === 0
      ? (["rtcwake", bare] as const)
      : (["sudo", ["-n", "rtcwake", ...bare]] as const);
  return await new Promise((resolve) => {
    const child = spawn(bin, args, {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stderr = "";
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.on("error", (err) => {
      resolve({ command, ok: false, stderr: err.message });
    });
    child.on("close", (code) => {
      resolve({ command, ok: code === 0, stderr });
    });
  });
}

/**
 * Compatibility alias for the cross-platform `getPlatform` shim so
 * callers can keep using one name regardless of OS.
 */
export const pmsetScheduleWake = rtcwakeScheduleWake;

/** Base name of the systemd user units (`.service` and `.timer`). */
export const SYSTEMD_UNIT = "tidegap-tick";
/** The 0.17 unit name, detected so `tidegap install` can print its cleanup. */
export const LEGACY_SYSTEMD_UNIT = "ebb-tick";

export interface SystemdServiceOptions {
  dbPath: string;
  /**
   * The argv[0..n] that invoke `tidegap`, resolved at install time. For a
   * pinned node install this is `[process.execPath, realpath(argv[1])]`
   * — the exact interpreter plus the real dist entry — immune to a bare
   * service PATH and `#!/usr/bin/env node` shebangs. Falls back to
   * `ebbBinaryPath` (single element) if omitted.
   */
  launcher?: string[];
  /** Legacy single-binary launcher. Prefer `launcher`. */
  ebbBinaryPath?: string;
  /** Absolute path to write stdout/stderr logs. Defaults to ~/.tidegap/logs/tick.log. */
  logPath?: string;
  /** Optional env vars added as `Environment=KEY=VAL` lines. */
  env?: Record<string, string>;
}

/**
 * Render the `tidegap-tick.service` unit file. `Type=oneshot` because the
 * service runs `tidegap tick --once` and exits; the companion timer is
 * responsible for cadence. `EnvironmentFile=` references a user-owned
 * env file (belt-and-braces: `tidegap tick` also loads it directly), so
 * secrets never land in the service unit itself.
 */
export function systemdService(opts: SystemdServiceOptions): string {
  const logPath = opts.logPath ?? `${homeDir()}/.tidegap/logs/tick.log`;
  const launcher =
    opts.launcher && opts.launcher.length > 0
      ? opts.launcher
      : [opts.ebbBinaryPath ?? "tidegap"];
  const execStart = [...launcher, "tick", "--db", opts.dbPath, "--once"].join(
    " ",
  );
  const envLines = opts.env
    ? Object.entries(opts.env)
        .map(([k, v]) => `Environment=${k}=${v}`)
        .join("\n")
    : "";
  const envBlock = envLines ? `${envLines}\n` : "";
  return `[Unit]
Description=Tidegap cron-tick drain
After=network.target

[Service]
Type=oneshot
ExecStart=${execStart}
EnvironmentFile=-%h/.config/tidegap/env
${envBlock}StandardOutput=append:${logPath}
StandardError=append:${logPath}

[Install]
WantedBy=default.target
`;
}

export interface SystemdTimerOptions {
  tickIntervalSec: number;
}

/**
 * Render the `tidegap-tick.timer` unit file. Uses `OnUnitActiveSec=<n>s`
 * so the cadence matches the launchd `StartInterval` — fires every N
 * seconds regardless of wall-clock alignment. `OnBootSec=30s` covers
 * the case where the user-session starts before the network does.
 */
export function systemdTimer(opts: SystemdTimerOptions): string {
  const interval = Math.max(1, Math.floor(opts.tickIntervalSec));
  return `[Unit]
Description=Run ${SYSTEMD_UNIT} every ${interval} seconds

[Timer]
OnBootSec=30s
OnUnitActiveSec=${interval}s
Unit=${SYSTEMD_UNIT}.service

[Install]
WantedBy=timers.target
`;
}

/** A systemd user unit to enable, for example `tidegap-tick.timer`. */
export interface SystemdUnit {
  kind: "systemd";
  /** Full unit name with its suffix. */
  unit: string;
  /** False when the unit files on disk were byte-identical before this install wrote them. */
  changed: boolean;
}

/**
 * Enable the unit (KTD9): already active with unchanged files → nothing;
 * otherwise `daemon-reload` then `enable --now`. Neither stops a running
 * service, so a running task needs no guard here.
 */
export function loadSystemdUnit(unit: SystemdUnit, exec: PlatformExec): LoadResult {
  const manual = `systemctl --user daemon-reload && systemctl --user enable --now ${unit.unit}`;
  const active = exec("systemctl", ["--user", "is-active", unit.unit]).status === 0;
  if (active && !unit.changed) {
    return { ok: true, action: "unchanged", message: `${unit.unit} is already active with these unit files.` };
  }
  for (const args of [["--user", "daemon-reload"], ["--user", "enable", "--now", unit.unit]]) {
    const out = exec("systemctl", args);
    if (out.status !== 0) {
      const why = (out.stderr || out.stdout).trim() || (out.status === null ? "systemctl did not run" : `exit ${out.status}`);
      return {
        ok: false,
        action: "failed",
        message: `systemctl ${args.slice(1).join(" ")} failed: ${why}\n   Enable it by hand:\n     ${manual}`,
        manual,
      };
    }
  }
  return { ok: true, action: "loaded", message: `Enabled ${unit.unit} (systemctl --user enable --now).` };
}

function homeDir(): string {
  return process.env.HOME ?? "/tmp";
}
