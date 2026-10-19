/**
 * Validation for the SSOT data tables read by `gen-data.mjs`. Pure: takes
 * the parsed JSON, returns nothing, throws on the first invalid row. Split
 * out so tests can import it without running the generator.
 */
const STATUSES = new Set(["retired", "deprecated"]);

/**
 * @param {{ energy: { coefficients: Record<string, { status?: string }>, families: Array<{ id: string, representative: string }> }, prices: { prices: Record<string, unknown> }, regions?: { regionFloors: Record<string, number>, regionCatalog: Record<string, unknown> }, webZones?: string[] }} tables
 */
export function validateTables({ energy, prices, regions, webZones }) {
  const coeffIds = new Set(Object.keys(energy.coefficients));
  for (const fam of energy.families) {
    if (!coeffIds.has(fam.representative)) {
      throw new Error(
        `family "${fam.id}" points at representative "${fam.representative}" which is not a coefficient key`,
      );
    }
  }
  // A lifecycle flag is optional; when present it must be a known value so a
  // typo cannot silently mark a live model as retired (or vice versa).
  for (const [id, c] of Object.entries(energy.coefficients)) {
    if (c.status !== undefined && !STATUSES.has(c.status)) {
      throw new Error(`coefficient "${id}" has unknown status "${c.status}" (expected retired | deprecated)`);
    }
  }
  // Routing scores carbon and cost off ONE model-id space. Every priced model
  // must have an energy coefficient so a routable candidate can be scored on
  // both dimensions; a price for an id the energy table never heard of is a
  // silent typo waiting to mis-score. (The reverse is fine: an energy-only id
  // simply isn't routable.)
  for (const id of Object.keys(prices.prices)) {
    if (!coeffIds.has(id)) {
      throw new Error(
        `price entry "${id}" has no matching energy coefficient key — routing scores carbon+cost off one id space`,
      );
    }
    // A retired model cannot be called, so a price for it is not a routing
    // input: retired rows keep their energy coefficient (old receipts still
    // resolve) but must not be priced.
    if (energy.coefficients[id].status === "retired") {
      throw new Error(`price entry "${id}" belongs to a retired model — remove the price row`);
    }
  }
  if (regions) validateRegionCatalog(regions, webZones);
}

const CATALOG_FIELDS = ["name", "country", "countryName", "operator"];

/**
 * The region catalog names the supported zones for people. Its keys must
 * equal the synthetic-curve floors (every zone has a curve) and the website's
 * zone list (the site and the CLI offer the same regions).
 */
function validateRegionCatalog({ regionFloors, regionCatalog }, webZones) {
  if (!regionCatalog) throw new Error("regions.json has no regionCatalog");
  const catalog = Object.keys(regionCatalog);
  const sameSet = (a, b) => a.length === b.length && a.every((z) => b.includes(z));
  const diff = (a, b) => a.filter((z) => !b.includes(z)).join(", ") || "none";
  const floors = Object.keys(regionFloors);
  if (!sameSet(catalog, floors)) {
    throw new Error(
      `regionCatalog keys differ from regionFloors — missing from catalog: ${diff(floors, catalog)}; extra in catalog: ${diff(catalog, floors)}`,
    );
  }
  if (webZones && !sameSet(catalog, webZones)) {
    throw new Error(
      `regionCatalog keys differ from apps/web/src/lib/regions.ts — missing from catalog: ${diff(webZones, catalog)}; extra in catalog: ${diff(catalog, webZones)}`,
    );
  }
  for (const [zone, entry] of Object.entries(regionCatalog)) {
    for (const field of CATALOG_FIELDS) {
      if (typeof entry?.[field] !== "string" || entry[field].trim() === "") {
        throw new Error(`regionCatalog "${zone}" needs a non-empty "${field}"`);
      }
    }
  }
}
