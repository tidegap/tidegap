/**
 * The `@tidegap/mcp` server's environment boundary.
 *
 * `@tidegap/core` is an environment-pure library: it reads no environment
 * variables and takes every credential as an explicit argument. The MCP server
 * is a HOST, so reading the environment is its job — and this module is the
 * single place it happens. Every variable is read BY NAME into a closed shape;
 * the whole process environment object is never bound to a local or handed to
 * core.
 *
 * Behaviour is unchanged from before core became environment-pure: the same
 * variables, the same precedence (GEMINI_API_KEY before GOOGLE_API_KEY).
 *
 * The Tidegap variables are named `TIDEGAP_*`. 0.19 removed the 0.17 `EBB_*`
 * fallback: a left-over `EBB_*` variable (or `EBB_*` key in
 * `~/.tidegap/config`) is never used, and the process prints one stderr line
 * naming every such name and its new name.
 *
 * See also: `packages/cli/src/env.ts` (the CLI's copy of this boundary) and
 * `packages/openclaw-plugin` — which has NO environment boundary at all,
 * taking everything from OpenClaw plugin config so its published bundle
 * contains zero environment reads.
 */

import { existsSync, readFileSync } from "node:fs";
import { carbonBudgetConfigPath, parseKeyValues, type CarbonBudgetEnv, type GridFeedCredentials } from "@tidegap/core";
import type { UsageEnv } from "@tidegap/cli/usage";

/** Provider credentials the MCP server forwards to `@tidegap/core`'s adapters. */
export interface ProviderCredentials {
  /** `ANTHROPIC_API_KEY` */
  anthropicApiKey?: string;
  /** `OPENAI_API_KEY` */
  openaiApiKey?: string;
  /** `GEMINI_API_KEY`, else `GOOGLE_API_KEY` */
  geminiApiKey?: string;
  /** `OLLAMA_HOST` (opt-in: unset means "do not register the Ollama adapter") */
  ollamaHost?: string;
}

export interface EnvCredentials extends ProviderCredentials {
  /** Grid-feed credentials for `buildDefaultGridFeed`. */
  grid: GridFeedCredentials;
  /** Aggregate carbon-budget overrides for `loadCarbonBudgetConfig`. */
  carbonBudget: CarbonBudgetEnv;
  /** `TIDEGAP_DB_PATH`: explicit queue path (`:memory:` for no persistence). */
  dbPath?: string;
  /** `TIDEGAP_DEFAULT_REGION`: region when a tool call omits one. */
  defaultRegion?: string;
  /** `TIDEGAP_DEFAULT_MODEL`: Anthropic model override. */
  defaultModel?: string;
}

/** Trim and collapse an empty string to `undefined`. */
function val(raw: string | undefined): string | undefined {
  const v = raw?.trim();
  return v ? v : undefined;
}

/** Receives the one line about left-over `EBB_*` names. */
export type NoticeWriter = (line: string) => void;

let noticeReported = false;

/** Default writer: stderr, once per process. */
const writeOnce: NoticeWriter = (line) => {
  if (noticeReported) return;
  noticeReported = true;
  process.stderr.write(`${line}\n`);
};

/** The `TIDEGAP_<NAME>` suffixes whose 0.17 `EBB_<NAME>` twin is reported when left over. */
const RENAMED = ["ELECTRICITY_MAPS_API_KEY", "EIA_API_KEY", "ENTSOE_SECURITY_TOKEN", "CARBON_BUDGET_G", "CARBON_BUDGET_WINDOW", "DB_PATH", "DEFAULT_REGION", "DEFAULT_MODEL"] as const;

/**
 * The 0.17 names that are set but no longer read: an `EBB_<NAME>` variable
 * whose `TIDEGAP_<NAME>` twin is unset, and every `EBB_*` key in
 * `~/.tidegap/config`. Values are never read.
 */
function leftOverNames(): string[] {
  const out: string[] = [];
  for (const name of RENAMED) {
    if (val(process.env[`EBB_${name}`]) !== undefined && val(process.env[`TIDEGAP_${name}`]) === undefined) {
      out.push(`EBB_${name}`);
    }
  }
  try {
    const path = carbonBudgetConfigPath();
    if (existsSync(path)) {
      for (const key of Object.keys(parseKeyValues(readFileSync(path, "utf8")))) {
        if (key.startsWith("EBB_") && !out.includes(key)) out.push(key);
      }
    }
  } catch {
    // An unreadable config is the loaders' concern, not this notice's.
  }
  return out;
}

/** One line naming every left-over `EBB_*` name and its new name. */
function reportLeftOverNames(write: NoticeWriter): void {
  const names = leftOverNames();
  if (names.length === 0) return;
  const renames = names.map((n) => `${n} -> TIDEGAP_${n.slice(4)}`).join(", ");
  write(`tidegap: EBB_* names are no longer read (removed in 0.19); rename ${renames}.`);
}

/**
 * Snapshot every environment variable the MCP server recognizes, by name.
 * Call this at an entry point and pass the result down — never re-read the
 * environment deeper in the call tree. Left-over `EBB_*` names go to `write`
 * (default: one stderr line per process).
 */
export function readEnvCredentials(write: NoticeWriter = writeOnce): EnvCredentials {
  const out: EnvCredentials = {
    anthropicApiKey: val(process.env.ANTHROPIC_API_KEY),
    openaiApiKey: val(process.env.OPENAI_API_KEY),
    geminiApiKey: val(process.env.GEMINI_API_KEY) ?? val(process.env.GOOGLE_API_KEY),
    ollamaHost: val(process.env.OLLAMA_HOST),
    grid: {
      electricityMapsApiKey: val(process.env.TIDEGAP_ELECTRICITY_MAPS_API_KEY),
      eiaApiKey: val(process.env.TIDEGAP_EIA_API_KEY),
      entsoeSecurityToken: val(process.env.TIDEGAP_ENTSOE_SECURITY_TOKEN),
      wattTimeUsername: val(process.env.WATTTIME_USERNAME),
      wattTimePassword: val(process.env.WATTTIME_PASSWORD),
    },
    carbonBudget: {
      TIDEGAP_CARBON_BUDGET_G: process.env.TIDEGAP_CARBON_BUDGET_G,
      TIDEGAP_CARBON_BUDGET_WINDOW: process.env.TIDEGAP_CARBON_BUDGET_WINDOW,
    },
    dbPath: process.env.TIDEGAP_DB_PATH,
    defaultRegion: process.env.TIDEGAP_DEFAULT_REGION,
    defaultModel: process.env.TIDEGAP_DEFAULT_MODEL,
  };
  reportLeftOverNames(write);
  return out;
}

/**
 * The usage settings and Claude Code location variables, by name (same
 * names as the CLI): `TIDEGAP_USAGE`, `TIDEGAP_USAGE_OAUTH`,
 * `CLAUDE_CONFIG_DIR`, `CLAUDE_SECURESTORAGE_CONFIG_DIR` (defined-but-empty
 * is meaningful) and `USER` (the Keychain account).
 */
export function readUsageEnv(): UsageEnv {
  return {
    usage: val(process.env.TIDEGAP_USAGE),
    oauth: val(process.env.TIDEGAP_USAGE_OAUTH),
    claudeConfigDir: val(process.env.CLAUDE_CONFIG_DIR),
    claudeSecureStorageConfigDir: process.env.CLAUDE_SECURESTORAGE_CONFIG_DIR,
    user: val(process.env.USER),
  };
}
