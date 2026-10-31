// Usage panel: a header pill with the Claude limit ("Claude 5h 72% · resets
// 16:30") that opens a dialog with the 5-hour, weekly and per-model windows,
// the Codex windows, and a "Show spend" button. Data comes from GET
// /api/usage (the server's usage/v1 document); spend only on request,
// because the log scan takes seconds. Text nodes only.

import { api } from "./api.js";
import { openDialog } from "./dialog.js";
import { ago, h, hm, parse } from "./dom.js";

/** How often the pill refreshes; the server reuses a reading for 10 minutes. */
const REFRESH_MS = 60_000;
const WINDOW_LABEL = { five_hour: "5h", seven_day: "7d" };

let doc = null;

/** "16:30" today, "Mon 16:30" another day (the server's line uses the same form). */
export function resetClock(ms, now = Date.now()) {
  if (!Number.isFinite(ms)) return "";
  if (new Date(ms).toDateString() === new Date(now).toDateString()) return hm(ms);
  return `${new Date(ms).toLocaleDateString("en-US", { weekday: "short" })} ${hm(ms)}`;
}

function rowOf(label, w, now) {
  const resets = parse(w.resets_at);
  const passed = w.pct === null || w.pct === undefined || !(resets > now);
  return {
    label,
    pct: passed ? null : w.pct,
    text: passed ? "reset since seen" : `${Math.round(w.pct)}%`,
    resets: passed ? "" : `resets ${resetClock(resets, now)}`,
  };
}

/**
 * The view model of one usage/v1 document: the pill and the dialog
 * sections. Pure, so the server tests can check every state.
 */
export function usageView(d, now = Date.now()) {
  if (!d || !d.claude) return { pill: null, sections: [] };
  const c = d.claude;
  const sections = [];
  let pill;
  if (c.status === "disabled") {
    pill = null;
    sections.push({ title: "Claude", rows: [], note: "Limit reads are off (TIDEGAP_USAGE=off)." });
  } else if (c.status === "unavailable") {
    pill = { text: "Claude limits ?", state: "unavailable" };
    sections.push({ title: "Claude", rows: [], note: c.error?.message || "Limit state unavailable." });
  } else {
    const rows = [];
    if (c.five_hour) rows.push(rowOf("5h", c.five_hour, now));
    if (c.seven_day) rows.push(rowOf("7d", c.seven_day, now));
    for (const s of c.scoped || []) rows.push(rowOf(`${s.model} 7d`, s, now));
    const fetched = parse(c.fetched_at);
    const age = Number.isFinite(fetched) ? `as of ${hm(fetched)}, ${ago(fetched, now)}` : "";
    const note = c.stale && c.error ? `Last good value. ${c.error.message}` : c.stale ? "Last good value; it may be old." : "";
    sections.push({ title: "Claude", sub: [c.source ? `from ${c.source}` : "", age].filter(Boolean).join(" · "), rows, note });
    // The pill names the window the server's line names: the fullest current one.
    const live = rows.filter((r) => r.pct !== null && (r.label === "5h" || r.label === "7d"));
    const top = live.reduce((a, b) => (b.pct > a.pct ? b : a), live[0]);
    pill = top
      ? { text: `Claude ${top.label} ${top.text} · ${top.resets}`, state: c.stale ? "stale" : top.pct >= 90 ? "high" : "ok" }
      : { text: "Claude limits reset", state: "stale" };
  }
  const x = d.codex;
  if (x && x.status === "ok") {
    const rows = [];
    if (x.five_hour) rows.push(rowOf("5h", x.five_hour, now));
    if (x.seven_day) rows.push(rowOf("7d", x.seven_day, now));
    const seen = parse(x.as_of);
    if (rows.length && rows.every((r) => r.pct === null)) {
      // Every window has reset since the reading: its rows would say nothing (KTD3).
      const age = Number.isFinite(seen) ? ago(seen, now) : "";
      const note = age.endsWith(" ago") ? `No reading for ${age.slice(0, -" ago".length)}.` : "No current reading.";
      sections.push({ title: "Codex", sub: x.plan_type || "", rows: [], note });
    } else {
      const sub = [x.plan_type, Number.isFinite(seen) ? `seen ${ago(seen, now)}` : ""].filter(Boolean).join(" · ");
      sections.push({ title: "Codex", sub, rows, note: "" });
    }
  } else if (x && x.status === "no_limits") {
    sections.push({ title: "Codex", rows: [], note: "No limit reading in the Codex logs yet." });
  }
  return { pill, sections };
}

