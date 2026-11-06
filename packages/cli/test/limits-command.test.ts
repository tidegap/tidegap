/**
 * `tidegap limits`: show each run time limit per runner with its source,
 * set and reset the `~/.tidegap/config` lines, keep every other line byte
 * for byte, and list the lines that are ignored.
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { formatLimitsView, runLimitsReset, runLimitsSet, runLimitsShow } from "../src/commands/limits.js";
import { limitDefaultsText, limitsView } from "../src/limits.js";

let dir: string;
let config: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "tidegap-limits-"));
  config = join(dir, "config");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

/** The rows of `tidegap limits show --json`. */
function rows(): Array<{ setting: string; runner: string; value_s: number | "none"; source: string }> {
  return JSON.parse(runLimitsShow({ json: true, config }).out!).limits;
}

const row = (setting: string, runner: string) => rows().find((r) => r.setting === setting && r.runner === runner);

describe("tidegap limits", () => {
  it("shows every setting for every runner it applies to, with the defaults on an empty file", () => {
    expect(rows().map((r) => `${r.setting} ${r.runner} ${r.value_s} ${r.source}`)).toEqual([
      "command-timeout command 1800 default",
      "llm-timeout claude-code 1800 default",
      "llm-timeout anthropic 600 default",
      "llm-timeout openai 600 default",
      "llm-timeout gemini 600 default",
      "llm-timeout ollama 600 default",
    ]);
    const text = runLimitsShow({ config }).out!;
    expect(text).toContain("command-timeout  command      30m (default)");
    expect(text).toContain("none switches a time limit off");
  });

  it("set llm-timeout 1h --runner claude-code writes its key and keeps every other line byte for byte", () => {
    const before = "# my settings\r\nTIDEGAP_DEFAULT_REGION=FR\r\n\r\nTIDEGAP_QUOTA_RESET_CLAUDE=fri 09:00\r\n";
    writeFileSync(config, before);
    const res = runLimitsSet("llm-timeout", "1h", { runner: "claude-code", config });
    expect(res.exitCode).toBe(0);
    expect(res.out!.split("\n")[0]).toBe("Set TIDEGAP_LLM_TIMEOUT_CLAUDE_CODE=1h in ~/.tidegap/config.");
    expect(readFileSync(config, "utf8")).toBe(`${before}TIDEGAP_LLM_TIMEOUT_CLAUDE_CODE=1h\r\n`);
    expect(row("llm-timeout", "claude-code")).toMatchObject({ value_s: 3600, source: "setting:claude-code" });
    expect(row("llm-timeout", "anthropic")).toMatchObject({ value_s: 600, source: "default" });
  });

  it("set stores the canonical form; none warns that the run holds other tasks", () => {
    expect(runLimitsSet("llm-timeout", "90MIN", { config }).exitCode).toBe(0);
    expect(readFileSync(config, "utf8")).toBe("TIDEGAP_LLM_TIMEOUT=90m\n");
    const none = runLimitsSet("command-timeout", "none", { config });
    expect(none.out).toContain("holds every other due task while it runs; tidegap queue cancel <id> stops it.");
    expect(row("command-timeout", "command")).toMatchObject({ value_s: "none", source: "setting" });
  });

  it("refuses 0, a bad value, an unknown setting and a runner the setting does not take, with exit 2", () => {
    expect(runLimitsSet("command-timeout", "0", { config })).toEqual({
      exitCode: 2,
      err: "limits set: 0 is not a time limit; use none for no time limit.",
    });
    expect(runLimitsSet("command-timeout", "8d", { config }).err).toBe("limits set: A time limit must be from 1s to 7d; use none for no time limit.");
    expect(runLimitsSet("wall-timeout", "1h", { config }).err).toBe('limits set: unknown setting "wall-timeout"; use command-timeout or llm-timeout');
    expect(runLimitsSet("command-timeout", "1h", { runner: "command", config }).err).toBe(
      "limits set: command-timeout takes no --runner: it applies to the command runner only",
    );
    expect(runLimitsSet("llm-timeout", "1h", { runner: "command", config }).err).toBe(
      'limits set: llm-timeout takes --runner claude-code, anthropic, openai, gemini, ollama, got "command"',
    );
  });

  it("reset command-timeout removes the key; the default shows again", () => {
    writeFileSync(config, "TIDEGAP_COMMAND_TIMEOUT=2h\nTIDEGAP_DEFAULT_REGION=FR\n");
    expect(row("command-timeout", "command")).toMatchObject({ value_s: 7200, source: "setting" });
    const res = runLimitsReset("command-timeout", { config });
    expect(res.out!.split("\n")[0]).toBe("Removed TIDEGAP_COMMAND_TIMEOUT from ~/.tidegap/config; the next layer applies.");
    expect(readFileSync(config, "utf8")).toBe("TIDEGAP_DEFAULT_REGION=FR\n");
    expect(runLimitsShow({ config }).out).toContain("command-timeout  command      30m (default)");
  });

  it("covers AE4: a TIDEGAP_COMMAND_TIMEOUT=0 line is listed as ignored with its reason, and the default applies", () => {
    writeFileSync(config, "TIDEGAP_COMMAND_TIMEOUT=0\nTIDEGAP_LLM_TIMEOUT_COMMAND=5m\n");
    expect(row("command-timeout", "command")).toMatchObject({ value_s: 1800, source: "default" });
    const text = formatLimitsView(limitsView(config));
    expect(text).toContain("Ignored lines:\n  TIDEGAP_COMMAND_TIMEOUT=0: 0 is not a time limit; use none for no time limit.");
    expect(text).toContain("TIDEGAP_LLM_TIMEOUT_COMMAND=5m: TIDEGAP_LLM_TIMEOUT takes a runner suffix of CLAUDE_CODE, ANTHROPIC, OPENAI, GEMINI or OLLAMA.");
  });

  it("help text reads the defaults from the registry", () => {
    expect(limitDefaultsText("command-timeout")).toBe("30m");
    expect(limitDefaultsText("llm-timeout")).toBe("30m for claude-code, 10m for anthropic, openai, gemini and ollama");
  });
});
