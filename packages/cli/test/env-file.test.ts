import { lstatSync, mkdirSync, mkdtempSync, rmSync, statSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  ensureEnvFile,
  envFileTemplate,
  isTelegramBotToken,
  setEnvFileKey,
  ENV_FILE_KEYS_VAR,
  loadEnvFileIntoProcess,
  parseEnvFile,
} from "../src/commands/env-file.js";

describe("parseEnvFile", () => {
  it("parses KEY=VALUE lines, ignoring comments and blanks", () => {
    const parsed = parseEnvFile(
      ["# comment", "", "ANTHROPIC_API_KEY=sk-abc", "  OPENAI_API_KEY = sk-def "].join(
        "\n",
      ),
    );
    expect(parsed.ANTHROPIC_API_KEY).toBe("sk-abc");
    expect(parsed.OPENAI_API_KEY).toBe("sk-def");
  });

  it("strips one layer of surrounding quotes", () => {
    const parsed = parseEnvFile(`A="quoted"\nB='single'`);
    expect(parsed.A).toBe("quoted");
    expect(parsed.B).toBe("single");
  });
});

describe("ensureEnvFile", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "tidegap-env-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("creates the file 0600 with the commented template", () => {
    const path = join(dir, "sub", "env");
    const r = ensureEnvFile(path);
    expect(r.created).toBe(true);
    const mode = statSync(path).mode & 0o777;
    expect(mode).toBe(0o600);
    const body = readFileSync(path, "utf8");
    expect(body).toContain("#ANTHROPIC_API_KEY=");
    expect(body).toContain("#OPENAI_API_KEY=");
    expect(body).toContain("TIDEGAP_ELECTRICITY_MAPS_API_KEY");
    expect(body).toContain("#WATTTIME_USERNAME=");
  });

  it("is idempotent — never overwrites an existing file", () => {
    const path = join(dir, "env");
    ensureEnvFile(path);
    // Corrupt it, then re-run.
    rmSync(path);
    ensureEnvFile(path);
    const r2 = ensureEnvFile(path);
    expect(r2.created).toBe(false);
  });
});

describe("loadEnvFileIntoProcess", () => {
  let dir: string;
  const KEY = "TIDEGAP_TEST_LOAD_KEY";
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "tidegap-env-"));
    delete process.env[KEY];
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    delete process.env[KEY];
    delete process.env[ENV_FILE_KEYS_VAR];
  });

  it("loads keys not already set", () => {
    const path = join(dir, "env");
    ensureEnvFile(path);
    // Append a real key.
    writeFileSync(path, `${KEY}=from-file\n`, "utf8");
    const applied = loadEnvFileIntoProcess(path);
    expect(applied).toContain(KEY);
    expect(process.env[KEY]).toBe("from-file");
  });

  it("does not override an already-set key", () => {
    const path = join(dir, "env");
    writeFileSync(path, `${KEY}=from-file\n`, "utf8");
    process.env[KEY] = "already-set";
    const applied = loadEnvFileIntoProcess(path);
    expect(applied).not.toContain(KEY);
    expect(process.env[KEY]).toBe("already-set");
  });

  it("is a silent no-op for a missing file", () => {
    expect(loadEnvFileIntoProcess(join(dir, "nope"))).toEqual([]);
  });

  it("follows the file for a key it set: changed, then removed (K3)", () => {
    const path = join(dir, "env");
    writeFileSync(path, `${KEY}=one\n`, "utf8");
    loadEnvFileIntoProcess(path);
    writeFileSync(path, `${KEY}=two\n`, "utf8");
    expect(loadEnvFileIntoProcess(path)).toEqual([KEY]);
    expect(process.env[KEY]).toBe("two");
    writeFileSync(path, "# empty\n", "utf8");
    loadEnvFileIntoProcess(path);
    expect(process.env[KEY]).toBeUndefined();
    expect(process.env[ENV_FILE_KEYS_VAR]).toBeUndefined();
  });

  it("drops a file key when the file is deleted (K3)", () => {
    const path = join(dir, "env");
    writeFileSync(path, `${KEY}=one\n`, "utf8");
    loadEnvFileIntoProcess(path);
    rmSync(path);
    loadEnvFileIntoProcess(path);
    expect(process.env[KEY]).toBeUndefined();
  });

  it("treats a key inherited from a parent that loaded the file as file-sourced (K3)", () => {
    const path = join(dir, "env");
    process.env[KEY] = "from-parent-file";
    process.env[ENV_FILE_KEYS_VAR] = KEY;
    writeFileSync(path, "# token removed\n", "utf8");
    loadEnvFileIntoProcess(path);
    expect(process.env[KEY]).toBeUndefined();
  });

  it("keeps file keys when the file is present but unreadable (K3)", () => {
    const path = join(dir, "env");
    writeFileSync(path, `${KEY}=one\n`, "utf8");
    loadEnvFileIntoProcess(path);
    rmSync(path);
    mkdirSync(path); // exists, but reading it throws EISDIR
    expect(loadEnvFileIntoProcess(path)).toEqual([]);
    expect(process.env[KEY]).toBe("one");
  });

  it("never replaces or removes a key from the real environment (K3)", () => {
    const path = join(dir, "env");
    process.env[KEY] = "real";
    writeFileSync(path, `${KEY}=from-file\n`, "utf8");
    loadEnvFileIntoProcess(path);
    writeFileSync(path, "", "utf8");
    loadEnvFileIntoProcess(path);
    expect(process.env[KEY]).toBe("real");
  });
});

