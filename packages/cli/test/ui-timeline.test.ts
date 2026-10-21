/**
 * Timeline chart at any hour: the forecast curve has a point per hour and a
 * visible height. QA case S2.11 timed out after ~21:00 New York time because
 * it waited for the first `svg path`, the area of the current hour, which is
 * zero high while the mock FR curve is at 0 g; the curve itself was fine.
 */

import { mockGridFeed } from "@tidegap/core";
import { afterEach, describe, expect, it, vi } from "vitest";

import { state } from "../ui/state.js";
import { renderTimeline } from "../ui/timeline.js";
import { FakeElement, installFakeDom, walk } from "./fixtures/fake-dom.js";

installFakeDom();

async function render(at: Date) {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(at);
  const f = await mockGridFeed(() => new Date()).fetchForecast("FR", 72);
  Object.assign(state, { loaded: true, error: null, pending: [], finished: [], status: { default_region: "FR" } });
  state.forecasts.set("FR", {
    at: at.getTime(),
    source: f.source,
    region: f.region,
    error: null,
    points: f.entries.map((e) => ({ t: e.datetime, g: e.carbonIntensityGCo2PerKwh, band: e.band })),
  });
  const root = new FakeElement("div");
  renderTimeline(root, { width: 960 });
  const curve = walk([root]).els.find((el) => el.tagName === "path" && el.attrs.class === "curve");
  const ys = [...(curve?.attrs.d ?? "").matchAll(/[ML][\d.]+,([\d.]+)/g)].map((m) => Number(m[1]));
  return { curve, ys };
}

afterEach(() => {
  vi.useRealTimers();
  state.forecasts.clear();
});

describe("timeline chart", () => {
  it("draws the 72 h curve at 23:30 local", async () => {
    const { curve, ys } = await render(new Date(2026, 9, 20, 23, 30));
    expect(curve).toBeDefined();
    expect(ys).toHaveLength(74);
    expect(Math.max(...ys) - Math.min(...ys)).toBeGreaterThan(0);
  });

  it("draws a curve with height at every hour of the day", async () => {
    for (let hour = 0; hour < 24; hour++) {
      const { ys } = await render(new Date(2026, 9, 20, hour, 30));
      expect(ys, `hour ${hour}`).toHaveLength(74);
      expect(Math.max(...ys) - Math.min(...ys), `hour ${hour}`).toBeGreaterThan(0);
    }
  });
});
