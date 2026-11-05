/**
 * The run-limits registry: the duration grammar, the `~/.tidegap/config`
 * read and the precedence resolver. The cases live in
 * fixtures/run-limits-vectors.json, which the Python suite
 * (packages/core-py/tests/test_run_limits.py) reads too.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  carbonBudgetConfigPath,
  formatDuration,
  loadRunLimitSettings,
  parseDuration,
  resolveRunLimits,
  RUN_LIMITS,
  runLimitSettingsFromValues,
  parseKeyValues,
  type DurationValue,
  type ProviderName,
} from "../src/index.js";

interface ParseVector {
  input: string;
  value?: DurationValue;
  canonical?: string;
  error?: string;
}
interface SettingsVector {
  id: string;
  config: string[];
  values: Record<string, DurationValue>;
  ignored: { key: string; value: string; reason: string }[];
}
interface ResolveVector {
  id: string;
  config: string[];
  caps?: Record<string, unknown>;
  runner: ProviderName;
  expected: Record<string, { value: DurationValue; source: string }>;
}

const VECTORS = JSON.parse(
  readFileSync(new URL("./fixtures/run-limits-vectors.json", import.meta.url), "utf8"),
) as {
  errors: Record<string, string>;
  parse: ParseVector[];
  settings: SettingsVector[];
  resolve: ResolveVector[];
  legacy: ResolveVector[];
};

function settingsOf(lines: string[]) {
  return runLimitSettingsFromValues(parseKeyValues(lines.join("\n")));
}

describe("run-limits registry", () => {
  it("names the two time limits with their keys, runners and defaults", () => {
    expect(RUN_LIMITS.map((l) => [l.name, l.key, l.cliName])).toEqual([
      ["command_timeout", "TIDEGAP_COMMAND_TIMEOUT", "command-timeout"],
      ["llm_timeout", "TIDEGAP_LLM_TIMEOUT", "llm-timeout"],
    ]);
    const [command, llm] = RUN_LIMITS;
    expect(command!.defaults).toEqual({ command: 1_800_000 });
    expect(llm!.defaults).toEqual({
      "claude-code": 1_800_000,
      anthropic: 600_000,
      openai: 600_000,
      gemini: 600_000,
      ollama: 600_000,
    });
  });
});

describe("parseDuration / formatDuration vectors", () => {
  for (const v of VECTORS.parse) {
    if (v.error) {
      it(`${JSON.stringify(v.input)} fails with the ${v.error} sentence`, () => {
        expect(() => parseDuration(v.input)).toThrow(VECTORS.errors[v.error!]!);
      });
    } else {
      it(`${JSON.stringify(v.input)} is ${String(v.value)} and prints ${v.canonical}`, () => {
        expect(parseDuration(v.input)).toBe(v.value);
        expect(formatDuration(parseDuration(v.input))).toBe(v.canonical);
        expect(parseDuration(v.canonical!)).toBe(v.value);
      });
    }
  }

  it("throws the exact sentence, nothing more", () => {
    try {
      parseDuration("0");
      expect.unreachable();
    } catch (err) {
      expect((err as Error).message).toBe(VECTORS.errors.zero);
    }
  });
});

describe("settings vectors", () => {
  for (const v of VECTORS.settings) {
    it(v.id, () => {
      const settings = settingsOf(v.config);
      expect(settings.values).toEqual(v.values);
      expect(settings.ignored).toEqual(v.ignored);
    });
  }
});

describe("resolve and legacy vectors", () => {
  for (const v of [...VECTORS.resolve, ...VECTORS.legacy]) {
    it(v.id, () => {
      expect(resolveRunLimits(v.caps, settingsOf(v.config), v.runner)).toEqual(v.expected);
    });
  }
});

describe("loadRunLimitSettings", () => {
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "tidegap-run-limits-"));
  });
  afterEach(() => {
    warn.mockClear();
    rmSync(dir, { recursive: true, force: true });
  });

  function tempConfig(contents: string): string {
    const path = join(dir, "config");
    writeFileSync(path, contents);
    return path;
  }

  it("reads ~/.tidegap/config by default", () => {
    mkdirSync(join(carbonBudgetConfigPath(), ".."), { recursive: true });
    writeFileSync(carbonBudgetConfigPath(), "TIDEGAP_LLM_TIMEOUT=20m\n");
    expect(loadRunLimitSettings().values).toEqual({ TIDEGAP_LLM_TIMEOUT: 1_200_000 });
  });

  it("keeps every valid line of a file with an invalid line and warns once per process", () => {
    const path = tempConfig("TIDEGAP_COMMAND_TIMEOUT=12m\nTIDEGAP_LLM_TIMEOUT_COMMAND=1h\nTIDEGAP_LLM_TIMEOUT=0\n");
    const first = loadRunLimitSettings({ path });
    expect(first.values).toEqual({ TIDEGAP_COMMAND_TIMEOUT: 720_000 });
    expect(first.ignored.map((i) => i.key)).toEqual(["TIDEGAP_LLM_TIMEOUT_COMMAND", "TIDEGAP_LLM_TIMEOUT"]);
    expect(warn).toHaveBeenCalledTimes(2);
    expect(String(warn.mock.calls[0]![0])).toContain("TIDEGAP_LLM_TIMEOUT_COMMAND");
    loadRunLimitSettings({ path });
    expect(warn).toHaveBeenCalledTimes(2);
  });

  it("gives the defaults and no throw for a missing or unreadable file", () => {
    const missing = loadRunLimitSettings({ path: join(dir, "no-such-dir", "config") });
    expect(missing).toEqual({ values: {}, ignored: [] });
    const unreadable = loadRunLimitSettings({ path: dir });
    expect(unreadable).toEqual({ values: {}, ignored: [] });
    expect(resolveRunLimits(undefined, unreadable, "anthropic")).toEqual({
      llm_timeout: { value: 600_000, source: "default" },
    });
  });

  it("reads no environment variable", () => {
    const saved = process.env.TIDEGAP_COMMAND_TIMEOUT;
    process.env.TIDEGAP_COMMAND_TIMEOUT = "1h";
    try {
      const settings = loadRunLimitSettings({ path: tempConfig("") });
      expect(resolveRunLimits(undefined, settings, "command")).toEqual({
        command_timeout: { value: 1_800_000, source: "default" },
      });
    } finally {
      if (saved === undefined) delete process.env.TIDEGAP_COMMAND_TIMEOUT;
      else process.env.TIDEGAP_COMMAND_TIMEOUT = saved;
    }
  });
});
