/**
 * Host side of the claude-code provider: find the `claude` binary, build
 * the child environment, and parse the budget cap and the default tool set. `tidegap tick` uses
 * these to construct {@link ClaudeCodeAdapter}.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { accessSync, constants, realpathSync, statSync } from "node:fs";
import { homedir, platform as osPlatform } from "node:os";
import { delimiter, dirname, isAbsolute, join } from "node:path";
import { claudeCodeToolsError, DEFAULT_CLAUDE_CODE_TOOLS } from "@tidegap/core";
import { underTest, type EnvCredentials } from "./env.js";
import { DEFAULT_MAX_BUDGET_USD, DEFAULT_RESUME_MAX_BUDGET_USD } from "./providers/claude-code.js";
import { singleFlight } from "./usage/host.js";

/** Lookup inputs. Tests inject them; production uses the real machine. */
export interface ClaudeLookup {
  /** The `PATH` to search. */
  path?: string;
  home?: string;
  platform?: NodeJS.Platform;
  isExecutable?: (path: string) => boolean;
  /** macOS login-shell lookup: the path `command -v claude` prints, or undefined. */
  loginShell?: () => Promise<string | undefined>;
}

const LOGIN_SHELL_TIMEOUT_MS = 5_000;
const MARKER = "__TIDEGAP_CLAUDE__";

const WORLD_WRITABLE = 0o002;

/**
 * An executable regular file that no other user can swap: neither the file
 * nor its directory (for a symlink, at both ends) is world-writable.
 */
export function isExecutableFile(path: string): boolean {
  try {
    const real = realpathSync(path);
    const file = statSync(real);
    if (!file.isFile() || file.mode & WORLD_WRITABLE) return false;
    for (const dir of new Set([dirname(path), dirname(real)])) {
      if (statSync(dir).mode & WORLD_WRITABLE) return false;
    }
    accessSync(real, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** `zsh -ilc` prints `command -v claude` after this marker, past any startup-file output. */
const LOGIN_SHELL_ARGS = ["-ilc", `printf '${MARKER}%s\\n' "$(command -v claude)"`];

/**
 * The same lookup as the Mac app's `ServerLauncher.queryLoginShell`, bounded
 * here, where the answer is used. An interactive zsh ignores SIGTERM, so at
 * `timeoutMs` the shell gets SIGKILL and the query answers at once with what
 * the shell printed so far (`login-shell-query-that-ignores-sigterm.md`). It
 * never blocks the event loop, and it waits at most `timeoutMs`, also when a
 * child that a startup file started keeps stdout open. A shell that cannot
 * start answers nothing; the query never rejects. `shell`, `timeoutMs` and
 * `start` are for tests.
 */
export function queryLoginShell(
  shell = "/bin/zsh",
  timeoutMs = LOGIN_SHELL_TIMEOUT_MS,
  start: (file: string, args: string[], opts: { stdio: ["ignore", "pipe", "ignore"] }) => ChildProcess = spawn,
): Promise<string | undefined> {
  return new Promise((resolve) => {
    let stdout = "";
    let timer: NodeJS.Timeout | undefined;
    const settle = () => {
      clearTimeout(timer);
      const line = stdout.split("\n").reverse().find((l) => l.startsWith(MARKER));
      resolve(line?.slice(MARKER.length).trim() || undefined);
    };
    let child: ChildProcess;
    try {
      child = start(shell, LOGIN_SHELL_ARGS, { stdio: ["ignore", "pipe", "ignore"] });
    } catch {
      // spawn throws for some errors that spawnSync returned.
      return settle();
    }
    // First: on EMFILE or ENFILE the child has no stdout and reports only here.
    child.on("error", settle);
    child.on("close", settle);
    timer = setTimeout(() => {
      child.kill("SIGKILL");
      child.stdout?.destroy();
      settle();
    }, timeoutMs);
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => (stdout += chunk));
  });
}

/** Overlapping lookups in one process (the UI's status and summary) share one login shell. */
const sharedLoginShell = singleFlight(() => queryLoginShell());

/** Steps 2-4 of the lookup: PATH, known locations, the macOS login shell. */
async function searchMachine(lookup: Required<ClaudeLookup>, needsClaude: () => boolean): Promise<string | undefined> {
  const { home, isExecutable } = lookup;
  const candidates = [
    ...lookup.path.split(delimiter).filter(Boolean).map((dir) => join(dir, "claude")),
    join(home, ".local", "bin", "claude"),
    join(home, ".claude", "local", "claude"),
    "/opt/homebrew/bin/claude",
    "/usr/local/bin/claude",
  ];
  const hit = candidates.find((p) => isExecutable(p));
  if (hit) return hit;
  // The login shell sources the user's interactive zsh config, so it runs
  // only when a pending task actually needs Claude Code.
  if (lookup.platform !== "darwin" || !needsClaude()) return undefined;
  const fromShell = await lookup.loginShell();
  return fromShell && isAbsolute(fromShell) && isExecutable(fromShell) ? fromShell : undefined;
}

let cachedHit: string | undefined;

/**
 * The `claude` binary for the claude-code adapter, or undefined.
 *
 * Order: `TIDEGAP_CLAUDE_BIN`, then each `PATH` directory, then the known
 * install locations, then (macOS only, and only when `needsClaude()` says a
 * pending task needs it) the login shell. `TIDEGAP_CLAUDE_CODE=0` turns the
 * lookup off. A hit is cached for the process. Under a test runner nothing
 * is looked up unless the test injects `lookup`, so no test finds the
 * developer's real `claude`.
 */
export async function findClaudeBinary(
  env: Pick<EnvCredentials, "claudeBin" | "claudeCodeDisabled">,
  needsClaude: () => boolean,
  lookup?: ClaudeLookup,
): Promise<string | undefined> {
  if (env.claudeCodeDisabled) return undefined;
  if (!lookup && underTest()) return undefined;
  // An explicit TIDEGAP_CLAUDE_BIN is used as given, with no PATH fallback;
  // a missing or non-executable file means no claude-code runner.
  if (env.claudeBin) return (lookup?.isExecutable ?? isExecutableFile)(env.claudeBin) ? env.claudeBin : undefined;
  if (!lookup && cachedHit) return cachedHit;
  const found = await searchMachine(
    {
      path: process.env.PATH ?? "",
      home: homedir(),
      platform: osPlatform(),
      isExecutable: isExecutableFile,
      loginShell: sharedLoginShell,
      ...lookup,
    },
    needsClaude,
  );
  if (!lookup) cachedHit = found;
  return found;
}

/**
 * Variables the child must not see. An Anthropic API key or auth token would
 * bypass the subscription login; the nested-session markers would make
 * Claude Code think it runs inside another session; the other provider and
 * grid-feed credentials (often loaded from `~/.config/tidegap/env`) are none
 * of its business. Every `TIDEGAP_*` variable is dropped as well. The
 * session variables of a Claude Code session that started this tick are
 * dropped too (KTD15), so the run is not that session's child.
 * `CLAUDE_CONFIG_DIR` stays: it names where the user's sessions live.
 */
const DROPPED_FOR_CHILD = new Set([
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "CLAUDECODE",
  "CLAUDE_CODE_ENTRYPOINT",
  "CLAUDE_CODE_SESSION_ID",
  "CLAUDE_PROJECT_DIR",
  "CLAUDE_PID",
  "CLAUDE_CODE_CHILD_SESSION",
  "CLAUDE_CODE_SESSION_ATTENDED",
  "CLAUDE_CODE_BRIDGE_SESSION_ID",
  "CLAUDE_CODE_MESSAGING_SOCKET",
  "CLAUDE_CODE_MESSAGING_TOKEN",
  "OPENAI_API_KEY",
  "GEMINI_API_KEY",
  "GOOGLE_API_KEY",
  "WATTTIME_USERNAME",
  "WATTTIME_PASSWORD",
]);

/** A copy of `source` for the `claude` child process, without the dropped variables. */
export function claudeChildEnv(
  source: Record<string, string | undefined> = process.env,
): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(source)) {
    if (!DROPPED_FOR_CHILD.has(key) && !key.startsWith("TIDEGAP_")) out[key] = value;
  }
  return out;
}

