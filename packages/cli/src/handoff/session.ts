/**
 * Which Claude Code session the CLI runs in, for `--session current` and
 * the session commands. First hit wins:
 *
 *   1. The plugin hook's capture file of the nearest ancestor `claude`
 *      process (`~/.tidegap/sessions/claude-<pid>.json`), current after
 *      `/clear` and `/resume`.
 *   2. `CLAUDE_CODE_SESSION_ID` from the environment.
 *
 * A session found this way is a checked origin: the body of a task the CLI
 * queues for it gets `origin: { agent: "claude-code", via }`. The MCP server
 * keeps its own rule (`packages/mcp-server/src/origin.ts`).
 */

import { isValidSessionId } from "@tidegap/core";

import { findAncestorPid, readCapture, type CapturedSession } from "../session/capture.js";

/** A usage error of a queue watch or session command (bad input, unknown id): exit code 2. */
export class UsageError extends Error {
  readonly exitCode = 2;
  constructor(message: string) {
    super(message);
    this.name = "UsageError";
  }
}

/** Where the session facts come from. Tests inject every one. */
export interface SessionSources {
  /** The nearest ancestor `claude` pid, or undefined. */
  claudePid: () => number | undefined;
  readCapture: (pid: number) => CapturedSession | undefined;
  /** `CLAUDE_CODE_SESSION_ID`. */
  envSessionId: () => string | undefined;
  /** `CLAUDE_PROJECT_DIR`. */
  envProjectDir?: () => string | undefined;
}

export interface CurrentSession {
  sessionId: string;
  /** How it was found: the capture file (`hook`) or the environment (`env`). */
  origin: { agent: "claude-code"; via: "hook" | "env"; transcriptPath?: string };
  /** The session's project folder: the capture's `CLAUDE_PROJECT_DIR` (else its `cwd`), or the environment's. */
  cwd?: string;
}

/** This process's sources: a `ps` walk, the capture files under the Tidegap home, the environment. */
export function defaultSessionSources(env: NodeJS.ProcessEnv = process.env): SessionSources {
  return {
    claudePid: () => findAncestorPid("claude"),
    readCapture: (pid) => readCapture(pid),
    envSessionId: () => env.CLAUDE_CODE_SESSION_ID,
    envProjectDir: () => env.CLAUDE_PROJECT_DIR,
  };
}

/** The session the CLI runs in, or undefined outside a Claude Code session. */
export function currentSession(sources: SessionSources = defaultSessionSources()): CurrentSession | undefined {
  const pid = sources.claudePid();
  const captured = pid !== undefined ? sources.readCapture(pid) : undefined;
  if (captured && isValidSessionId(captured.sessionId)) {
    const cwd = captured.projectDir ?? captured.cwd;
    return {
      sessionId: captured.sessionId,
      origin: { agent: "claude-code", via: "hook", ...(captured.transcriptPath ? { transcriptPath: captured.transcriptPath } : {}) },
      ...(cwd ? { cwd } : {}),
    };
  }
  const envId = sources.envSessionId();
  if (isValidSessionId(envId)) {
    const cwd = sources.envProjectDir?.();
    return { sessionId: envId, origin: { agent: "claude-code", via: "env" }, ...(cwd ? { cwd } : {}) };
  }
  return undefined;
}

/**
 * The session a `--session <id|current>` value names. `current` needs a
 * Claude Code session; an id must be 8-128 letters, digits, `-` or `_`.
 * Throws {@link UsageError}.
 */
export function resolveSessionArg(
  command: string,
  value: string,
  sources: SessionSources = defaultSessionSources(),
): string {
  if (value === "current") {
    const current = currentSession(sources);
    if (!current) {
      throw new UsageError(
        `${command}: --session current needs a Claude Code session, and none was found; pass --session <id>`,
      );
    }
    return current.sessionId;
  }
  if (!isValidSessionId(value)) {
    throw new UsageError(`${command}: --session must be current or a session id (8-128 letters, digits, - or _)`);
  }
  return value;
}

/**
 * Like {@link resolveSessionArg}, for a command that acts on the session:
 * the id must be the session the CLI runs in, so a session cannot claim
 * another session's notices.
 */
export function requireOwnSession(
  command: string,
  value: string,
  sources: SessionSources = defaultSessionSources(),
  hint = "use --peek to only print",
): CurrentSession {
  const current = currentSession(sources);
  if (!current) {
    throw new UsageError(`${command}: needs a Claude Code session, and none was found; ${hint}`);
  }
  if (value !== "current" && value !== current.sessionId) {
    throw new UsageError(`${command}: --session ${value} is not this Claude Code session; ${hint}`);
  }
  return current;
}
