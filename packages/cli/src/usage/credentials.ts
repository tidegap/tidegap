/**
 * Read-only access to the active Claude Code login, the way claude-swap reads
 * it (KTD2). Used only when the OAuth usage read is turned on
 * (`TIDEGAP_USAGE_OAUTH=1`). Nothing here writes, refreshes or logs a token:
 * the token is returned to one caller for one request and never stored.
 */

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { join, resolve } from "node:path";

import { underTest } from "../env.js";
import type { LimitCause, UsageEnv } from "./types.js";

export const KEYCHAIN_SERVICE = "Claude Code-credentials";
const SECURITY_BIN = "/usr/bin/security";
const SECURITY_TIMEOUT_MS = 5_000;
/** `security find-generic-password` exit code for "item not found". */
const NOT_FOUND = 44;

export interface SecurityResult {
  code: number | null;
  stdout: string;
  timedOut: boolean;
}
/** Runs `/usr/bin/security` with an argv array (no shell). */
export type SecurityRunner = (args: string[], timeoutMs: number) => Promise<SecurityResult>;

export const defaultSecurityRunner: SecurityRunner = (args, timeoutMs) => {
  // Tests inject a runner; reaching the real Keychain from a test is a bug.
  if (underTest()) return Promise.reject(new Error("security runner not injected under test"));
  return new Promise((done) => {
    const child = spawn(SECURITY_BIN, args, { stdio: ["ignore", "pipe", "ignore"] });
    let stdout = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);
    child.stdout.setEncoding("utf8").on("data", (d: string) => (stdout += d));
    child.on("error", () => {
      clearTimeout(timer);
      done({ code: null, stdout: "", timedOut });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      done({ code, stdout, timedOut });
    });
  });
};

export interface CredentialDeps {
  env: UsageEnv;
  home?: string;
  platform?: NodeJS.Platform;
  runSecurity?: SecurityRunner;
  /** File reader; undefined for a missing file. */
  readFile?: (path: string) => string | undefined;
  now?: Date;
}

export type TokenResult = { ok: true; token: string } | { ok: false; cause: LimitCause };

function hashedService(value: string): string {
  const hex = createHash("sha256").update(value.normalize("NFC")).digest("hex");
  return `${KEYCHAIN_SERVICE}-${hex.slice(0, 8)}`;
}

/** Keychain service names to try, in order (KTD2.1). */
export function keychainServiceNames(env: UsageEnv, home: string = homedir()): string[] {
  const secure = env.claudeSecureStorageConfigDir;
  if (secure !== undefined) return [secure === "" ? KEYCHAIN_SERVICE : hashedService(secure)];
  const dir = env.claudeConfigDir;
  if (dir) {
    const names = [hashedService(dir)];
    if (resolve(dir) === resolve(join(home, ".claude"))) names.push(KEYCHAIN_SERVICE);
    return names;
  }
  return [KEYCHAIN_SERVICE];
}

function defaultReadFile(path: string): string | undefined {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
}

/** The token from a credentials JSON document, or why there is none. */
function parseCredential(text: string, now: Date): TokenResult {
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch {
    return { ok: false, cause: "not_logged_in" };
  }
  const o = (doc ?? {}) as { claudeAiOauth?: { accessToken?: unknown; expiresAt?: unknown }; primaryApiKey?: unknown };
  const oauth = o.claudeAiOauth;
  if (oauth && typeof oauth.accessToken === "string" && oauth.accessToken) {
    if (typeof oauth.expiresAt === "number" && oauth.expiresAt <= now.getTime()) {
      return { ok: false, cause: "token_expired" };
    }
    return { ok: true, token: oauth.accessToken };
  }
  if (typeof o.primaryApiKey === "string" && o.primaryApiKey) return { ok: false, cause: "api_key" };
  return { ok: false, cause: "not_logged_in" };
}

/** The active login's OAuth token, read-only (KTD2 steps 2-4). */
export async function readClaudeToken(deps: CredentialDeps): Promise<TokenResult> {
  const home = deps.home ?? homedir();
  const platform = deps.platform ?? process.platform;
  const readFile = deps.readFile ?? defaultReadFile;
  const now = deps.now ?? new Date();
  let keychainFailed = false;
  if (platform === "darwin") {
    const run = deps.runSecurity ?? defaultSecurityRunner;
    const account = deps.env.user || userInfo().username;
    for (const service of keychainServiceNames(deps.env, home)) {
      let res: SecurityResult;
      try {
        res = await run(["find-generic-password", "-a", account, "-s", service, "-w"], SECURITY_TIMEOUT_MS);
      } catch {
        keychainFailed = true;
        break;
      }
      if (res.code === 0 && !res.timedOut) return parseCredential(res.stdout.trim(), now);
      if (res.code === NOT_FOUND && !res.timedOut) continue;
      keychainFailed = true;
      break;
    }
  }
  const configHome = deps.env.claudeConfigDir || join(home, ".claude");
  const file = readFile(join(configHome, ".credentials.json"));
  if (file !== undefined) return parseCredential(file, now);
  if (keychainFailed) return { ok: false, cause: "keychain_unavailable" };
  const legacy = readFile(deps.env.claudeConfigDir ? join(configHome, ".claude.json") : join(home, ".claude.json"));
  // A managed API key login has no subscription limits.
  if (legacy !== undefined) {
    const r = parseCredential(legacy, now);
    if (!r.ok && r.cause === "api_key") return r;
  }
  return { ok: false, cause: "not_logged_in" };
}
