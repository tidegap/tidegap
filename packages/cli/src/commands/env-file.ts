/**
 * Shared secrets file: `~/.config/tidegap/env`.
 *
 * 0.17 kept it at `~/.config/ebb/env`. 0.18 still read that file; 0.19 does
 * not. While the old file holds keys the new one lacks (none of them, by
 * name, `EBB_*` counted as `TIDEGAP_*`), loading prints one stderr line
 * naming it, and `tidegap install` lists it under its warnings.
 *
 * A single standardized location for provider API keys that works
 * uniformly across launchd, systemd, and manual cron:
 *
 *   - `tidegap install` creates it (0600) with a commented template if it
 *     does not already exist, so the user has one obvious place to drop
 *     `ANTHROPIC_API_KEY=…`.
 *   - `tidegap tick` syncs it into `process.env` on every tick for any key
 *     not set by the real environment — this covers launchd (which passes a bare
 *     environment) AND systemd (belt-and-braces with `EnvironmentFile=`)
 *     AND a hand-rolled crontab entry.
 *
 * The parser is intentionally tiny (no dotenv dependency): `KEY=VALUE`
 * lines, `#` comments, blank lines, optional surrounding quotes.
 */

import { randomBytes } from "node:crypto";
import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/** Absolute path to the standardized secrets file. */
export function envFilePath(home: string = homedir()): string {
  return join(home, ".config", "tidegap", "env");
}

/** The 0.17 secrets file, never read since 0.19; only checked for the notice. */
function oldEnvFilePath(home: string): string {
  return join(home, ".config", "ebb", "env");
}

/** The keys of a secrets file, `EBB_*` named as `TIDEGAP_*`; none when missing or unreadable. */
function envFileKeys(path: string): string[] {
  try {
    if (!existsSync(path)) return [];
    return Object.keys(parseEnvFile(readFileSync(path, "utf8"))).map((k) =>
      k.startsWith("EBB_") ? `TIDEGAP_${k.slice(4)}` : k,
    );
  } catch {
    return [];
  }
}

/**
 * The notice for a 0.17 secrets file that holds keys while the new file has
 * none of them, else `undefined`. The template `tidegap install` writes has
 * no keys, so it does not hide the notice.
 */
export function oldEnvFileNotice(home: string = homedir()): string | undefined {
  const old = oldEnvFilePath(home);
  const oldKeys = envFileKeys(old);
  if (oldKeys.length === 0) return undefined;
  const current = new Set(envFileKeys(envFilePath(home)));
  if (oldKeys.some((k) => current.has(k))) return undefined;
  return (
    `tidegap: ${old} is no longer read (removed in 0.19); move its keys to ${envFilePath(home)} ` +
    "and rename its EBB_* keys to TIDEGAP_*."
  );
}

let oldEnvFileReported = false;

/** The commented template written when the file is first created. */
export function envFileTemplate(): string {
  return `# Tidegap secrets — KEY=VALUE per line. Loaded by \`tidegap tick\` at startup
# (and referenced by the systemd unit's EnvironmentFile=). This file is
# created 0600; keep it that way. Uncomment and fill the keys you use.
#
# Direct provider keys:
#ANTHROPIC_API_KEY=
#OPENAI_API_KEY=
#
# Per-region grid-data feed keys (only for the regions you schedule into):
#TIDEGAP_ELECTRICITY_MAPS_API_KEY=
#TIDEGAP_EIA_API_KEY=
#TIDEGAP_ENTSOE_SECURITY_TOKEN=
# WattTime marginal-emissions (US ISOs) — HTTP Basic login, takes
# precedence over EIA for the zones it covers. Username + password, not
# a single key:
#WATTTIME_USERNAME=
#WATTTIME_PASSWORD=
#
# Telegram: the token of a bot used only by Tidegap (from @BotFather), then
# run \`tidegap channels add telegram\`. TELEGRAM_BOT_TOKEN is read as a fallback.
#TIDEGAP_TELEGRAM_BOT_TOKEN=
`;
}

/**
 * Parse `KEY=VALUE` lines. Ignores blank lines and `#` comments.
 * Strips one layer of surrounding single/double quotes from the value.
 */
