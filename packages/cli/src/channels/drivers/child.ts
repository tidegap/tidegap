/**
 * The child-process transport of the Shortcuts and Command drivers:
 * `execFile` with an argv array (no shell), a fixed working directory, the
 * minimal environment of {@link readChannelDriverEnv} (no secret and no
 * Tidegap variable, R17), stdin from a string, and a time limit after
 * which the child gets SIGKILL (a pending macOS prompt hangs a launchd
 * child otherwise). Output is read only to map an error, at most 64 KiB.
 */

import { execFile } from "node:child_process";

export const CHILD_TIMEOUT_MS = 20_000;

export type ChildResult =
  | { ok: true }
  | { ok: false; reason: "timeout" | "not_found" | "not_executable" | "exit"; exitCode?: number; stderr: string };

export interface ChildOptions {
  cwd: string;
  env: Record<string, string>;
  /** Written to stdin, then closed; absent: stdin is empty. */
  input?: string;
  timeoutMs?: number;
}

export function runChild(file: string, args: readonly string[], opts: ChildOptions): Promise<ChildResult> {
  return new Promise((resolve) => {
    const child = execFile(
      file,
      [...args],
      { cwd: opts.cwd, env: opts.env, timeout: opts.timeoutMs ?? CHILD_TIMEOUT_MS, killSignal: "SIGKILL", maxBuffer: 64 * 1024, encoding: "utf8", shell: false, windowsHide: true },
      (err, _stdout, stderr) => {
        if (!err) return resolve({ ok: true });
        const e = err as NodeJS.ErrnoException & { killed?: boolean; signal?: string | null; code?: string | number };
        const text = String(stderr ?? "");
        if (e.code === "ENOENT") return resolve({ ok: false, reason: "not_found", stderr: text });
        if (e.code === "EACCES" || e.code === "ENOEXEC") return resolve({ ok: false, reason: "not_executable", stderr: text });
        if (e.killed || e.signal === "SIGKILL") return resolve({ ok: false, reason: "timeout", stderr: text });
        resolve({ ok: false, reason: "exit", exitCode: typeof e.code === "number" ? e.code : undefined, stderr: text });
      },
    );
    // A child that exits without reading its input must not crash the host.
    child.stdin?.on("error", () => {});
    child.stdin?.end(opts.input ?? "");
  });
}
