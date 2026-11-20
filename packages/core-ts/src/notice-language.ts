/**
 * The notice language: the language a job's summarize step writes in, a
 * user-level setting in `~/.tidegap/config` (`tidegap language set <code>`).
 * Unset, the summary follows the language of the job title. The file is
 * read on each call, so a change applies to the next run with no restart.
 */

import { readFileSync } from "node:fs";

import { carbonBudgetConfigPath, parseKeyValues } from "./budget.js";

/** The `~/.tidegap/config` key of the notice language. */
export const NOTICE_LANGUAGE_KEY = "TIDEGAP_NOTICE_LANGUAGE";

/** A language the setting accepts: its canonical BCP 47 code and its English name. */
export interface NoticeLanguage {
  code: string;
  name: string;
}

/** A code the setting refuses; the message is the sentence to print. */
export class NoticeLanguageError extends Error {
  override name = "NoticeLanguageError";
}

/** The setting as the file holds it: the language, or the stored line that is not used and why. */
export interface NoticeLanguageSetting {
  language?: NoticeLanguage;
  ignored?: { key: string; value: string; reason: string };
}

const NAMES = new Intl.DisplayNames(["en"], { type: "language", fallback: "none" });

/** Most characters of a stored code: a language, script, region and variant fit (RFC 5646 section 4.4.1). */
const NOTICE_LANGUAGE_MAX_CHARS = 35;

/** An extension or private-use part (`-u-`, `-t-`, `-x-`): a reply language needs none, and the ICU builds disagree on its name. */
const SINGLETON = /(?:^|-)[a-z0-9](?:-|$)/i;

/** Codes that name no language to write in: undetermined, multiple, uncoded and no linguistic content. */
const NOT_A_LANGUAGE: ReadonlySet<string> = new Set(["und", "mul", "mis", "zxx"]);

/**
 * A language code as the setting stores it: canonical (`pt-br` gives
 * `pt-BR`) and with an English name (`Brazilian Portuguese`). Throws
 * {@link NoticeLanguageError} for anything that is not a BCP 47 code with
 * a name, such as `Russian`, `en_US`, `und`, an empty string, a code with
 * an extension (`ru-u-ca-gregory`) or a code longer than 35 characters.
 */
export function parseNoticeLanguage(input: string): NoticeLanguage {
  const text = input.trim();
  let code: string | undefined;
  let name: string | undefined;
  try {
    // DisplayNames throws a RangeError for some valid tags (extensions, long private use).
    code = text.length <= NOTICE_LANGUAGE_MAX_CHARS && !SINGLETON.test(text) ? Intl.getCanonicalLocales(text)[0] : undefined;
    name = code && !NOT_A_LANGUAGE.has(code.split("-")[0]!) ? NAMES.of(code) : undefined;
  } catch {
    name = undefined;
  }
  if (!code || !name) {
    throw new NoticeLanguageError(`${JSON.stringify(input)} is not a language code; use a BCP 47 code such as ru, de, pt-BR or zh-Hant`);
  }
  return { code, name };
}

/** The notice language stored in `path` (default `~/.tidegap/config`); a value the setting refuses is reported as ignored. */
export function loadNoticeLanguage(path: string = carbonBudgetConfigPath()): NoticeLanguageSetting {
  let contents: string;
  try {
    contents = readFileSync(path, "utf8");
  } catch {
    return {};
  }
  const value = parseKeyValues(contents)[NOTICE_LANGUAGE_KEY];
  if (value === undefined) return {};
  try {
    return { language: parseNoticeLanguage(value) };
  } catch (err) {
    if (!(err instanceof NoticeLanguageError)) throw err;
    return { ignored: { key: NOTICE_LANGUAGE_KEY, value, reason: "not a language code with a name" } };
  }
}