export function parseEnvFile(contents: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const rawLine of contents.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    if (!key) continue;
    let value = line.slice(eq + 1).trim();
    if (
      value.length >= 2 &&
      ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'")))
    ) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

/**
 * Names (never values) of the `process.env` keys the env file set, comma
 * separated. It lives in the environment so a child (the page's
 * `tick --daemon`) knows which inherited keys came from the file.
 */
export const ENV_FILE_KEYS_VAR = "TIDEGAP_ENV_FILE_KEYS";

function fileSourcedKeys(): Set<string> {
  return new Set((process.env[ENV_FILE_KEYS_VAR] ?? "").split(",").filter(Boolean));
}

/**
 * Sync the env file into `process.env`. A key not already set is applied; a
 * key the file set earlier follows the file (changed, or removed when the
 * file drops it or is gone); a key from the real environment always wins.
 * Safe to call on every tick. Returns the keys set or changed. With the
 * default path, a 0.17 secrets file whose keys the new file lacks gets one
 * stderr line per process.
 */
export function loadEnvFileIntoProcess(path?: string): string[] {
  if (path === undefined) {
    path = envFilePath();
    const notice = oldEnvFileReported ? undefined : oldEnvFileNotice();
    if (notice) {
      oldEnvFileReported = true;
      process.stderr.write(`${notice}\n`);
    }
  }
  let parsed: Record<string, string> = {};
  if (existsSync(path)) {
    try {
      parsed = parseEnvFile(readFileSync(path, "utf8"));
    } catch {
      // Unreadable now: keep what the last good read applied.
      return [];
    }
  }
  const tracked = fileSourcedKeys();
  const applied: string[] = [];
  for (const k of tracked) {
    if (k in parsed) continue;
    delete process.env[k];
    tracked.delete(k);
  }
  for (const [k, v] of Object.entries(parsed)) {
    if (!tracked.has(k) && process.env[k] !== undefined) continue;
    if (process.env[k] !== v) applied.push(k);
    process.env[k] = v;
    tracked.add(k);
  }
  if (tracked.size > 0) process.env[ENV_FILE_KEYS_VAR] = [...tracked].join(",");
  else delete process.env[ENV_FILE_KEYS_VAR];
  return applied;
}

export interface EnsureEnvFileResult {
  path: string;
  created: boolean;
}

/**
 * Create the secrets file (0600) with the commented template if it does not
 * already exist. Idempotent: never overwrites an existing file.
 */
export function ensureEnvFile(path: string = envFilePath()): EnsureEnvFileResult {
  if (existsSync(path)) return { path, created: false };
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, envFileTemplate(), { encoding: "utf8", mode: 0o600 });
  return { path, created: true };
}

/** A Telegram bot token: `<bot id>:<secret>`, nothing else (no space, no newline). */
export function isTelegramBotToken(value: string): boolean {
  return /^\d{5,12}:[A-Za-z0-9_-]{30,50}$/.test(value);
}

/** The active `KEY=` line's key, or the commented `#KEY=` template line's key. */
function lineKey(line: string): { key: string; active: boolean } | undefined {
  const m = /^\s*(#?)\s*([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(line);
  return m ? { key: m[2]!, active: m[1] === "" } : undefined;
}

/**
 * Set or remove one key in the secrets file (KTD4) and keep every other line
 * byte for byte. Setting replaces the first active `KEY=` line and drops later
 * active duplicates, else fills the template's `#KEY=` line, else appends.
 * Removing (`value` undefined) drops every active `KEY=` line; comments stay.
 * A symlinked file is written through to its target. The write is atomic:
 * a 0600 temp file in the same directory, fsync, rename.
 */
export function setEnvFileKey(path: string, key: string, value: string | undefined): void {
  if (value !== undefined && /[\r\n]/.test(value)) throw new Error("an env value cannot hold a line break");
  let target = path;
  try {
    target = realpathSync(path);
  } catch {
    // Missing file: create it at `path`.
  }
  mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
  let before = "";
  try {
    before = readFileSync(target, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
  const eol = before.includes("\r\n") ? "\r\n" : "\n";
  const lines = before === "" ? [] : before.split(/\r?\n/);
  // A trailing newline leaves one empty last element; keep it last.
  const trailing = lines.length > 0 && lines[lines.length - 1] === "";
  if (trailing) lines.pop();
  const next: string[] = [];
  let placed = value === undefined;
  for (const line of lines) {
    const k = lineKey(line);
    if (k?.key === key && k.active) {
      if (!placed) {
        next.push(`${key}=${value}`);
        placed = true;
      }
      continue;
    }
    next.push(line);
  }
  if (!placed) {
    const i = next.findIndex((l) => {
      const k = lineKey(l);
      return k?.key === key && !k.active;
    });
    if (i >= 0) next[i] = `${key}=${value}`;
    else next.push(`${key}=${value}`);
  }
  const out = next.length > 0 ? next.join(eol) + eol : "";
  const tmp = `${target}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  try {
    const fd = openSync(tmp, "w", 0o600);
    try {
      writeSync(fd, out);
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

/** The env-file keys that hold the Telegram bot token, preferred first. */
export const TELEGRAM_TOKEN_KEYS = ["TIDEGAP_TELEGRAM_BOT_TOKEN", "TELEGRAM_BOT_TOKEN"] as const;

/**
 * The bot token as the env file holds it, the way the listener unit reads it;
 * `undefined` when the file is missing or has no token. Read on each call, so
 * a long-running process sees a token saved after it started (KTD4).
 */
export function envFileTelegramToken(path: string = envFilePath()): string | undefined {
  let file: Record<string, string>;
  try {
    file = parseEnvFile(readFileSync(path, "utf8"));
  } catch {
    return undefined;
  }
  for (const key of TELEGRAM_TOKEN_KEYS) {
    const token = file[key]?.trim();
    if (token) return token;
  }
  return undefined;
}
