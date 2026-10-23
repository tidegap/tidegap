/**
 * The shell step of a command job (jobs KD4, R11): `/bin/sh -c <command>`
 * run by the daemon, in its own process group, with stdin closed, a
 * minimal environment and a time limit.
 *
 * This is a deliberate exception to "no shell" in
 * `channels-url-policy-and-child-process-rules.md`: the command string is
 * written by the user on the page or the CLI only, never by an agent
 * (KD10, KTD13). The rest of those rules hold:
 *
 * - Own process group: the timeout sends SIGTERM to the group, then SIGKILL
 *   {@link KILL_GRACE_MS} later, so background children stop too. A timed
 *   out run resolves only after that SIGKILL, so a one-shot tick cannot
 *   exit before it. After a normal exit the group is left alone: what the
 *   command started in the background is the command's business.
 * - The run ends when the shell exits, not when its pipes close: after the
 *   exit, {@link PIPE_GRACE_MS} for the last bytes, then the pipes are
 *   destroyed (the `runChild` settle rule).
 * - Standard output and standard error together are capped at
 *   `outputCapBytes`; the rest is dropped (`truncated`), the command is not
 *   stopped for it.
 * - The environment is {@link childEnv}: an allowlist plus the job's named
 *   secrets. Provider keys loaded from the env file never reach it. The
 *   named secrets are the second deliberate exception, to "secrets never
 *   enter the child env": the user named them for this command.
 *
 * Nothing here scrubs: the caller scrubs every string before it leaves.
 */

import { spawn } from "node:child_process";

/** Time between SIGTERM and SIGKILL of the group on a timeout. */
export const KILL_GRACE_MS = 5_000;

/** How long after the exit the last output may take to arrive. */
const PIPE_GRACE_MS = 250;

/** Bytes of standard error kept for the error text (the end of it). */
const STDERR_TAIL_BYTES = 4 * 1024;

/** The longest delay `setTimeout` honours; a larger one fires at once. */
const MAX_TIMER_MS = 2 ** 31 - 1;

/** Variables the command inherits from the daemon; `LC_*` by prefix. */
const ENV_ALLOW: ReadonlySet<string> = new Set(["PATH", "HOME", "USER", "LOGNAME", "SHELL", "LANG", "TMPDIR", "TZ"]);

/**
 * The command's environment: the allowlisted variables of `base` (`PATH`,
 * `HOME`, `USER`, `LOGNAME`, `SHELL`, `LANG`, `LC_*`, `TMPDIR`, `TZ`) plus
 * `secrets`. Nothing else: no provider key, no Tidegap variable.
 */
export function childEnv(base: NodeJS.ProcessEnv, secrets: Record<string, string>): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(base)) {
    if (v !== undefined && (ENV_ALLOW.has(k) || k.startsWith("LC_"))) env[k] = v;
  }
  return { ...env, ...secrets };
}

export interface RunShellInput {
  command: string;
  /** An existing directory (the caller checks it). */
  cwd: string;
  env: Record<string, string>;
  timeoutMs: number;
  outputCapBytes: number;
  /** Time between SIGTERM and SIGKILL (tests); default {@link KILL_GRACE_MS}. */
  killGraceMs?: number;
}

export interface RunShellResult {
  /** Exit code; null when a signal ended the shell. */
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  /** The last few KB of standard error. */
  stderrTail: string;
  /** True when earlier standard error was dropped, so `stderrTail` starts at a byte cut. */
  stderrCut: boolean;
  timedOut: boolean;
  /**
   * True when output went over `outputCapBytes` and the rest was dropped;
   * `stdout` and `stderrTail` may then end at a byte cut.
   */
  truncated: boolean;
  /** The shell's pid (tests check that its group is gone). */
  pid?: number;
}

export function runShell(input: RunShellInput): Promise<RunShellResult> {
  return new Promise((resolve, reject) => {
    const child = spawn("/bin/sh", ["-c", input.command], {
      cwd: input.cwd,
      env: input.env,
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
      windowsHide: true,
    });
    const out: Buffer[] = [];
    let err: Buffer = Buffer.alloc(0);
    let stderrCut = false;
    let used = 0;
    let truncated = false;
    let timedOut = false;
    let settled = false;
    let killTimer: NodeJS.Timeout | undefined;
    /** The finish of a timed out run, deferred until the SIGKILL is sent. */
    let afterKill: (() => void) | undefined;

    const killGroup = (signal: NodeJS.Signals) => {
      if (child.pid === undefined || child.pid <= 1) return;
      try {
        process.kill(-child.pid, signal);
      } catch {
        try {
          child.kill(signal);
        } catch {
          /* already gone */
        }
      }
    };
    const timer = setTimeout(() => {
      // The shell exited just before: the run is not a timeout.
      if (child.exitCode !== null || child.signalCode !== null) return;
      timedOut = true;
      killGroup("SIGTERM");
      // Not cleared at the exit, and the run waits for it: a group member
      // that ignores SIGTERM still gets SIGKILL before the tick can exit.
      killTimer = setTimeout(() => {
        killTimer = undefined;
        killGroup("SIGKILL");
        afterKill?.();
      }, input.killGraceMs ?? KILL_GRACE_MS);
    }, Math.min(input.timeoutMs, MAX_TIMER_MS));

    /** Bytes of `chunk` still under the cap; marks `truncated` past it. */
    const take = (chunk: Buffer): Buffer => {
      const room = Math.max(0, input.outputCapBytes - used);
      if (chunk.length > room) truncated = true;
      const kept = chunk.length > room ? chunk.subarray(0, room) : chunk;
      used += kept.length;
      return kept;
    };
    child.stdout.on("data", (chunk: Buffer) => {
      const kept = take(chunk);
      if (kept.length > 0) out.push(kept);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      const kept = take(chunk);
      if (kept.length === 0) return;
      err = Buffer.concat([err, kept]);
      if (err.length > STDERR_TAIL_BYTES) {
        err = err.subarray(-STDERR_TAIL_BYTES);
        stderrCut = true;
      }
    });
    child.stdout.on("error", () => {});
    child.stderr.on("error", () => {});

    const finish = (code: number | null, signal: NodeJS.Signals | null) => {
      if (settled) return;
      if (killTimer) {
        afterKill = () => finish(code, signal);
        return;
      }
      settled = true;
      clearTimeout(timer);
      // A background job may still hold the pipes; stop reading them.
      child.stdout.destroy();
      child.stderr.destroy();
      resolve({
        code,
        signal,
        stdout: Buffer.concat(out).toString("utf8"),
        stderrTail: err.toString("utf8"),
        stderrCut,
        timedOut,
        truncated,
        ...(child.pid !== undefined ? { pid: child.pid } : {}),
      });
    };
    child.on("error", (e) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(e);
    });
    let pipesDone = 0;
    let exited: (() => void) | undefined;
    const pipeEnd = () => {
      pipesDone += 1;
      if (pipesDone === 2) exited?.();
    };
    child.stdout.on("end", pipeEnd);
    child.stderr.on("end", pipeEnd);
    child.on("exit", (code, signal) => {
      exited = () => finish(code, signal);
      if (pipesDone === 2) return exited();
      setTimeout(exited, PIPE_GRACE_MS);
    });
  });
}
