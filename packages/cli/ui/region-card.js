// Settings → Grid region (region plan U4). One card: the zone in use, where
// it came from and its data source; a search that narrows a select of the
// catalog zones (plus "Auto (time zone)"); one Save that stores the choice
// at once and shows the server's new resolution. A --region flag or the
// TIDEGAP_DEFAULT_REGION variable overrides the setting: the card says so
// and Save is off. `regionModel` is the pure view-model; `regionNodes`
// renders it through `h()`, text nodes only.

import { api, ApiError, SessionExpired } from "./api.js";
import { cardHead } from "./channel-card.js";
import { h } from "./dom.js";
import { refresh } from "./state.js";

const ENV_KEY = "TIDEGAP_DEFAULT_REGION";

/** The pill per source: the short form of the source sentence. */
export const SOURCE_PILL = { setting: "Set here", timezone: "From time zone", fallback: "Default", env: "From env", flag: "Flag" };

/** How the zone in use was chosen, in one sentence. */
export function sourceText(v) {
  switch (v.source) {
    case "setting":
      return "Set here.";
    case "timezone":
      return `From time zone ${v.timeZone}.`;
    case "fallback":
      return v.timeZone ? `Default: time zone ${v.timeZone} is not mapped.` : "Default: no time zone.";
    case "env":
      return `From env: ${ENV_KEY}.`;
    case "flag":
      return "Flag: tidegap ui --region.";
    default:
      return "";
  }
}

/** "Data: ENTSO-E (live)" or the sample curve and the key that turns it live. */
export function dataText(d) {
  if (!d) return "";
  if (d.live) return `Data: ${d.label} (live).`;
  return `Data: ${d.label} (sample curve${d.keyVar ? `; add ${d.keyVar} for live data` : ""}).`;
}

/** Catalog zones whose code, name, country, operator or data source contain `query` (any case). */
export function filterCatalog(catalog, query) {
  const q = query.trim().toLowerCase();
  if (!q) return catalog;
  return catalog.filter((z) =>
    [z.zone, z.name, z.country, z.countryName, z.operator, z.dataSource?.label, z.dataSource?.id].some((f) => f && f.toLowerCase().includes(q)),
  );
}

/** "Poland (PL)" for a catalog zone, else the code. */
export function zoneLabel(catalog, zone) {
  const z = catalog.find((c) => c.zone === zone);
  return z ? `${z.name} (${zone})` : zone;
}

/** The stored choice as the select names it: a catalog zone, or "auto" when nothing (valid) is stored. */
export function storedChoice(view) {
  if (!view.stored || view.ignored) return "auto";
  const z = view.catalog.find((c) => c.zone.toLowerCase() === view.stored.toLowerCase());
  return z ? z.zone : "auto";
}

/** The note block: an approximate guess, the GB fallback or an ignored stored value; with the request link. */
function noteOf(v) {
  const lines = [];
  if (v.ignored) lines.push(`Stored region ${v.ignored} is not supported; ignored.`);
  if (v.approximate) lines.push(v.approximate.note);
  else if (v.source === "fallback") lines.push(v.timeZone ? `Your time zone (${v.timeZone}) is not mapped; using Great Britain (GB).` : "No time zone found; using Great Britain (GB).");
  return lines.length ? { text: lines.join(" "), link: v.requestUrl || "" } : null;
}

/** Why Save is off when a flag or the env variable wins, and what the stored value does then. */
function overrideOf(v, current) {
  if (v.source !== "env" && v.source !== "flag") return null;
  const text = v.source === "env"
    ? `${ENV_KEY} overrides this setting. Remove it from the environment or ~/.config/tidegap/env to choose here.`
    : "tidegap ui --region overrides this setting. Start tidegap ui without --region to choose here.";
  const stored = current !== "auto" && current !== v.effective ? `Stored setting ${current} applies when the override is removed.` : "";
  return { text, stored };
}

/**
 * The card's view-model. `view` is the GET/POST /api/settings/region body
 * (null while loading); `ui` is the page's state of the card:
 * {query, choice, pending, error, loadError}. Pure: tests call it without a DOM.
 */
