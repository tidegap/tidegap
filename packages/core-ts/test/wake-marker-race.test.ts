/**
 * `writeWakeMarker` against a waiter or the sweep that removes or writes
 * the same marker between its look and its write.
 */

import { existsSync, mkdtempSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const race = vi.hoisted(() => ({ afterLook: undefined as ((path: string) => void) | undefined }));

vi.mock("node:fs", async (importOriginal) => {
  const fs = await importOriginal<typeof import("node:fs")>();
  // The next look runs `afterLook` once, right after it: another process acting at that moment.
  const lstatSync = ((path: string, ...rest: unknown[]) => {
    try {
      return (fs.lstatSync as (...a: unknown[]) => unknown)(path, ...rest);
    } finally {
      const act = race.afterLook;
      race.afterLook = undefined;
      act?.(String(path));
    }
  }) as typeof fs.lstatSync;
  return { ...fs, default: { ...fs, lstatSync }, lstatSync };
});

const { wakeMarkerPath, writeWakeMarker } = await import("../src/handoff.js");

const SESSION = "5e55a0b1-2222-4333-8444-955566667777";
let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "tidegap-wake-race-"));
});

afterEach(() => {
  race.afterLook = undefined;
  rmSync(dir, { recursive: true, force: true });
});

describe("writeWakeMarker with a concurrent remover or writer", () => {
  it("a refresh whose marker was removed after the look creates it; a create that finds one written after the look refreshes it", () => {
    const at = new Date("2026-11-01T09:00:00Z");
    const path = wakeMarkerPath(SESSION, dir)!;
    expect(writeWakeMarker(SESSION, dir)).toBeUndefined();
    // The look sees the marker, then a waiter removes it: the refresh would hit ENOENT.
    race.afterLook = (p) => p === path && unlinkSync(p);
    expect(writeWakeMarker(SESSION, dir, at)).toBeUndefined();
    expect(statSync(path).mtime.toISOString()).toBe(at.toISOString());
    // The look sees none, then the sweep writes it back: the create would hit EEXIST.
    unlinkSync(path);
    race.afterLook = (p) => p === path && writeFileSync(p, "x\n", { mode: 0o600 });
    expect(writeWakeMarker(SESSION, dir, at)).toBeUndefined();
    expect(existsSync(path)).toBe(true);
    expect(statSync(path).mtime.toISOString()).toBe(at.toISOString());
  });
});
