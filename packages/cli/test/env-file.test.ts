import { mkdtempSync, rmSync, statSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  ensureEnvFile,
  envFileTemplate,
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
