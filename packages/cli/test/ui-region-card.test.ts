/** Settings → Grid region (region plan U4): view-model per source, search, Save state, text-only rendering. */

import { describe, expect, it } from "vitest";

import { filterCatalog, regionModel, regionNodes, savedText } from "../ui/region-card.js";
import { FakeElement, installFakeDom, walk } from "./fixtures/fake-dom.js";

installFakeDom();

const entsoe = { id: "entsoe", label: "ENTSO-E", keyVar: "TIDEGAP_ENTSOE_SECURITY_TOKEN", live: false };
const catalog = [
  { zone: "GB", name: "Great Britain", country: "GB", countryName: "United Kingdom", operator: "NESO", dataSource: { id: "neso", label: "NESO Carbon Intensity API", live: true } },
  { zone: "FR", name: "France", country: "FR", countryName: "France", operator: "RTE", dataSource: entsoe },
  { zone: "PL", name: "Poland", country: "PL", countryName: "Poland", operator: "PSE", dataSource: { id: "electricitymaps", label: "Electricity Maps", keyVar: "TIDEGAP_ELECTRICITY_MAPS_API_KEY", live: false } },
  { zone: "US-MIDA-PJM", name: "Mid-Atlantic (PJM)", country: "US", countryName: "United States", operator: "PJM Interconnection", dataSource: { id: "watttime-eia", label: "WattTime or US EIA", live: false } },
  { zone: "DE", name: "Germany", country: "DE", countryName: "Germany", operator: "TenneT, 50Hertz, Amprion, TransnetBW", dataSource: entsoe },
];

const UA_NOTE = "No Ukrainian grid data yet; using Poland (PL), the nearest grid in the same synchronous area.";
const KYIV_URL = "https://github.com/tidegap/tidegap/issues/new?template=region_request.md&title=Region+request:+UA";

type View = Record<string, unknown>;
const view = (extra: View = {}): View => ({
  effective: "FR",
  source: "setting",
  name: "France",
  dataSource: entsoe,
  stored: "FR",
  timeZone: "Europe/Paris",
  detected: { region: "FR", source: "timezone", timeZone: "Europe/Paris" },
  catalog,
  ...extra,
});
const kyiv = view({
  effective: "PL",
  source: "timezone",
  name: "Poland",
  stored: null,
  timeZone: "Europe/Kyiv",
  dataSource: catalog[2]!.dataSource,
  detected: { region: "PL", source: "timezone", timeZone: "Europe/Kyiv", approximate: { country: "UA", note: UA_NOTE } },
  approximate: { country: "UA", note: UA_NOTE },
  requestUrl: KYIV_URL,
});

const noop = new Proxy({}, { get: () => () => {} });
const render = (m: ReturnType<typeof regionModel>) => walk(regionNodes(m, noop));
const byId = (els: FakeElement[], id: string) => els.find((e) => e.attrs.id === id);
const values = (m: ReturnType<typeof regionModel>) => (m.options ?? []).map((o: { value: string }) => o.value);

describe("regionModel: source sentence per source", () => {
  it("setting: 'Set here', the stored zone selected, Save off until the choice changes", () => {
    const m = regionModel(view());
    expect(m).toMatchObject({ pill: "Set here", name: "France", zone: "FR", source: "Set here.", selected: "FR", canSave: false, locked: false, note: null });
    expect(m.data).toBe("Data: ENTSO-E (sample curve; add TIDEGAP_ENTSOE_SECURITY_TOKEN for live data).");
    expect(regionModel(view(), { choice: "auto" })).toMatchObject({ selected: "auto", target: "auto", canSave: true });
  });

  it("time zone, Kyiv: PL, approximate, the UA note with the request link, Auto selected", () => {
    const m = regionModel(kyiv);
    expect(m).toMatchObject({ pill: "From time zone", source: "From time zone Europe/Kyiv.", selected: "auto", canSave: false });
    expect(m.note).toEqual({ text: UA_NOTE, link: KYIV_URL });
    expect(m.options![0]).toEqual({ value: "auto", label: "Auto (time zone): Poland (PL), approximate" });
    const { els, text } = render(m);
    expect(els.find((e) => e.attrs.role === "note")).toBeDefined();
    expect(els.find((e) => e.tagName === "a")?.attrs.href).toBe(KYIV_URL);
    expect(text.join("")).toContain(UA_NOTE);
  });

  it("fallback: the unmapped time zone note and GB", () => {
    const m = regionModel(view({ effective: "GB", name: "Great Britain", source: "fallback", stored: null, timeZone: "Europe/Oslo", requestUrl: "https://x.test/r" }));
    expect(m).toMatchObject({ pill: "Default", source: "Default: time zone Europe/Oslo is not mapped." });
    expect(m.note).toEqual({ text: "Your time zone (Europe/Oslo) is not mapped; using Great Britain (GB).", link: "https://x.test/r" });
  });

  it("env: Save and the controls off, the override named, a differing stored value explained", () => {
    const m = regionModel(view({ effective: "DE", name: "Germany", source: "env", stored: "FR" }), { choice: "PL" });
    expect(m).toMatchObject({ pill: "From env", source: "From env: TIDEGAP_DEFAULT_REGION.", locked: true, canSave: false });
    expect(m.override!.text).toContain("TIDEGAP_DEFAULT_REGION overrides this setting");
    expect(m.override!.stored).toBe("Stored setting FR applies when the override is removed.");
    const { els } = render(m);
    expect(byId(els, "region-select")!.attrs.disabled).toBe("");
    expect(byId(els, "region-search")!.attrs.disabled).toBe("");
    expect(els.find((e) => e.attrs["data-action"] === "save")!.attrs.disabled).toBe("");
  });

  it("flag: locked with the --region sentence; no stored line when nothing is stored", () => {
    const m = regionModel(view({ source: "flag", stored: null }));
    expect(m).toMatchObject({ pill: "Flag", source: "Flag: tidegap ui --region.", locked: true, canSave: false });
    expect(m.override).toMatchObject({ stored: "" });
    expect(m.override!.text).toContain("without --region");
  });

  it("ignored stored value: the warning, Auto selected", () => {
    const m = regionModel(view({ effective: "FR", source: "timezone", stored: "XX", ignored: "XX" }));
    expect(m.note!.text).toBe("Stored region XX is not supported; ignored.");
    expect(m.selected).toBe("auto");
    // Saving Auto clears the ignored value.
    expect(m).toMatchObject({ target: "auto", canSave: true });
  });

  it("a stored value in lower case selects its catalog zone", () => {
    expect(regionModel(view({ stored: "fr" })).selected).toBe("FR");
  });
});

