/**
 * `tidegap language [show] | set <code> | reset`: the language a job's
 * summarize step writes in, stored as `TIDEGAP_NOTICE_LANGUAGE` in
 * `~/.tidegap/config`. Unset, the summary follows the job title's
 * language. A job's own prompt still wins when it names a language. A
 * change applies to the next run, with no restart.
 */

import {
  carbonBudgetConfigPath,
  loadNoticeLanguage,
  NOTICE_LANGUAGE_KEY,
  NoticeLanguageError,
  parseNoticeLanguage,
  stripControlChars,
  type NoticeLanguage,
  type NoticeLanguageSetting,
} from "@tidegap/core";

import { setEnvFileKey } from "./commands/env-file.js";

export interface LanguageCommandResult {
  exitCode: number;
  /** stdout text. */
  out?: string;
  /** stderr text. */
  err?: string;
}

export interface LanguageCommandOptions {
  json?: boolean;
  /** `~/.tidegap/config` override (tests). */
  config?: string;
}

function viewJson(setting: NoticeLanguageSetting): string {
  const { language, ignored } = setting;
  return JSON.stringify(
    {
      language: language?.code ?? null,
      name: language?.name ?? null,
      source: language ? "setting" : "unset",
      ignored: ignored ? [ignored] : [],
    },
    null,
    2,
  );
}

/** The value and its source, then the ignored line, if any. */
function formatLanguageView(setting: NoticeLanguageSetting): string {
  const lines = [setting.language ? `${setting.language.code} (${setting.language.name}), from ~/.tidegap/config` : "unset: the job title's language"];
  if (setting.ignored) lines.push(`Ignored line: ${setting.ignored.key}=${stripControlChars(setting.ignored.value)}: ${setting.ignored.reason}`);
  return lines.join("\n");
}

function view(path: string, opts: LanguageCommandOptions, head?: string): LanguageCommandResult {
  const setting = loadNoticeLanguage(path);
  if (opts.json) return { exitCode: 0, out: viewJson(setting) };
  return { exitCode: 0, out: [head, formatLanguageView(setting)].filter(Boolean).join("\n") };
}

export function runLanguageShow(opts: LanguageCommandOptions = {}): LanguageCommandResult {
  return view(opts.config ?? carbonBudgetConfigPath(), opts);
}

export function runLanguageSet(code: string, opts: LanguageCommandOptions = {}): LanguageCommandResult {
  const path = opts.config ?? carbonBudgetConfigPath();
  let language: NoticeLanguage;
  try {
    language = parseNoticeLanguage(code);
  } catch (err) {
    if (err instanceof NoticeLanguageError) return { exitCode: 2, err: `language set: ${err.message}` };
    throw err;
  }
  setEnvFileKey(path, NOTICE_LANGUAGE_KEY, language.code);
  return view(path, opts, `Set ${NOTICE_LANGUAGE_KEY}=${language.code} in ~/.tidegap/config.`);
}

export function runLanguageReset(opts: LanguageCommandOptions = {}): LanguageCommandResult {
  const path = opts.config ?? carbonBudgetConfigPath();
  setEnvFileKey(path, NOTICE_LANGUAGE_KEY, undefined);
  return view(path, opts, `Removed ${NOTICE_LANGUAGE_KEY} from ~/.tidegap/config.`);
}
