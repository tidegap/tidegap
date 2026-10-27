/**
 * `schedule_task` job helpers shared by the MCP server and the OpenClaw
 * plugin: repeat -> cadence, the weekly default day, and the refusals.
 */

import { describe, expect, it } from "vitest";

import {
  commandJobRefusal,
  jobUnsupportedRefusal,
  scheduleJobInput,
  systemTimeZone,
  type ScheduleJobArgs,
} from "../src/index.js";

const base: ScheduleJobArgs = {
  prompt: "nightly digest",
  repeat: "daily",
  provider: "anthropic",
  tools: "none",
  timeZone: "UTC",
  host: "mcp",
};

describe("scheduleJobInput", () => {
  it.each<[Partial<ScheduleJobArgs>, unknown]>([
    [{ repeat: "daily" }, { kind: "daily" }],
    [{ repeat: "weekdays" }, { kind: "weekdays" }],
    [{ repeat: "weekly", days: ["fri", "mon"] }, { kind: "weekly", days: ["mon", "fri"] }],
    [{ repeat: "every_n_hours", everyHours: 6 }, { kind: "hours", every: 6 }],
  ])("maps %o to its cadence", (args, cadence) => {
    expect(scheduleJobInput({ ...base, ...args }).cadence).toEqual(cadence);
  });

  it("weekly with no days takes the weekday of the call in the job zone", () => {
    // 2026-11-02 03:00 UTC is Monday in UTC and still Sunday in Los Angeles.
    const now = new Date("2026-11-02T03:00:00Z");
    expect(scheduleJobInput({ ...base, repeat: "weekly" }, now).cadence).toEqual({ kind: "weekly", days: ["mon"] });
    expect(
      scheduleJobInput({ ...base, repeat: "weekly", timeZone: "America/Los_Angeles" }, now).cadence,
    ).toEqual({ kind: "weekly", days: ["sun"] });
  });

  it("a job with no zone uses the system zone", () => {
    const input = scheduleJobInput({ ...base, timeZone: undefined });
    expect(input.timeZone).toBe(systemTimeZone());
  });

  it("refuses a bad day name, a bad zone and every_n_hours without every_hours", () => {
    expect(() => scheduleJobInput({ ...base, repeat: "weekly", days: ["moon"] })).toThrow('unknown day "moon"');
    expect(() => scheduleJobInput({ ...base, timeZone: "Mars/Olympus" })).toThrow('unknown time zone "Mars/Olympus"');
    expect(() => scheduleJobInput({ ...base, repeat: "every_n_hours" })).toThrow("needs every_hours");
  });
});

describe("job refusals", () => {
  it("refuses a shell argument with the CLI command to run instead", () => {
    expect(commandJobRefusal({ prompt: "x", command: "ls" })).toContain(
      `schedule_task cannot create command jobs (got "command")`,
    );
    expect(commandJobRefusal({ prompt: "x" })).toBeUndefined();
  });

  it("names every per-task option a job cannot keep, in one sentence", () => {
    expect(jobUnsupportedRefusal({ prompt: "x", region: "GB" })).toBe("region cannot be used with a job repeat; omit it");
    expect(jobUnsupportedRefusal({ region: "GB", deliver: ["chat"], dispatch: false })).toBe(
      "region, deliver, dispatch cannot be used with a job repeat; omit them",
    );
  });

  it("ignores options set to false, and dispatch unless it is false", () => {
    expect(jobUnsupportedRefusal({ prompt: "x", dry_run: false, after_limit_reset: false, dispatch: true })).toBeUndefined();
  });
});
