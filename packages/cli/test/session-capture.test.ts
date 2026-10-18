import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { findAncestorPid, readCapture, type PsEntry } from "../src/session/index.js";

const ID = "d76db676-78da-4dca-b20e-1328074e7009";
let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "tidegap-sessions-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function write(pid: number, body: string): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `claude-${pid}.json`), body);
}

const file = (over: Record<string, unknown> = {}, hook: Record<string, unknown> = {}) =>
  JSON.stringify({
    v: 1,
    pid: 200,
    session_id: ID,
    project_dir: "/work/app",
    written_at: "2026-10-17T18:00:00Z",
    hook: { session_id: ID, transcript_path: `/t/${ID}.jsonl`, cwd: "/work/app/sub", source: "startup", ...hook },
    ...over,
  });

describe("readCapture", () => {
  it("returns the session of a valid file", () => {
    write(200, file());
    expect(readCapture(200, dir)).toEqual({
      sessionId: ID,
      pid: 200,
      projectDir: "/work/app",
      cwd: "/work/app/sub",
      transcriptPath: `/t/${ID}.jsonl`,
      source: "startup",
    });
  });

  it("rejects a file whose pid is another process's", () => {
    write(200, file({ pid: 201 }));
    expect(readCapture(200, dir)).toBeUndefined();
  });

  it("rejects an invalid session id", () => {
    write(200, file({ session_id: "${CLAUDE_SESSION_ID}" }, { session_id: "${CLAUDE_SESSION_ID}" }));
    expect(readCapture(200, dir)).toBeUndefined();
  });

  it("rejects a hook object that names another session", () => {
    write(200, file({}, { session_id: "aa11bb22-0000-4000-8000-000000000001" }));
    expect(readCapture(200, dir)).toBeUndefined();
  });

  it("rejects a file the hook wrote from malformed input", () => {
    write(200, `{"v":1,"pid":200,"session_id":"${ID}","project_dir":"","written_at":"x","hook":{"session_id":"${ID}" broken}}`);
    expect(readCapture(200, dir)).toBeUndefined();
  });

  it("returns undefined for a missing file", () => {
    expect(readCapture(200, dir)).toBeUndefined();
  });
});

function chain(entries: Record<number, PsEntry>) {
  return vi.fn((pid: number) => entries[pid]);
}

describe("findAncestorPid", () => {
  it("finds claude above node and npm", () => {
    const ps = chain({
      500: { ppid: 400, comm: "node" },
      400: { ppid: 200, comm: "npm exec @tidegap/mcp" },
      200: { ppid: 1, comm: "/Users/u/.local/bin/claude" },
    });
    expect(findAncestorPid("claude", { startPid: 500, ps, platform: "darwin" })).toBe(200);
  });

  it("gives up after 6 levels without claude", () => {
    const entries: Record<number, PsEntry> = {};
    for (let p = 10; p < 17; p++) entries[p] = { ppid: p + 1, comm: "sh" };
    entries[17] = { ppid: 1, comm: "claude" };
    expect(findAncestorPid("claude", { startPid: 10, ps: chain(entries), platform: "linux" })).toBeUndefined();
  });

  it("does not run ps on Windows", () => {
    const ps = chain({});
    expect(findAncestorPid("claude", { startPid: 10, ps, platform: "win32" })).toBeUndefined();
    expect(ps).not.toHaveBeenCalled();
  });

  it("stops when a pid does not run", () => {
    expect(findAncestorPid("claude", { startPid: 10, ps: chain({}), platform: "linux" })).toBeUndefined();
  });
});
