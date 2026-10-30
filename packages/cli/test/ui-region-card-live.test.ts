/** Settings → Grid region, the live card (region plan U4): load error and Retry, rate limit, expired session, typing with an input method, a press that ends a composition. API and page state are stubbed. */

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
/** Whether `el` is still in the card: walk the card tree from its root (the fake `contains` does not model the tree). */
const inCard = (m: Awaited<ReturnType<typeof mount>>, el: FakeElement) => m.nodes().els.includes(el);
/** A press on a submit button submits its own form, as the browser does. */
function press(button: FakeElement) {
  let form = button.parent;
  while (form && form.tagName !== "form") form = form.parent;
  form?.dispatch("submit", { preventDefault() {} });
}
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
    expect(m.find(byAction("retry"))).toBeUndefined();
    expect(m.find((e) => e.attrs.id === "region-select")).toBeDefined();
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
    const save = m.find(byAction("save"))!;
    choosePlAndSave(m);
    await settle();
    expect(setRegion).toHaveBeenCalledWith("PL");
    expect(alertText(m)).toBe("Wait 7 seconds and try again.");
    expect(m.text()).toContain("France");
    expect(m.find(byAction("save"))).toBe(save);
    expect(save.attrs.disabled).toBeUndefined();
    expect(m.find((e) => e.attrs.id === "region-select")!.attrs.disabled).toBeUndefined();
    expect(m.status.textContent).toBe("");
    expect(refresh).not.toHaveBeenCalled();
  });

  it("a Save and its error keep the select's option nodes when the list does not change", async () => {
    region.mockResolvedValue(view());
    setRegion.mockRejectedValue(new ApiError(429, "Wait 7 seconds and try again.", { code: "rate_limited" }));
    const m = await mount();
    const select = m.find((e) => e.attrs.id === "region-select")!;
    Object.assign(select, { value: "PL" });
    select.dispatch("change");
    const list = [...select.children];
    m.find((e) => e.tagName === "form")!.dispatch("submit", { preventDefault() {} });
    expect(select.attrs.disabled).toBe("");
    await settle();
    expect(alertText(m)).toBe("Wait 7 seconds and try again.");
    expect(select.children).toHaveLength(list.length);
    expect(select.children.every((o, i) => o === list[i])).toBe(true);
    expect(select).toHaveProperty("value", "PL");
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

describe("search with an input method (IME)", () => {
  const search = (m: Awaited<ReturnType<typeof mount>>) => m.find((e) => e.attrs.id === "region-search")!;
  const options = (m: Awaited<ReturnType<typeof mount>>) => m.nodes().els.filter((e) => e.tagName === "option").map((e) => e.attrs.value);
  const selected = (m: Awaited<ReturnType<typeof mount>>) => m.nodes().els.find((e) => e.tagName === "option" && "selected" in e.attrs)?.attrs.value;
  /** Type `value` into the search, as the browser's input event reports it. */
  const type = (el: FakeElement, value: string) => {
    Object.assign(el, { value });
    el.dispatch("input");
  };

  it("input during a composition keeps the search node and does not filter; compositionend filters by the composed text", async () => {
    region.mockResolvedValue(view());
    const m = await mount();
    const el = search(m);
    el.dispatch("compositionstart");
    type(el, "Po");
    type(el, "Pol");
    expect(search(m)).toBe(el);
    expect(options(m)).toEqual(["auto", "FR", "PL"]);
    el.dispatch("compositionend");
    expect(options(m)).toEqual(["PL"]);
  });

  it("a redraw from another source during a composition waits for compositionend, then draws it with the composed text", async () => {
    region.mockResolvedValue(view());
    const m = await mount();
    const el = search(m);
    el.dispatch("compositionstart");
    type(el, "entso");
    const select = m.find((e) => e.attrs.id === "region-select")!;
    Object.assign(select, { value: "PL" });
    select.dispatch("change");
    expect(search(m)).toBe(el);
    expect(selected(m)).toBe("FR");
    el.dispatch("compositionend");
    expect(options(m)).toEqual(["FR", "PL"]);
    expect(selected(m)).toBe("PL");
  });

  it("a composition whose compositionend never comes ends when the search loses focus: the list filters and later typing draws", async () => {
    region.mockResolvedValue(view());
    const m = await mount();
    const el = search(m);
    el.dispatch("compositionstart");
    type(el, "Pol");
    el.dispatch("blur");
    expect(options(m)).toEqual(["PL"]);
    type(search(m), "fr");
    expect(options(m)).toEqual(["FR"]);
  });

  it("leaving the search with no composition open keeps a shown Save error (control)", async () => {
    region.mockResolvedValue(view());
    setRegion.mockRejectedValue(new ApiError(429, "Wait 7 seconds and try again.", { code: "rate_limited" }));
    const m = await mount();
    choosePlAndSave(m);
    await settle();
    search(m).dispatch("blur");
    expect(alertText(m)).toBe("Wait 7 seconds and try again.");
  });

  it("plain typing with no composition filters at once and keeps the search node (control)", async () => {
    region.mockResolvedValue(view());
    const m = await mount();
    const el = search(m);
    type(el, "Pol");
    expect(search(m)).toBe(el);
    expect(options(m)).toEqual(["PL"]);
  });

  it("the select's options follow the query without replacing the select", async () => {
    region.mockResolvedValue(view());
    const m = await mount();
    const select = m.find((e) => e.attrs.id === "region-select")!;
    type(search(m), "Pol");
    expect(options(m)).toEqual(["PL"]);
    type(search(m), "");
    expect(options(m)).toEqual(["auto", "FR", "PL"]);
    expect(m.find((e) => e.attrs.id === "region-select")).toBe(select);
  });

  it("a draw while typing leaves the search value alone, so the caret stays where the user types", async () => {
    region.mockResolvedValue(view());
    const m = await mount();
    const el = search(m);
    let value = "";
    const writes: string[] = [];
    Object.defineProperty(el, "value", { get: () => value, set: (v: string) => void writes.push((value = v)), configurable: true });
    value = "Pol";
    el.dispatch("input");
    expect(options(m)).toEqual(["PL"]);
    expect(search(m)).toBe(el);
    expect(writes).toEqual([]);
  });

  it("the kept form drops the no-match line and the error description when the next search matches", async () => {
    region.mockResolvedValue(view());
    setRegion.mockRejectedValue(new ApiError(429, "Wait 7 seconds and try again.", { code: "rate_limited" }));
    const m = await mount();
    const select = m.find((e) => e.attrs.id === "region-select")!;
    const noMatch = () => m.find((e) => "nomatch" in e.dataset)!;
    type(search(m), "zzz");
    expect(textOf(noMatch())).toContain('No supported zone matches "zzz"');
    expect(noMatch().attrs.hidden).toBeUndefined();
    m.find((e) => e.tagName === "form")!.dispatch("submit", { preventDefault() {} });
    await settle();
    expect(setRegion).toHaveBeenCalledWith("zzz");
    expect(select.attrs["aria-describedby"]).toBe("region-error");
    type(search(m), "Pol");
    expect(alertText(m)).toBeUndefined();
    expect(select.attrs["aria-describedby"]).toBeUndefined();
    expect(noMatch().attrs.hidden).toBe("");
    expect(textOf(noMatch())).toBe("");
    expect(m.find((e) => e.attrs.id === "region-select")).toBe(select);
    expect(options(m)).toEqual(["PL"]);
  });
});

describe("a press that ends a composition", () => {
  const search = (m: Awaited<ReturnType<typeof mount>>) => m.find((e) => e.attrs.id === "region-search")!;
  const options = (m: Awaited<ReturnType<typeof mount>>) => m.nodes().els.filter((e) => e.tagName === "option").map((e) => e.attrs.value);
  const selected = (m: Awaited<ReturnType<typeof mount>>) => m.nodes().els.find((e) => e.tagName === "option" && "selected" in e.attrs)?.attrs.value;
  const compose = (el: FakeElement, value: string) => {
    el.dispatch("compositionstart");
    Object.assign(el, { value });
    el.dispatch("input");
  };
  /** The press moves focus off the search: blur, then the input method ends the composition. */
  const endByPress = (el: FakeElement) => {
    el.dispatch("blur");
    el.dispatch("compositionend");
  };
  const germany = { zone: "DE", name: "Germany", country: "DE", countryName: "Germany", operator: "TenneT", dataSource: entsoe };

  it("a Save press that ends a composition saves the zone the form then shows", async () => {
    region.mockResolvedValue({ ...view(), catalog: [...catalog, germany] });
    setRegion.mockResolvedValue({ ...view("DE", "Germany"), catalog: [...catalog, germany] });
    const m = await mount();
    const select = m.find((e) => e.attrs.id === "region-select")!;
    Object.assign(select, { value: "PL" });
    select.dispatch("change");
    const save = m.find(byAction("save"))!;
    expect(save.attrs.disabled).toBeUndefined();
    const el = search(m);
    compose(el, "Ger");
    expect(selected(m)).toBe("PL");
    endByPress(el);
    expect(inCard(m, save)).toBe(true);
    expect(selected(m)).toBe("DE");
    expect(save.attrs.disabled).toBeUndefined();
    press(save);
    expect(setRegion).toHaveBeenCalledTimes(1);
    expect(setRegion).toHaveBeenCalledWith("DE");
    await settle();
    expect(m.status.textContent).toBe("Region set to Germany (DE).");
  });

  it("a select change that ends a composition chooses the zone", async () => {
    region.mockResolvedValue(view());
    const m = await mount();
    const select = m.find((e) => e.attrs.id === "region-select")!;
    const el = search(m);
    compose(el, "entso");
    endByPress(el);
    expect(inCard(m, select)).toBe(true);
    expect(options(m)).toEqual(["FR", "PL"]);
    Object.assign(select, { value: "PL" });
    select.dispatch("change");
    expect(selected(m)).toBe("PL");
    expect(m.find(byAction("save"))!.attrs.disabled).toBeUndefined();
  });
});

describe("Save while a composition is open", () => {
  const search = (m: Awaited<ReturnType<typeof mount>>) => m.find((e) => e.attrs.id === "region-search")!;
  const current = (m: Awaited<ReturnType<typeof mount>>) => textOf(m.find((e) => e.attrs.class === "region-current")!);
  /** A request that settles when the test says so. */
  const deferred = () => {
    let resolve!: (v: unknown) => void;
    let reject!: (e: unknown) => void;
    const promise = new Promise((res, rej) => {
      resolve = res;
      reject = rej;
    });
    return { promise, resolve, reject };
  };
  /** Choose PL, then open a composition in the search and leave it open: WebKit does not focus a clicked button, so the press sends no blur. */
  const composeAfterPl = (m: Awaited<ReturnType<typeof mount>>) => {
    const select = m.find((e) => e.attrs.id === "region-select")!;
    Object.assign(select, { value: "PL" });
    select.dispatch("change");
    const el = search(m);
    el.dispatch("compositionstart");
    Object.assign(el, { value: "Pol" });
    el.dispatch("input");
    return el;
  };

  it("two presses send one request; Save shows 'Saving…' and is disabled from the first press", async () => {
    region.mockResolvedValue(view());
    const req = deferred();
    setRegion.mockReturnValue(req.promise);
    const m = await mount();
    composeAfterPl(m);
    const save = m.find(byAction("save"))!;
    const form = m.find((e) => e.tagName === "form")!;
    press(save);
    expect(textOf(save)).toBe("Saving…");
    expect(save.attrs.disabled).toBe("");
    expect(form.attrs["aria-busy"]).toBe("true");
    press(save);
    expect(setRegion).toHaveBeenCalledTimes(1);
    expect(setRegion).toHaveBeenCalledWith("PL");
    req.resolve(view("PL", "Poland"));
    await settle();
    expect(setRegion).toHaveBeenCalledTimes(1);
  });

  it("a save that settles during the composition shows 'Save' again; the rest of the card draws on compositionend", async () => {
    region.mockResolvedValue(view());
    const req = deferred();
    setRegion.mockReturnValue(req.promise);
    const m = await mount();
    const el = composeAfterPl(m);
    const save = m.find(byAction("save"))!;
    press(save);
    expect(textOf(save)).toBe("Saving…");
    req.resolve(view("PL", "Poland"));
    await settle();
    expect(textOf(save)).toBe("Save");
    expect(m.find((e) => e.tagName === "form")!.attrs["aria-busy"]).toBe("false");
    expect(m.status.textContent).toBe("Region set to Poland (PL).");
    expect(current(m)).toContain("France");
    el.dispatch("compositionend");
    expect(current(m)).toContain("Poland");
    expect(m.find(byAction("save"))).toBe(save);
    expect(textOf(save)).toBe("Save");
    expect(save.attrs.disabled).toBe("");
  });

  it("a failed save during the composition enables Save again; the error shows on compositionend", async () => {
    region.mockResolvedValue(view());
    const req = deferred();
    setRegion.mockReturnValue(req.promise);
    const m = await mount();
    const el = composeAfterPl(m);
    const save = m.find(byAction("save"))!;
    press(save);
    expect(save.attrs.disabled).toBe("");
    req.reject(new ApiError(429, "Wait 7 seconds and try again.", { code: "rate_limited" }));
    await settle();
    expect(textOf(save)).toBe("Save");
    expect(save.attrs.disabled).toBeUndefined();
    expect(alertText(m)).toBeUndefined();
    el.dispatch("compositionend");
    expect(alertText(m)).toBe("Wait 7 seconds and try again.");
    expect(save.attrs.disabled).toBeUndefined();
    press(save);
    expect(setRegion).toHaveBeenCalledTimes(2);
  });
});