/** Parse `TIDEGAP_CLAUDE_CODE_MAX_BUDGET_USD`; an invalid value falls back to the default with a warning. */
export function claudeMaxBudget(
  raw: string | undefined,
  name = "TIDEGAP_CLAUDE_CODE_MAX_BUDGET_USD",
  fallback = DEFAULT_MAX_BUDGET_USD,
): { usd: number; warning?: string } {
  if (raw === undefined) return { usd: fallback };
  const n = Number(raw);
  if (Number.isFinite(n) && n > 0) return { usd: n };
  return {
    usd: fallback,
    warning: `!! WARNING: ${name}=${JSON.stringify(raw)} is not a positive number; using ${fallback}.`,
  };
}

/** Parse `TIDEGAP_CLAUDE_CODE_RESUME_MAX_BUDGET_USD` (KTD10), default 3. */
export function claudeResumeMaxBudget(raw: string | undefined): { usd: number; warning?: string } {
  return claudeMaxBudget(raw, "TIDEGAP_CLAUDE_CODE_RESUME_MAX_BUDGET_USD", DEFAULT_RESUME_MAX_BUDGET_USD);
}

/**
 * Parse `TIDEGAP_CLAUDE_TOOLS`: a comma list from the allowlist, empty = no
 * tools. Unset or invalid keeps the default (an invalid value also warns).
 */
export function claudeTools(raw: string | undefined): { tools: string[]; warning?: string } {
  if (raw === undefined) return { tools: [...DEFAULT_CLAUDE_CODE_TOOLS] };
  const tools = raw.split(",").map((t) => t.trim()).filter((t) => t.length > 0);
  const error = claudeCodeToolsError(tools);
  if (!error) return { tools };
  return {
    tools: [...DEFAULT_CLAUDE_CODE_TOOLS],
    warning: `!! WARNING: TIDEGAP_CLAUDE_TOOLS=${JSON.stringify(raw)}: ${error}; using ${DEFAULT_CLAUDE_CODE_TOOLS.join(",")}.`,
  };
}
