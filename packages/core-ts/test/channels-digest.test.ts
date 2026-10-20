import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { buildDigest, DIGEST_LIST_MAX, digestAt, digestDue, foldIntoDigest, parseDigestAt, planNotifications } from "../src/index.js";
import type { Channel, ChannelEvent, ReadinessProblem, TaskRecord } from "../src/index.js";

const H = 3_600_000;

const rec = (id: string, status: TaskRecord<unknown>["status"], grams?: number): TaskRecord<unknown> =>
  ({
    taskId: id,
    title: `task ${id}`,
    status,
    enqueuedAt: "2026-10-17T10:00:00Z",
    completedAt: "2026-10-17T23:10:00Z",
    region: "DE",
    ...(grams !== undefined ? { receipt: { actualCarbonGCo2: grams } } : {}),
  }) as TaskRecord<unknown>;

const problem: ReadinessProblem = { code: "no_runner", provider: "claude-code", message: "No runner for claude-code tasks.", fix: "tidegap install" };

function withTz(tz: string) {
  let prev: string | undefined;
  beforeEach(() => {
    prev = process.env.TZ;
    process.env.TZ = tz;
  });
  afterEach(() => {
    if (prev === undefined) delete process.env.TZ;
    else process.env.TZ = prev;
  });
}

describe("parseDigestAt / digestAt", () => {
  it("accepts HH:MM in 00:00–23:59 only", () => {
    expect(parseDigestAt("09:00")).toEqual({ h: 9, m: 0 });
    expect(parseDigestAt("23:59")).toEqual({ h: 23, m: 59 });
    for (const bad of ["9:00", "24:00", "12:60", "", "noon", 900, undefined]) expect(parseDigestAt(bad)).toBeNull();
  });
  it("falls back to 09:00 for an absent or bad stored value", () => {
    expect(digestAt(undefined)).toBe("09:00");
    expect(digestAt("25:00")).toBe("09:00");
    expect(digestAt("07:30")).toBe("07:30");
  });
});

describe("digestDue (local time)", () => {
  withTz("Europe/Berlin");
  const local = (d: string) => new Date(d); // ISO without zone = local time

  it("08:59 → not due; 09:01 → due; a second tick at 09:30 after a send → not due", () => {
    const last = local("2026-10-19T09:00:30").toISOString();
    expect(digestDue(local("2026-10-20T08:59:00"), last).due).toBe(false);
    const at901 = digestDue(local("2026-10-20T09:01:00"), last);
    expect(at901.due).toBe(true);
    expect(at901.since.toISOString()).toBe(last);
    expect(digestDue(local("2026-10-20T09:30:00"), local("2026-10-20T09:01:00").toISOString()).due).toBe(false);
  });

  it("a machine asleep until 15:00 sends at 15:00", () => {
    expect(digestDue(local("2026-10-20T15:00:00"), local("2026-10-19T09:00:00").toISOString()).due).toBe(true);
  });

  it("asleep until the next day 10:00: one summary covering at most 48 h", () => {
    const now = local("2026-10-22T10:00:00");
    const r = digestDue(now, local("2026-10-18T09:00:00").toISOString());
    expect(r.due).toBe(true);
    expect(now.getTime() - r.since.getTime()).toBe(48 * H);
    expect(digestDue(local("2026-10-22T11:00:00"), now.toISOString()).due).toBe(false);
  });

  it("the first summary covers the last 24 h", () => {
    const now = local("2026-10-20T09:05:00");
    const r = digestDue(now, undefined);
    expect(r.due).toBe(true);
    expect(now.getTime() - r.since.getTime()).toBe(24 * H);
  });

  it("follows a custom send time", () => {
    const last = local("2026-10-19T07:00:00").toISOString();
    expect(digestDue(local("2026-10-20T06:59:00"), last, "07:00").due).toBe(false);
    expect(digestDue(local("2026-10-20T07:00:00"), last, "07:00").due).toBe(true);
  });

  it("a send time moved later the same day does not send a second summary", () => {
    const sentToday = local("2026-10-20T09:00:00").toISOString();
    expect(digestDue(local("2026-10-20T18:01:00"), sentToday, "18:00").due).toBe(false);
    expect(digestDue(local("2026-10-21T18:01:00"), sentToday, "18:00").due).toBe(true);
  });

  it("DST end (2026-10-25, 25-hour day): due at 09:00 local, once", () => {
    const last = local("2026-10-24T09:00:00").toISOString();
    expect(digestDue(local("2026-10-25T08:59:00"), last).due).toBe(false);
    const now = local("2026-10-25T09:00:00");
    expect(digestDue(now, last).due).toBe(true);
    expect(now.getTime() - Date.parse(last)).toBe(25 * H);
  });
});

describe("digestDue across zones and DST start", () => {
  describe("America/New_York", () => {
    withTz("America/New_York");
    it("the same instant is 09:30 in New York: due", () => {
      expect(digestDue(new Date("2026-10-20T13:30:00Z"), "2026-10-19T13:00:00Z").due).toBe(true);
    });
    it("a send time in the spring-forward gap (02:30 on 2026-03-08) moves to 03:30", () => {
      const last = new Date("2026-03-07T02:30:00").toISOString();
      expect(digestDue(new Date("2026-03-08T03:29:00"), last, "02:30").due).toBe(false);
      expect(digestDue(new Date("2026-03-08T03:30:00"), last, "02:30").due).toBe(true);
    });
  });
  describe("Asia/Tokyo", () => {
    withTz("Asia/Tokyo");
    it("the same instant is 22:30 in Tokyo, a day after the last summary: due", () => {
      expect(digestDue(new Date("2026-10-20T13:30:00Z"), "2026-10-19T00:00:00Z").due).toBe(true);
    });
    it("the same instant is 08:30 in Tokyo: not due yet", () => {
      expect(digestDue(new Date("2026-10-19T23:30:00Z"), "2026-10-19T00:00:00Z").due).toBe(false);
    });
  });
});

