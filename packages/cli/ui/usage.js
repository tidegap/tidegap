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
    const sub = [x.plan_type, Number.isFinite(seen) ? `seen ${ago(seen, now)}` : ""].filter(Boolean).join(" · ");
    sections.push({ title: "Codex", sub, rows, note: "" });
  } else if (x && x.status === "no_limits") {
    sections.push({ title: "Codex", rows: [], note: "No limit reading in the Codex logs yet." });
  }
  return { pill, sections };
}

function tokens(n) {
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `${Math.round(n / 1e3)}k`;
  return String(n);
}

const usd = (v) => (v === null || v === undefined ? "no price" : `$${v.toFixed(2)}`);

/** The spend block's lines: [label, tokens text, cost text]. Pure. */
export function spendRows(spend, now = Date.now()) {
  if (!spend) return [];
  const t = (r) => `${tokens(r.input)} in · ${tokens(r.output)} out · ${tokens(r.cache_write)} cache write · ${tokens(r.cache_read)} cache read`;
  const rows = [["Total", t(spend.total), usd(spend.total.cost_usd)]];
  for (const m of spend.by_model || []) rows.push([m.model, t(m), usd(m.cost_usd)]);
  for (const s of spend.sessions || []) {
    rows.push([`${s.project} · ${hm(parse(s.last_activity))}`, t(s), usd(s.cost_usd)]);
  }
  return rows;
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

function spendBlock(spend) {
  const window = spend.window;
  const list = h("dl", { class: "usage-spend" });
  for (const [label, text, cost] of spendRows(spend)) {
    list.append(h("dt", {}, label), h("dd", {}, h("span", {}, text), h("span", { class: "usage-cost" }, cost)));
  }
  return h("section", { class: "usage-section" },
    h("h3", { class: "usage-title" }, "Claude spend", h("span", { class: "usage-sub" }, ` since ${hm(parse(window.start))} (${window.label})`)),
    list,
    h("p", { class: "dialog-sub" }, `${spend.note}.`,
      spend.unpriced_models?.length ? ` No price for ${spend.unpriced_models.join(", ")}.` : ""));
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
