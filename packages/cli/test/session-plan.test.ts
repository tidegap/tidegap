import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  describeRunsIn,
  effectiveTools,
  nodeSessionFs,
  planRun,
  resumeSettings,
  type PlanInput,
  type RunOrigin,
  type SessionFs,
} from "../src/session/index.js";

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "transcripts");
const ID = "d76db676-78da-4dca-b20e-1328074e7009";
const settings = resumeSettings({});

/** A file system where only `/work/app` and the named transcripts exist. */
const fs: SessionFs = {
  ...nodeSessionFs,
  isDirectory: (p) => p === "/work/app",
};

const origin = (over: Partial<RunOrigin> = {}): RunOrigin => ({
  sessionId: ID,
  cwd: "/work/app",
  agent: "claude-code",
  transcriptPath: join(FIXTURES, "small.jsonl"),
  ...over,
});

const plan = (over: Partial<PlanInput> = {}) =>
  planRun({ provider: "claude-code", origin: origin(), tools: ["Read", "Grep", "Glob"], settings, fs, ...over });

describe("planRun (KTD8)", () => {
  it("forks a small Claude Code session", () => {
    expect(plan()).toEqual({ mode: "fork", contextTokens: 12_000 });
  });

  it("the root or home directory, or a directory another user owns, is cwd-unsafe", () => {
    const rootFs: SessionFs = { ...fs, isDirectory: (p) => p === "/" || p === "/work/app" };
    expect(plan({ origin: origin({ cwd: "/" }), fs: rootFs })).toEqual({ mode: "fresh", reason: "cwd-unsafe" });
    expect(plan({ settings: { ...settings, home: "/work/app" } })).toEqual({ mode: "fresh", reason: "cwd-unsafe" });
    const foreign: SessionFs = { ...fs, dirInfo: (p) => ({ uid: process.getuid!() + 1, realPath: p }) };
    expect(plan({ fs: foreign })).toEqual({ mode: "fresh", reason: "cwd-unsafe" });
    expect(plan({ origin: origin({ cwd: "work/app" }) })).toEqual({ mode: "fresh", reason: "cwd-missing" });
  });

  it("a session id that is not a UUID is no-origin", () => {
    expect(plan({ origin: origin({ sessionId: "--dangerously-skip-permissions" }) })).toEqual({ mode: "fresh", reason: "no-origin" });
  });

  it("TIDEGAP_RESUME=off wins over a valid fork", () => {
    expect(plan({ settings: resumeSettings({ resume: "off" }) })).toEqual({ mode: "fresh", reason: "disabled" });
  });

  it("no session id, or another agent, is no-origin", () => {
    expect(plan({ origin: undefined })).toEqual({ mode: "fresh", reason: "no-origin" });
    expect(plan({ origin: origin({ sessionId: undefined }) })).toEqual({ mode: "fresh", reason: "no-origin" });
    expect(plan({ origin: origin({ agent: "codex" }) })).toEqual({ mode: "fresh", reason: "no-origin" });
  });

  it("an anthropic task never resumes", () => {
    expect(plan({ provider: "anthropic" })).toEqual({ mode: "fresh", reason: "api-provider" });
  });

  it("a web tool runs fresh, and wins over too-large", () => {
    expect(plan({ tools: ["WebSearch"] })).toEqual({ mode: "fresh", reason: "web-tools" });
    expect(plan({ tools: ["WebFetch"], origin: origin({ transcriptPath: join(FIXTURES, "large.jsonl") }) })).toEqual({
      mode: "fresh",
      reason: "web-tools",
    });
  });

  it("a missing directory is cwd-missing", () => {
    expect(plan({ origin: origin({ cwd: "/gone" }) })).toEqual({ mode: "fresh", reason: "cwd-missing" });
    expect(plan({ origin: origin({ cwd: undefined }) })).toEqual({ mode: "fresh", reason: "cwd-missing" });
  });

  it("a known transcript path that is gone is session-missing", () => {
    expect(plan({ origin: origin({ transcriptPath: join(FIXTURES, "gone.jsonl") }) })).toEqual({
      mode: "fresh",
      reason: "session-missing",
    });
  });

  it("a session above the cap is too-large", () => {
    expect(plan({ origin: origin({ transcriptPath: join(FIXTURES, "large.jsonl") }) })).toEqual({
      mode: "fresh",
      reason: "too-large",
      contextTokens: 620_000,
    });
    expect(plan({ settings: resumeSettings({ maxTokens: "1000" }) })).toEqual({
      mode: "fresh",
      reason: "too-large",
      contextTokens: 12_000,
    });
  });

  it("tools [] forks", () => {
    expect(plan({ tools: [] })).toEqual({ mode: "fork", contextTokens: 12_000 });
  });

  it("derives the transcript path when the hook gave none", () => {
    const derivedFs: SessionFs = {
      ...fs,
      size: (p) => (p === `/h/.claude/projects/-work-app/${ID}.jsonl` ? 4_000_000 : undefined),
      tail: () => "",
    };
    expect(
      plan({ origin: origin({ transcriptPath: undefined }), fs: derivedFs, settings: { ...settings, home: "/h" } }),
    ).toEqual({ mode: "fresh", reason: "too-large", contextTokens: 1_000_000 });
  });

  it("skips the size check when the derived path would be too long", () => {
    const long = `/${"a".repeat(220)}`;
    expect(
      plan({ origin: origin({ transcriptPath: undefined, cwd: long }), fs: { ...fs, isDirectory: (p) => p === long } }),
    ).toEqual({ mode: "fork" });
  });
});

describe("effectiveTools", () => {
  it("defaults a Claude Code origin to Read, Grep, Glob and keeps the task's set", () => {
    expect(effectiveTools(undefined, origin(), ["WebSearch", "WebFetch"])).toEqual(["Read", "Grep", "Glob"]);
    expect(effectiveTools([], origin(), ["WebSearch"])).toEqual([]);
    expect(effectiveTools(undefined, undefined, ["WebSearch", "WebFetch"])).toEqual(["WebSearch", "WebFetch"]);
  });
});

describe("resumeSettings", () => {
  it("parses the cap and warns on a bad one", () => {
    expect(resumeSettings({ maxTokens: "2000" }).maxTokens).toBe(2000);
    const bad = resumeSettings({ maxTokens: "lots" });
    expect(bad.maxTokens).toBe(150_000);
    expect(bad.warning).toContain("TIDEGAP_RESUME_MAX_TOKENS");
    expect(resumeSettings({ resume: "0" }).enabled).toBe(false);
    expect(resumeSettings({ resume: "on" }).enabled).toBe(true);
  });
});

describe("describeRunsIn", () => {
  it("words a fork and each fresh reason", () => {
    const tools = ["Read", "Grep", "Glob"];
    expect(describeRunsIn({ mode: "fork" }, origin(), tools, settings)).toBe(
      "a copy of this Claude Code session (d76db676) in /work/app, file tools Read, Grep, Glob",
    );
    expect(describeRunsIn({ mode: "fork" }, origin(), [], settings)).toContain(", no tools");
    expect(describeRunsIn({ mode: "fresh", reason: "no-origin" }, undefined, tools, settings)).toBe(
      "a fresh session (no session found)",
    );
    expect(describeRunsIn({ mode: "fresh", reason: "too-large", contextTokens: 620_000 }, origin(), tools, settings)).toBe(
      "a fresh session (session too large, about 620k tokens, cap 150k)",
    );
  });
});