describe("buildDigest", () => {
  const since = new Date("2026-10-19T07:00:00Z");
  const now = new Date("2026-10-20T07:00:00Z");
  const base = { since, now, done: [], failed: [], postponed: [], problems: [], queued: 0 };

  it("an empty day makes no summary, even with queued work", () => {
    expect(buildDigest(base)).toBeNull();
    expect(buildDigest({ ...base, queued: 3 })).toBeNull();
  });

  it("two done and one failed: counts, titles, total grams, covers", () => {
    const d = buildDigest({ ...base, done: [rec("a", "completed", 2.5), rec("b", "completed", 1)], failed: [rec("c", "failed")] })!;
    expect(d.title).toBe("Tidegap daily summary: 2 done, 1 failed");
    expect(d.text).toContain("Done (2):\n- task a\n- task b");
    expect(d.text).toContain("Failed (1):\n- task c");
    expect(d.text).toContain("Carbon of done tasks: 3.5 g CO2e.");
    expect(d.covers).toEqual({ taskIds: ["a", "b", "c"], notReady: false });
  });

  it("lists at most 10 titles, then 'and N more'", () => {
    const many = Array.from({ length: DIGEST_LIST_MAX + 3 }, (_, i) => rec(`t${i}`, "completed"));
    const d = buildDigest({ ...base, done: many })!;
    expect(d.text).toContain("- task t9\n- and 3 more");
    expect(d.text).not.toContain("task t10");
  });

  it("an open problem alone makes a summary that lists it; postponed tasks are listed", () => {
    const d = buildDigest({ ...base, problems: [problem], postponed: [rec("p", "scheduled")] })!;
    expect(d.title).toBe("Tidegap daily summary: 1 postponed");
    expect(d.text).toContain("Postponed (1):\n- task p");
    expect(d.text).toContain("Cannot run yet:\nNo runner for claude-code tasks. Run `tidegap install`.");
    expect(d.covers?.notReady).toBe(true);
  });

  it("names the queued count and the next clean window", () => {
    const window = { start: "2026-10-21T01:00:00Z", end: "2026-10-21T04:00:00Z" };
    const d = buildDigest({ ...base, done: [rec("a", "completed")], queued: 2, window })!;
    expect(d.text).toMatch(/Planned: 2 queued tasks\. Next clean window: .+ to .+\./);
    expect(d.covers?.cleanWindow).toBe(window.start);
  });
});

describe("foldIntoDigest", () => {
  const ch = (id: string, events: Channel["events"], quiet = "off"): Channel => ({
    id,
    kind: "webhook",
    enabled: true,
    events,
    config: { quiet },
    createdAt: "2026-10-17T10:00:00Z",
  });
  const digest: ChannelEvent = { kind: "digest", title: "Tidegap daily summary", text: "x", covers: { taskIds: ["a"], notReady: true } };
  const doneA: ChannelEvent = { kind: "task_done", task: rec("a", "completed") };
  const doneB: ChannelEvent = { kind: "task_done", task: rec("b", "completed") };
  const notReady: ChannelEvent = { kind: "not_ready", problems: [problem] };
  const morning = new Date(2026, 9, 20, 9, 0);

  it("a channel that gets the summary gets no separate alert for what it lists", () => {
    const jobs = planNotifications([doneA, notReady, digest], [ch("w", ["task_done", "not_ready", "digest"])], morning);
    const { jobs: kept, dropped, folded } = foldIntoDigest(jobs);
    expect(kept.map((j) => j.event.kind)).toEqual(["digest"]);
    expect(dropped.map((j) => `${j.channel.id}:${j.event.kind}`)).toEqual(["w:task_done", "w:not_ready"]);
    expect([...folded].sort()).toEqual(["not_ready", "task_done"]);
  });

  it("an alert for a task the summary does not list still goes out", () => {
    const { jobs } = foldIntoDigest(planNotifications([doneB, digest], [ch("w", ["task_done", "digest"])], morning));
    expect(jobs.map((j) => j.event.kind)).toEqual(["task_done", "digest"]);
  });

  it("11 failed tasks: the summary names 10, so the 11th keeps its own alert", () => {
    const failed = Array.from({ length: DIGEST_LIST_MAX + 1 }, (_, i) => rec(`f${i}`, "failed"));
    const d = buildDigest({ since: new Date(morning.getTime() - 24 * H), now: morning, done: [], failed, postponed: [], problems: [], queued: 0 })!;
    expect(d.covers?.taskIds).toEqual(failed.slice(0, DIGEST_LIST_MAX).map((r) => r.taskId));
    const events: ChannelEvent[] = [...failed.map((task): ChannelEvent => ({ kind: "task_failed", task })), d];
    const { jobs, dropped } = foldIntoDigest(planNotifications(events, [ch("w", ["task_failed", "digest"])], morning));
    expect(jobs.map((j) => (j.event.kind === "task_failed" ? j.event.task.taskId : j.event.kind))).toEqual(["f10", "digest"]);
    expect(dropped).toHaveLength(DIGEST_LIST_MAX);
  });

  it("a channel without the summary keeps its alerts", () => {
    const { jobs, folded } = foldIntoDigest(planNotifications([notReady, digest], [ch("w", ["digest"]), ch("s", ["not_ready"])], morning));
    expect(jobs.map((j) => `${j.channel.id}:${j.event.kind}`)).toEqual(["s:not_ready", "w:digest"]);
    expect(folded.size).toBe(0);
  });
});
