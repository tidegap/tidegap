/**
 * Usage settings: the process environment first, then `~/.tidegap/config`
 * (the same precedence as `TIDEGAP_NOTIFY`), so the Mac app and the launchd
 * tick, which do not see a shell's variables, follow the config file.
 */

import { existsSync, readFileSync } from "node:fs";
import { carbonBudgetConfigPath, parseKeyValues } from "@tidegap/core";

import type { UsageEnv, UsageSettings } from "./types.js";

const OFF = /^(0|false|off|no)$/i;
const ON = /^(1|true|yes|on)$/i;

function configValues(path: string): Record<string, string> {
  try {
    return existsSync(path) ? parseKeyValues(readFileSync(path, "utf8")) : {};
  } catch {
    return {};
  }
}

export function resolveUsageSettings(env: UsageEnv, configPath: string = carbonBudgetConfigPath()): UsageSettings {
  const file = configValues(configPath);
  const usage = env.usage?.trim() || file.TIDEGAP_USAGE?.trim() || "";
  const oauth = env.oauth?.trim() || file.TIDEGAP_USAGE_OAUTH?.trim() || "";
  return { disabled: OFF.test(usage), oauth: ON.test(oauth) };
}