export function regionModel(view, ui = {}) {
  if (!view) {
    return { state: ui.loadError ? "error" : "loading", pill: "", loadError: ui.loadError || "" };
  }
  const catalog = view.catalog || [];
  const current = storedChoice(view);
  const override = overrideOf(view, current);
  const query = ui.query || "";
  const matches = filterCatalog(catalog, query);
  const choice = ui.choice ?? current;
  const searching = query.trim() !== "";
  const noMatch = searching && matches.length === 0;
  // With a search, the select lists only the matches and picks the first one unless the choice is among them.
  const selected = !searching ? choice : matches.some((z) => z.zone === choice) ? choice : matches[0]?.zone ?? "";
  // No match: Save sends the typed text, so the server answers with its closest zones.
  const target = noMatch ? query.trim() : selected;
  const pending = !!ui.pending;
  const detected = view.detected || { region: view.effective };
  const options = [
    ...(searching ? [] : [{ value: "auto", label: `Auto (time zone): ${zoneLabel(catalog, detected.region)}${detected.approximate ? ", approximate" : ""}` }]),
    ...matches.map((z) => ({ value: z.zone, label: `${z.name} (${z.zone}) · ${z.operator} · ${z.dataSource?.label ?? ""}` })),
  ];
  return {
    state: "ready",
    pill: SOURCE_PILL[view.source] || "",
    name: view.name || view.effective,
    zone: view.effective,
    source: sourceText(view),
    data: dataText(view.dataSource),
    note: noteOf(view),
    override,
    locked: !!override,
    pending,
    query,
    options,
    selected,
    target,
    noMatch: noMatch ? `No supported zone matches "${query.trim()}". Save shows the closest ones and a link to request it.` : "",
    canSave: !override && !pending && !!target && (noMatch || target !== current),
    error: ui.error || "",
  };
}

/** An error sentence with its trailing link ("… Request a region: <url>") as a link node. */
export function errorParts(text) {
  const m = /^(.*\s)(https:\/\/\S+)$/s.exec(text);
  return m ? [m[1], link(m[2], m[2])] : [text];
}

/** The sentence the live region announces after a save. */
export function savedText(view) {
  const where = `${view.name || view.effective} (${view.effective})`;
  return view.source === "setting" ? `Region set to ${where}.` : `Region set to Auto: ${where}.`;
}

// ── rendering ───────────────────────────────────────────────────────────

function link(href, text) {
  return h("a", { href, target: "_blank", rel: "noopener noreferrer" }, text);
}

/** The card's nodes. `on` = {retry(), query(text), choose(zone), save(zone)}. */
export function regionNodes(model, on) {
  const nodes = [cardHead("region", "Grid region", "info", model.pill)];
  if (model.state === "loading") return [...nodes, h("p", { class: "integration-sub" }, "Loading…")];
  if (model.state === "error") {
    return [...nodes,
      h("p", { class: "integration-error", role: "alert" }, model.loadError),
      h("div", { class: "integration-actions" }, h("button", { type: "button", class: "btn btn-sm", "data-action": "retry", onclick: () => on.retry() }, "Retry"))];
  }
  nodes.push(
    h("p", { class: "region-current" }, h("strong", {}, model.name), " ", h("span", { class: "region-code mono" }, model.zone), " ", h("span", { class: "integration-sub" }, model.source)),
    h("p", { class: "integration-sub" }, model.data),
  );
  if (model.note) nodes.push(h("p", { class: "region-note", role: "note" }, model.note.text, model.note.link ? [" ", link(model.note.link, "Request your region")] : null));
  if (model.override) {
    nodes.push(h("p", { class: "integration-sub", dataset: { override: "" } }, model.override.text));
    if (model.override.stored) nodes.push(h("p", { class: "integration-sub" }, model.override.stored));
  }
  nodes.push(form(model, on));
  if (model.error) nodes.push(h("p", { class: "integration-error", id: "region-error", role: "alert" }, errorParts(model.error)));
  return nodes;
}

