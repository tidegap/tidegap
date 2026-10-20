/**
 * The child-process transport of the Shortcuts and Command drivers:
 * `spawn` with an argv array (no shell), a fixed working directory, the
 * minimal environment of {@link readChannelDriverEnv} (no secret and no
 * Tidegap variable, R17), stdin from a string, and a time limit after
 * which the child's process group gets SIGKILL (a pending macOS prompt
 * hangs a launchd child otherwise; `running-claude-p-from-a-daemon.md`).
 *
 * The run ends when the child exits, not when its pipes close: a program
 * that starts background work does not hold the send. Standard output is
 * ignored; standard error is kept only to map an error, at most 64 KiB, and
 * the rest is dropped without stopping the child. Neither ever reaches a
 * notification, a log line or an answer.
 */

import { spawn } from "node:child_process";

export const CHILD_TIMEOUT_MS = 20_000;

/** Most bytes of standard error kept. */
const STDERR_MAX = 64 * 1024;

/** How long after the exit the rest of standard error may take to arrive. */
const STDERR_GRACE_MS = 250;

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
    let stderr = "";
    let timedOut = false;
    let settled = false;
    const child = spawn(file, [...args], { cwd: opts.cwd, env: opts.env, stdio: ["pipe", "ignore", "pipe"], shell: false, detached: true, windowsHide: true });
    const finish = (res: ChildResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      // A background job may still hold the pipe; stop reading it.
      child.stderr?.destroy();
      child.stdin?.destroy();
      resolve(res);
    };
    const killGroup = () => {
      if (child.pid === undefined || child.pid <= 1) return;
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {
        try {
          child.kill("SIGKILL");
        } catch {
          /* already gone */
        }
      }
    };
    const timer = setTimeout(() => {
      timedOut = true;
      killGroup();
    }, opts.timeoutMs ?? CHILD_TIMEOUT_MS);
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => {
      if (stderr.length < STDERR_MAX) stderr = (stderr + chunk).slice(0, STDERR_MAX);
    });
    child.stderr?.on("error", () => {});
    child.on("error", (err: NodeJS.ErrnoException) => {
      if (err.code === "ENOENT") return finish({ ok: false, reason: "not_found", stderr: "" });
      if (err.code === "EACCES" || err.code === "ENOEXEC") return finish({ ok: false, reason: "not_executable", stderr: "" });
      finish({ ok: false, reason: "exit", stderr: "" });
    });
    let stderrDone = child.stderr === null;
    let exited: (() => void) | undefined;
    child.stderr?.on("end", () => {
      stderrDone = true;
      exited?.();
    });
    child.on("exit", (code, signal) => {
      const result = (): ChildResult => {
        if (timedOut || signal === "SIGKILL") return { ok: false, reason: "timeout", stderr };
        if (code === 0) return { ok: true };
        return { ok: false, reason: "exit", ...(code !== null ? { exitCode: code } : {}), stderr };
      };
      // The last stderr bytes can arrive after "exit"; a background job holding the pipe gets a short grace only.
      exited = () => finish(result());
      if (stderrDone) return exited();
      setTimeout(exited, STDERR_GRACE_MS);
    });
    // A child that exits without reading its input must not crash the host.
    child.stdin?.on("error", () => {});
    child.stdin?.end(opts.input ?? "");
  });
}