describe("search", () => {
  it("filters by code, name, country, operator and data source; empty lists every zone", () => {
    expect(filterCatalog(catalog, "pol").map((z: { zone: string }) => z.zone)).toEqual(["PL"]);
    expect(filterCatalog(catalog, "pjm").map((z: { zone: string }) => z.zone)).toEqual(["US-MIDA-PJM"]);
    expect(filterCatalog(catalog, "ENTSO").map((z: { zone: string }) => z.zone)).toEqual(["FR", "DE"]);
    expect(filterCatalog(catalog, "united kingdom").map((z: { zone: string }) => z.zone)).toEqual(["GB"]);
    expect(filterCatalog(catalog, "  ")).toHaveLength(catalog.length);
  });

  it("an exact zone or country code comes first, then a code or name prefix, then the rest", () => {
    // "es" is also inside "NESO" and "United States"; the catalog lists both zones before Spain.
    const spain = { zone: "ES", name: "Spain", country: "ES", countryName: "Spain", operator: "Red Eléctrica", dataSource: entsoe };
    const withSpain = [...catalog, spain];
    expect(filterCatalog(withSpain, "es").map((z: { zone: string }) => z.zone)).toEqual(["ES", "GB", "US-MIDA-PJM"]);
    expect(filterCatalog(withSpain, "united").map((z: { zone: string }) => z.zone)).toEqual(["GB", "US-MIDA-PJM"]);
    expect(regionModel(view({ catalog: withSpain }), { query: "ES" }).target).toBe("ES");
  });

  it("a search lists only matches, selects the first, and enables Save", () => {
    const m = regionModel(view(), { query: "pol" });
    expect(values(m)).toEqual(["PL"]);
    expect(m).toMatchObject({ selected: "PL", target: "PL", canSave: true });
    expect(values(regionModel(view()))).toEqual(["auto", "GB", "FR", "PL", "US-MIDA-PJM", "DE"]);
  });

  it("a choice among the matches stays selected", () => {
    expect(regionModel(view(), { query: "entso", choice: "DE" }).selected).toBe("DE");
  });

  it("no match: the request row with the typed text, and Save sends the text for the server's closest zones", () => {
    const m = regionModel(view(), { query: "UA" });
    expect(values(m)).toEqual([]);
    expect(m).toMatchObject({ target: "UA", canSave: true });
    expect(m.noMatch).toBe('No supported zone matches "UA". Save shows the closest ones and a link to request it.');
  });
});

describe("states", () => {
  it("loading, then a load failure with Retry", () => {
    expect(regionModel(null)).toMatchObject({ state: "loading" });
    expect(render(regionModel(null)).text).toContain("Loading…");
    const { els, text } = render(regionModel(null, { loadError: "Could not load the grid region." }));
    expect(text).toContain("Could not load the grid region.");
    expect(els.find((e) => e.attrs.role === "alert")).toBeDefined();
    expect(els.find((e) => e.attrs["data-action"] === "retry")).toBeDefined();
  });

  it("saving: controls off, 'Saving…'", () => {
    const m = regionModel(view(), { choice: "PL", pending: true });
    expect(m.canSave).toBe(false);
    const { els, text } = render(m);
    expect(text).toContain("Saving…");
    expect(byId(els, "region-select")!.attrs.disabled).toBe("");
  });

  it("an API error renders as an alert with its request link, the select points at it", () => {
    const url = "https://github.com/tidegap/tidegap/issues/new?template=region_request.md&title=Region+request:+UA";
    const error = `Unknown zone UA. Closest: PL. Request a region: ${url}`;
    const { els } = render(regionModel(view(), { query: "UA", error }));
    const alert = byId(els, "region-error")!;
    expect(alert.attrs.role).toBe("alert");
    expect(walk([alert]).text.join("")).toBe(error);
    expect(walk([alert]).els.find((e) => e.tagName === "a")?.attrs.href).toBe(url);
    expect(walk(regionNodes(regionModel(view(), { error: "Wait 5 seconds and try again." }), noop)).els.some((e) => e.tagName === "a")).toBe(false);
    expect(byId(els, "region-select")!.attrs["aria-describedby"]).toBe("region-error");
  });

  it("savedText names the new zone, or Auto", () => {
    expect(savedText(view({ effective: "PL", name: "Poland" }))).toBe("Region set to Poland (PL).");
    expect(savedText(kyiv)).toBe("Region set to Auto: Poland (PL).");
  });
});

describe("rendering", () => {
  it("server strings with markup render as text; no element comes from them", () => {
    const evil = [{ ...catalog[0]!, name: "<img src=x onerror=alert(1)>" }];
    const { els, text } = render(regionModel(view({ name: "<b>x</b>", catalog: evil })));
    expect(els.some((e) => e.tagName === "img" || e.tagName === "b")).toBe(false);
    expect(text.join("")).toContain("<b>x</b>");
  });
});
