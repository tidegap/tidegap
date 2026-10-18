import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { derivedTranscriptPath, estimateContextTokens, TAIL_BYTES } from "../src/session/index.js";

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "transcripts");
const fixture = (name: string) => join(FIXTURES, name);

describe("estimateContextTokens", () => {
  it("takes the last main-chain usage: input + cache creation + cache read", () => {
    expect(estimateContextTokens(fixture("small.jsonl"))).toBe(12_000);
    expect(estimateContextTokens(fixture("large.jsonl"))).toBe(620_000);
  });

  it("falls back to ceil(bytes / 4) without a usage object", () => {
    const bytes = statSync(fixture("no-usage.jsonl")).size;
    expect(estimateContextTokens(fixture("no-usage.jsonl"))).toBe(Math.ceil(bytes / 4));
  });

  it("skips broken lines at both ends", () => {
    expect(estimateContextTokens(fixture("truncated-tail.jsonl"))).toBe(1_000);
  });

  it("finds the last usage in a tail that starts mid-line", () => {
    const dir = mkdtempSync(join(tmpdir(), "tidegap-estimate-"));
    try {
      const path = join(dir, "long.jsonl");
      const filler = `{"type":"user","message":{"role":"user","content":"${"x".repeat(1000)}"}}\n`;
      const body = readFileSync(fixture("small.jsonl"), "utf8") + filler.repeat(Math.ceil(TAIL_BYTES / filler.length) + 10);
      // The usage line sits right after the filler, inside the tail.
      writeFileSync(path, `${body}${readFileSync(fixture("large.jsonl"), "utf8")}`);
      expect(estimateContextTokens(path)).toBe(620_000);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("is undefined for a missing file", () => {
    expect(estimateContextTokens(fixture("missing.jsonl"))).toBeUndefined();
  });
});

describe("derivedTranscriptPath", () => {
  it("maps every non-alphanumeric of the cwd to '-'", () => {
    expect(derivedTranscriptPath("abc12345", "/work/my_app.v2", { home: "/h" })).toBe(
      "/h/.claude/projects/-work-my-app-v2/abc12345.jsonl",
    );
    expect(derivedTranscriptPath("abc12345", "/w", { claudeConfigDir: "/cfg" })).toBe("/cfg/projects/-w/abc12345.jsonl");
  });

  it("is undefined for a folder name of 200 characters or more", () => {
    expect(derivedTranscriptPath("abc12345", `/${"a".repeat(199)}`, { home: "/h" })).toBeUndefined();
  });
});
