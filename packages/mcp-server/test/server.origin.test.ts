/**
 * Origin capture (KTD1), the default provider (KTD5) and the `runs_in:` line
 * (R10) through the REAL schedule_task handler. No test walks the real
 * process tree: the ancestor pid, the capture directory, the environment
 * and the directory check are injected.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { mockGridFeed, TaskStore, type ProviderCallSpec, type TaskRecord } from "@tidegap/core";
import { nodeSessionFs, readCapture } from "@tidegap/cli/session";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createEbbServer } from "../src/server.js";
import type { OriginEnv } from "../src/env.js";

type TextResult = { content: Array<{ type: string; text: string }>; isError?: boolean };

const TRANSCRIPTS = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "cli", "test", "fixtures", "transcripts");
const FIRST = "d76db676-78da-4dca-b20e-1328074e7009";
const SECOND = "aa11bb22-0000-4000-8000-000000000001";
const ENV_ID = "ee00ff11-2222-4333-8444-555566667777";

let root: string;
let sessions: string;
let dbPath: string;
const cleanups: Array<() => void> = [];

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "tidegap-mcp-origin-"));
  sessions = join(root, "sessions");
  mkdirSync(sessions);
  dbPath = join(root, "queue.db");
});
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()!();
  rmSync(root, { recursive: true, force: true });
});

/** Write the hook's capture file of pid 200. */
function capture(sessionId: string, transcript = "small.jsonl"): void {
  writeFileSync(
    join(sessions, "claude-200.json"),
    JSON.stringify({
      v: 1,
      pid: 200,
      session_id: sessionId,
      project_dir: "/work/app",
      written_at: "2026-10-17T18:00:00Z",
      hook: { session_id: sessionId, transcript_path: join(TRANSCRIPTS, transcript), cwd: "/work/app", source: "startup" },
    }),
  );
}

async function connect(env: Partial<OriginEnv> = {}, withPid = true) {
  const built = createEbbServer({
    feed: mockGridFeed(),
    dbPath,
    origin: {
      env: { claudeCode: false, ...env },
      claudePid: () => (withPid ? 200 : undefined),
      readCapture: (pid) => readCapture(pid, sessions),
      fallbackCwd: () => "/fallback",
    },
    sessionFs: { ...nodeSessionFs, isDirectory: (p) => p === "/work/app" },
  });
  const client = new Client({ name: "origin-test", version: "0.0.0" });
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([built.server.connect(serverTransport), client.connect(clientTransport)]);
  cleanups.push(() => {
    try {
      built.scheduler.shutdown();
    } catch {
      /* already closed */
    }
  });
  const call = async (name: string, args: Record<string, unknown>) =>
    (await client.callTool({ name, arguments: args })) as TextResult;
  return { ...built, call };
}

const text = (r: TextResult) => r.content.map((c) => c.text).join("\n");
const deadline = () => new Date(Date.now() + 6 * 3_600_000).toISOString();

function rows(): Array<TaskRecord<unknown> & { spec: ProviderCallSpec }> {
  const store = new TaskStore({ dbPath });
  try {
    return store.list().map((r) => ({ ...r, spec: JSON.parse(r.bodyJson!) as ProviderCallSpec }));
  } finally {
    store.close();
  }
}

