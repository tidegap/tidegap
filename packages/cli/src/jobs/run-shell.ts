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
 *   {@link KILL_GRACE_MS} later, so background children stop too. While the
 *   grace runs the group is probed every {@link STOP_PROBE_MS}: once it is
 *   empty (or its id is no longer ours) no more signal is sent and the run
 *   settles. A stopped run resolves only after its stop ended, so a one-shot
 *   tick cannot exit while a member waits for its SIGKILL. An abort of
 *   `signal` (the task was cancelled) stops the group the same way; a signal
 *   already aborted starts no shell. After a
 *   normal exit the group is left alone: what the command started in the
 *   background is the command's business.
 * - The group dies with the tick (KTD11): while a run is live, SIGTERM and
 *   SIGINT to the tick send each group SIGTERM, then SIGKILL when its shell
 *   exits or the grace ends, whichever comes first. A run that starts after
 *   the signal is stopped the same way at once. A second signal sends SIGKILL
 *   at once, unless it comes within {@link FORCED_STOP_GAP_MS} of the first:
 *   that one is a copy (`npm exec` forwards the terminal's Ctrl-C) and is
 *   ignored, so the grace stays. The tick's `exit` sends SIGKILL at once (exit
 *   listeners cannot wait). When no other listener handles the signal, the
 *   signal is raised again as soon as no stopped group waits for its SIGKILL,
 *   so the tick starts no more work and its default exit stays. A tick ended
 *   by SIGKILL or a crash runs no handler; its group lives on. A child that
 *   leaves the group (`setsid`) is out of reach.
 * - The listeners come off two loop turns after the last run settles (or its
 *   spawn fails), never at once: Node catches a signal at once but calls the
 *   listener in a later poll phase, and a signal whose listener is gone by
 *   then is dropped, so the tick would go on. Only the re-raise removes them
 *   at once, so the raised signal reaches its default action.
 * - A group is signalled by its id ({@link signalGroup}). The kernel does not
 *   reuse that id while any member lives, and no portable API pins a group.
 *   A group stopped by its time limit or a cancel gets no signal after a
 *   probe found it empty, so its id could be taken by another group only
 *   inside one probe interval. The tick's stop sends its SIGKILL when the
 *   run settles, at most {@link PIPE_GRACE_MS} after the shell's exit.
 * - The run ends when the shell exits, not when its pipes close: after the
 *   exit, {@link PIPE_GRACE_MS} for the last bytes, then the pipes are
 *   destroyed (the `runChild` settle rule).
 * - Standard output is capped at `outputCapBytes`; the rest is dropped
 *   (`truncated`), the command is not stopped for it. Standard error keeps
 *   its own rolling tail of {@link STDERR_TAIL_BYTES} (KTD12), so a command
 *   that fills the cap and then fails still reports why.
 * - While the run lasts, `onLine` gets the newest whole line with text of
 *   each standard output chunk, within the cap: lines that arrive together
 *   count as one moment, a blank line never hides the line before it, and a
 *   line the cap cuts is never passed. The core decides which lines become
 *   progress events.
 * - The environment is {@link childEnv}: an allowlist plus the job's named
 *   secrets. Provider keys loaded from the env file never reach it. The
 *   named secrets are the second deliberate exception, to "secrets never
 *   enter the child env": the user named them for this command.
 *
 * Nothing here scrubs: the caller scrubs every string before it leaves.
 */

import { MAX_TIMER_MS, progressLine } from "@tidegap/core";
import { spawn, type ChildProcessByStdio } from "node:child_process";
import type { Readable } from "node:stream";

import { signalGroup } from "../process-group.js";

/** Time between SIGTERM and SIGKILL of the group on a timeout. */
export const KILL_GRACE_MS = 5_000;

/** How often a group stopped by its time limit or a cancel is probed for a member left. */
const STOP_PROBE_MS = 100;

/** A second stop signal sooner than this after the first is a copy of it (`npm exec` forwards the terminal's Ctrl-C). */
export const FORCED_STOP_GAP_MS = 1_000;

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

/** A live run as the tick's stop sees it: its SIGTERM-to-SIGKILL grace, and its mark for that stop. */
interface LiveRun {
  graceMs: number;
  onTickStop: () => void;
}

/** Process groups of live runs. */
const liveGroups = new Map<number, LiveRun>();
/** Groups sent SIGTERM by a stop signal, each with its SIGKILL timer. */
const stopping = new Map<number, NodeJS.Timeout>();
/**
 * The stop signal the tick got, when (`Date.now()`), and whether its default
 * exit must follow (no other listener). Kept for the rest of the process: a
 * run that starts after it is stopped at once.
 */
