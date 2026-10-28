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
 * - The group dies with the tick (KTD11): while a run is live, SIGTERM and
 *   SIGINT to the tick send each group SIGTERM, then SIGKILL when its shell
 *   exits or the grace ends, whichever comes first. A run that starts after
 *   the signal is stopped the same way at once; a second signal sends
 *   SIGKILL at once. The tick's `exit` sends SIGKILL at once (exit listeners
 *   cannot wait). When no other listener handles the signal, the signal is
 *   raised again as soon as no stopped group waits for its SIGKILL, so the
 *   tick starts no more work and its default exit stays. A tick ended by
 *   SIGKILL or a crash runs no handler; its group lives on. A child that
 *   leaves the group (`setsid`) is out of reach.
 * - The run ends when the shell exits, not when its pipes close: after the
 *   exit, {@link PIPE_GRACE_MS} for the last bytes, then the pipes are
 *   destroyed (the `runChild` settle rule).
 * - Standard output is capped at `outputCapBytes`; the rest is dropped
 *   (`truncated`), the command is not stopped for it. Standard error keeps
 *   its own rolling tail of {@link STDERR_TAIL_BYTES} (KTD12), so a command
 *   that fills the cap and then fails still reports why.
 * - The environment is {@link childEnv}: an allowlist plus the job's named
 *   secrets. Provider keys loaded from the env file never reach it. The
 *   named secrets are the second deliberate exception, to "secrets never
 *   enter the child env": the user named them for this command.
 *
 * Nothing here scrubs: the caller scrubs every string before it leaves.
 */

import { MAX_TIMER_MS } from "@tidegap/core";
import { spawn, type ChildProcessByStdio } from "node:child_process";
import type { Readable } from "node:stream";

/** Time between SIGTERM and SIGKILL of the group on a timeout. */
export const KILL_GRACE_MS = 5_000;

/** How long after the exit the last output may take to arrive. */
const PIPE_GRACE_MS = 250;

/** Bytes of standard error kept for the error text (the end of it). */
export const STDERR_TAIL_BYTES = 4 * 1024;

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

/** Process groups of live runs, with their SIGTERM-to-SIGKILL grace. */
const liveGroups = new Map<number, number>();
/** Groups sent SIGTERM by a stop signal, each with its SIGKILL timer. */
const stopping = new Map<number, NodeJS.Timeout>();
/**
 * The stop signal the tick got, and whether its default exit must follow (no
 * other listener). Kept for the rest of the process: a run that starts after
 * it is stopped at once.
 */
let stop: { signal: NodeJS.Signals; alone: boolean } | undefined;

function signalGroup(pgid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pgid, signal);
  } catch {
    /* already gone */
  }
}

function stopGroup(pgid: number, graceMs: number): void {
  signalGroup(pgid, "SIGTERM");
  stopping.set(
    pgid,
    setTimeout(() => {
      stopping.delete(pgid);
      signalGroup(pgid, "SIGKILL");
      settleStop();
    }, graceMs),
  );
}

/** SIGKILL to stopped groups now: their shell exited, or a second signal came. */
function killStopped(pgids: readonly number[]): void {
  for (const pgid of pgids) {
    clearTimeout(stopping.get(pgid));
    stopping.delete(pgid);
    signalGroup(pgid, "SIGKILL");
  }
  settleStop();
}

/** Once no stopped group waits for its SIGKILL: the default exit when alone, else drop the listeners when nothing runs. */
function settleStop(): void {
  if (stopping.size > 0) return;
  if (stop?.alone) {
    unhook();
    process.kill(process.pid, stop.signal);
    return;
  }
  if (liveGroups.size === 0) unhook();
}

/** SIGTERM and SIGINT to the tick: stop every live group, then exit as the signal would have. */
function onStopSignal(signal: NodeJS.Signals): void {
  if (stop) {
    killStopped([...stopping.keys()]);
    return;
  }
  stop = { signal, alone: process.listenerCount(signal) === 1 };
  for (const [pgid, grace] of liveGroups) stopGroup(pgid, grace);
  settleStop();
}

/** The tick's exit: SIGKILL at once, because exit listeners run synchronously. */
function onExit(): void {
  for (const pgid of new Set([...liveGroups.keys(), ...stopping.keys()])) signalGroup(pgid, "SIGKILL");
}

let hooked = false;
function hook(): void {
  if (hooked) return;
  hooked = true;
  process.on("SIGTERM", onStopSignal);
  process.on("SIGINT", onStopSignal);
  process.on("exit", onExit);
}
function unhook(): void {
  if (!hooked) return;
  hooked = false;
  process.removeListener("SIGTERM", onStopSignal);
  process.removeListener("SIGINT", onStopSignal);
  process.removeListener("exit", onExit);
}

/** Drop the listeners when no run is live and no stopped group waits. */
function unhookIfIdle(): void {
  if (liveGroups.size === 0 && stopping.size === 0) unhook();
}

/**
 * {@link unhookIfIdle} two loop turns later, after a failed spawn. A signal
 * that came during the spawn is caught at once but reaches its listener only
 * in a later poll phase; removing the last listener before then drops it, and
 * the tick goes on. One turn is not enough when the run started from an I/O
 * callback.
 */
function unhookIfIdleLater(): void {
  setImmediate(() => setImmediate(unhookIfIdle));
}

function trackGroup(pgid: number, graceMs: number): void {
  liveGroups.set(pgid, graceMs);
  if (stop) stopGroup(pgid, graceMs);
}

function untrackGroup(pgid: number): void {
  liveGroups.delete(pgid);
  // A stopped group whose shell exited: the rest of it gets SIGKILL now.
  if (stopping.has(pgid)) return killStopped([pgid]);
  unhookIfIdle();
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
   * True when standard output went over `outputCapBytes` and the rest was
   * dropped; `stdout` may then end at a byte cut.
   */
  truncated: boolean;
  /** The shell's pid (tests check that its group is gone). */
  pid?: number;
}

export function runShell(input: RunShellInput): Promise<RunShellResult> {
  return new Promise((resolve, reject) => {
    // The listeners go in before the spawn: the shell can run (and a signal
    // reach the tick) before `spawn` returns, and a SIGTERM or SIGINT with no
    // listener yet would end the tick by default and leave the group running.
    // A signal that comes now is handled after this synchronous block, so the
    // group is tracked by then. When the spawn fails, the listeners come off
    // two loop turns later, so that signal still reaches them.
    hook();
    let child: ChildProcessByStdio<null, Readable, Readable>;
    try {
      child = spawn("/bin/sh", ["-c", input.command], {
        cwd: input.cwd,
        env: input.env,
        stdio: ["ignore", "pipe", "pipe"],
        detached: true,
        windowsHide: true,
      });
    } catch (e) {
      unhookIfIdleLater();
      throw e;
    }
    const grace = input.killGraceMs ?? KILL_GRACE_MS;
    const pgid = child.pid !== undefined && child.pid > 1 ? child.pid : undefined;
    if (pgid !== undefined) trackGroup(pgid, grace);
    else unhookIfIdleLater();
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
      }, grace);
    }, Math.min(input.timeoutMs, MAX_TIMER_MS));

    child.stdout.on("data", (chunk: Buffer) => {
      const room = Math.max(0, input.outputCapBytes - used);
      if (chunk.length > room) truncated = true;
      const kept = chunk.length > room ? chunk.subarray(0, room) : chunk;
      used += kept.length;
      if (kept.length > 0) out.push(kept);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      err = Buffer.concat([err, chunk]);
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
      if (pgid !== undefined) untrackGroup(pgid);
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
      if (pgid !== undefined) untrackGroup(pgid);
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
