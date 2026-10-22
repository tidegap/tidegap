/** The probe command runner shared by readiness (`launchctl`, `systemctl`) and the sleep counter (`sysctl`). */

import { spawnSync } from "node:child_process";

import { underTest } from "../env.js";

/** Runs a probe command; `status` null = it could not run. `stdout` when the command printed. */
export type ProbeExec = (cmd: string, args: string[]) => { status: number | null; stdout?: string };

const PROBE_TIMEOUT_MS = 5_000;

/** Real probe; under a test runner it never spawns (status null). */
export const defaultExec: ProbeExec = (cmd, args) => {
  if (underTest()) return { status: null };
  const out = spawnSync(cmd, args, { stdio: ["ignore", "pipe", "ignore"], encoding: "utf8", timeout: PROBE_TIMEOUT_MS });
  return out.error ? { status: null } : { status: out.status, stdout: out.stdout };
};
