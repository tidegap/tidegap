import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mockGridFeed, TaskStore } from "@tidegap/core";
import type { TaskRecord } from "@tidegap/core";
import {
  localDayBounds,
  parseLaterUntil,
  renderQueue,
  runQueueLater,
  runQueueCancel,
  runQueueList,
  runQueueReply,
  runQueueReschedule,
  runQueueRunNow,
  runQueueShow,
  runQueueUnread,
} from "../src/commands/queue.js";
import { buildProgram } from "../src/index.js";
import { writeUsageCache } from "../src/usage/index.js";

function rec(status: string): TaskRecord {
  return {
    taskId: `t-${status}`,
    status: status as TaskRecord["status"],
    enqueuedAt: "2026-06-01T10:00:00.000Z",
    region: "US-CAL-CISO",
  } as TaskRecord;
}

describe("renderQueue status pass-through", () => {
  it("renders the new 'submitted' status without crashing", () => {
    const out = renderQueue([rec("submitted")]);
    expect(out).toContain("submitted");
  });

  it("renders an unknown/future status gracefully", () => {
    // A concurrent agent may introduce statuses this CLI doesn't know.
    const out = renderQueue([rec("some-future-status")]);
    expect(out).toContain("some-future-statu"); // truncated to column width
  });
});

describe("queue list / show / unread (task visibility)", () => {
  let dir: string;
  let db: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "tidegap-cli-queue-"));
    db = join(dir, "queue.db");
    const store = new TaskStore({ dbPath: db });
    store.upsert({
      taskId: "t-quota",
      status: "scheduled",
      enqueuedAt: "2026-10-15T10:00:00.000Z",
      scheduledFor: "2026-10-18T03:00:00.000Z",
      deadline: "2026-10-19T08:00:00.000Z",
      region: "DE",
      title: "Weekly digest",
      deadlineKind: "quota_reset",
      quotaProvider: "claude",
      bodyJson: JSON.stringify({ type: "provider_call", provider: "anthropic", model: "m", prompt: "digest" }),
    });
    store.upsert({
      taskId: "t-done",
      status: "completed",
      enqueuedAt: "2026-10-15T11:00:00.000Z",
      completedAt: "2026-10-15T12:00:00.000Z",
      deadline: "2026-10-16T00:00:00.000Z",
      region: "DE",
      title: "Summarize \u001b[31mreport",
      originHost: "mcp",
      originCwd: "/work",
      bodyJson: JSON.stringify({
        type: "provider_call",
        provider: "anthropic",
        model: "m",
        prompt: "Summarize the report\nin bullets",
        messages: [{ role: "user", content: "earlier question" }, { role: "assistant", content: "earlier answer" }],
      }),
      result: { text: "three bullets\u001b]0;pwned\u0007", raw: { vendor: "payload-xyz" } },
      receipt: {
        taskId: "t-done",
        ranAt: "2026-10-15T12:00:00.000Z",
        region: "DE",
        estimatedCarbonGCo2: 0.42,
      },
    });
    store.setMeta("last_tick_at", "2026-10-15T12:05:00.000Z");
    store.close();
  });

  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const readAt = (id: string) => {
    const store = new TaskStore({ dbPath: db });
    try {
      return store.get(id)?.readAt;
    } finally {
      store.close();
    }
  };

  it("lists title, deadline and kind cells, and the last tick", async () => {
    const { rendered } = await runQueueList({ db });
    expect(rendered).toMatch(/t-quota .*Weekly digest .*2026-10-19T08:00:00.000Z .*quota:claude/);
    expect(rendered).toMatch(/t-done .*abs /);
    expect(rendered).toContain("last tick: 2026-10-15T12:05:00.000Z");
    expect(rendered).not.toContain("\u001b");
  });

  it("--kind quota_reset and --unread filter", async () => {
    expect((await runQueueList({ db, kind: "quota_reset" })).rows.map((r) => r.taskId)).toEqual([
      "t-quota",
    ]);
    expect((await runQueueList({ db, unread: true })).rows.map((r) => r.taskId)).toEqual([
      "t-done",
    ]);
    await expect(runQueueList({ db, kind: "weekly" })).rejects.toThrow(/unknown kind/);
  });

  it("show prints title, prompt, history, result and receipt, hides the raw payload, and marks read", async () => {
    const { rendered } = await runQueueShow("t-done", { db, config: join(dir, "none") });
    expect(rendered).toMatch(/^title: Summarize \[31mreport$/m);
    expect(rendered).toMatch(/^origin: mcp \(\/work\)$/m);
    expect(rendered).toContain("Prompt:\nSummarize the report\nin bullets");
    expect(rendered).toContain("History:\n[user] earlier question\n[assistant] earlier answer");
    expect(rendered).toContain("Result:\nthree bullets]0;pwned");
    expect(rendered).toContain("estimated_carbon_g: 0.42");
    expect(rendered).not.toContain("payload-xyz");
    expect(rendered).not.toMatch(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/);
    expect(readAt("t-done")).toBeDefined();
  });

  it("show --raw includes the raw payload; --no-mark-read leaves read_at null", async () => {
    const { rendered } = await runQueueShow("t-done", { db, raw: true, markRead: false });
    expect(rendered).toContain("payload-xyz");
    expect(readAt("t-done")).toBeUndefined();
  });

  it("show labels a quota deadline and does not mark an unfinished task read", async () => {
    const config = join(dir, "config");
    writeFileSync(config, "TIDEGAP_QUOTA_RESET_CLAUDE=mon 10:00 UTC\nTIDEGAP_QUOTA_MARGIN_H_CLAUDE=2\n");
    const { rendered } = await runQueueShow("t-quota", { db, config });
    expect(rendered).toContain(
      "deadline: 2026-10-19T08:00:00.000Z (quota reset (claude), reset_at 2026-10-19T10:00:00.000Z, margin_h 2)",
    );
    expect(readAt("t-quota")).toBeUndefined();
  });

  it("show --json carries the history", async () => {
    const { rendered } = await runQueueShow("t-done", { db, json: true, markRead: false });
    const parsed = JSON.parse(rendered) as { history: unknown[]; result: Record<string, unknown> };
    expect(parsed.history).toHaveLength(4);
    expect(parsed.result).not.toHaveProperty("raw");
  });

  it("show on an unknown id throws", async () => {
    await expect(runQueueShow("missing-id", { db })).rejects.toThrow(/no task/);
  });

  it("unread reverses a mark-read", async () => {
    await runQueueShow("t-done", { db });
    expect(readAt("t-done")).toBeDefined();
    expect(await runQueueUnread("t-done", { db })).toContain("marked unread");
    expect(readAt("t-done")).toBeUndefined();
    await expect(runQueueUnread("missing-id", { db })).rejects.toThrow(/no task/);
  });
});

