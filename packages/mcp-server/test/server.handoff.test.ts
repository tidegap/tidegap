/**
 * `schedule_task` with the handoff parameters (`runner`, `cwd`,
 * `permission_profile`, `result_path`) through the REAL handler, the
 * refusal of a shell command, the `output_path` location rules, and
 * `check_queue_status` showing the work shape. The session is injected: a
 * capture file whose project folder is a real temp folder.
 */

import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { mockGridFeed, TaskStore, type ProviderCallSpec, type TaskRecord } from "@tidegap/core";
import { nodeSessionFs, readCapture } from "@tidegap/cli/session";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createEbbServer } from "../src/server.js";

type TextResult = { content: Array<{ type: string; text: string }>; isError?: boolean };

const TRANSCRIPTS = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "cli", "test", "fixtures", "transcripts");
const SESSION = "11111111-2222-4333-8444-555555555555";

let root: string;
let app: string;
let work: string;
let sessions: string;
let dbPath: string;
const cleanups: Array<() => void> = [];

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "tidegap-mcp-handoff-")));
  app = join(root, "app");
  work = join(root, "app", "worktree");
  sessions = join(root, "sessions");
  mkdirSync(work, { recursive: true });
  mkdirSync(sessions);
  dbPath = join(root, "queue.db");
  writeFileSync(
    join(sessions, "claude-200.json"),
    JSON.stringify({
      v: 1,
      pid: 200,
      session_id: SESSION,
      project_dir: app,
      written_at: "2026-10-31T18:00:00Z",
      hook: { session_id: SESSION, transcript_path: join(TRANSCRIPTS, "small.jsonl"), cwd: app, source: "startup" },
    }),
  );
});
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()!();
  rmSync(root, { recursive: true, force: true });
});

