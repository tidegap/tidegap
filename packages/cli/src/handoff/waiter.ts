/**
 * The wake waiter: `tidegap queue notices --wait --rewake`, started by the
 * plugin's `Stop` hook (`hooks/session-wake.sh`, Claude Code `asyncRewake`)
 * when the session has a wake marker. It waits in the background for a
 * task queued with wake to finish, then prints the session's notice to
 * stderr, claims it (`notified`, `via: "rewake"`) and exits 2, which wakes
 * the idle session with the notice. Every other way out exits 0 and leaves
 * the notice to the prompt hook.
 *
 * - One waiter per session: each writes its pid to
 *   `~/.tidegap/sessions/waiters/<session_id>.pid` (a temporary name renamed
 *   into place), so the newest wins; an older one that finds another pid
 *   there exits 0 at its next poll. The file is removed on every way out
 *   while it still names this process.
 * - It polls every {@link WAITER_POLL_MS} and reads rows only when the
 *   ledger's `data_version` changed (another connection committed).
 * - It stops when its `claude` ancestor is gone (the pid no longer runs the
 *   same process: owner, start time and name are compared, not the pid
 *   alone; a process table it cannot read 3 times in a row counts as gone),
 *   when that process now runs another session (`/clear`, `/resume`: its
 *   capture file names another id) and at {@link WAITER_LIMIT_MS}, under
 *   the hook's 12 h timeout.
 * - Only a completed or failed wake task wakes; a cancel never does.
 * - The notice is written first, and claimed only once the write reached the
 *   hook's pipe, so a hook that is gone never gets a claimed notice it
 *   cannot pass on. The claim is insert-if-absent: a wake task the prompt
 *   hook claimed first makes the waiter exit 0.
 * - It removes the wake marker when the session has no wake task left to
 *   wait for (none unfinished, none waiting for its result file). The tick
 *   sweep removes a marker older than 12 h with nothing left to wait for.
 */

import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, readFileSync, renameSync, statSync, unlinkSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { isValidSessionId, removeWakeMarker, TaskStore, wakeMarkerPath } from "@tidegap/core";
import type { SessionNotice, TaskRecord } from "@tidegap/core";

import { hookSessionId } from "../commands/queue.js";
import { defaultDbPath } from "../commands/tick.js";
import { findAncestorPid, readCapture, sessionsDir } from "../session/capture.js";
import { isWakeTask, pendingWakeTasks, removeNoticeMarker, renderNoticeBlock } from "./notices.js";

/** How often the waiter checks the ledger, its pid file and its `claude` process. */
export const WAITER_POLL_MS = 5_000;
/** The waiter gives up after 11 h 50 min, under the Stop hook's 12 h timeout. */
export const WAITER_LIMIT_MS = 11 * 3_600_000 + 50 * 60_000;
/** Exit codes: 2 wakes the session (asyncRewake); 0 leaves the notice to the prompt hook. */
export const WAKE_EXIT = { idle: 0, wake: 2 } as const;
/** Polls in a row with an unreadable process table that count as the `claude` process gone. */
const UNKNOWN_IDENTITY_LIMIT = 3;

/** Why the waiter stopped (tests and logs). */
export type WaiterOutcome =
  | "woke"
  | "no-session"
  | "no-marker"
  | "no-ledger"
  | "no-claude"
  | "no-pid-file"
  | "nothing-pending"
  | "claimed-elsewhere"
  | "replaced"
  | "claude-gone"
  | "session-changed"
  | "no-reader"
  | "limit"
  | "stopped"
  | "error";

export interface WakeWaiterResult {
  exitCode: 0 | 2;
  outcome: WaiterOutcome;
  /** Tasks this waiter claimed. */
  claimed: string[];
}

/** The process facts the waiter needs. Tests describe processes that do not exist. */
export interface WaiterProcess {
  /** This process's pid. */
  pid: number;
  /** The nearest ancestor `claude` process of this user, or undefined. */
  claudePid(): number | undefined;
  /**
   * What tells a running process apart from a later one with the same pid
   * (its owner, start time and command); undefined when the pid does not
   * run, null when it cannot tell (the process table could not be read).
   */
  identity(pid: number): string | undefined | null;
  /** The session the `claude` process runs now (its capture file); default `readCapture`. */
  session?(pid: number): string | undefined;
}

/** True when `pid` runs no process this user can signal: gone, or reused by another user. */
function pidGone(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return false;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    return code === "ESRCH" || code === "EPERM";
  }
}

/**
 * `ps -o uid=,lstart=,comm= -p <pid>`, whitespace collapsed (macOS and
 * Linux). A failed `ps` (a timeout under load, a failed fork) is null while
 * the pid still runs, so one bad poll does not end the wait.
 */
function psIdentity(pid: number): string | undefined | null {
  try {
    const out = execFileSync("ps", ["-o", "uid=,lstart=,comm=", "-p", String(pid)], {
      encoding: "utf8",
      timeout: 2_000,
      stdio: ["ignore", "pipe", "ignore"],
    });
    const line = out.split("\n")[0]?.trim().replace(/\s+/g, " ");
    return line ? line : undefined;
  } catch {
    return pidGone(pid) ? undefined : null;
  }
}

