import { describe, expect, it } from "vitest";

import { osChannel, planNotifications } from "../src/index.js";
import type { Channel, ChannelEvent, TaskRecord } from "../src/index.js";

const task = { taskId: "t-1", status: "completed", enqueuedAt: "2026-10-17T10:00:00Z", region: "DE" } as TaskRecord<unknown>;
const tg = (enabled: boolean, events: Channel["events"] = ["task_done", "task_failed", "clean_window", "not_ready"]): Channel => ({
  id: "telegram-1",
  kind: "telegram",
  enabled,
  events,
  config: { chat_id: 1 },
  createdAt: "2026-10-17T10:00:00Z",
});

describe("planNotifications", () => {
  const done: ChannelEvent = { kind: "task_done", task };

  it("an enabled telegram channel subscribed to task_done gets one job", () => {
    const jobs = planNotifications([done], [tg(true)]);
    expect(jobs).toHaveLength(1);
    expect(jobs[0]!.channel.id).toBe("telegram-1");
    expect(jobs[0]!.event).toBe(done);
  });

  it("a disabled channel gets none", () => {
    expect(planNotifications([done], [tg(false)])).toEqual([]);
  });

  it("a channel not subscribed to the event kind gets none", () => {
    expect(planNotifications([done], [tg(true, ["not_ready"])])).toEqual([]);
  });

  it("the os channel takes done and failed only, and follows its switch", () => {
    const window: ChannelEvent = { kind: "clean_window", window: { start: "2026-10-17T12:00:00Z", end: "2026-10-17T14:00:00Z" } };
    expect(planNotifications([done, window], [osChannel(true)]).map((j) => j.event.kind)).toEqual(["task_done"]);
    expect(planNotifications([done], [osChannel(false)])).toEqual([]);
  });

  describe("quiet hours (KTD10)", () => {
    const local = (h: number, m = 0) => new Date(2026, 9, 19, h, m);
    const quiet = (mode: "night" | "off"): Channel => ({ ...tg(true, ["task_done", "digest"]), config: { chat_id: 1, quiet: mode } });
    const digest: ChannelEvent = { kind: "digest", title: "Summary", text: "1 finished." };

    it("quiet night at 23:10: task_done gets no job, digest does", () => {
      expect(planNotifications([done], [quiet("night")], local(23, 10))).toEqual([]);
      expect(planNotifications([digest], [quiet("night")], local(23, 10)).map((j) => j.event.kind)).toEqual(["digest"]);
    });

    it("quiet night at 09:00 → job; quiet off at 23:10 → job; 21:59 and 08:59 bound the window", () => {
      expect(planNotifications([done], [quiet("night")], local(9, 0))).toHaveLength(1);
      expect(planNotifications([done], [quiet("off")], local(23, 10))).toHaveLength(1);
      expect(planNotifications([done], [quiet("night")], local(21, 59))).toHaveLength(1);
      expect(planNotifications([done], [quiet("night")], local(8, 59))).toEqual([]);
    });
  });
});
