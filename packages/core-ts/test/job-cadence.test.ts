/**
 * Cadence, window and anchor math (U2). The vectors live in a JSON fixture
 * so a future Python port can run the same cases.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  guaranteeText,
  JobScheduleError,
  nextOccurrence,
  parseCadence,
  parseWindow,
  systemTimeZone,
  untilBoundMs,
  validateJobSchedule,
} from "../src/index.js";
import type { JobSchedule, Occurrence } from "../src/index.js";

interface Vector {
  name: string;
  schedule: JobSchedule;
  now: string;
  lastRunStart?: string;
  skippedDeadline?: string;
  expect?: Occurrence;
  error?: string;
}

const fixture = JSON.parse(
  readFileSync(join(dirname(fileURLToPath(import.meta.url)), "fixtures", "job-cadence-vectors.json"), "utf8"),
) as { vectors: Vector[]; guarantees: Array<{ schedule: JobSchedule; text: string }> };

describe("nextOccurrence vectors", () => {
  for (const v of fixture.vectors) {
    it(v.name, () => {
      const run = () =>
        nextOccurrence(v.schedule, { now: v.now, lastRunStart: v.lastRunStart, skippedDeadline: v.skippedDeadline });
      if (v.error !== undefined) {
        expect(run).toThrow(JobScheduleError);
        expect(run).toThrow(v.error);
      } else {
        expect(run()).toEqual(v.expect);
      }
    });
  }
});

describe("guaranteeText", () => {
  for (const g of fixture.guarantees) {
    it(g.text, () => {
      expect(guaranteeText(g.schedule)).toBe(g.text);
    });
  }
});

describe("parsing", () => {
  it("parses the cadence forms", () => {
    expect(parseCadence("daily")).toEqual({ kind: "daily" });
    expect(parseCadence("Weekdays")).toEqual({ kind: "weekdays" });
    expect(parseCadence("weekly:mon,Thursday")).toEqual({ kind: "weekly", days: ["mon", "thu"] });
    expect(parseCadence("weekly mon")).toEqual({ kind: "weekly", days: ["mon"] });
    expect(parseCadence("weekly:  mon, thu")).toEqual({ kind: "weekly", days: ["mon", "thu"] });
    expect(parseCadence("every 6h")).toEqual({ kind: "hours", every: 6 });
    expect(parseCadence("every 12 hours")).toEqual({ kind: "hours", every: 12 });
    expect(() => parseCadence("hourly")).toThrow("unknown cadence");
    expect(() => parseCadence("weekly:moon")).toThrow('unknown day "moon"');
  });

  it("rejects a long run of whitespace in linear time (no regex backtracking)", () => {
    const started = Date.now();
    expect(() => parseCadence(`weekly\t${" ".repeat(100_000)}x\ny`)).toThrow("unknown cadence");
    expect(Date.now() - started).toBeLessThan(500);
  });

  it("parses a window and pads hours", () => {
    expect(parseWindow("0:00-8:00")).toEqual({ start: "00:00", end: "08:00" });
    expect(parseWindow("22:00-06:00")).toEqual({ start: "22:00", end: "06:00" });
    expect(() => parseWindow("24:00-08:00")).toThrow("HH:MM-HH:MM");
    expect(() => parseWindow("night")).toThrow("HH:MM-HH:MM");
  });

  it("validation orders and deduplicates weekly days", () => {
    expect(
      validateJobSchedule({ cadence: { kind: "weekly", days: ["thu", "mon", "thu"] }, timeZone: "UTC" }).cadence,
    ).toEqual({ kind: "weekly", days: ["mon", "thu"] });
  });
});

describe("systemTimeZone", () => {
  afterEach(() => vi.restoreAllMocks());

  it("returns the runtime zone", () => {
    expect(systemTimeZone()).toBe(Intl.DateTimeFormat().resolvedOptions().timeZone);
  });

  it("falls back to UTC when the runtime reports an empty zone", () => {
    const real = Intl.DateTimeFormat.prototype.resolvedOptions;
    vi.spyOn(Intl.DateTimeFormat.prototype, "resolvedOptions").mockImplementation(function (this: Intl.DateTimeFormat) {
      return { ...real.call(this), timeZone: "" };
    });
    expect(systemTimeZone()).toBe("UTC");
  });

  it("falls back to UTC when the runtime reports a zone it cannot use", () => {
    const real = Intl.DateTimeFormat.prototype.resolvedOptions;
    vi.spyOn(Intl.DateTimeFormat.prototype, "resolvedOptions").mockImplementation(function (this: Intl.DateTimeFormat) {
      return { ...real.call(this), timeZone: "Etc/Unknown" };
    });
    expect(systemTimeZone()).toBe("UTC");
  });
});

describe("untilBoundMs", () => {
  it("a day ends at the next local midnight, on DST days, in a DST gap and at a month end", () => {
    // Europe/Berlin: 25 October 2026 has 25 h, 29 March 2026 has 23 h.
    expect(untilBoundMs("2026-10-25", "Europe/Berlin")).toBe(Date.parse("2026-10-25T23:00:00.000Z"));
    expect(untilBoundMs("2026-03-29", "Europe/Berlin")).toBe(Date.parse("2026-03-29T22:00:00.000Z"));
    // America/Santiago springs forward at midnight on 6 September 2026: the first instant after the gap.
    expect(untilBoundMs("2026-09-05", "America/Santiago")).toBe(Date.parse("2026-09-06T04:00:00.000Z"));
    expect(untilBoundMs("2026-12-31", "UTC")).toBe(Date.parse("2027-01-01T00:00:00.000Z"));
    expect(untilBoundMs("2026-02-28", "America/New_York")).toBe(Date.parse("2026-03-01T05:00:00.000Z"));
  });

  it("an instant is its own bound; a day or a time that does not exist is refused", () => {
    expect(untilBoundMs("2026-11-17T10:00:00+02:00", "UTC")).toBe(Date.parse("2026-11-17T08:00:00.000Z"));
    expect(untilBoundMs("2026-11-17T10:00Z", "UTC")).toBe(Date.parse("2026-11-17T10:00:00.000Z"));
    for (const bad of ["2026-02-30", "2026-02-30T10:00:00Z", "2026-11-17T24:00:00Z", "2026-11-17T10:60Z", "2026-11-17T10:00:00+25:00", "2026-11-17T10:00:00", "soon"]) {
      expect(() => untilBoundMs(bad, "UTC"), bad).toThrow(JobScheduleError);
    }
  });
});
