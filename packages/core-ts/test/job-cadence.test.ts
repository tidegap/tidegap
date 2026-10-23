/**
 * Cadence, window and anchor math (U2). The vectors live in a JSON fixture
 * so a future Python port can run the same cases.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  guaranteeText,
  JobScheduleError,
  nextOccurrence,
  parseCadence,
  parseWindow,
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
