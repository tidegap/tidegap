process.env.TZ = "UTC";
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { badgeFor, limitsLine, summaryLine } from "../src/lib/summary.js";

const NOW = Date.parse("2026-10-17T09:00:00.000Z");
const at = (h, m = 0) => new Date(NOW + (h * 60 + m) * 60_000).toISOString();
const ok = (body) => ({ state: "ok", status: 200, body: { region: "FR", active: 0, forecast_ok: true, clean_window: null, ...body } });
const later = (h, m = 0) => ({ start: at(h, m), end: at(h + 3, m), band: "clean", g: 40, now: false, fallback: false });

describe("badge (AE4)", () => {
  const cases = [
    ["no token", { state: "unpaired", message: "Not paired." }, "?"],
    ["unreachable", { state: "offline", message: "not running" }, "off"],
    ["3 active", ok({ active: 3, clean_window: later(5) }), "3"],
    ["120 active", ok({ active: 120 }), "99+"],
    ["window now", ok({ clean_window: { ...later(-1), now: true } }), "now"],
    ["window in 5 h", ok({ clean_window: later(5) }), "5h"],
    ["window in 45 min", ok({ clean_window: later(0, 45) }), "45m"],
    ["forecast unavailable", ok({ forecast_ok: false }), ""],
  ];
  for (const [name, result, text] of cases) {
    it(`${name}: "${text}"`, () => assert.equal(badgeFor(result, NOW).text, text));
  }

  it("the title has the count and the window range with the region", () => {
    const b = badgeFor(ok({ active: 3, clean_window: later(5) }), NOW);
    assert.equal(b.title, "Tidegap: 3 queued · clean 14:00-17:00 FR");
  });

  it("an error result shows ! with its message", () => {
    const b = badgeFor({ state: "error", status: 403, message: "refused" }, NOW);
    assert.equal(b.text, "!");
    assert.match(b.title, /refused/);
  });

  it("not ready: the text gets a !, the color turns amber, the tooltip starts with the line", () => {
    const readiness = { ready: false, line: "Tasks will not run: no tick daemon. Run `tidegap install`." };
    const b = badgeFor(ok({ active: 3, clean_window: later(5), readiness }), NOW);
    assert.equal(b.text, "!3");
    assert.equal(b.color, "#d97706");
    assert.equal(b.title, "Tidegap: Tasks will not run: no tick daemon. Run `tidegap install`. · 3 queued · clean 14:00-17:00 FR");
    assert.equal(badgeFor(ok({ forecast_ok: false, readiness }), NOW).text, "!");
    assert.equal(badgeFor(ok({ active: 3, readiness: { ready: true, line: null } }), NOW).text, "3");
  });

  it("summary line names a missing forecast and a fallback hour", () => {
    assert.equal(summaryLine({ active: 0, forecast_ok: false, clean_window: null }), "Queue empty · forecast unavailable");
    assert.equal(summaryLine({ active: 1, region: "DE", clean_window: { ...later(2), fallback: true } }), "1 queued · cleanest hour 11:00 DE");
  });

  it("the tooltip ends with the server's limit line when there is one", () => {
    const limits = { line: "Claude 5h: 72%, resets 16:30", status: "ok", pct: 72, resets_at: at(7, 30) };
    assert.equal(summaryLine({ active: 3, region: "FR", clean_window: later(5), limits }), "3 queued · clean 14:00-17:00 FR · Claude 5h: 72%, resets 16:30");
    assert.equal(badgeFor(ok({ active: 3, clean_window: later(5), limits }), NOW).title, "Tidegap: 3 queued · clean 14:00-17:00 FR · Claude 5h: 72%, resets 16:30");
    // The badge rule does not change.
    assert.equal(badgeFor(ok({ active: 3, clean_window: later(5), limits }), NOW).text, "3");
  });

  it("no limits, null limits and the empty line of disabled reads add nothing", () => {
    assert.equal(limitsLine({}), null);
    assert.equal(limitsLine({ limits: null }), null);
    assert.equal(limitsLine({ limits: { line: "", status: "disabled", pct: null, resets_at: null } }), null);
    assert.equal(summaryLine({ active: 0, forecast_ok: false, clean_window: null, limits: null }), "Queue empty · forecast unavailable");
  });
});