let stderrGuarded = false;

/**
 * Write the notice to stderr; true once it reached the pipe. A pipe with no
 * reader (the hook's shell is gone) gives false, and its error does not
 * end the process.
 */
function writeStderr(text: string): Promise<boolean> {
  if (!stderrGuarded) {
    stderrGuarded = true;
    process.stderr.on("error", () => {});
  }
  return new Promise((ok) => {
    try {
      process.stderr.write(`${text}\n`, (err) => ok(!err));
    } catch {
      ok(false);
    }
  });
}

export const defaultWaiterProcess: WaiterProcess = {
  pid: process.pid,
  claudePid: () => findAncestorPid("claude"),
  identity: psIdentity,
};

export interface WakeWaiterOptions {
  db?: string;
  /** The hook's stdin JSON; only its `session_id` is read. */
  hookInput?: string;
  /** `~/.tidegap/sessions` (tests). */
  dir?: string;
  /** Stops the wait (SIGTERM, SIGINT, SIGHUP in the CLI): exit 0. */
  signal?: AbortSignal;
  /**
   * Where the notice goes; default stderr. False (or a promise of false)
   * means it did not reach a reader: nothing is claimed.
   */
  stderr?: (text: string) => boolean | Promise<boolean>;
  /** Tests: the process facts, the clock and the sleep between polls. */
  proc?: WaiterProcess;
  now?: () => Date;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  pollMs?: number;
  limitMs?: number;
  openStore?: (dbPath: string) => TaskStore;
}

/** A sleep that ends early when `signal` aborts. */
function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((ok) => {
    if (signal?.aborted) return ok();
    const timer = setTimeout(done, ms);
    function done(): void {
      clearTimeout(timer);
      signal?.removeEventListener("abort", done);
      ok();
    }
    signal?.addEventListener("abort", done, { once: true });
  });
}

/** The pid a waiter pid file names, or undefined when it is missing or not one complete line of digits. */
function readPid(path: string): number | undefined {
  try {
    const m = /^(\d+)\n$/.exec(readFileSync(path, "utf8"));
    return m ? Number(m[1]) : undefined;
  } catch {
    return undefined;
  }
}

/** Write this waiter's pid file: a new file under a temporary name, renamed into place. */
function writePid(dir: string, path: string, pid: number): boolean {
  const tmp = join(dir, `.${pid}.${Date.now()}.tmp`);
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    writeFileSync(tmp, `${pid}\n`, { mode: 0o600, flag: "wx" });
    renameSync(tmp, path);
    return true;
  } catch {
    try {
      unlinkSync(tmp);
    } catch {
      // never written
    }
    return false;
  }
}

/** The modification time of the file at `path`, or undefined. */
function mtimeOf(path: string): number | undefined {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return undefined;
  }
}

/** True when a regular file is at `path` (a link is not followed). */
function isFile(path: string | undefined): path is string {
  if (!path) return false;
  try {
    return lstatSync(path).isFile();
  } catch {
    return false;
  }
}

/**
 * Run the waiter of the session named in `hookInput`. Never throws: every
 * failure is a `0` exit, so the prompt hook keeps the notice.
 */
