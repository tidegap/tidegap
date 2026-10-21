/**
 * Atomic, locked writes of the small config files more than one Tidegap
 * process edits: the env file (`setEnvFileKey`) and `channel-secrets.json`
 * (`writeSecrets`). The CLI and a running `tidegap ui` can write the same
 * file at once; each write is a read-modify-write, so without a lock the
 * second writer would drop the first one's change.
 *
 * - {@link writeTarget} resolves a symlink, so a symlinked file stays one,
 *   and creates the directory with mode 0700.
 * - {@link withFileLock} holds `<target>.lock` (O_EXCL) around the whole
 *   read-modify-write. A lock older than {@link STALE_LOCK_MS} is left by a
 *   crashed writer and is taken over: it is renamed to a name only the taker
 *   knows before it is deleted, so two writers that both find it stale cannot
 *   both get in, and a fresh lock is never deleted. A writer releases the
 *   lock only while the lock file is still its own.
 * - {@link tryFileLock} is the same lock without the wait, for a long
 *   holder (`tidegap tick`) that touches it to stay fresh.
 * - {@link writeFileAtomic} writes a 0600 temp file in the target's
 *   directory, fsyncs it, renames it over the target and fsyncs the
 *   directory, so a reader never sees half a file and the rename survives a
 *   power loss.
 */

import { randomBytes } from "node:crypto";
import { chmodSync, closeSync, fstatSync, fsyncSync, futimesSync, linkSync, mkdirSync, openSync, realpathSync, renameSync, statSync, unlinkSync, writeSync, type Stats } from "node:fs";
import { dirname } from "node:path";

/** A lock this old belongs to a writer that died; a real write takes milliseconds. */
export const STALE_LOCK_MS = 3_000;

/** How long a writer waits for the lock before it gives up; longer than {@link STALE_LOCK_MS}, so a crashed writer's lock never fails a write. */
const LOCK_WAIT_MS = 5_000;
const LOCK_POLL_MS = 20;

const SLEEP_CELL = new Int32Array(new SharedArrayBuffer(4));
const sleepSync = (ms: number) => Atomics.wait(SLEEP_CELL, 0, 0, ms);

/** The file a write goes to: the symlink's target, else `path`. Creates the directory (0700). */
export function writeTarget(path: string): string {
  let target = path;
  try {
    target = realpathSync(path);
  } catch {
    // Missing file: create it at `path`.
  }
  mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
  return target;
}

/** Run `fn` while holding `<target>.lock`; throws when another writer holds it for longer than 5 s. */
export function withFileLock<T>(target: string, fn: () => T): T {
  const deadline = Date.now() + LOCK_WAIT_MS;
  let lock: FileLock | undefined;
  while (!(lock = tryFileLock(target))) {
    if (Date.now() >= deadline) throw new Error("another Tidegap process is writing this file; try again");
    sleepSync(LOCK_POLL_MS);
  }
  try {
    return fn();
  } finally {
    lock.release();
  }
}

/** A held `<target>.lock`. */
export interface FileLock {
  /** Move the lock's mtime to now, so a long holder is not taken for stale. */
  touch(): void;
  /** Delete the lock while it is still ours, and close it. */
  release(): void;
}

/**
 * One attempt at `<target>.lock`, with the stale takeover of
 * {@link withFileLock}; undefined when another process holds a lock younger
 * than `staleMs`. A holder that runs longer than `staleMs` calls `touch()`
 * more often than that.
 */
export function tryFileLock(target: string, staleMs: number = STALE_LOCK_MS): FileLock | undefined {
  const lock = `${target}.lock`;
  for (;;) {
    let fd: number;
    try {
      fd = openSync(lock, "wx", 0o600);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      if (takeOverStale(lock, staleMs)) continue;
      return undefined;
    }
    const mine = fstatSync(fd);
    let open = true;
    return {
      touch: () => {
        if (!open) return;
        try {
          const now = new Date();
          futimesSync(fd, now, now);
        } catch {
          // best effort
        }
      },
      release: () => {
        if (!open) return;
        open = false;
        // Before the close: while our descriptor is open, no new lock file can reuse our inode.
        release(lock, mine);
        closeSync(fd);
      },
    };
  }
}

/**
 * Delete `lock` when it is stale; true when the caller should try the open
 * again at once. The lock is first renamed to a name only this writer knows,
 * so of two writers that saw it stale only one moves it. When the moved file
 * turns out to be fresh (another writer replaced the stale lock between our
 * stat and our rename), it is put back, not deleted.
 */
function takeOverStale(lock: string, staleMs: number): boolean {
  const isStale = (st: Stats) => Date.now() - st.mtimeMs > staleMs;
  try {
    if (!isStale(statSync(lock))) return false;
  } catch {
    return true; // released between the open and the stat
  }
  const moved = `${lock}.${process.pid}.${randomBytes(4).toString("hex")}.stale`;
  try {
    renameSync(lock, moved);
  } catch {
    return true; // another writer moved or released it first
  }
  try {
    if (!isStale(statSync(moved))) linkSync(moved, lock);
  } catch {
    // A third writer holds the lock now; the moved one is gone for good.
  }
  try {
    unlinkSync(moved);
  } catch {
    // already gone
  }
  return true;
}

/** Delete `lock` when it is still the file this writer created. */
function release(lock: string, mine: Stats): void {
  try {
    const now = statSync(lock);
    if (now.ino === mine.ino && now.dev === mine.dev) unlinkSync(lock);
  } catch {
    // taken over as stale
  }
}

/** Replace `target` with `content` through a 0600 temp file in its directory, fsync, rename and a directory fsync. */
export function writeFileAtomic(target: string, content: string): void {
  const tmp = `${target}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  try {
    const fd = openSync(tmp, "w", 0o600);
    try {
      writeSync(fd, content);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    chmodSync(tmp, 0o600);
    renameSync(tmp, target);
  } catch (err) {
    try {
      unlinkSync(tmp);
    } catch {
      // already gone
    }
    throw err;
  }
  syncDir(dirname(target));
}

/** Make a rename in `dir` durable. Best effort: some platforms cannot open or fsync a directory. */
function syncDir(dir: string): void {
  let fd: number | undefined;
  try {
    fd = openSync(dir, "r");
    fsyncSync(fd);
  } catch {
    // not supported here
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}