describe("tidegap queue list --hook (Claude Code SessionStart)", () => {
  let dir: string;
  let db: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "tidegap-hook-"));
    db = join(dir, "queue.db");
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  function seedDone(n: number): void {
    const store = new TaskStore({ dbPath: db });
    for (let i = 0; i < n; i++) {
      store.upsert({
        taskId: `done-${i}`,
        status: "completed",
        enqueuedAt: "2026-06-01T10:00:00.000Z",
        completedAt: `2026-06-01T11:0${i}:00.000Z`,
        region: "FR",
        title: `title\u001b[2J ${i}`,
      });
    }
    store.close();
  }

  it("names the unread count and drops it after a mark read (AE1)", async () => {
    seedDone(2);
    expect((await runQueueList({ db, unread: true, hook: true })).rendered).toBe(
      "2 unread Tidegap tasks, run `tidegap ui` to read them.",
    );
    const store = new TaskStore({ dbPath: db });
    store.markRead("done-0");
    store.close();
    expect((await runQueueList({ db, unread: true, hook: true })).rendered).toBe(
      "1 unread Tidegap task, run `tidegap ui` to read them.",
    );
  });

  describe("with the hook input naming a session (KTD14)", () => {
    const S = "d76db676-78da-4dca-b20e-1328074e7009";
    const T = "aa11bb22-0000-4000-8000-000000000001";
    const FORK = "f1a2b3c4-5d6e-4f70-8a9b-0c1d2e3f4a5b";
    const input = (id: string) => JSON.stringify({ session_id: id, source: "resume", cwd: "/work/app" });

    function seedSessions(): void {
      const store = new TaskStore({ dbPath: db });
      const base = {
        status: "completed" as const,
        enqueuedAt: "2026-06-01T10:00:00.000Z",
        completedAt: "2026-06-01T11:00:00.000Z",
        region: "FR",
        originHost: "mcp" as const,
        originCwd: "/work/app",
        title: "MARKER-title",
        bodyJson: JSON.stringify({ type: "provider_call", provider: "claude-code", model: "default", prompt: "MARKER-prompt" }),
        result: { text: "MARKER-reply" },
      };
      const receipt = (taskId: string, session: object) => ({ taskId, ranAt: base.completedAt, region: "FR", estimatedCarbonGCo2: 0.1, session });
      store.upsert({ ...base, taskId: "s-fork", originSessionId: S, receipt: receipt("s-fork", { mode: "fork", sessionId: FORK, originSessionId: S }) });
      store.upsert({
        ...base,
        taskId: "s-fresh",
        originSessionId: S,
        receipt: receipt("s-fresh", { mode: "fresh", reason: "too-large", originSessionId: S, contextTokens: 620_000 }),
      });
      store.upsert({ ...base, taskId: "t-other", originSessionId: T });
      store.close();
    }

    it("AE5: names this session's finished tasks, counts the rest, marks nothing read", async () => {
      seedSessions();
      const { rendered } = await runQueueList({ db, hook: true, hookInput: input(S) });
      const lines = rendered.split("\n");
      expect(lines[0]).toBe("2 Tidegap tasks queued from this session finished:");
      expect(rendered).toContain(`- s-fork completed, ran in fork f1a2b3c4 of d76db676; open it: cd /work/app && claude --resume ${FORK}`);
      expect(rendered).toContain("- s-fresh completed, ran in fresh (too-large, about 620k tokens)");
      expect(rendered).toContain("Read a result with check_queue_status task_id=<id>.");
      expect(lines.at(-1)).toBe("1 unread Tidegap task, run `tidegap ui` to read them.");
      expect(rendered).not.toContain("MARKER");
      const store = new TaskStore({ dbPath: db });
      expect(store.list({ unread: true }).map((r) => r.taskId).sort()).toEqual(["s-fork", "s-fresh", "t-other"]);
      store.close();
    });

    it("input that is not JSON, or names no session, prints today's line", async () => {
      seedSessions();
      for (const hookInput of ["not json", "{}", input("${CLAUDE_SESSION_ID}")]) {
        expect((await runQueueList({ db, hook: true, hookInput })).rendered).toBe(
          "3 unread Tidegap tasks, run `tidegap ui` to read them.",
        );
      }
    });

    it("show prints the origin, how it ran and the command that opens the fork", async () => {
      seedSessions();
      const store = new TaskStore({ dbPath: db });
      const spec = { type: "provider_call", provider: "claude-code", model: "default", prompt: "p", origin: { agent: "claude-code", via: "hook" } };
      for (const id of ["s-fork", "s-fresh"]) store.upsert({ ...store.get(id)!, bodyJson: JSON.stringify(spec) });
      store.close();
      const fork = (await runQueueShow("s-fork", { db, markRead: false })).rendered;
      expect(fork).toMatch(/^origin: claude-code session d76db676 in \/work\/app$/m);
      expect(fork).toMatch(/^ran: fork f1a2b3c4 of d76db676$/m);
      expect(fork).toContain(`open: cd /work/app && claude --resume ${FORK}`);
      const fresh = (await runQueueShow("s-fresh", { db, markRead: false })).rendered;
      expect(fresh).toMatch(/^ran: fresh \(too-large, about 620k tokens\)$/m);
      expect(fresh).not.toContain("open:");
      const none = (await runQueueShow("t-other", { db, markRead: false })).rendered;
      expect(none).not.toMatch(/^ran:/m);
      expect(none).toMatch(/^origin: mcp \(\/work\/app\)$/m);
    });
  });

  it("prints nothing when nothing is unread", async () => {
    seedDone(0);
    expect((await runQueueList({ db, hook: true })).rendered).toBe("");
  });

  it("prints nothing for a missing ledger and does not create one", async () => {
    const missing = join(dir, "nope", "queue.db");
    expect((await runQueueList({ db: missing, hook: true })).rendered).toBe("");
    expect(existsSync(missing)).toBe(false);
  });

  describe("hooks.json command", () => {
    const hooksFile = join(__dirname, "..", "..", "claude-code-plugin", "hooks", "hooks.json");
    const command = (
      JSON.parse(readFileSync(hooksFile, "utf8")) as {
        hooks: { SessionStart: Array<{ hooks: Array<{ type: string; command: string }> }> };
      }
    ).hooks.SessionStart[0]!.hooks[0]!;

    function runHook(stub: string | null, name = "tidegap", input = ""): { status: number | null; stdout: string } {
      const bin = join(dir, "bin");
      mkdirSync(bin, { recursive: true });
      if (stub !== null) {
        writeFileSync(join(bin, name), `#!/bin/sh\n${stub}\n`);
        chmodSync(join(bin, name), 0o755);
      }
      const r = spawnSync("/bin/sh", ["-c", command.command], {
        env: { PATH: `${bin}:/usr/bin:/bin` },
        encoding: "utf8",
        input,
      });
      return { status: r.status, stdout: r.stdout };
    }

    it("is a command hook", () => {
      expect(command.type).toBe("command");
    });

    it("stays silent with exit 0 when neither tidegap nor ebb is installed", () => {
      expect(runHook(null)).toEqual({ status: 0, stdout: "" });
    });

    it("stays silent with exit 0 when an older ebb rejects --hook", () => {
      expect(runHook(`echo "error: unknown option '--hook'" >&2; exit 1`, "ebb")).toEqual({ status: 0, stdout: "" });
    });

    it("falls back to the 0.17 ebb command when tidegap is absent", () => {
      expect(runHook(`echo "1 unread task via $0"`, "ebb").stdout).toMatch(/via .*\/ebb\n$/);
    });

    it("hands the hook input to tidegap through --hook-input -", () => {
      const out = runHook(`echo "args: $*"; cat`, "tidegap", '{"session_id":"abc12345"}');
      expect(out.stdout).toBe('args: queue list --unread --hook --hook-input -\n{"session_id":"abc12345"}');
    });

    it("falls back to the plain hook call when an older tidegap rejects --hook-input", () => {
      const stub = `case "$*" in *hook-input*) echo "error: unknown option '--hook-input'" >&2; exit 1 ;; *) echo "1 unread Tidegap task" ;; esac`;
      expect(runHook(stub, "tidegap", "{}")).toEqual({ status: 0, stdout: "1 unread Tidegap task\n" });
    });

    it("passes the CLI line through", () => {
      expect(runHook(`echo "2 unread Tidegap tasks, run \\\`tidegap ui\\\` to read them."`).stdout).toBe(
        "2 unread Tidegap tasks, run `tidegap ui` to read them.\n",
      );
    });
  });
});

