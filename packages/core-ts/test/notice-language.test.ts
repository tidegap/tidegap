import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { loadNoticeLanguage, NoticeLanguageError, parseNoticeLanguage } from "../src/index.js";

describe("parseNoticeLanguage", () => {
  it("canonical code and English name", () => {
    expect(parseNoticeLanguage("ru")).toEqual({ code: "ru", name: "Russian" });
    expect(parseNoticeLanguage("pt-br")).toEqual({ code: "pt-BR", name: "Brazilian Portuguese" });
    expect(parseNoticeLanguage(" zh-Hant ")).toEqual({ code: "zh-Hant", name: "Traditional Chinese" });
  });

  it.each(["Russian", "xx-QQ-zz", "", "en_US", "xx", "ru\nX", "und", "zxx", "mul", "en-u-ca-buddhist", `ru-x-${"abcdefgh-".repeat(30)}a`, `de-${"1996-".repeat(8)}x`])("refuses %j", (input) => {
    expect(() => parseNoticeLanguage(input)).toThrow(NoticeLanguageError);
    expect(() => parseNoticeLanguage(input)).toThrow(/use a BCP 47 code such as ru/);
  });
});

describe("loadNoticeLanguage", () => {
  let dir: string;
  let config: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "tidegap-notice-language-"));
    config = join(dir, "config");
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("no file and no key: unset", () => {
    expect(loadNoticeLanguage(config)).toEqual({});
    writeFileSync(config, "TIDEGAP_DEFAULT_REGION=FR\n");
    expect(loadNoticeLanguage(config)).toEqual({});
  });

  it("a stored code; a value the setting refuses is ignored with the reason", () => {
    writeFileSync(config, "TIDEGAP_NOTICE_LANGUAGE=pt-br\n");
    expect(loadNoticeLanguage(config)).toEqual({ language: { code: "pt-BR", name: "Brazilian Portuguese" } });
    writeFileSync(config, "TIDEGAP_NOTICE_LANGUAGE=en-u-ca-buddhist\n");
    expect(loadNoticeLanguage(config).ignored?.value).toBe("en-u-ca-buddhist");
    writeFileSync(config, "TIDEGAP_NOTICE_LANGUAGE=??\n");
    expect(loadNoticeLanguage(config)).toEqual({ ignored: { key: "TIDEGAP_NOTICE_LANGUAGE", value: "??", reason: "not a language code with a name" } });
  });
});