let stop: { signal: NodeJS.Signals; at: number; alone: boolean } | undefined;

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
    // At once: the raised signal must reach its default action, not this listener.
    unhook();
    process.kill(process.pid, stop.signal);
    return;
  }
  unhookIfIdleLater();
}

/** SIGTERM and SIGINT to the tick: stop every live group, then exit as the signal would have. */
function onStopSignal(signal: NodeJS.Signals): void {
  if (stop) {
    if (Date.now() - stop.at < FORCED_STOP_GAP_MS) return;
    killStopped([...stopping.keys()]);
    return;
  }
  stop = { signal, at: Date.now(), alone: process.listenerCount(signal) === 1 };
  for (const [pgid, run] of liveGroups) tickStop(pgid, run);
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
 * {@link unhookIfIdle} two loop turns later, after a run settles or its spawn
 * fails. A signal that came meanwhile is caught at once but reaches its
 * listener only in a later poll phase; removing the last listener before then
 * drops it, and the tick goes on. One turn is not enough when the run started
 * or settled in an I/O callback.
 */
function unhookIfIdleLater(): void {
  setImmediate(() => setImmediate(unhookIfIdle));
}

/** The tick's stop of one live run: mark it, then SIGTERM to its group. */
function tickStop(pgid: number, run: LiveRun): void {
  run.onTickStop();
  stopGroup(pgid, run.graceMs);
}

function trackGroup(pgid: number, run: LiveRun): void {
  liveGroups.set(pgid, run);
  if (stop) tickStop(pgid, run);
}

function untrackGroup(pgid: number): void {
  liveGroups.delete(pgid);
  // A stopped group whose shell exited: the rest of it gets SIGKILL now.
  if (stopping.has(pgid)) return killStopped([pgid]);
  unhookIfIdleLater();
}

export interface RunShellInput {
  command: string;
  /** An existing directory (the caller checks it). */
  cwd: string;
  env: Record<string, string>;
  /** The time limit in ms, or `"none"`: no timer, only a cancel or the tick's stop ends the run. */
  timeoutMs: number | "none";
  outputCapBytes: number;
  /** Time between SIGTERM and SIGKILL (tests); default {@link KILL_GRACE_MS}. */
  killGraceMs?: number;
  /**
   * The newest whole line with text (without its newline) of each standard
   * output chunk inside `outputCapBytes`, while the run lasts; a chunk of
   * blank lines passes none. Not scrubbed. An error it throws is ignored.
   */
  onLine?: (line: string) => void;
  /** Aborted when the task is cancelled: the group is stopped as at the time limit. */
  signal?: AbortSignal;
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
  /** True when an abort of `signal` stopped the run, or it was aborted before the spawn. */
  cancelled: boolean;
  /**
   * True when the tick's stop (SIGTERM or SIGINT to the tick) reached the run
   * while its shell was still running; false when the shell had exited by
   * then, though its run still waited for the pipes.
   */
  stoppedByTick: boolean;
  /**
   * True when standard output went over `outputCapBytes` and the rest was
   * dropped; `stdout` may then end at a byte cut.
   */
  truncated: boolean;
  /**
   * Time from the last standard output or error byte to the stop of a timed
   * out run; 0 otherwise. A run that wrote no byte before the stop was quiet
   * for all of it: at least its time limit, decided from that fact, since a
   * timer can fire a millisecond before `Date.now()` says its delay passed.
   * Read by the macOS privacy hint only.
   */
  quietMs: number;
  /** The shell's pid (tests check that its group is gone). */
  pid?: number;
}

export function runShell(input: RunShellInput): Promise<RunShellResult> {
  if (input.signal?.aborted) {
    return Promise.resolve({ code: null, signal: null, stdout: "", stderrTail: "", stderrCut: false, timedOut: false, cancelled: true, stoppedByTick: false, truncated: false, quietMs: 0 });
  }
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
    let stoppedByTick = false;
    const onTickStop = () => {
      if (child.exitCode === null && child.signalCode === null) stoppedByTick = true;
    };
    if (pgid !== undefined) trackGroup(pgid, { graceMs: grace, onTickStop });
    else unhookIfIdleLater();
    const out: Buffer[] = [];
    let err: Buffer = Buffer.alloc(0);
    let stderrCut = false;
    let used = 0;
    let truncated = false;
    let timedOut = false;
    let cancelled = false;
    /** `Date.now()` of the spawn, then of each output chunk; the time limit's stop reads it. */
    let lastOutputAt = Date.now();
    /** True once a stdout or stderr byte came before the stop. */
    let heard = false;
    let quietMs = 0;
    let settled = false;
    let killTimer: NodeJS.Timeout | undefined;
    let probeTimer: NodeJS.Timeout | undefined;
    let stopSent = false;
    /** The finish of a stopped run, deferred until its stop ends. */
    let afterKill: (() => void) | undefined;

    const killGroup = (signal: NodeJS.Signals) => {
      if (pgid === undefined || signalGroup(pgid, signal) === "sent") return;
      try {
        child.kill(signal);
      } catch {
        /* already gone */
      }
    };
    /**
     * True while the group has a member. While the shell is unreaped its pid,
     * and so the group id, is ours: a `"denied"` answer then means a member
     * we may not signal, and the grace-end SIGKILL falls back to the shell.
     * After the shell's exit a `"denied"` id names another user's group.
     */
    const groupLive = (): boolean => {
      const probe = signalGroup(pgid, 0);
      return probe === "sent" || (probe === "denied" && child.exitCode === null && child.signalCode === null);
    };
    /** The stop is over: no more signals, and a finish that waited goes on. */
    const endStop = (): void => {
      clearTimeout(killTimer);
      clearInterval(probeTimer);
      killTimer = undefined;
      probeTimer = undefined;
      afterKill?.();
    };
    /**
     * SIGTERM to the group, then a probe every {@link STOP_PROBE_MS}: once the
     * group is empty the stop ends with no further signal. A member still
     * there at the end of the grace gets SIGKILL. False when the shell already
     * exited or a stop is under way.
     */
    const stopGroup = (): boolean => {
      // The shell exited just before: the run is not stopped.
      if (settled || stopSent || child.exitCode !== null || child.signalCode !== null) return false;
      stopSent = true;
      killGroup("SIGTERM");
      // Not cleared at the exit, and the run waits for the stop to end: a
      // group member that ignores SIGTERM still gets SIGKILL before the tick
      // can exit.
      killTimer = setTimeout(() => {
        if (groupLive()) killGroup("SIGKILL");
        endStop();
      }, grace);
      probeTimer = setInterval(() => {
        if (!groupLive()) endStop();
      }, STOP_PROBE_MS);
      return true;
    };
    const limit = input.timeoutMs;
    const delay = limit === "none" ? undefined : Math.min(limit, MAX_TIMER_MS);
    const timer =
      delay === undefined
        ? undefined
        : setTimeout(() => {
            if (!stopGroup()) return;
            timedOut = true;
            const sinceOutput = Math.max(0, Date.now() - lastOutputAt);
            quietMs = heard ? sinceOutput : Math.max(sinceOutput, delay);
          }, delay);
    const onAbort = () => {
      if (stopGroup()) cancelled = true;
    };
    input.signal?.addEventListener("abort", onAbort, { once: true });

    // The bytes after the last newline so far: the start of a line still open.
    let open: Buffer[] = [];
    const newestLine = (kept: Buffer, cut: boolean): void => {
      const last = kept.lastIndexOf(0x0a);
      if (last < 0) {
        if (cut) open = [];
        else open.push(kept);
        return;
      }
      // The newest whole line with something to show: a blank line (or one
      // only of control characters) after it must not hide it.
      let line: string | undefined;
      for (let end = last; end >= 0 && line === undefined; ) {
        const start = end > 0 ? kept.lastIndexOf(0x0a, end - 1) : -1;
        const text = (start >= 0 ? kept.subarray(start + 1, end) : Buffer.concat([...open, kept.subarray(0, end)])).toString("utf8");
        if (progressLine(text) !== undefined) line = text;
        end = start;
      }
      // An open line the cap cut never ends inside the kept output.
      open = cut || last + 1 === kept.length ? [] : [kept.subarray(last + 1)];
      if (line === undefined) return;
      try {
        input.onLine?.(line);
      } catch {
        // the caller's callback must not break the run
      }
    };
    child.stdout.on("data", (chunk: Buffer) => {
      if (!timedOut) {
        lastOutputAt = Date.now();
        heard = true;
      }
      const room = Math.max(0, input.outputCapBytes - used);
      if (chunk.length > room) truncated = true;
      const kept = chunk.length > room ? chunk.subarray(0, room) : chunk;
      used += kept.length;
      if (kept.length > 0) out.push(kept);
      if (input.onLine && !settled && (kept.length > 0 || chunk.length > room)) newestLine(kept, chunk.length > room);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      if (!timedOut) {
        lastOutputAt = Date.now();
        heard = true;
      }
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
      input.signal?.removeEventListener("abort", onAbort);
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
        cancelled,
        stoppedByTick,
        truncated,
        quietMs,
        ...(child.pid !== undefined ? { pid: child.pid } : {}),
      });
    };
    child.on("error", (e) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(killTimer);
      clearInterval(probeTimer);
      input.signal?.removeEventListener("abort", onAbort);
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
