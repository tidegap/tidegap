/**
 * Platform-aware loader. Returns the right submodule for the current OS.
 * The submodules expose the same shape (`caffeinateWhilePending`,
 * `pmsetScheduleWake`, etc.); only macOS is fully wired in v0.4.
 */

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import * as linux from "./linux.js";
import * as macos from "./macos.js";
import * as windows from "./windows.js";
import { underTest } from "../env.js";

export type PlatformName = "macos" | "linux" | "windows";

export function currentPlatform(): PlatformName {
  if (process.platform === "darwin") return "macos";
  if (process.platform === "win32") return "windows";
  return "linux";
}

export function getPlatform(name?: PlatformName): {
  name: PlatformName;
  caffeinateWhilePending: typeof macos.caffeinateWhilePending;
  pmsetScheduleWake: typeof macos.pmsetScheduleWake;
} {
  const resolved = name ?? currentPlatform();
  if (resolved === "macos") {
    return {
      name: "macos",
      caffeinateWhilePending: macos.caffeinateWhilePending,
      pmsetScheduleWake: macos.pmsetScheduleWake,
    };
  }
  if (resolved === "windows") {
    return {
      name: "windows",
      caffeinateWhilePending: windows.caffeinateWhilePending,
      pmsetScheduleWake: windows.pmsetScheduleWake,
    };
  }
  return {
    name: "linux",
    caffeinateWhilePending: linux.caffeinateWhilePending,
    pmsetScheduleWake: linux.pmsetScheduleWake,
  };
}

export { macos, linux, windows };

/** Whether a tick daemon (`tidegap install`) is set up on this machine. */
export type DaemonStatus = "installed" | "not_installed" | "unknown";

/**
 * Probe for the unit file `tidegap install` writes: the macOS LaunchAgent plist
 * or the Linux systemd user timer. Windows reports `unknown`, because there
 * `tidegap install` only prints a schtasks command and nothing on disk shows
 * whether the user ran it.
 */
export function daemonStatus(
  opts: {
    platform?: NodeJS.Platform;
    home?: string;
    exists?: (path: string) => boolean;
  } = {},
): DaemonStatus {
  const platform = opts.platform ?? process.platform;
  const home = opts.home ?? homedir();
  const exists = opts.exists ?? existsSync;
  // The 0.17 unit counts too: it keeps ticking the same ledger until removed.
  if (platform === "darwin") {
    const agents = join(home, "Library", "LaunchAgents");
    return [macos.LAUNCHD_LABEL, macos.LEGACY_LAUNCHD_LABEL].some((l) => exists(join(agents, `${l}.plist`)))
      ? "installed"
      : "not_installed";
  }
  if (platform === "win32") return "unknown";
  const units = join(home, ".config", "systemd", "user");
  return [linux.SYSTEMD_UNIT, linux.LEGACY_SYSTEMD_UNIT].some((u) => exists(join(units, `${u}.timer`)))
    ? "installed"
    : "not_installed";
}

/** Output of one platform command; `status` null = it could not run. */
export interface ExecResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

/** Why a platform command failed: its output, else whether it ran or its exit code. */
export function execFailure(out: ExecResult, cmd: string): string {
  return (out.stderr || out.stdout).trim() || (out.status === null ? `${cmd} did not run` : `exit ${out.status}`);
}

/** Runs a platform command (`pmset`, `launchctl`, `systemctl`); tests inject a fake. */
export type PlatformExec = (cmd: string, args: string[]) => ExecResult;

const EXEC_TIMEOUT_MS = 15_000;

/** The real exec. Under a test runner it never spawns, so no test reaches launchd or systemd. */
export const defaultPlatformExec: PlatformExec = (cmd, args) => {
  if (underTest()) return { status: null, stdout: "", stderr: "not run under a test runner" };
  const out = spawnSync(cmd, args, { encoding: "utf8", timeout: EXEC_TIMEOUT_MS });
  return {
    status: out.error ? null : out.status,
    stdout: out.stdout ?? "",
    stderr: out.error ? out.error.message : (out.stderr ?? ""),
  };
};

/** The mode `tidegap install` picks without a flag, and why (coherence KTD9). */
export interface InstallModeChoice {
  mode: "laptop" | "server";
  reason: string;
}

/** `--laptop` on a Mac with an internal battery, `--server` everywhere else. */
export function detectInstallMode(platform: PlatformName, exec: PlatformExec = defaultPlatformExec): InstallModeChoice {
  if (platform === "macos") return macos.detectInstallMode(exec);
  return { mode: "server", reason: "this machine is not a Mac" };
}

/** A unit `loadAgent` loads: a LaunchAgent plist or a systemd user unit. */
export type AgentUnit = macos.LaunchAgentUnit | linux.SystemdUnit;

/** What `loadAgent` did. `manual` is the command a user runs to finish by hand. */
export interface LoadResult {
  ok: boolean;
  action: "loaded" | "unloaded" | "unchanged" | "deferred" | "failed";
  /** One line for the install output. */
  message: string;
  manual?: string;
}

/** Load (or reload) an agent unit through `exec` (KTD9); U15 reuses it for the channels listener. */
export function loadAgent(unit: AgentUnit, exec: PlatformExec = defaultPlatformExec): LoadResult {
  return unit.kind === "launchd" ? macos.loadLaunchAgent(unit, exec) : linux.loadSystemdUnit(unit, exec);
}

/** Unload an agent unit by name: a launchd label in `gui/<uid>`, or a systemd user unit. */
export function unloadAgent(
  unit: { kind: "launchd"; label: string; uid: number } | { kind: "systemd"; unit: string },
  exec: PlatformExec = defaultPlatformExec,
): LoadResult {
  return unit.kind === "launchd" ? macos.unloadLaunchAgent(unit.label, unit.uid, exec) : linux.unloadSystemdUnit(unit.unit, exec);
}

/** Where the channels listener unit lives; null on Windows (no unit there). */
export function channelsUnitPath(platform: NodeJS.Platform = process.platform, home: string = homedir()): string | null {
  if (platform === "darwin") return join(home, "Library", "LaunchAgents", `${macos.CHANNELS_LAUNCHD_LABEL}.plist`);
  if (platform === "win32") return null;
  return join(home, ".config", "systemd", "user", `${linux.CHANNELS_SYSTEMD_UNIT}.service`);
}

/** Whether the channels listener unit file is on disk; `unknown` on Windows. Reads no process state. */
export function listenerUnitStatus(platform: NodeJS.Platform = process.platform, home: string = homedir()): DaemonStatus {
  const path = channelsUnitPath(platform, home);
  if (!path) return "unknown";
  return existsSync(path) ? "installed" : "not_installed";
}
