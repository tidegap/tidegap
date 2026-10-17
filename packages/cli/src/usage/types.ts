/** Shapes shared by the usage module (`@tidegap/cli/usage`). */

/** One limit window: percent used (0-100, can exceed 100) and its reset. */
export interface LimitWindow {
  pct: number;
  /** ISO-8601 instant. */
  resets_at: string;
}

/** A per-model weekly window (for example "Fable"), OAuth source only. */
export interface ScopedWindow extends LimitWindow {
  model: string;
}

/** Normalized Claude subscription limits. */
export interface ClaudeLimits {
  five_hour?: LimitWindow;
  seven_day?: LimitWindow;
  scoped: ScopedWindow[];
}

/** Why limit state is missing or old (R4). */
export type LimitCause =
  | "no_data"
  | "not_logged_in"
  | "api_key"
  | "token_expired"
  | "keychain_unavailable"
  | "rate_limited"
  | "network"
  | "api_error";

export interface ClaudeLimitState {
  status: "ok" | "unavailable" | "disabled";
  /** Where the values came from: the statusline hook, a live API read, or the API cache. */
  source?: "statusline" | "api" | "cache";
  fetched_at?: string;
  age_s?: number;
  /** A last good value served after a failed read, or older than the TTL. */
  stale: boolean;
  five_hour?: LimitWindow;
  seven_day?: LimitWindow;
  scoped: ScopedWindow[];
  error?: { cause: LimitCause; message: string };
}

/** Raw usage settings, read by name by the host's env boundary. */
export interface UsageEnv {
  /** `TIDEGAP_USAGE`: `off` (or 0/false/no) turns off every limit read. */
  usage?: string;
  /** `TIDEGAP_USAGE_OAUTH`: `1` (or true/yes/on) turns on the OAuth usage API read. */
  oauth?: string;
  /** `CLAUDE_CONFIG_DIR`, untrimmed. */
  claudeConfigDir?: string;
  /** `CLAUDE_SECURESTORAGE_CONFIG_DIR`, untrimmed; "" is meaningful. */
  claudeSecureStorageConfigDir?: string;
  /** `USER`: the Keychain account. */
  user?: string;
}

export interface UsageSettings {
  disabled: boolean;
  oauth: boolean;
}