export async function runWakeWaiter(opts: WakeWaiterOptions = {}): Promise<WakeWaiterResult> {
  const idle = (outcome: WaiterOutcome, claimed: string[] = []): WakeWaiterResult => ({ exitCode: WAKE_EXIT.idle, outcome, claimed });
  const proc = opts.proc ?? defaultWaiterProcess;
  const now = opts.now ?? (() => new Date());
  const sleep = opts.sleep ?? abortableSleep;
  const pollMs = opts.pollMs ?? WAITER_POLL_MS;
  const limitMs = opts.limitMs ?? WAITER_LIMIT_MS;
  const stderr = opts.stderr ?? writeStderr;
  const root = opts.dir ?? sessionsDir();
  const wakeDir = join(root, "wake");
  const noticeDir = join(root, "notices");
  const waitersDir = join(root, "waiters");

  const sessionId = hookSessionId(opts.hookInput);
  if (!sessionId || !isValidSessionId(sessionId)) return idle("no-session");
  const marker = wakeMarkerPath(sessionId, wakeDir);
  if (!isFile(marker)) return idle("no-marker");
  const dbPath = opts.db ?? defaultDbPath();
  if (dbPath !== ":memory:" && !existsSync(dbPath)) return idle("no-ledger");
  const sessionOf = (pid: number): string | undefined => (proc.session ? proc.session(pid) : readCapture(pid, root)?.sessionId);
  let claude: { pid: number; identity: string; session: string | undefined } | undefined;
  try {
    const pid = proc.claudePid();
    const identity = pid !== undefined && pid > 1 ? proc.identity(pid) : undefined;
    if (pid !== undefined && typeof identity === "string" && identity) claude = { pid, identity, session: sessionOf(pid) };
  } catch {
    claude = undefined;
  }
  if (!claude) return idle("no-claude");

  const start = now().getTime();
  // The session's turn just ended: the marker's age counts from here. A
  // later refresh means a newer waiter (or a new wake task) came after this one.
  try {
    utimesSync(marker, now(), now());
  } catch {
    // a read-only folder: the marker keeps its age
  }
  const refreshed = mtimeOf(marker);
  const pidPath = join(waitersDir, `${sessionId}.pid`);
  if (!writePid(waitersDir, pidPath, proc.pid)) return idle("no-pid-file");

  let store: TaskStore | undefined;
  try {
    store = opts.openStore ? opts.openStore(dbPath) : new TaskStore({ dbPath });
    let version: number | undefined;
    let unknown = 0;
    for (;;) {
      if (opts.signal?.aborted) return idle("stopped");
      const named = readPid(pidPath);
      if (named === undefined) {
        // A newer waiter that already ended removed its file, and it
        // refreshed the marker first: this one is old. Otherwise an older
        // waiter removed this one's file as it ended: write it again.
        const m = mtimeOf(marker);
        if (m === undefined || refreshed === undefined || m > refreshed) return idle("replaced");
        if (!writePid(waitersDir, pidPath, proc.pid)) return idle("no-pid-file");
      } else if (named !== proc.pid) {
        return idle("replaced");
      }
      const seen = proc.identity(claude.pid);
      if (seen === null) {
        if (++unknown >= UNKNOWN_IDENTITY_LIMIT) return idle("claude-gone");
      } else {
        unknown = 0;
        if (seen !== claude.identity) return idle("claude-gone");
      }
      const runs = sessionOf(claude.pid);
      if (runs !== undefined && runs !== sessionId && runs !== claude.session) return idle("session-changed");
      const elapsed = now().getTime() - start;
      if (elapsed >= limitMs) return idle("limit");
      let v: number | undefined;
      try {
        v = store.dataVersion();
      } catch {
        v = undefined;
      }
      if (v === undefined || v !== version) {
        const done = await check(store);
        // A failed read looks again at the next poll, also without a new commit.
        if (done !== "read-failed") {
          version = v;
          if (done) return done;
        }
      }
      await sleep(Math.max(0, Math.min(pollMs, limitMs - elapsed)), opts.signal);
    }
  } catch {
    // An unreadable ledger or process table: the prompt hook keeps the notice.
    return idle("error");
  } finally {
    if (readPid(pidPath) === proc.pid) {
      try {
        unlinkSync(pidPath);
      } catch {
        // gone already
      }
    }
    try {
      store?.close();
    } catch {
      // ignore
    }
  }

  /**
   * One look at the ledger: the wake, a stop, undefined to keep waiting, or
   * "read-failed" (a busy ledger) to look again at the next poll.
   */
  async function check(s: TaskStore): Promise<WakeWaiterResult | undefined | "read-failed"> {
    let notices: SessionNotice[];
    let pending: TaskRecord<unknown>[];
    try {
      notices = s.listSessionNotices({ sessionId: sessionId!, now: now() });
      pending = pendingWakeTasks(s, sessionId!, now());
    } catch {
      return "read-failed";
    }
    // A cancel is someone's own act: it never spends a turn.
    const wakes = (n: SessionNotice): boolean => isWakeTask(n.record) && n.record.status !== "cancelled";
    const woke = notices.filter(wakes);
    if (woke.length === 0) {
      if (pending.length > 0) return undefined;
      removeWakeMarker(sessionId!, wakeDir);
      return idle("nothing-pending");
    }
    // The wake tasks come first, so the notice names them even when it is cut.
    const ordered = [...woke, ...notices.filter((n) => !wakes(n))];
    const { text, listed } = renderNoticeBlock(ordered);
    // Claimed only once the hook has it: a claimed notice nobody can pass
    // on would never reach the prompt hook either. A claim that then fails
    // exits 0, and the hook drops what was written.
    let written: boolean;
    try {
      written = (await stderr(text)) !== false;
    } catch {
      written = false;
    }
    if (!written) return idle("no-reader");
    const claimed: string[] = [];
    let failed = false;
    const claim = (n: SessionNotice): boolean => {
      try {
        if (!s.claimNotice(n.record.taskId, { via: "rewake", session_id: sessionId! }, "agent:claude-code")) return false;
      } catch {
        failed = true;
        return false;
      }
      claimed.push(n.record.taskId);
      try {
        s.markRead(n.record.taskId);
      } catch {
        // the claim stands: the session gets the notice; the task stays unread
      }
      return true;
    };
    const shown = ordered.slice(0, listed);
    // The wake task's claim decides between this waiter and the prompt hook.
    let won = false;
    for (const n of shown.filter(wakes)) won = claim(n) || won;
    if (!won) return idle(failed ? "error" : "claimed-elsewhere");
    for (const n of shown.filter((x) => !wakes(x))) claim(n);
    try {
      if (s.listSessionNotices({ sessionId: sessionId!, now: now() }).length === 0) removeNoticeMarker(sessionId!, noticeDir);
      if (pending.length === 0) removeWakeMarker(sessionId!, wakeDir);
    } catch {
      // the next tick sweep fixes the markers
    }
    return { exitCode: WAKE_EXIT.wake, outcome: "woke", claimed };
  }
}
