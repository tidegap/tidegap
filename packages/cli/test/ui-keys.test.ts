/** The page's keyboard map: the number keys open the four views. The document is a stub that records the keydown handler. */

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { initKeys } from "../ui/keys.js";

let onKey: (e: Record<string, unknown>) => void;
const saved = (globalThis as Record<string, unknown>).document;

beforeAll(() => {
  vi.stubGlobal("Element", class {});
  vi.stubGlobal("document", {
    activeElement: null,
    addEventListener: (type: string, fn: typeof onKey) => {
      if (type === "keydown") onKey = fn;
    },
    getElementById: (id: string) => (id === "dialog" ? { open: false } : { contains: () => false }),
    querySelectorAll: () => [],
  });
});
afterAll(() => {
  vi.unstubAllGlobals();
  (globalThis as Record<string, unknown>).document = saved;
});

describe("view keys", () => {
  it("1 2 3 4 open Agenda, Timeline, Journal and Jobs", () => {
    const view = vi.fn();
    initKeys({ current: () => null, open: vi.fn(), close: vi.fn(), drawerOpen: () => false, act: vi.fn(), view, filters: vi.fn(), help: vi.fn() });
    for (const key of ["1", "2", "3", "4"]) onKey({ key, target: { tagName: "BODY" }, preventDefault() {} });
    expect(view.mock.calls.map((c) => c[0])).toEqual(["agenda", "timeline", "journal", "jobs"]);
  });
});
