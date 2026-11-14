/**
 * Task visibility (v0.17): title derivation, history, deadline-kind
 * validation, and redaction of prior message turns.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  capHistory,
  isValidSessionId,
  resumeCommand,
  deadlineKindLabel,
  deriveTitle,
  mockGridFeed,
  Scheduler,
  stripControlChars,
  taskHistory,
  taskResultText,
  TaskStore,
  taskSummaryError,
  taskSummaryText,
} from "../src/index.js";
import type { ProviderAdapter, ProviderCallSpec, TaskRecord } from "../src/index.js";

const SECRET = "sk-ant-abc123DEF456ghi789JKL012mno";

function spec(prompt: string, extra: Partial<ProviderCallSpec> = {}): ProviderCallSpec {
  return {
    type: "provider_call",
    provider: "anthropic",
    model: "claude-sonnet-4-5",
    prompt,
    ...extra,
  };
}

function adapter(opts: { fail?: boolean } = {}): ProviderAdapter {
  return {
    provider: "anthropic",
    ready: true,
    async dispatch(model) {
      if (opts.fail) throw Object.assign(new Error("bad request"), { status: 400 });
      return { text: "the answer", model, provider: "anthropic", raw: null };
    },
    async dispatchBatch() {
      throw new Error("unused");
    },
  };
}

const inSixHours = () => new Date(Date.now() + 6 * 3_600_000);

describe("deriveTitle", () => {
  it("uses the first non-empty line", () => {
    expect(deriveTitle("\n\n  Summarize the report  \nsecond line")).toBe(
      "Summarize the report",
    );
  });

  it("cuts a long first line to 80 characters with an ellipsis", () => {
    const title = deriveTitle("x".repeat(200))!;
    expect(Array.from(title)).toHaveLength(80);
    expect(title.endsWith("…")).toBe(true);
  });

  it("redacts secrets in the title (AE11)", () => {
    const title = deriveTitle(`use key ${SECRET} to summarize`)!;
    expect(title).not.toContain(SECRET);
    expect(title).toContain("[REDACTED]");
  });

  it("removes terminal control characters", () => {
    expect(deriveTitle("\u001b[31mred\u001b[0m title\u0007")).toBe("[31mred[0m title");
  });
});

describe("taskResultText, taskSummaryText, taskSummaryError", () => {
  const rec = (result: unknown) => ({ result }) as TaskRecord<unknown>;

  it("read the raw output, the summary and the summary error as separate keys", () => {
    const r = rec({ text: "visits|OK", summary: "All fine.", model: "m" });
    expect(taskResultText(r)).toBe("visits|OK");
    expect(taskSummaryText(r)).toBe("All fine.");
    expect(taskSummaryError(r)).toBeUndefined();
    const failed = rec({ text: "visits|OK", summaryError: "summarize: stopped: budget" });
    expect(taskSummaryText(failed)).toBeUndefined();
    expect(taskSummaryError(failed)).toBe("summarize: stopped: budget");
  });

  it("give undefined for a missing result, a non-object or a non-string key", () => {
    for (const result of [undefined, null, "text", { text: 1, summary: {}, summaryError: [] }]) {
      expect(taskResultText(rec(result))).toBeUndefined();
      expect(taskSummaryText(rec(result))).toBeUndefined();
      expect(taskSummaryError(rec(result))).toBeUndefined();
    }
  });
});

describe("capHistory", () => {
  const turns = (n: number, size: number) =>
    Array.from({ length: n }, (_, i) => ({
      role: (i % 2 === 0 ? "user" : "assistant") as "user" | "assistant",
      content: `${i}`.padEnd(size, "x"),
    }));

  it("keeps a history under the budget unchanged", () => {
    const h = turns(4, 10);
    expect(capHistory(h, 100)).toBe(h);
  });

  it("drops the oldest pairs first and starts with a user turn", () => {
    const out = capHistory(turns(6, 100), 250);
    expect(out.map((m) => m.content[0])).toEqual(["4", "5"]);
    expect(out[0]!.role).toBe("user");
  });

  it("always keeps the newest pair", () => {
    expect(capHistory(turns(4, 1000), 10)).toHaveLength(2);
  });
});

describe("stripControlChars", () => {
  it("strips C0/C1 controls, keeps newlines only when multiline", () => {
    const text = "a\u001b]0;x\u0007b\u009bc\r\nd\te";
    expect(stripControlChars(text)).toBe("a]0;xbc d e");
    expect(stripControlChars(text, { multiline: true })).toBe("a]0;xbc\nd\te");
  });
});

describe("deadlineKindLabel", () => {
  it("labels quota and absolute kinds", () => {
    expect(deadlineKindLabel({ deadlineKind: "quota_reset", quotaProvider: "claude" })).toBe(
      "quota reset (claude)",
    );
    expect(deadlineKindLabel({ deadlineKind: undefined })).toBe("absolute");
  });

  it("adds the reset instant and margin when the label is configured", () => {
    const quota = {
      claude: {
        label: "claude",
        weekday: 1,
        hour: 10,
        minute: 0,
        timeZone: "UTC",
        marginH: 2,
      },
    };
    expect(
      deadlineKindLabel(
        {
          deadlineKind: "quota_reset",
          quotaProvider: "claude",
          deadline: "2026-10-19T08:00:00.000Z",
        },
        quota,
      ),
    ).toBe("quota reset (claude), reset_at 2026-10-19T10:00:00.000Z, margin_h 2");
  });
});

describe("taskHistory", () => {
  const base: TaskRecord<unknown> = {
    taskId: "t",
    status: "completed",
    enqueuedAt: "2026-10-10T00:00:00.000Z",
    region: "DE",
  };

  it("returns prior turns, the prompt and the result in order", () => {
    const record: TaskRecord<unknown> = {
      ...base,
      bodyJson: JSON.stringify(
        spec("third", {
          messages: [
            { role: "user", content: "first" },
            { role: "assistant", content: "second" },
          ],
        }),
      ),
      result: { text: "fourth" },
    };
    expect(taskHistory(record)).toEqual([
      { role: "user", content: "first" },
      { role: "assistant", content: "second" },
      { role: "user", content: "third" },
      { role: "assistant", content: "fourth" },
    ]);
  });

  it("omits the assistant turn until the task completed", () => {
    const record = { ...base, status: "scheduled" as const, bodyJson: JSON.stringify(spec("q")) };
    expect(taskHistory(record)).toEqual([{ role: "user", content: "q" }]);
  });

  it("tolerates a corrupt body", () => {
    expect(taskHistory({ ...base, bodyJson: "{not json" })).toEqual([]);
    expect(taskHistory(base)).toEqual([]);
  });
});

describe("Scheduler.enqueueProviderCall task-visibility fields", () => {
  let dir: string;
  let dbPath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "tidegap-history-"));
    dbPath = join(dir, "queue.db");
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("stores a derived title, origin and absolute kind", async () => {
    const s = new Scheduler({ dbPath, feed: mockGridFeed(), signing: false });
    const rec = await s.enqueueProviderCall(spec("Summarize Q3\nmore detail"), {
      deadline: inSixHours(),
      region: "US-CAL-CISO",
      originHost: "mcp",
      originCwd: "/work/project",
    });
    s.shutdown();
    const store = new TaskStore({ dbPath });
    const row = store.get(rec.taskId)!;
    expect(row.title).toBe("Summarize Q3");
    expect(row.originHost).toBe("mcp");
    expect(row.originCwd).toBe("/work/project");
    expect(row.deadlineKind).toBe("absolute");
    expect(row.quotaProvider).toBeUndefined();
    store.close();
  });

  it("redacts a caller-given title and a prompt-derived title (AE11)", async () => {
    const s = new Scheduler({ dbPath, feed: mockGridFeed(), signing: false });
    const derived = await s.enqueueProviderCall(spec(`use key ${SECRET} to summarize`), {
      deadline: inSixHours(),
    });
    const given = await s.enqueueProviderCall(spec("p"), {
      deadline: inSixHours(),
      title: `title with ${SECRET}`,
    });
    s.shutdown();
    const store = new TaskStore({ dbPath });
    expect(store.get(derived.taskId)!.title).toBe("use key [REDACTED] to summarize");
    expect(store.get(given.taskId)!.title).toBe("title with [REDACTED]");
    store.close();
  });

  it("stores the quota kind and label", async () => {
    const s = new Scheduler({ dbPath, feed: mockGridFeed(), signing: false });
    const rec = await s.enqueueProviderCall(spec("p"), {
      deadline: inSixHours(),
      deadlineKind: "quota_reset",
      quotaProvider: "claude",
    });
    s.shutdown();
    const store = new TaskStore({ dbPath });
    expect(store.get(rec.taskId)!.deadlineKind).toBe("quota_reset");
    expect(store.get(rec.taskId)!.quotaProvider).toBe("claude");
    store.close();
  });

  it("rejects quota_reset without a label and a label without quota_reset", async () => {
    const s = new Scheduler({ dbPath, feed: mockGridFeed(), signing: false });
    await expect(
      s.enqueueProviderCall(spec("p"), { deadline: inSixHours(), deadlineKind: "quota_reset" }),
    ).rejects.toThrow(/quotaProvider/);
    await expect(
      s.enqueueProviderCall(spec("p"), {
        deadline: inSixHours(),
        deadlineKind: "absolute",
        quotaProvider: "claude",
      }),
    ).rejects.toThrow(/quotaProvider/);
    expect(s.listPersistedTasks()).toHaveLength(0);
    s.shutdown();
  });

  it("redacts prior message turns on completion and keeps them on failure", async () => {
    const s = new Scheduler({ dbPath, feed: mockGridFeed(), signing: false });
    const withSecret = (p: string) =>
      spec(p, {
        messages: [
          { role: "user", content: `earlier ${SECRET}` },
          { role: "assistant", content: "ok" },
        ],
      });
    const done = await s.enqueueProviderCall(withSecret("now"), { deadline: inSixHours() });
    await s.expediteTask(done.taskId, { anthropic: adapter() });
    const failed = await s.enqueueProviderCall(withSecret("again"), { deadline: inSixHours() });
    await s.expediteTask(failed.taskId, { anthropic: adapter({ fail: true }) });
    s.shutdown();
    const store = new TaskStore({ dbPath });
    const doneRow = store.get(done.taskId)!;
    expect(doneRow.status).toBe("completed");
    expect(doneRow.bodyJson).not.toContain(SECRET);
    expect(taskHistory(doneRow)).toEqual([
      { role: "user", content: "earlier [REDACTED]" },
      { role: "assistant", content: "ok" },
      { role: "user", content: "now" },
      { role: "assistant", content: "the answer" },
    ]);
    const failedRow = store.get(failed.taskId)!;
    expect(failedRow.status).toBe("failed");
    expect(failedRow.bodyJson).toContain(SECRET);
    store.close();
  });
});

describe("session resume helpers (ui v2)", () => {
  it("accepts 8-128 safe characters and rejects an unsubstituted placeholder", () => {
    expect(isValidSessionId("3f2a0c1e-1234-4abc-9def-0123456789ab")).toBe(true);
    expect(isValidSessionId("${CLAUDE_SESSION_ID}")).toBe(false);
    expect(isValidSessionId("short")).toBe(false);
    expect(isValidSessionId("x".repeat(129))).toBe(false);
  });

  it("builds the resume command only when cwd and a valid session exist, quoting the cwd", () => {
    expect(resumeCommand({ originCwd: "/work/tidegap", originSessionId: "sess-12345678" })).toBe(
      "cd /work/tidegap && claude --resume sess-12345678",
    );
    expect(
      resumeCommand({ originCwd: "/work/my project's", originSessionId: "sess-12345678" }),
    ).toBe("cd '/work/my project'\\''s' && claude --resume sess-12345678");
    expect(resumeCommand({ originCwd: "/work", originSessionId: undefined })).toBeUndefined();
    expect(resumeCommand({ originCwd: undefined, originSessionId: "sess-12345678" })).toBeUndefined();
    expect(resumeCommand({ originCwd: "/w", originSessionId: "${CLAUDE_SESSION_ID}" })).toBeUndefined();
  });

  it("strips control characters from the cwd", () => {
    expect(resumeCommand({ originCwd: "/w\u001b[2Jx", originSessionId: "sess-12345678" })).toBe(
      "cd '/w[2Jx' && claude --resume sess-12345678",
    );
  });
});
