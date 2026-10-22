/**
 * The machine's sleep counter (coherence KTD2 follow-up): how long the
 * machine slept since boot. Two readings of one boot give the sleep between
 * them, so readiness does not count a gap the machine slept through as
 * missed ticks. `process.hrtime` cannot tell: on macOS it keeps counting
 * through sleep.
 */

import { uptime } from "node:os";

import type { SleepReading } from "@tidegap/core";

import { underTest } from "../env.js";
import { defaultExec, type ProbeExec } from "./probe.js";

/** `{ sec = 1792682659, usec = 83247 } ...` (a `sysctl` timeval) as epoch ms; null when unparsable. */
function timevalMs(line: string | undefined): number | null {
  const m = /sec = (\d+), usec = (\d+)/.exec(line ?? "");
  return m ? Number(m[1]) * 1000 + Math.floor(Number(m[2]) / 1000) : null;
}

/**
 * Parse `sysctl -n kern.boottime kern.waketime kern.wake_abs_time hw.tbfrequency`.
 * Sleep since boot = wall time from boot to the last wake minus the awake
 * time to it (`wake_abs_time` counts only awake ticks). A machine that never
 * slept has `waketime` 0.
 */
export function parseDarwinSleep(stdout: string): SleepReading | null {
  const [boot, wake, abs, freq] = stdout.trim().split("\n");
  const bootAt = timevalMs(boot);
  const wokeAt = timevalMs(wake);
  const ticks = Number(abs);
  const hz = Number(freq);
  if (bootAt === null || wokeAt === null || !Number.isFinite(ticks) || !(hz > 0)) return null;
  if (wokeAt === 0) return { boot_at: bootAt, slept_ms: 0 };
  return { boot_at: bootAt, slept_ms: Math.max(0, wokeAt - bootAt - (ticks / hz) * 1000), woke_at: wokeAt };
}

/** The Linux clocks: boot clock seconds (counts suspend), monotonic ms (does not), wall ms. */
export interface LinuxClocks {
  uptimeS(): number;
  monoMs(): number;
  nowMs(): number;
}

const realClocks: LinuxClocks = {
  uptimeS: uptime,
  monoMs: () => Number(process.hrtime.bigint() / 1_000_000n),
  nowMs: Date.now,
};

/**
 * The machine's sleep counter now; null where it cannot be read (Windows,
 * a failed `sysctl`, under a test runner without injected clocks). macOS
 * spawns one `sysctl`; Linux compares the boot clock (`os.uptime`, counts
 * suspend) with the monotonic clock (`process.hrtime`, does not).
 */
export function readSleep(platform: NodeJS.Platform = process.platform, exec: ProbeExec = defaultExec, clocks?: LinuxClocks): SleepReading | null {
  if (platform === "darwin") {
    const out = exec("sysctl", ["-n", "kern.boottime", "kern.waketime", "kern.wake_abs_time", "hw.tbfrequency"]);
    return out.status === 0 && out.stdout ? parseDarwinSleep(out.stdout) : null;
  }
  if (platform === "linux") {
    if (!clocks && underTest()) return null;
    const c = clocks ?? realClocks;
    const bootMs = c.uptimeS() * 1000;
    const monoMs = c.monoMs();
    if (!Number.isFinite(bootMs) || !Number.isFinite(monoMs)) return null;
    return { boot_at: c.nowMs() - bootMs, slept_ms: Math.max(0, bootMs - monoMs) };
  }
  return null;
}
