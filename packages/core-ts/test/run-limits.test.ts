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
  attemptNumber,
  capValueError,
  carbonBudgetConfigPath,
  classifyFailure,
  failureFactsOf,
  finalFailureError,
  formatDuration,
  formatRunLimitValue,
  loadRunLimitSettings,
  NonRetryableError,
  parseDuration,
  parseRunLimitValue,
  permanentError,
  planRetry,
  ProviderRefusalError,
  resolveRunLimits,
  resolveTaskRunLimits,
  retryPolicyText,
  RUN_LIMITS,
  runLimitDefinition,
  runLimitsDetails,
  runLimitsFromDetails,
  runLimitSettingsFromValues,
  parseKeyValues,
  type DurationValue,
  type FailureFacts,
  type FinalReason,
  type ProviderName,
  type RunLimitName,
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
  summarize?: ProviderName;
  expected: Record<string, { value: DurationValue; source: string }>;
}
interface RetryParseVector {
  setting: RunLimitName;
  input: string;
  value?: number;
  canonical?: string;
  error?: string;
}
interface PlanVector {
  id: string;
  input: { attempt: number; retries: number; delay_ms: number; failed_at: number; deadline?: number; not_before?: number };
  expected: { retry_at?: number; final?: string };
}

const VECTORS = JSON.parse(
  readFileSync(new URL("./fixtures/run-limits-vectors.json", import.meta.url), "utf8"),
) as {
  errors: Record<string, string>;
  parse: ParseVector[];
  settings: SettingsVector[];
  resolve: ResolveVector[];
  legacy: ResolveVector[];
  retry_parse: RetryParseVector[];
  classify: { id: string; facts: FailureFacts; class: string }[];
  plan: PlanVector[];
  attempts: { id: string; events: { kind: string; details?: Record<string, unknown> }[]; attempt: number }[];
  final_error: { error: string; attempts: number; reason?: FinalReason; error_out: string }[];
};

function settingsOf(lines: string[]) {
  return runLimitSettingsFromValues(parseKeyValues(lines.join("\n")));
}

describe("run-limits registry", () => {
  it("names the two time limits and the retry settings with their keys, runners and defaults", () => {
    expect(RUN_LIMITS.map((l) => [l.name, l.key, l.cliName, l.kind])).toEqual([
      ["command_timeout", "TIDEGAP_COMMAND_TIMEOUT", "command-timeout", "time_limit"],
      ["llm_timeout", "TIDEGAP_LLM_TIMEOUT", "llm-timeout", "time_limit"],
      ["retries", "TIDEGAP_RETRIES", "retries", "count"],
      ["retry_delay", "TIDEGAP_RETRY_DELAY", "retry-delay", "delay"],
    ]);
    const [command, llm, retries, delay] = RUN_LIMITS;
    expect(command!.defaults).toEqual({ command: 1_800_000 });
    expect(llm!.defaults).toEqual({
      "claude-code": 1_800_000,
      anthropic: 600_000,
      openai: 600_000,
      gemini: 600_000,
      ollama: 600_000,
    });
    const every = (v: number) => ({ command: v, "claude-code": v, anthropic: v, openai: v, gemini: v, ollama: v });
    expect(retries!.defaults).toEqual(every(1));
    expect(delay!.defaults).toEqual(every(1_800_000));
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
      const settings = settingsOf(v.config);
      const got = v.summarize
        ? resolveTaskRunLimits({ provider: v.runner, caps: v.caps, summarize: { provider: v.summarize } }, settings)
        : resolveRunLimits(v.caps, settings, v.runner);
      expect(got).toEqual(v.expected);
    });
  }
});

describe("retry parse vectors", () => {
  for (const v of VECTORS.retry_parse) {
    const def = runLimitDefinition(v.setting);
    if (v.error) {
      it(`${v.setting} ${JSON.stringify(v.input)} fails with the ${v.error} sentence`, () => {
        expect(() => parseRunLimitValue(def, v.input)).toThrow(VECTORS.errors[v.error!]!);
      });
    } else {
      it(`${v.setting} ${JSON.stringify(v.input)} is ${v.value} and prints ${v.canonical}`, () => {
        const value = parseRunLimitValue(def, v.input);
        expect(value).toBe(v.value);
        expect(formatRunLimitValue(def, value)).toBe(v.canonical);
      });
    }
  }

  it("a stored retries or retry delay outside its range is refused with its sentence", () => {
    expect(capValueError("retries", 0)).toBeUndefined();
    expect(capValueError("retries", 11)).toBe(`cap retries: ${VECTORS.errors.retries}`);
    expect(capValueError("retries", "none")).toBe(`cap retries: ${VECTORS.errors.retries}`);
    expect(capValueError("retryDelayMs", 600_000)).toBeUndefined();
    expect(capValueError("retryDelayMs", "none")).toBe(`cap retryDelayMs: ${VECTORS.errors.retry_delay}`);
    expect(capValueError("retryDelayMs", 0)).toBe(`cap retryDelayMs: ${VECTORS.errors.retry_delay}`);
  });
});