async function connect() {
  const built = createEbbServer({
    feed: mockGridFeed(),
    dbPath,
    // Absent unless a test writes it: no quota reset is configured then.
    quotaConfigPath: join(root, "quota.env"),
    origin: {
      env: { claudeCode: true },
      claudePid: () => 200,
      readCapture: (pid) => readCapture(pid, sessions),
      fallbackCwd: () => app,
    },
    sessionFs: nodeSessionFs,
  });
  const client = new Client({ name: "handoff-test", version: "0.0.0" });
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([built.server.connect(serverTransport), client.connect(clientTransport)]);
  cleanups.push(() => {
    try {
      built.scheduler.shutdown();
    } catch {
      /* already closed */
    }
  });
  const call = async (name: string, args: Record<string, unknown>) => (await client.callTool({ name, arguments: args })) as TextResult;
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

describe("schedule_task handoff parameters", () => {
  it("schedule_task with cwd, permission_profile read and result_path queues a claude-code task with handoff and tools", async () => {
    const { call } = await connect();
    const out = join(work, "review.md");
    const r = await call("schedule_task", {
      prompt: "review the diff",
      deadline: deadline(),
      cwd: work,
      permission_profile: "read",
      result_path: out,
    });
    expect(r.isError).toBeFalsy();
    const reply = text(r);
    expect(reply).toContain("provider: claude-code");
    expect(reply).toContain(`runs_in: a fresh session in ${work} (the task names another folder)`);
    expect(reply).toContain(`cwd: ${work}\n`);
    expect(reply).toContain("profile: read\n");
    expect(reply).toContain("tools: Read, Grep, Glob\n");
    expect(reply).toContain(`result_path: ${out}\n`);
    const [row] = rows();
    expect(row!.spec.provider).toBe("claude-code");
    expect(row!.spec.handoff).toEqual({ cwd: work, profile: "read", resultPath: out });
    expect(row!.spec.tools).toEqual(["Read", "Grep", "Glob"]);
    expect(row!.originSessionId).toBe(SESSION);
    expect(row!.spec.origin).toMatchObject({ agent: "claude-code", via: "hook" });
  });

  it("dry_run previews the handoff fields and queues nothing", async () => {
    const { call } = await connect();
    const r = await call("schedule_task", { prompt: "x", deadline: deadline(), cwd: work, dry_run: true });
    expect(r.isError).toBeFalsy();
    expect(text(r)).toContain("dry_run plan (nothing persisted)");
    expect(text(r)).toContain(`cwd: ${work}\n`);
    expect(text(r)).toContain("profile: read\n");
    const refused = await call("schedule_task", { prompt: "x", deadline: deadline(), result_path: join(homedir(), ".zshrc"), dry_run: true });
    expect(refused.isError).toBe(true);
    expect(rows()).toEqual([]);
  });

  it("schedule_task with runner claude-code queues like provider claude-code; runner and provider that differ are refused", async () => {
    const { call } = await connect();
    expect((await call("schedule_task", { prompt: "a", deadline: deadline(), runner: "claude-code" })).isError).toBeFalsy();
    expect((await call("schedule_task", { prompt: "b", deadline: deadline(), runner: "anthropic", provider: "anthropic" })).isError).toBeFalsy();
    const [a, b] = rows().sort((x, y) => x.enqueuedAt.localeCompare(y.enqueuedAt));
    expect(a!.spec.provider).toBe("claude-code");
    expect(b!.spec.provider).toBe("anthropic");
    const r = await call("schedule_task", { prompt: "c", deadline: deadline(), runner: "claude-code", provider: "anthropic" });
    expect(r.isError).toBe(true);
    expect(text(r)).toContain('runner "claude-code" and provider "anthropic" differ');
    expect(rows()).toHaveLength(2);
  });

  it("covers AE7: schedule_task with runner command or provider command queues nothing and names tidegap queue add", async () => {
    const { call } = await connect();
    for (const args of [{ runner: "command" }, { provider: "command" }]) {
      const r = await call("schedule_task", { prompt: "echo hi", deadline: deadline(), ...args });
      expect(r.isError).toBe(true);
      expect(text(r)).toContain("tidegap queue add --runner command --cwd <dir> --by <when> '<cmd>'");
    }
    expect(rows()).toEqual([]);
  });

  it("schedule_task with permission_profile web and cwd is refused", async () => {
    const { call } = await connect();
    const r = await call("schedule_task", { prompt: "x", deadline: deadline(), cwd: work, permission_profile: "web" });
    expect(r.isError).toBe(true);
    expect(text(r)).toMatch(/profile web runs in a fresh temporary folder and cannot take a cwd/);
    const anthropic = await call("schedule_task", { prompt: "x", deadline: deadline(), provider: "anthropic", cwd: work });
    expect(anthropic.isError).toBe(true);
    expect(text(anthropic)).toMatch(/claude-code runner only/);
    const mismatch = await call("schedule_task", { prompt: "x", deadline: deadline(), permission_profile: "read", tools: ["WebSearch"] });
    expect(mismatch.isError).toBe(true);
    expect(rows()).toEqual([]);
  });

  it("covers AE8: schedule_task with result_path or output_path at ~/.zshrc, under ~/Library or inside ~/.tidegap is refused", async () => {
    const { call } = await connect();
    const home = homedir();
    mkdirSync(join(home, "Library", "LaunchAgents"), { recursive: true });
    mkdirSync(join(home, ".tidegap"), { recursive: true });
    for (const path of [join(home, ".zshrc"), join(home, "Library", "LaunchAgents", "x.plist"), join(home, ".tidegap", "queue.json")]) {
      for (const key of ["result_path", "output_path"]) {
        const r = await call("schedule_task", { prompt: "x", deadline: deadline(), [key]: path });
        expect(r.isError, `${key} ${path}`).toBe(true);
        expect(text(r), `${key} ${path}`).toContain(`allowed folders: ${app}`);
      }
    }
    expect(rows()).toEqual([]);
  });

  it("output_path inside the project folder still works and keeps its JSON", async () => {
    const { call } = await connect();
    const r = await call("schedule_task", { prompt: "x", deadline: deadline(), output_path: join(app, "digest.json") });
    expect(r.isError).toBeFalsy();
    expect(rows()[0]!.spec.outputPath).toBe(join(app, "digest.json"));
  });

  it("a job repeat refuses the handoff parameters by name", async () => {
    const { call } = await connect();
    const r = await call("schedule_task", { prompt: "nightly", repeat: "daily", cwd: work });
    expect(r.isError).toBe(true);
    expect(text(r)).toContain("cwd cannot be used with a job repeat");
  });

  it("a series repeat refuses result_path: each run would write the same new file", async () => {
    writeFileSync(join(root, "quota.env"), "TIDEGAP_QUOTA_RESET_CLAUDE=mon 10:00 UTC\n");
    const { call } = await connect();
    const r = await call("schedule_task", {
      prompt: "after each reset",
      deadline_kind: "quota_reset",
      repeat: "daily",
      result_path: join(app, "after-reset.md"),
    });
    expect(r.isError).toBe(true);
    expect(text(r)).toContain("a result path needs a one-off task");
    expect(rows()).toEqual([]);
  });

  it("check_queue_status task_id shows cwd, profile, tools and result_path", async () => {
    const { call } = await connect();
    const out = join(work, "answer.md");
    await call("schedule_task", { prompt: "x", deadline: deadline(), cwd: work, result_path: out });
    const [row] = rows();
    const r = await call("check_queue_status", { task_id: row!.taskId });
    const shown = text(r);
    expect(shown).toContain("runner: claude-code");
    expect(shown).toContain(`cwd: ${work}`);
    expect(shown).toContain("profile: read");
    expect(shown).toContain("tools: Read, Grep, Glob");
    expect(shown).toContain(`result_path: ${out}`);
    expect(shown).toContain("result_file: not written yet");
  });
});
