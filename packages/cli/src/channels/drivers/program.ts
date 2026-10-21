/**
 * The program check of the Command driver and of a `TIDEGAP_SHORTCUTS_BIN`
 * override, run before every start (so at connect and at each send): an
 * absolute path to an executable regular file owned by this user, where
 * neither the file nor its folder (for a symlink, at both ends) can be
 * changed by another user (no group or world write bit). Anything else
 * could be swapped by another account and then run as this user from the
 * tick, with no prompt.
 */

import { accessSync, constants, realpathSync, statSync } from "node:fs";
import { dirname, isAbsolute } from "node:path";

/** Group or world write. */
const OTHERS_WRITE = 0o022;

export type ProgramCheck = { ok: true; path: string } | { ok: false; code: "invalid_config" | "not_found" | "not_executable" | "unsafe_path" };

/** Check `path`; on success `path` is the resolved file to run. */
export function checkProgram(path: string, uid: number | undefined = process.getuid?.()): ProgramCheck {
  if (!isAbsolute(path) || path.includes("\0")) return { ok: false, code: "invalid_config" };
  let real: string;
  try {
    real = realpathSync(path);
  } catch {
    return { ok: false, code: "not_found" };
  }
  try {
    const file = statSync(real);
    if (!file.isFile()) return { ok: false, code: "not_executable" };
    if ((uid !== undefined && file.uid !== uid) || file.mode & OTHERS_WRITE) return { ok: false, code: "unsafe_path" };
    for (const dir of new Set([dirname(path), dirname(real)])) {
      if (statSync(dir).mode & OTHERS_WRITE) return { ok: false, code: "unsafe_path" };
    }
    accessSync(real, constants.X_OK);
    return { ok: true, path: real };
  } catch {
    return { ok: false, code: "not_executable" };
  }
}
