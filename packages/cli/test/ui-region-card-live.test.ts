/** Settings → Grid region, the live card (region plan U4): load error and Retry, rate limit, expired session. API and page state are stubbed. */

import { beforeEach, describe, expect, it, vi } from "vitest";

const region = vi.fn();
const setRegion = vi.fn();
const refresh = vi.fn(async () => {});

vi.mock("../ui/api.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../ui/api.js")>()),
  api: { region: (...a: unknown[]) => region(...a), setRegion: (...a: unknown[]) => setRegion(...a) },
}));
vi.mock("../ui/state.js", () => ({ refresh: () => refresh() }));

import { ApiError, SessionExpired } from "../ui/api.js";
import { mountRegionCard } from "../ui/region-card.js";
import { FakeElement, installFakeDom, textOf, walk } from "./fixtures/fake-dom.js";

installFakeDom();

const entsoe = { id: "entsoe", label: "ENTSO-E", keyVar: "TIDEGAP_ENTSOE_SECURITY_TOKEN", live: false };
const catalog = [
  { zone: "FR", name: "France", country: "FR", countryName: "France", operator: "RTE", dataSource: entsoe },
  { zone: "PL", name: "Poland", country: "PL", countryName: "Poland", operator: "PSE", dataSource: entsoe },
];
const view = (effective = "FR", name = "France") => ({
  effective, source: "setting", name, dataSource: entsoe, stored: effective, timeZone: "Europe/Paris",
  detected: { region: "FR", source: "timezone", timeZone: "Europe/Paris" }, catalog,
});

const settle = () => new Promise((r) => setTimeout(r, 0));
const mount = async () => {
  const onExpired = vi.fn();
  const status = { textContent: "" };
  const card = mountRegionCard(new FakeElement("section") as never, { onExpired, status });
  await settle();
  const nodes = () => walk(card.body.children);
  const text = () => textOf(card.body);
  const find = (pick: (e: FakeElement) => boolean) => nodes().els.find(pick);
  return { card, onExpired, status, nodes, text, find };
};
const byAction = (action: string) => (e: FakeElement) => e.attrs["data-action"] === action;
const alertText = (m: Awaited<ReturnType<typeof mount>>) => {
  const a = m.find((e) => e.attrs.role === "alert");
  return a ? textOf(a) : undefined;
};
/** Pick PL in the select and press Save, as a user would. */
function choosePlAndSave(m: Awaited<ReturnType<typeof mount>>) {
  const select = m.find((e) => e.attrs.id === "region-select")!;
  Object.assign(select, { value: "PL" });
  select.dispatch("change");
  m.find((e) => e.tagName === "form")!.dispatch("submit", { preventDefault() {} });
}

beforeEach(() => {
  region.mockReset();
  setRegion.mockReset();
  refresh.mockClear();
});

describe("load", () => {
  it("a network failure shows 'Could not load the grid region.' with Retry; Retry loads again and draws the card", async () => {
    region.mockRejectedValueOnce(new TypeError("fetch failed")).mockResolvedValueOnce(view());
    const m = await mount();
    expect(alertText(m)).toBe("Could not load the grid region.");
    expect(m.find(byAction("retry"))).toBeDefined();
    m.find(byAction("retry"))!.dispatch("click");
    await settle();
    expect(region).toHaveBeenCalledTimes(2);
    expect(alertText(m)).toBeUndefined();
    expect(m.text()).toContain("France");
  });

  it("a failed Retry keeps the error and the button", async () => {
    region.mockRejectedValue(new ApiError(500, "boom"));
    const m = await mount();
    m.find(byAction("retry"))!.dispatch("click");
    await settle();
    expect(region).toHaveBeenCalledTimes(2);
    expect(alertText(m)).toBe("Could not load the grid region.");
    expect(m.find(byAction("retry"))).toBeDefined();
  });

  it("403 says settings open in the printed page and the Mac app", async () => {
    region.mockRejectedValue(new ApiError(403, "forbidden"));
    const m = await mount();
    expect(alertText(m)).toBe("Settings open in the page that tidegap ui prints and in the Mac app.");
  });

  it("an expired session calls onExpired once and draws no error", async () => {
    region.mockRejectedValue(new SessionExpired());
    const m = await mount();
    expect(m.onExpired).toHaveBeenCalledTimes(1);
    expect(alertText(m)).toBeUndefined();
    expect(m.text()).toContain("Loading…");
  });
});

describe("save", () => {
  it("429 shows the server's wait sentence as an alert, re-enables Save and leaves the zone, the status line and the page alone", async () => {
    region.mockResolvedValue(view());
    setRegion.mockRejectedValue(new ApiError(429, "Wait 7 seconds and try again.", { code: "rate_limited" }));
    const m = await mount();
    choosePlAndSave(m);
    await settle();
    expect(setRegion).toHaveBeenCalledWith("PL");
    expect(alertText(m)).toBe("Wait 7 seconds and try again.");
    expect(m.text()).toContain("France");
    expect(m.find(byAction("save"))!.attrs.disabled).toBeUndefined();
    expect(m.find((e) => e.attrs.id === "region-select")!.attrs.disabled).toBeUndefined();
    expect(m.status.textContent).toBe("");
    expect(refresh).not.toHaveBeenCalled();
  });

  it("an offline save says Tidegap could not be reached", async () => {
    region.mockResolvedValue(view());
    setRegion.mockRejectedValue(new TypeError("fetch failed"));
    const m = await mount();
    choosePlAndSave(m);
    await settle();
    expect(alertText(m)).toBe("Could not reach Tidegap. Try again.");
  });

  it("an expired session on Save calls onExpired once and shows no error", async () => {
    region.mockResolvedValue(view());
    setRegion.mockRejectedValue(new SessionExpired());
    const m = await mount();
    choosePlAndSave(m);
    await settle();
    expect(m.onExpired).toHaveBeenCalledTimes(1);
    expect(alertText(m)).toBeUndefined();
    expect(refresh).not.toHaveBeenCalled();
  });

  it("a successful save draws the new zone, announces it and refreshes the page (control)", async () => {
    region.mockResolvedValue(view());
    setRegion.mockResolvedValue(view("PL", "Poland"));
    const m = await mount();
    choosePlAndSave(m);
    await settle();
    expect(m.text()).toContain("Poland");
    expect(alertText(m)).toBeUndefined();
    expect(m.status.textContent).toBe("Region set to Poland (PL).");
    expect(refresh).toHaveBeenCalledTimes(1);
  });
});
