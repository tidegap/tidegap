/**
 * The dispatcher pill: its age does not count time the machine slept, and
 * each state has a long text, a short text for narrow windows and a title.
 */

import { describe, expect, it } from "vitest";

import { dispatcherPill } from "../ui/dispatcher.js";
import { agoAwake } from "../ui/dom.js";
import { installFakeDom } from "./fixtures/fake-dom.js";

installFakeDom();

const last = Date.parse("2026-10-22T11:05:00Z");
const now = last + 60 * 60_000;
const ticker = (over: Record<string, unknown> = {}) => ({ last_tick_at: new Date(last).toISOString(), slept_s: 0, ...over });

describe("agoAwake", () => {
  it("is the wall-clock age without a sleep", () => {
    expect(agoAwake(last, ticker(), now)).toBe("1 h ago");
    expect(agoAwake(last, undefined, now)).toBe("1 h ago");
  });

  it("subtracts the sleep of the same tick", () => {
    expect(agoAwake(last, ticker({ slept_s: 55 * 60 }), now)).toBe("5 min ago");
  });

  it("ignores a sleep reading that belongs to another tick", () => {
    expect(agoAwake(last, ticker({ slept_s: 55 * 60, last_tick_at: new Date(last - 60_000).toISOString() }), now)).toBe("1 h ago");
  });

  it("never shows a negative age", () => {
    expect(agoAwake(last, ticker({ slept_s: 3 * 3600 }), now)).toBe("just now");
  });
});

describe("dispatcherPill", () => {
  const LINE = "Tasks will not run: 2 claude-code tasks have no runner. Fix: install Claude Code.";
  const at = (ms: number) => new Date(ms).toISOString();
  const disp = (over: Record<string, unknown> = {}) => ({ state: "running", last_tick_at: at(now - 5 * 60_000), interval_s: 300, ui_child: null, ...over });
  const ready = (over: Record<string, unknown> = {}) => ({ ready: true, line: null, problems: [], ticker: ticker({ last_tick_at: at(now - 5 * 60_000) }), ...over });
  const blocked = (line: string | null) => ready({ ready: false, line, problems: [{ code: "no_runner" }] });

  const cases = {
    unknown: dispatcherPill(null, null, now),
    ran: dispatcherPill(disp(), ready(), now),
    child: dispatcherPill(disp({ last_tick_at: at(now - 20 * 60_000), interval_s: 60, ui_child: { pid: 4242, log: "/x.log", started_at: at(now - 30_000), alive: true } }), ready(), now),
    blocked: dispatcherPill(disp(), blocked(LINE), now),
    blockedNoLine: dispatcherPill(disp(), blocked(null), now),
    idle: dispatcherPill(disp({ state: "stale", last_tick_at: at(last) }), ready({ ticker: ticker({ slept_s: 55 * 60 }) }), now),
    idleHours: dispatcherPill(disp({ state: "stale", last_tick_at: at(now - 2 * 3_600_000) }), null, now),
    never: dispatcherPill(disp({ state: "never", last_tick_at: null }), null, now),
  };

  it("not loaded yet: the neutral pill", () => {
    expect(cases.unknown).toEqual({ state: "unknown", text: "Dispatcher", short: "Dispatcher", title: "Dispatcher" });
  });

  it("running: the age of the last tick, or the page's child; both read Running when narrow", () => {
    expect(cases.ran).toEqual({ state: "running", text: "Dispatcher ran 5 min ago", short: "Running", title: "Dispatcher ran 5 min ago" });
    expect(cases.child).toEqual({ state: "running", text: "Dispatcher running · PID 4242", short: "Running", title: "Dispatcher running · PID 4242" });
  });

  it("running while nothing can run: Blocked, with the readiness line as its title", () => {
    expect(cases.blocked).toEqual({ state: "blocked", text: "Running · nothing can run", short: "Blocked", title: LINE });
    expect(cases.blockedNoLine.title).toBe("Running · nothing can run");
  });

  it("idle: the awake age without its suffix in the short text", () => {
    expect(cases.idle).toEqual({ state: "stale", text: "Dispatcher idle · 5 min ago", short: "Idle · 5 min", title: "Dispatcher idle · 5 min ago" });
    expect([cases.idleHours.text, cases.idleHours.short]).toEqual(["Dispatcher idle · 2 h ago", "Idle · 2 h"]);
  });

  it("never ran: No dispatcher in both texts", () => {
    expect(cases.never).toEqual({ state: "never", text: "No dispatcher", short: "No dispatcher", title: "No dispatcher" });
  });

  it("every short text fits 15 characters, and every title is the long text or the readiness line", () => {
    for (const [name, p] of Object.entries(cases)) {
      expect([name, p.short.length <= 15]).toEqual([name, true]);
      expect([name, p.title]).toEqual([name, name === "blocked" ? LINE : p.text]);
    }
  });
});