describe("queue write commands (ui v2)", () => {
  let dir: string;
  let db: string;
  const H = 3_600_000;
  const spec = (prompt: string) =>
    JSON.stringify({ type: "provider_call", provider: "anthropic", model: "claude-sonnet-4-6", prompt });

  async function seedPending(taskId: string, extra: Partial<TaskRecord> = {}): Promise<void> {
    const store = new TaskStore({ dbPath: db });
    store.upsert({
      taskId,
      status: "scheduled",
      enqueuedAt: new Date().toISOString(),
      scheduledFor: new Date(Date.now() + 5 * H).toISOString(),
      deadline: new Date(Date.now() + 6 * H).toISOString(),
      region: "DE",
      bodyJson: spec(`prompt of ${taskId}`),
      ...extra,
    } as TaskRecord);
    store.close();
  }
  const row = (id: string) => {
    const store = new TaskStore({ dbPath: db });
    try {
      return store.get(id);
    } finally {
      store.close();
    }
  };
  const feed = mockGridFeed();

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "tidegap-cli-write-"));
    db = join(dir, "queue.db");
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("cancel cancels; --series also ends the series", async () => {
    await seedPending("a");
    await seedPending("s", { seriesId: "s", repeat: "weekly" });
    expect(await runQueueCancel("a", { db, feed })).toMatch(/a: cancelled/);
    expect(row("a")?.status).toBe("cancelled");
    expect(await runQueueCancel("s", { db, feed, series: true })).toMatch(/series s ended/);
    expect(row("s")?.repeat).toBe("none");
    expect(row("s~2")).toBeUndefined();
  });

  it("run-now marks the row due and expedited and names the next tick", async () => {
    await seedPending("r");
    const out = await runQueueRunNow("r", { db, feed });
    expect(out).toMatch(/runs on the next tick \(last tick: never recorded\)/);
    expect(row("r")?.intensitySource).toBe("expedited");
    expect(Date.parse(row("r")!.scheduledFor!)).toBeLessThanOrEqual(Date.now());
  });

  it("reschedule --by, --at and --day change the row as the core specifies", async () => {
    await seedPending("x");
    await runQueueReschedule("x", { db, feed, by: "30h" });
    const by = row("x")!;
    expect(Date.parse(by.deadline!)).toBeGreaterThan(Date.now() + 29 * H);
    const at = new Date(Date.now() + 10 * H).toISOString();
    await runQueueReschedule("x", { db, feed, at });
    expect(row("x")?.scheduledFor).toBe(at);
    const t = new Date(Date.now() + 2 * 24 * H);
    const day = `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, "0")}-${String(t.getDate()).padStart(2, "0")}`;
    await runQueueReschedule("x", { db, feed, day });
    const { dayStart, dayEnd } = localDayBounds(day);
    const s = Date.parse(row("x")!.scheduledFor!);
    expect(s).toBeGreaterThanOrEqual(dayStart.getTime());
    expect(s).toBeLessThanOrEqual(dayEnd.getTime());
    await expect(runQueueReschedule("x", { db, feed })).rejects.toThrow(/exactly one/);
  });

  describe("reschedule --after-limit-reset", () => {
    const usage = () => ({ cachePath: join(dir, "usage.json"), configPath: join(dir, "config"), env: {} });
    function seedLimits(fivePct: number, fiveReset: Date): void {
      writeUsageCache(
        {
          version: 1,
          claude: {
            statusline: {
              fetched_at: new Date().toISOString(),
              data: {
                five_hour: { pct: fivePct, resets_at: fiveReset.toISOString() },
                seven_day: { pct: 40, resets_at: new Date(Date.now() + 3 * 24 * H).toISOString() },
                scoped: [],
              },
            },
          },
        },
        usage().cachePath,
      );
    }

    it("with an exhausted 5 h window stores notBefore = that reset", async () => {
      await seedPending("x");
      const reset = new Date(Math.ceil((Date.now() + 3 * H) / 60_000) * 60_000);
      seedLimits(100, reset);
      const out = await runQueueReschedule("x", { db, feed, afterLimitReset: true, usage: usage() });
      expect(out).toMatch(/rescheduled after the 5h limit reset/);
      const r = row("x")!;
      expect(r.notBefore).toBe(reset.toISOString());
      expect(Date.parse(r.scheduledFor!)).toBeGreaterThan(reset.getTime());
    });

    it("with no limit state refuses with the cause", async () => {
      await seedPending("x");
      await expect(runQueueReschedule("x", { db, feed, afterLimitReset: true, usage: usage() })).rejects.toThrow(
        /limit state unavailable/,
      );
      expect(row("x")!.notBefore).toBeUndefined();
    });

    it("cannot be combined with --at", async () => {
      await seedPending("x");
      await expect(
        runQueueReschedule("x", { db, feed, afterLimitReset: true, at: "2h", usage: usage() }),
      ).rejects.toThrow(/exactly one of --by, --at, --day or --after-limit-reset/);
    });
  });

  describe("later (coherence U6)", () => {
    // Local wall clock 2026-10-20 15:00; only Date is faked, timers stay real.
    const NOW = new Date(2026, 9, 20, 15, 0, 0, 0);
    const M = 60_000;
    const noReset = async () => null;
    beforeEach(() => {
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(NOW);
    });
    afterEach(() => vi.useRealTimers());

    it("--until +2h on a task planned in 30 minutes: not before 2 h 30 min from now", async () => {
      await seedPending("a", { scheduledFor: new Date(NOW.getTime() + 30 * M).toISOString() });
      const out = await runQueueLater("a", { db, feed, until: "+2h", limitReset: noReset });
      expect(row("a")!.notBefore).toBe(new Date(NOW.getTime() + 150 * M).toISOString());
      expect(out).toContain("a: moved later (not before 17:30)");
    });

    it("--until tonight on a task already planned for 23:00 is refused and names 23:00", async () => {
      await seedPending("n", { scheduledFor: new Date(2026, 9, 20, 23, 0).toISOString() });
      await expect(runQueueLater("n", { db, feed, until: "tonight", limitReset: noReset })).rejects.toThrow(
        /already planned for 23:00/,
      );
    });

    it("--until 9:00 at 10:00 means tomorrow 09:00", () => {
      const at10 = new Date(2026, 9, 20, 10, 0);
      expect(parseLaterUntil("9:00", at10)).toEqual({ until: new Date(2026, 9, 21, 9, 0) });
      expect(parseLaterUntil("tomorrow 9:00", at10)).toEqual({ until: new Date(2026, 9, 21, 9, 0) });
      expect(parseLaterUntil("11:30", at10)).toEqual({ until: new Date(2026, 9, 20, 11, 30) });
      expect(parseLaterUntil("tomorrow", at10)).toEqual({ preset: "tomorrow_morning" });
    });

    it("--until after-limit-reset with no reset time is refused with the --reset-at hint", async () => {
      await seedPending("r");
      await expect(runQueueLater("r", { db, feed, until: "after-limit-reset", limitReset: noReset })).rejects.toThrow(
        /needs the reset time; pass --reset-at/,
      );
    });

    it("--preset after_limit_reset uses the plugged-in reset source", async () => {
      await seedPending("u", { scheduledFor: new Date(NOW.getTime() + 30 * M).toISOString() });
      const reset = new Date(NOW.getTime() + 3 * 60 * M);
      await runQueueLater("u", { db, feed, preset: "after_limit_reset", limitReset: async () => ({ at: reset, source: "usage:five_hour" }) });
      expect(row("u")!.notBefore).toBe(new Date(reset.getTime() + 5 * M).toISOString());
    });

    it("--delay <minutes> counts from the planned start; --reset-at HH:MM sets the reset", async () => {
      await seedPending("d", { scheduledFor: new Date(NOW.getTime() + 60 * M).toISOString() });
      await runQueueLater("d", { db, feed, delay: "45", limitReset: noReset });
      expect(row("d")!.notBefore).toBe(new Date(NOW.getTime() + 105 * M).toISOString());
      await seedPending("e", { scheduledFor: new Date(NOW.getTime() + 30 * M).toISOString() });
      await runQueueLater("e", { db, feed, until: "after-limit-reset", resetAt: "18:00", limitReset: noReset });
      expect(row("e")!.notBefore).toBe(new Date(2026, 9, 20, 18, 5).toISOString());
    });

    it("reschedule --by 2h on a task due 23:59 never sets an earlier deadline and prints the alias notice", async () => {
      const deadline = new Date(2026, 9, 20, 23, 59).toISOString();
      await seedPending("b", { scheduledFor: new Date(NOW.getTime() + 30 * M).toISOString(), deadline });
      const notes: string[] = [];
      await runQueueReschedule("b", { db, feed, by: "2h", limitReset: noReset, notice: (l) => notes.push(l) });
      const r = row("b")!;
      expect(Date.parse(r.deadline!)).toBeGreaterThanOrEqual(Date.parse(deadline));
      expect(Date.parse(r.notBefore!)).toBeGreaterThan(NOW.getTime() + 30 * M);
      expect(notes).toEqual(["note: `queue reschedule --by` is now `queue later b --until +2h`; it never moves a task earlier."]);
    });

    it("--until garbage lists the accepted forms; two targets are refused", async () => {
      await seedPending("g");
      await expect(runQueueLater("g", { db, feed, until: "garbage", limitReset: noReset })).rejects.toThrow(
        /use one of: \+<dur>.*tonight, tomorrow, tomorrow HH:MM, HH:MM, an ISO-8601 time, after-limit-reset/,
      );
      await expect(runQueueLater("g", { db, feed, until: "+1h", delay: "5" })).rejects.toThrow(/exactly one/);
    });
  });

  it("reply on a completed task queues a child; on a cancelled one refuses", async () => {
    const store = new TaskStore({ dbPath: db });
    store.upsert({
      taskId: "done",
      status: "completed",
      enqueuedAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
      region: "DE",
      bodyJson: spec("first"),
      result: { text: "answer" },
    } as TaskRecord);
    store.close();
    const out = await runQueueReply("done", "more please", { db, feed, by: "2h" });
    const childId = /reply queued as (\S+)/.exec(out)![1]!;
    expect(row(childId)?.parentTaskId).toBe("done");
    await seedPending("c");
    await runQueueCancel("c", { db, feed });
    await expect(runQueueReply("c", "x", { db, feed })).rejects.toThrow(/is cancelled/);
  });

  it("a refused action exits 1 with the core message", async () => {
    await seedPending("gone");
    await runQueueCancel("gone", { db, feed });
    const exit = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Error(`exit ${code}`);
    }) as never);
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await expect(
        buildProgram().parseAsync(["node", "tidegap", "queue", "run-now", "gone", "--db", db]),
      ).rejects.toThrow("exit 1");
      expect(err.mock.calls.flat().join(" ")).toMatch(/runNow: task gone is cancelled/);
    } finally {
      exit.mockRestore();
      err.mockRestore();
    }
  });

  it("show prints the resume line only with both cwd and session, cwd shell-quoted", async () => {
    await seedPending("with", { originCwd: "/work/my dir", originSessionId: "sess-12345678" });
    await seedPending("without", { originCwd: "/work" });
    const a = await runQueueShow("with", { db, markRead: false });
    expect(a.rendered).toContain("resume: cd '/work/my dir' && claude --resume sess-12345678");
    const b = await runQueueShow("without", { db, markRead: false });
    expect(b.rendered).not.toContain("resume:");
  });

  it("show prints series, repeat, parent and children", async () => {
    await seedPending("p", { seriesId: "p", repeat: "daily" });
    await seedPending("kid", { parentTaskId: "p" });
    const out = (await runQueueShow("p", { db, markRead: false })).rendered;
    expect(out).toContain("series: p");
    expect(out).toContain("repeat: daily");
    expect(out).toContain("children: kid");
  });

  it("list --series lists occurrences oldest first", async () => {
    await seedPending("q~3", { seriesId: "q", repeat: "weekly" });
    await seedPending("q", { seriesId: "q", repeat: "weekly" });
    await seedPending("q~2", { seriesId: "q", repeat: "weekly" });
    await seedPending("other");
    const res = await runQueueList({ db, series: "q" });
    expect(res.rows.map((r) => r.taskId)).toEqual(["q", "q~2", "q~3"]);
    const json = JSON.parse((await runQueueList({ db, series: "q", json: true })).rendered);
    expect(json.tasks[0]).toMatchObject({
      display_title: "prompt of q",
      series_id: "q",
      repeat: "weekly",
      provider: "anthropic",
      model: "claude-sonnet-4-6",
    });
  });
});