describe("classify vectors", () => {
  for (const v of VECTORS.classify) {
    it(`${v.id} is ${v.class}`, () => {
      expect(classifyFailure(v.facts)).toBe(v.class);
    });
  }

  it("reads the facts off a thrown error", () => {
    expect(classifyFailure(failureFactsOf(Object.assign(new Error("rate"), { status: 429 })))).toBe("transient");
    expect(classifyFailure(failureFactsOf(Object.assign(new Error("key"), { statusCode: 401 })))).toBe("permanent");
    expect(classifyFailure(failureFactsOf(permanentError("command: refused")))).toBe("permanent");
    expect(classifyFailure(failureFactsOf(new ProviderRefusalError("anthropic", "m", null)))).toBe("permanent");
    expect(classifyFailure(failureFactsOf(new NonRetryableError("exit 1", { steps: ["command"] })))).toBe("exit");
    expect(classifyFailure(failureFactsOf(new NonRetryableError("t", { stopped_by: "llm_timeout" })))).toBe("timeout");
    expect(classifyFailure(failureFactsOf(new Error("boom")))).toBe("transient");
    expect(failureFactsOf("not an error")).toEqual({});
  });
});

describe("plan vectors", () => {
  for (const v of VECTORS.plan) {
    it(v.id, () => {
      const plan = planRetry({
        attempt: v.input.attempt,
        retries: v.input.retries,
        delayMs: v.input.delay_ms,
        failedAt: v.input.failed_at,
        deadline: v.input.deadline,
        notBefore: v.input.not_before,
      });
      expect(plan).toEqual(v.expected.final ? { final: v.expected.final } : { retryAt: v.expected.retry_at });
    });
  }
});

describe("attempt vectors", () => {
  for (const v of VECTORS.attempts) {
    it(`${v.id} runs attempt ${v.attempt}`, () => {
      expect(attemptNumber(v.events)).toBe(v.attempt);
    });
  }
});

describe("final error vectors", () => {
  for (const v of VECTORS.final_error) {
    it(v.error_out, () => {
      expect(finalFailureError(v.error, v.attempts, v.reason)).toBe(v.error_out);
    });
  }
});

describe("retry details and text", () => {
  it("records retries as a count and the delay in seconds, and reads them back", () => {
    const limits = resolveRunLimits({ retries: 2, capsVersion: 2 }, settingsOf(["TIDEGAP_RETRY_DELAY=10m"]), "gemini");
    const details = runLimitsDetails(limits);
    expect(details.retries).toEqual({ value: 2, source: "task" });
    expect(details.retry_delay).toEqual({ value_s: 600, source: "setting" });
    expect(runLimitsFromDetails({ limits: details })).toEqual(limits);
    expect(retryPolicyText(details)).toBe("2 after 10m, doubling (task; delay setting)");
    expect(retryPolicyText(runLimitsDetails(resolveRunLimits(undefined, settingsOf([]), "command")))).toBe("1 after 30m (default)");
    expect(retryPolicyText(runLimitsDetails(resolveRunLimits({ retries: 0, capsVersion: 2 }, settingsOf([]), "command")))).toBe(
      "0, no automatic retry (task; delay default)",
    );
  });
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
      retries: { value: 1, source: "default" },
      retry_delay: { value: 1_800_000, source: "default" },
    });
  });

  it("reads no environment variable", () => {
    const saved = process.env.TIDEGAP_COMMAND_TIMEOUT;
    process.env.TIDEGAP_COMMAND_TIMEOUT = "1h";
    try {
      const settings = loadRunLimitSettings({ path: tempConfig("") });
      expect(resolveRunLimits(undefined, settings, "command")).toEqual({
        command_timeout: { value: 1_800_000, source: "default" },
        retries: { value: 1, source: "default" },
        retry_delay: { value: 1_800_000, source: "default" },
      });
    } finally {
      if (saved === undefined) delete process.env.TIDEGAP_COMMAND_TIMEOUT;
      else process.env.TIDEGAP_COMMAND_TIMEOUT = saved;
    }
  });
});