function form(model, on) {
  const off = model.locked || model.pending;
  const search = h("input", {
    type: "search", id: "region-search", class: "input", name: "query", value: model.query,
    placeholder: "Country, zone, operator or data source", autocomplete: "off", spellcheck: "false",
    "aria-controls": "region-select", disabled: off,
  });
  search.addEventListener("input", () => on.query(search.value));
  const select = h("select", { id: "region-select", class: "select", name: "zone", disabled: off || !model.options.length, "aria-describedby": model.error ? "region-error" : null },
    model.options.map((o) => h("option", { value: o.value, selected: o.value === model.selected }, o.label)));
  select.addEventListener("change", () => on.choose(select.value));
  const el = h("form", { class: "region-form", novalidate: true, "aria-busy": model.pending ? "true" : "false" },
    h("label", { class: "field", for: "region-search" }, h("span", { class: "field-label" }, "Search"), search),
    h("label", { class: "field", for: "region-select" }, h("span", { class: "field-label" }, "Region"), select),
    model.noMatch ? h("p", { class: "integration-sub", dataset: { nomatch: "" } }, model.noMatch) : null,
    h("div", { class: "integration-actions" },
      h("button", { type: "submit", class: "btn btn-primary", "data-action": "save", disabled: !model.canSave }, model.pending ? "Saving…" : "Save")));
  el.addEventListener("submit", (e) => {
    e.preventDefault();
    if (model.canSave) on.save(model.target);
  });
  return el;
}

// ── the live card ───────────────────────────────────────────────────────

function errorText(err) {
  return err instanceof ApiError && err.message ? err.message : "Could not reach Tidegap. Try again.";
}

/**
 * Fill `el` (a section) with the card and load it. `onExpired` runs on a
 * 401. After a save the page's status refreshes, so every region the page
 * shows follows the new one.
 */
export function mountRegionCard(el, { onExpired } = {}) {
  const body = h("div", { class: "region-body" });
  const status = h("p", { class: "sr-only", role: "status" });
  el.replaceChildren(body, status);
  const c = { el, body, status, view: null, ui: {}, key: "", onExpired };
  void load(c);
  return c;
}

async function load(c) {
  c.ui = { loadError: "" };
  draw(c);
  try {
    c.view = await api.region();
  } catch (err) {
    if (err instanceof SessionExpired) return void c.onExpired?.();
    c.ui.loadError = err instanceof ApiError && err.status === 403
      ? "Settings open in the page that tidegap ui prints and in the Mac app."
      : "Could not load the grid region.";
  }
  draw(c);
}

async function save(c, zone) {
  Object.assign(c.ui, { pending: true, error: "" });
  draw(c);
  try {
    c.view = await api.setRegion(zone);
    c.ui = {};
    c.status.textContent = savedText(c.view);
    void refresh();
  } catch (err) {
    if (err instanceof SessionExpired) return void c.onExpired?.();
    Object.assign(c.ui, { pending: false, error: errorText(err) });
  }
  draw(c);
  c.body.querySelector("#region-select")?.focus();
}

function handlers(c) {
  return {
    retry: () => void load(c),
    query: (text) => {
      c.ui.query = text;
      draw(c);
    },
    choose: (zone) => {
      c.ui.choice = zone;
      draw(c);
    },
    save: (zone) => void save(c, zone),
  };
}

/** Rebuild when the model changed; focus and the search caret survive. */
function draw(c) {
  const model = regionModel(c.view, c.ui);
  const key = JSON.stringify(model);
  if (key === c.key) return;
  c.key = key;
  const active = c.body.contains(document.activeElement) ? document.activeElement : null;
  const caret = active?.id === "region-search" ? [active.selectionStart, active.selectionEnd] : null;
  c.body.replaceChildren(...regionNodes(model, handlers(c)));
  const next = active?.id ? c.body.querySelector(`#${active.id}`) : null;
  if (next && !next.disabled) {
    next.focus();
    if (caret) next.setSelectionRange(...caret);
  }
}