const UNITS = [["k", 1e3], ["M", 1e6], ["B", 1e9]];

/**
 * A token count in at most four characters plus a unit: 999, 9.9k, 27k,
 * 5.5M, 25M, 1.0B. A value that rounds to 1,000 of a unit takes the next
 * unit (999,500 is 1.0M).
 */
export function compactCount(n) {
  const v = Number(n) || 0;
  if (v < 999.5) return String(Math.round(v));
  for (const [unit, size] of UNITS) {
    const tenths = Math.round((v * 10) / size);
    if (tenths < 100) return `${(tenths / 10).toFixed(1)}${unit}`;
    const whole = Math.round(v / size);
    if (whole < 1000 || unit === "B") return `${whole}${unit}`;
  }
}

/** "$711.01"; whole dollars from $1,000 ("$12,346"), so the cost column keeps its width. */
const usd = (v) => {
  if (v === null || v === undefined) return "no price";
  return v >= 1000 ? `$${Math.round(v).toLocaleString("en-US")}` : `$${v.toFixed(2)}`;
};

/** The spend columns after the label: usage/v1 key, header text, header title. */
const SPEND_COLUMNS = [
  ["input", "in", "Input tokens"],
  ["output", "out", "Output tokens"],
  ["cache_write", "cache w", "Cache write tokens"],
  ["cache_read", "cache r", "Cache read tokens"],
];

/**
 * The spend block's model: one header, then the groups Total (no title), By
 * model and Recent sessions. Each row has a label (and the full label as its
 * title, for the ellipsis), four counts (compact text, exact title) and a
 * cost. An empty group is left out. Pure.
 */
export function spendTable(spend) {
  const row = (label, r) => ({
    label,
    title: label,
    counts: SPEND_COLUMNS.map(([key]) => ({ text: compactCount(r[key]), title: (Number(r[key]) || 0).toLocaleString("en-US") })),
    cost: usd(r.cost_usd),
  });
  const groups = [{ title: null, rows: [row("Total", spend.total)] }];
  const models = (spend.by_model || []).map((m) => row(m.model, m));
  if (models.length) groups.push({ title: "By model", rows: models });
  // The time leads, so the ellipsis on a long project name never hides it.
  const sessions = (spend.sessions || []).map((s) => row(`${hm(parse(s.last_activity))} · ${s.project}`, s));
  if (sessions.length) groups.push({ title: "Recent sessions", rows: sessions });
  const header = [...SPEND_COLUMNS.map(([, text, title]) => ({ text, title })), { text: "cost", title: "API list-price estimate" }];
  return { header, groups };
}

function renderPill() {
  const pill = document.getElementById("usage-pill");
  if (!pill) return;
  const view = usageView(doc);
  pill.hidden = !view.pill;
  if (!view.pill) return;
  pill.dataset.state = view.pill.state;
  document.getElementById("usage-text").textContent = view.pill.text;
}

function section(s) {
  const list = h("dl", { class: "usage-rows" });
  for (const r of s.rows) {
    list.append(
      h("dt", {}, r.label),
      h("dd", {},
        r.pct === null ? null : h("meter", { min: "0", max: "100", low: "70", high: "90", optimum: "0", value: String(Math.min(100, r.pct)), "aria-label": `${s.title} ${r.label}` }),
        h("span", { class: "usage-pct" }, r.text),
        r.resets ? h("span", { class: "usage-reset" }, r.resets) : null),
    );
  }
  return h("section", { class: "usage-section" },
    h("h3", { class: "usage-title" }, s.title, s.sub ? h("span", { class: "usage-sub" }, ` ${s.sub}`) : null),
    s.rows.length ? list : null,
    s.note ? h("p", { class: "dialog-body" }, s.note) : null);
}

