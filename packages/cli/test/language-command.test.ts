/** `tidegap language`: show, set and reset the notice language in `~/.tidegap/config`, other lines byte for byte. */

import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { runLanguageReset, runLanguageSet, runLanguageShow } from "../src/language.js";

let dir: string;
let config: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "tidegap-language-"));
  config = join(dir, "config");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("tidegap language", () => {
  it("unset on an empty file", () => {
    expect(runLanguageShow({ config })).toEqual({ exitCode: 0, out: "unset: the job title's language" });
    expect(JSON.parse(runLanguageShow({ config, json: true }).out!)).toEqual({ language: null, name: null, source: "unset", ignored: [] });
  });

  it("set ru stores the key and keeps every other line byte for byte; show names it; reset removes it", () => {
    const before = "# my settings\r\nTIDEGAP_DEFAULT_REGION=FR\r\n";
    writeFileSync(config, before);
    const set = runLanguageSet("ru", { config });
    expect(set).toEqual({ exitCode: 0, out: "Set TIDEGAP_NOTICE_LANGUAGE=ru in ~/.tidegap/config.\nru (Russian), from ~/.tidegap/config" });
    expect(readFileSync(config, "utf8")).toBe(`${before}TIDEGAP_NOTICE_LANGUAGE=ru\r\n`);
    expect(runLanguageShow({ config }).out).toBe("ru (Russian), from ~/.tidegap/config");
    expect(JSON.parse(runLanguageShow({ config, json: true }).out!)).toEqual({ language: "ru", name: "Russian", source: "setting", ignored: [] });
    const reset = runLanguageReset({ config });
    expect(reset.out).toBe("Removed TIDEGAP_NOTICE_LANGUAGE from ~/.tidegap/config.\nunset: the job title's language");
    expect(readFileSync(config, "utf8")).toBe(before);
  });

  it("set stores the canonical code", () => {
    expect(runLanguageSet("pt-br", { config }).exitCode).toBe(0);
    expect(readFileSync(config, "utf8")).toBe("TIDEGAP_NOTICE_LANGUAGE=pt-BR\n");
  });

  it("set Russian exits 2 with a valid code example and writes nothing", () => {
    expect(runLanguageSet("Russian", { config })).toEqual({
      exitCode: 2,
      err: 'language set: "Russian" is not a language code; use a BCP 47 code such as ru, de, pt-BR or zh-Hant',
    });
    expect(existsSync(config)).toBe(false);
  });

  it("set with an extension subtag or a code past 35 characters exits 2 and writes nothing", () => {
    for (const code of ["ru-u-ca-gregory", "en-Latn-US-x-foo", `de-${"a".repeat(40)}`, "und", "zxx"]) {
      expect(runLanguageSet(code, { config }).exitCode).toBe(2);
    }
    expect(existsSync(config)).toBe(false);
    writeFileSync(config, "TIDEGAP_NOTICE_LANGUAGE=ru-u-ca-gregory\n");
    expect(runLanguageShow({ config }).out).toBe("unset: the job title's language\nIgnored line: TIDEGAP_NOTICE_LANGUAGE=ru-u-ca-gregory: not a language code with a name");
  });

  it("a stored value the setting refuses is listed as ignored", () => {
    writeFileSync(config, "TIDEGAP_NOTICE_LANGUAGE=??\n");
    expect(runLanguageShow({ config }).out).toBe("unset: the job title's language\nIgnored line: TIDEGAP_NOTICE_LANGUAGE=??: not a language code with a name");
    expect(JSON.parse(runLanguageShow({ config, json: true }).out!).ignored).toEqual([{ key: "TIDEGAP_NOTICE_LANGUAGE", value: "??", reason: "not a language code with a name" }]);
  });
});
