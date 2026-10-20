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
 *   crashed writer and is taken over.
 * - {@link writeFileAtomic} writes a 0600 temp file, fsyncs it and renames
 *   it over the target, so a reader never sees half a file.
 */

import { randomBytes } from "node:crypto";
import { chmodSync, closeSync, fsyncSync, mkdirSync, openSync, realpathSync, renameSync, statSync, unlinkSync, writeSync } from "node:fs";
import { dirname } from "node:path";

/** A lock this old belongs to a writer that died; a real write takes milliseconds. */
export const STALE_LOCK_MS = 10_000;

/** How long a writer waits for the lock before it gives up. */
const LOCK_WAIT_MS = 5_000;
const LOCK_POLL_MS = 20;

const sleepSync = (ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

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
  const lock = `${target}.lock`;
  const deadline = Date.now() + LOCK_WAIT_MS;
  let fd: number;
  for (;;) {
    try {
      fd = openSync(lock, "wx", 0o600);
      break;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      try {
        if (Date.now() - statSync(lock).mtimeMs > STALE_LOCK_MS) {
          unlinkSync(lock);
          continue;
        }
      } catch {
        continue; // released between the open and the stat
      }
      if (Date.now() >= deadline) throw new Error("another Tidegap process is writing this file; try again");
      sleepSync(LOCK_POLL_MS);
    }
  }
  try {
    return fn();
  } finally {
    closeSync(fd);
    try {
      unlinkSync(lock);
    } catch {
      // taken over as stale
    }
  }
}

/** Replace `target` with `content` through a 0600 temp file, fsync and rename. */
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
}