/**
 * The spend grid (KTD1): ARIA table roles on one CSS grid per row, every row
 * on the same tracks, so the columns line up. The first group is Total.
 */
export function spendBlock(spend) {
  const window = spend.window;
  const { header, groups } = spendTable(spend);
  const table = h("div", { class: "usage-spend", role: "table", "aria-label": "Claude spend" },
    h("div", { class: "usage-spend-row usage-spend-head", role: "row" },
      h("span", { class: "usage-spend-corner", role: "columnheader", "aria-label": "Name" }),
      header.map((c) => h("span", { class: "usage-spend-num", role: "columnheader", title: c.title }, c.text))),
    groups.map((g, i) => [
      g.title
        ? h("div", { class: "usage-spend-row usage-spend-group", role: "row" }, h("span", { role: "cell", "aria-colspan": "6" }, g.title))
        : null,
      g.rows.map((r) => h("div", { class: ["usage-spend-row", i === 0 && "usage-spend-total"], role: "row" },
        h("span", { class: "usage-spend-label", role: "rowheader", title: r.title }, r.label),
        r.counts.map((c) => h("span", { class: "usage-spend-num", role: "cell", title: c.title }, c.text)),
        h("span", { class: "usage-spend-num", role: "cell" }, r.cost))),
    ]));
  return h("section", { class: "usage-section" },
    h("h3", { class: "usage-title" }, "Claude spend", h("span", { class: "usage-sub" }, ` since ${hm(parse(window.start))} (${window.label})`)),
    table,
    h("p", { class: "dialog-sub" }, `${spend.note}.`,
      spend.unpriced_models?.length ? ` No price for ${spend.unpriced_models.join(", ")}.` : "",
      spend.truncated ? " Partial: the scan stopped at its cap; the oldest logs are not counted." : ""));
}

function usageDialog() {
  const view = usageView(doc);
  const slot = h("div", { class: "usage-spend-slot", "aria-live": "polite" });
  const btn = h("button", { type: "button", class: "btn" }, "Show spend");
  btn.addEventListener("click", async () => {
    btn.disabled = true;
    btn.textContent = "Scanning…";
    slot.replaceChildren();
    try {
      const withSpend = await api.usage(true);
      if (withSpend.claude_spend) slot.replaceChildren(spendBlock(withSpend.claude_spend));
      else slot.replaceChildren(h("p", { class: "dialog-body" }, "No spend in this answer."));
      btn.hidden = true;
    } catch (err) {
      // The limit rows stay; only the spend part failed.
      slot.replaceChildren(h("p", { class: "dialog-body usage-error", role: "alert" }, `Could not read the spend: ${err.message}`));
      btn.disabled = false;
      btn.textContent = "Show spend";
    }
  });
  openDialog([
    h("header", { class: "dialog-head" },
      h("h2", { class: "dialog-title", id: "dialog-title" }, "Usage"),
      h("p", { class: "dialog-sub" }, "Subscription limits on this Mac. Tidegap only reads them.")),
    ...view.sections.map(section),
    slot,
    h("footer", { class: "dialog-foot" },
      h("button", { type: "button", class: "btn btn-ghost", onclick: () => document.getElementById("dialog").close() }, "Close"),
      doc?.claude?.status === "disabled" ? null : btn),
  ], { label: "Usage" });
}

async function load() {
  try {
    doc = await api.usage(false);
  } catch {
    // An older server (404) or a failed read: no pill.
    doc = null;
  }
  renderPill();
}

/** Load the usage document, show the pill, and refresh it every minute. */
export function initUsage() {
  const pill = document.getElementById("usage-pill");
  if (!pill) return;
  pill.addEventListener("click", usageDialog);
  void load();
  setInterval(() => void load(), REFRESH_MS);
}
