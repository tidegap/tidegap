/**
 * The one way the CLI signals a process group: `kill(-pgid, signal)`. A
 * child spawned with `detached: true` leads its own group, whose id is the
 * child's pid.
 *
 * A pgid below 2 is never signalled: `kill(0)` reaches the caller's own
 * group and `kill(-1)` every process the user owns. Such an id answers
 * `"gone"` without a system call.
 */

/** What a group signal did: `"sent"`, `"gone"` (`ESRCH`: no member left) or `"denied"` (`EPERM`: the id names a group that is not ours). */
export type GroupSignalResult = "sent" | "gone" | "denied";

/**
 * Sends `signal` to the process group `pgid`; signal 0 only probes it.
 * Any error other than `EPERM` reads as `"gone"`. `kill` defaults to
 * `process.kill`, looked up at each call.
 */
export function signalGroup(
  pgid: number | undefined,
  signal: NodeJS.Signals | 0,
  kill: (pid: number, signal: NodeJS.Signals | 0) => void = (pid, sig) => process.kill(pid, sig),
): GroupSignalResult {
  if (pgid === undefined || !Number.isInteger(pgid) || pgid < 2) return "gone";
  try {
    kill(-pgid, signal);
    return "sent";
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM" ? "denied" : "gone";
  }
}