describe("envFileTemplate", () => {
  it("includes the provider + grid key grid, all commented", () => {
    const t = envFileTemplate();
    for (const k of [
      "ANTHROPIC_API_KEY",
      "OPENAI_API_KEY",
      "TIDEGAP_ELECTRICITY_MAPS_API_KEY",
      "TIDEGAP_EIA_API_KEY",
      "TIDEGAP_ENTSOE_SECURITY_TOKEN",
      "WATTTIME_USERNAME",
      "WATTTIME_PASSWORD",
    ]) {
      expect(t).toContain(k);
    }
  });

  it("has a commented TIDEGAP_TELEGRAM_BOT_TOKEN line that parses to no key", () => {
    const t = envFileTemplate();
    expect(t).toContain("\n#TIDEGAP_TELEGRAM_BOT_TOKEN=\n");
    expect(parseEnvFile(t)).toEqual({});
  });
});

describe("setEnvFileKey", () => {
  const KEY = "TIDEGAP_TELEGRAM_BOT_TOKEN";
  const TOKEN = "123456789:AAbbCCddEEffGGhhIIjjKKllMMnnOOppQQr";
  let dir: string;
  let path: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "tidegap-env-set-"));
    path = join(dir, "env");
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const mode = (p: string) => statSync(p).mode & 0o777;

  it("fills the template's commented line and keeps every other line byte for byte", () => {
    const before = `ANTHROPIC_API_KEY=sk-1\n${envFileTemplate()}`;
    writeFileSync(path, before, { mode: 0o600 });
    setEnvFileKey(path, KEY, TOKEN);
    const after = readFileSync(path, "utf8");
    expect(after).toBe(before.replace(`#${KEY}=\n`, `${KEY}=${TOKEN}\n`));
    expect(mode(path)).toBe(0o600);
  });

  it("replaces one active line; later active duplicates go", () => {
    writeFileSync(path, `A=1\n${KEY}=old\nB=2\n${KEY}=older\n`);
    setEnvFileKey(path, KEY, TOKEN);
    expect(readFileSync(path, "utf8")).toBe(`A=1\n${KEY}=${TOKEN}\nB=2\n`);
  });

  it("appends when the key is absent; creates the file 0600 and the directory 0700", () => {
    const nested = join(dir, "cfg", "env");
    setEnvFileKey(nested, KEY, TOKEN);
    expect(readFileSync(nested, "utf8")).toBe(`${KEY}=${TOKEN}\n`);
    expect(mode(nested)).toBe(0o600);
    expect(mode(join(dir, "cfg"))).toBe(0o700);
  });

  it("writes through a symlink and keeps the link", () => {
    const real = join(dir, "real-env");
    writeFileSync(real, "A=1\n");
    symlinkSync(real, path);
    setEnvFileKey(path, KEY, TOKEN);
    expect(lstatSync(path).isSymbolicLink()).toBe(true);
    expect(readFileSync(real, "utf8")).toBe(`A=1\n${KEY}=${TOKEN}\n`);
  });

  it("removing drops the active lines of the key and keeps the comments", () => {
    writeFileSync(path, `# keep\n#${KEY}=\n${KEY}=x\nTELEGRAM_BOT_TOKEN=y\nA=1\n`);
    setEnvFileKey(path, KEY, undefined);
    setEnvFileKey(path, "TELEGRAM_BOT_TOKEN", undefined);
    expect(readFileSync(path, "utf8")).toBe(`# keep\n#${KEY}=\nA=1\n`);
    expect(mode(path)).toBe(0o600);
  });

  it("refuses a value with a line break", () => {
    expect(() => setEnvFileKey(path, KEY, "a\nB=1")).toThrow();
  });
});

describe("isTelegramBotToken", () => {
  it("accepts a bot token and rejects anything else", () => {
    expect(isTelegramBotToken("123456789:AAbbCCddEEffGGhhIIjjKKllMMnnOOppQQr")).toBe(true);
    expect(isTelegramBotToken("123456789:AAbbCCddEEffGGhhIIjjKKllMMnnOOppQQr\nX=1")).toBe(false);
    expect(isTelegramBotToken("123456789:AAbbCCddEEffGGhh IIjjKKllMMnnOOppQQr")).toBe(false);
    expect(isTelegramBotToken(":AAbbCCddEEffGGhhIIjjKKllMMnnOOppQQr")).toBe(false);
    expect(isTelegramBotToken("123456789:")).toBe(false);
    expect(isTelegramBotToken(`123456789:${"a".repeat(190)}`)).toBe(false);
  });
});