describe("schedule_task origin capture", () => {
  it("AE1: stores the captured session, defaults to claude-code and says where it runs", async () => {
    capture(FIRST);
    const { call } = await connect();
    const r = await call("schedule_task", { prompt: "review queue.ts", deadline: deadline(), region: "GB" });
    expect(r.isError).toBeFalsy();
    expect(text(r)).toContain(
      "runs_in: a copy of this Claude Code session (d76db676) in /work/app, file tools Read, Grep, Glob",
    );
    const [row] = rows();
    expect(row!.originSessionId).toBe(FIRST);
    expect(row!.originCwd).toBe("/work/app");
    expect(row!.spec.provider).toBe("claude-code");
    expect(row!.spec.model).toBe("default");
    expect(row!.spec.origin).toEqual({ agent: "claude-code", via: "hook", transcriptPath: join(TRANSCRIPTS, "small.jsonl") });
  });

  it("AE2: each task stores the session current at its call", async () => {
    capture(FIRST);
    const { call } = await connect();
    await call("schedule_task", { prompt: "first", deadline: deadline(), region: "GB" });
    capture(SECOND);
    await call("schedule_task", { prompt: "second", deadline: deadline(), region: "GB" });
    const byTitle = Object.fromEntries(rows().map((r) => [r.title, r.originSessionId]));
    expect(byTitle).toEqual({ first: FIRST, second: SECOND });
  });

  it("a valid origin_session_id wins over the capture file", async () => {
    capture(FIRST);
    const { call } = await connect();
    await call("schedule_task", { prompt: "x", deadline: deadline(), region: "GB", origin_session_id: SECOND });
    const [row] = rows();
    expect(row!.originSessionId).toBe(SECOND);
    expect(row!.originCwd).toBe("/work/app");
    expect(row!.spec.origin).toEqual({ agent: "claude-code", via: "arg" });
  });

  it("falls back to CLAUDE_CODE_SESSION_ID without a capture file", async () => {
    const { call } = await connect({ sessionId: ENV_ID, projectDir: "/work/app", claudeCode: true });
    await call("schedule_task", { prompt: "x", deadline: deadline(), region: "GB" });
    const [row] = rows();
    expect(row!.originSessionId).toBe(ENV_ID);
    expect(row!.originCwd).toBe("/work/app");
    expect(row!.spec.origin).toEqual({ agent: "claude-code", via: "env" });
    expect(row!.spec.provider).toBe("claude-code");
  });

  it("with nothing found, queues as before", async () => {
    const { call } = await connect({}, false);
    const r = await call("schedule_task", { prompt: "x", deadline: deadline(), region: "GB" });
    expect(text(r)).toContain("runs_in: a fresh session (no session found)");
    const [row] = rows();
    expect(row!.originSessionId).toBeUndefined();
    expect(row!.originCwd).toBe("/fallback");
    expect(row!.spec.provider).toBe("anthropic");
    expect(row!.spec.origin).toBeUndefined();
  });

  it("an explicit anthropic provider stays, and runs fresh", async () => {
    capture(FIRST);
    const { call } = await connect();
    const r = await call("schedule_task", { prompt: "x", deadline: deadline(), region: "GB", provider: "anthropic" });
    expect(text(r)).toContain("runs_in: a fresh session (the API provider has no session)");
    expect(rows()[0]!.spec.provider).toBe("anthropic");
  });

  it("web tools run fresh", async () => {
    capture(FIRST);
    const { call } = await connect();
    const r = await call("schedule_task", { prompt: "x", deadline: deadline(), region: "GB", tools: ["WebSearch"] });
    expect(text(r)).toContain("runs_in: a fresh session (web tools)");
  });

  it("a large session runs fresh", async () => {
    capture(FIRST, "large.jsonl");
    const { call } = await connect();
    const r = await call("schedule_task", { prompt: "x", deadline: deadline(), region: "GB" });
    expect(text(r)).toContain("runs_in: a fresh session (session too large, about 620k tokens, cap 150k)");
  });

  it("dry_run shows the same line and persists nothing", async () => {
    capture(FIRST);
    const { call } = await connect();
    const r = await call("schedule_task", { prompt: "x", deadline: deadline(), region: "GB", dry_run: true });
    expect(text(r)).toContain("runs_in: a copy of this Claude Code session (d76db676) in /work/app");
    expect(rows()).toEqual([]);
  });
});

describe("expedite_task and retry_task on a claude-code task", () => {
  it("refuse before they claim the row and name tidegap queue run-now", async () => {
    capture(FIRST);
    const saved = process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_API_KEY = "sk-test-not-used";
    try {
      const { call } = await connect();
      await call("schedule_task", { prompt: "x", deadline: deadline(), region: "GB" });
      const before = rows()[0]!;
      for (const tool of ["expedite_task", "retry_task"]) {
        const r = await call(tool, { task_id: before.taskId });
        expect(r.isError).toBe(true);
        expect(text(r)).toContain(`tidegap queue run-now ${before.taskId}`);
      }
      const after = rows()[0]!;
      expect(after.status).toBe(before.status);
      expect(after.bodyJson).toBe(before.bodyJson);
    } finally {
      if (saved === undefined) delete process.env.ANTHROPIC_API_KEY;
      else process.env.ANTHROPIC_API_KEY = saved;
    }
  });
});
