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
 *   - `tidegap tick` loads it at startup into `process.env` for any key not
 *     already present — this covers launchd (which passes a bare
 *     environment) AND systemd (belt-and-braces with `EnvironmentFile=`)
 *     AND a hand-rolled crontab entry.
 *
 * The parser is intentionally tiny (no dotenv dependency): `KEY=VALUE`
 * lines, `#` comments, blank lines, optional surrounding quotes.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
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
 * Load the env file into `process.env` for any key not already set.
 * Returns the keys that were applied. A missing file is a no-op. With the
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
  if (!existsSync(path)) return [];
  let parsed: Record<string, string>;
  try {
    parsed = parseEnvFile(readFileSync(path, "utf8"));
  } catch {
    return [];
  }
  const applied: string[] = [];
  for (const [k, v] of Object.entries(parsed)) {
    if (process.env[k] === undefined) {
      process.env[k] = v;
      applied.push(k);
    }
  }
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
