// Task detail drawer: everything about one task and the actions its state
// allows. Buttons carry data-action and the drawer carries data-task-id, so
// app.js handles them with the same delegated listener as the rows.
// Opening an unread finished task marks it read (v1 behaviour).

import { api, ApiError, SessionExpired } from "./api.js";
import {
  bandChip,
  bandOf,
  eventLine,
  grams,
  h,
  isFinished,
  parse,
  providerModel,
  REPEAT_LABEL,
  shortId,
  swapChildren,
  taskHref,
  title,
  when,
} from "./dom.js";
import { badges, joinMeta, statusTag } from "./row.js";
import { findTask, notify, state } from "./state.js";
import { errorToast, toast } from "./toast.js";

const drawerState = {
  id: null,
  data: null,
  loading: false,
  error: null,
  draft: "",
  rawOpen: false,
  seq: 0,
  returnFocus: null,
  marked: new Set(),
};

export function detailId() {
  return drawerState.id;
}

function el() {
  return document.getElementById("drawer");
}

export async function openDetail(id) {
  const same = drawerState.id === id;
  if (!same) {
    if (!drawerState.id) drawerState.returnFocus = document.activeElement;
    drawerState.id = id;
    drawerState.data = null;
    drawerState.error = null;
    drawerState.draft = "";
    drawerState.rawOpen = false;
  }
  drawerState.loading = !same || !drawerState.data;
  renderDetail();
  if (!same) focusDrawer();
  await loadDetail();
}

async function loadDetail() {
  const id = drawerState.id;
  if (!id) return;
  const mine = ++drawerState.seq;
  try {
    const data = await api.task(id);
    const series = data.series ? await api.series(data.series.series_id).catch(() => null) : null;
    if (mine !== drawerState.seq || drawerState.id !== id) return;
    drawerState.data = data;
    drawerState.series = series;
    drawerState.error = null;
    drawerState.loading = false;
    renderDetail();
    maybeMarkRead(data);
  } catch (err) {
    if (mine !== drawerState.seq || drawerState.id !== id) return;
    if (err instanceof SessionExpired) {
      state.expired = true;
      notify();
      return;
    }
    drawerState.loading = false;
    drawerState.error = err;
    renderDetail();
  }
}

function maybeMarkRead(t) {
  if ((t.status !== "completed" && t.status !== "failed") || t.read_at || drawerState.marked.has(t.task_id)) return;
  drawerState.marked.add(t.task_id);
  // A failed mark-read is ignored: the task just stays unread.
  api.read(t.task_id).catch(() => {});
}

export function closeDetail() {
  if (!drawerState.id) return;
  const id = drawerState.id;
  drawerState.id = null;
  drawerState.data = null;
  drawerState.seq++;
  el().hidden = true;
  el().removeAttribute("data-task-id");
  document.getElementById("scrim").hidden = true;
  document.body.classList.remove("drawer-open");
  const row = document.querySelector(`#view .row[data-task-id="${CSS.escape(id)}"]`);
  const back = row || (drawerState.returnFocus?.isConnected ? drawerState.returnFocus : null);
  (back || document.getElementById("view")).focus({ preventScroll: !!row });
  drawerState.returnFocus = null;
}

/** Re-fetch when the stream names this task, its parent or a child. */
export function onDetailEvent(ids) {
  const d = drawerState.data;
  if (!drawerState.id) return;
  const related = new Set([drawerState.id]);
  if (d?.parent?.task_id) related.add(d.parent.task_id);
  for (const c of d?.children || []) related.add(c.task_id);
  if (ids.length === 0 || ids.some((id) => related.has(id)) || d?.series) void loadDetail();
}

function focusDrawer() {
  requestAnimationFrame(() => el().querySelector(".drawer-close")?.focus());
}

export function focusReply() {
  const box = el().querySelector("textarea.reply-input");
  if (box) box.focus();
  return !!box;
}

/** Keep Tab inside the open drawer. */
export function trapFocus(e) {
  if (e.key !== "Tab" || el().hidden) return;
  const items = [...el().querySelectorAll("a[href], button:not([disabled]), textarea, select, input, summary, [tabindex='0']")].filter((n) => n.offsetParent !== null);
  if (items.length === 0) return;
  const first = items[0], last = items[items.length - 1];
  if (!el().contains(document.activeElement)) {
    e.preventDefault();
    first.focus();
  } else if (e.shiftKey && document.activeElement === first) {
    e.preventDefault();
    last.focus();
  } else if (!e.shiftKey && document.activeElement === last) {
    e.preventDefault();
    first.focus();
  }
}

// ── render ──────────────────────────────────────────────────────────────

function section(name, ...body) {
  return h("section", { class: "d-section" }, h("h3", { class: "d-h" }, name), body);
}

function kv(pairs) {
  const dl = h("dl", { class: "kv" });
  for (const [k, v] of pairs) {
    if (v === undefined || v === null || v === "") continue;
    dl.append(h("dt", {}, k), h("dd", {}, v));
  }
  return dl;
}

export function renderDetail() {
  const root = el();
  if (!drawerState.id) return;
  // Merge the optimistic view of this task (pending op) over the fetched one.
  const live = findTask(drawerState.id);
  const t = drawerState.data ? { ...drawerState.data, ...(live?._op ? { ...live._op.patch, _op: live._op } : {}) } : null;
  const draftBox = root.querySelector("textarea.reply-input");
  if (draftBox) drawerState.draft = draftBox.value;
  const rawBox = root.querySelector("details.raw");
  if (rawBox) drawerState.rawOpen = rawBox.open;
  const focusedAction = root.contains(document.activeElement) ? document.activeElement?.dataset?.action || (document.activeElement?.classList.contains("reply-input") ? "reply-input" : null) : null;

  root.setAttribute("data-task-id", drawerState.id);
  const close = h("button", { type: "button", class: "icon-btn drawer-close", "data-action": "close", "aria-label": "Close (Esc)", title: "Close (Esc)" }, "×");
  let body;
  if (drawerState.error) {
    const notFound = drawerState.error instanceof ApiError && drawerState.error.status === 404;
    body = [
      h("div", { class: "drawer-head" }, h("h2", { id: "drawer-title", class: "drawer-title", tabindex: "-1" }, notFound ? "Task not found" : "Could not load this task"), close),
      h("p", { class: "muted" }, notFound ? "It may have been deleted, or the link is from another ledger." : "The page could not reach tidegap ui."),
      h("p", {}, notFound ? h("a", { class: "btn", href: "#/agenda" }, "Back to the Agenda") : h("button", { type: "button", class: "btn", "data-action": "detail-retry" }, "Retry")),
    ];
  } else if (!t) {
    body = [
      h("div", { class: "drawer-head" }, h("h2", { id: "drawer-title", class: "drawer-title" }, h("span", { class: "sk sk-title" })), close),
      h("div", { class: "sk sk-block" }), h("div", { class: "sk sk-block" }), h("div", { class: "sk sk-block sk-short" }),
    ];
  } else {
    body = detailBody(t, close);
  }
  swapChildren(root, body);
  root.hidden = false;
  document.getElementById("scrim").hidden = false;
  document.body.classList.add("drawer-open");
  const box = root.querySelector("textarea.reply-input");
  if (box) box.value = drawerState.draft;
  if (focusedAction) {
    const target = focusedAction === "reply-input" ? box : root.querySelector(`[data-action="${focusedAction}"]`);
    target?.focus();
  }
}

function headline(t) {
  const parts = [statusTag(t)];
  const now = Date.now();
  const at = parse(t.scheduled_for);
  const done = parse(t.completed_at);
  if (isFinished(t) && Number.isFinite(done)) parts.push(`${t.status === "cancelled" ? "cancelled" : "ran"} ${when(done, now)}`);
  else if (Number.isFinite(at)) parts.push(at <= now ? "due now · runs on the next tick" : `runs ${when(at, now)}`);
  if (typeof t.carbon_g === "number") parts.push(h("span", { class: "num" }, `${grams(t.carbon_g)} CO2e${t.status === "completed" ? "" : " est."}`));
  const band = bandOf(t.intensity_g_per_kwh);
  if (band) parts.push(bandChip(band));
  return parts;
}

function actionBar(t) {
  const a = t.actions || {};
  const pendingOp = !!t._op;
  const btn = (action, label, cls = "", key) =>
    h("button", { type: "button", class: `btn ${cls}`, "data-action": action, disabled: pendingOp ? true : undefined, title: key ? `${label} (${key})` : label }, label);
  const out = [];
  if (a.runNow) out.push(btn("run-now", "Run now", "btn-primary", "n"));
  if (a.reschedule) out.push(btn("reschedule", "Reschedule…", "", "r"), btn("later", "Later…", "", "m"));
  if (a.reply) out.push(btn("reply-focus", "Reply", "btn-primary", "R"));
  if (a.markRead) out.push(btn(t.read_at ? "unread" : "read", t.read_at ? "Mark unread" : "Mark read", "", "u"));
  if (a.cancel) out.push(btn("cancel", "Cancel", "btn-danger", "c"));
  if (a.stopSeries) out.push(btn("stop-series", "Stop series", "btn-danger", "C"));
  if (pendingOp) out.push(h("span", { class: "row-op" }, h("span", { class: "spinner", "aria-hidden": "true" }), ` ${t._op.label || "Saving…"}`));
  return out.length ? h("div", { class: "action-bar" }, out) : null;
}

function detailBody(t, close) {
  const out = [
    h("div", { class: "drawer-head" },
      h("h2", { id: "drawer-title", class: "drawer-title", tabindex: "-1", title: title(t) }, title(t)),
      close),
    h("p", { class: "drawer-meta" }, joinMeta(headline(t))),
    badges(t).length ? h("p", { class: "drawer-badges" }, badges(t), providerModel(t) ? h("span", { class: "muted" }, providerModel(t)) : null) : providerModel(t) ? h("p", { class: "drawer-badges muted" }, providerModel(t)) : null,
    actionBar(t),
  ];

  if (t.error) out.push(section("Error", h("pre", { class: "pre is-error" }, t.error)));

  if (t.status === "completed") {
    const text = t.result_text ?? (t.result !== null && t.result !== undefined ? JSON.stringify(t.result, null, 2) : null);
    const blocks = [text !== null ? h("pre", { class: "pre result" }, text) : h("p", { class: "muted" }, "No result text.")];
    if (t.raw !== null && t.raw !== undefined) {
      const raw = h("details", { class: "raw" }, h("summary", {}, "Raw JSON"), h("pre", { class: "pre mono" }, JSON.stringify(t.raw, null, 2)));
      raw.open = drawerState.rawOpen;
      blocks.push(raw);
    }
    out.push(section("Result", blocks));
  }

  out.push(conversation(t));

  if (!isFinished(t)) {
    out.push(section("Schedule", kv([
      ["runs", Number.isFinite(parse(t.scheduled_for)) ? when(parse(t.scheduled_for)) : "not planned yet"],
      ["deadline", Number.isFinite(parse(t.deadline)) ? `${when(parse(t.deadline))}${t.deadline_label ? ` (${t.deadline_label})` : ""}` : null],
      ["region", t.region],
      ["estimate", typeof t.estimated_carbon_g === "number" ? `${grams(t.estimated_carbon_g)} CO2e` : null],
    ])));
  }

  if (t.receipt) out.push(receipt(t));
  out.push(origin(t));
  const chain = chainSection(t);
  if (chain) out.push(chain);
  const events = eventsSection(t);
  if (events) out.push(events);
  out.push(section("Details", kv([
    ["task id", h("code", {}, t.task_id)],
    ["enqueued", Number.isFinite(parse(t.enqueued_at)) ? when(parse(t.enqueued_at)) : null],
    ["region", t.region],
    ["routing", t.routing?.chosen ? `${t.routing.chosen}${t.routing.reasoning ? ` — ${t.routing.reasoning}` : ""}` : null],
  ])));
  return out;
}

/** Task events (audit trail), oldest first, text only. */
function eventsSection(t) {
  const list = Array.isArray(t.events) ? t.events : [];
  if (!list.length) return null;
  const fmt = (iso) => (Number.isFinite(parse(iso)) ? when(parse(iso)) : iso);
  return section("Events", h("ol", { class: "events" }, list.map((e) => h("li", {}, eventLine(e, fmt)))));
}

function conversation(t) {
  const turns = Array.isArray(t.history) ? [...t.history] : [];
  if (turns.length === 0 && t.prompt) turns.push({ role: "user", content: t.prompt });
  // On a completed task the last assistant turn is the result shown above.
  const shown = t.status === "completed" && turns.length && turns[turns.length - 1].role === "assistant" && t.result_text ? turns.slice(0, -1) : turns;
  const items = shown.map((m) =>
    h("li", { class: `turn turn-${m.role}` },
      h("span", { class: "turn-role" }, m.role === "user" ? "you" : "model"),
      h("pre", { class: "pre turn-text" }, m.content)));
  const body = [];
  if (items.length) body.push(h("ol", { class: "turns" }, items));
  else body.push(h("p", { class: "muted" }, t.status === "running" ? "The prompt is hidden while the task runs." : "No stored prompt."));
  if (t.actions?.reply) {
    body.push(h("form", { class: "reply", "data-action-form": "reply" },
      h("label", { class: "sr-only", for: "reply-input" }, "Reply"),
      h("textarea", { id: "reply-input", class: "reply-input", rows: "3", maxlength: "32000", placeholder: "Continue the conversation…", "aria-describedby": "reply-hint" }),
      h("div", { class: "reply-row" },
        h("span", { id: "reply-hint", class: "muted" }, "Same provider and model, with this history. Runs on the next tick."),
        h("button", { type: "submit", class: "btn btn-primary", "data-action": "reply-send" }, "Send"))));
  } else if (t.status === "failed" || t.status === "cancelled") {
    body.push(h("p", { class: "muted small" }, `A ${t.status} task cannot be replied to.`));
  }
  return section("Conversation", body);
}

/**
 * The words for a receipt's `tokenCounts` (batch 27): the grams rest on a
 * token count the run did not report. Null when every count was reported.
 */
export function tokenCountsText(value) {
  if (value === "partial") return "partial (a token count was not reported; billed at the typical count)";
  if (value === "typical") return "typical (no token count reported; billed as a typical call)";
  return null;
}

/** The receipt's "tokens" row: the total, the marker, or both. */
export function receiptTokens(r) {
  const total = typeof r.totalTokens === "number" ? String(r.totalTokens) : null;
  const marker = tokenCountsText(r.tokenCounts);
  return total && marker ? `${total} · ${marker}` : total ?? marker;
}

function receipt(t) {
  const r = t.receipt;
  const est = r.estimatedCarbonGCo2;
  const act = r.actualCarbonGCo2;
  return section("Receipt",
    kv([
      ["region", r.region],
      ["intensity", typeof r.intensityGCo2PerKwh === "number" ? h("span", {}, `${Math.round(r.intensityGCo2PerKwh)} gCO2/kWh `, bandChip(bandOf(r.intensityGCo2PerKwh))) : null],
      ["estimated", typeof est === "number" ? `${grams(est)} CO2e` : null],
      ["actual", typeof act === "number" ? `${grams(act)} CO2e${typeof r.deltaPct === "number" ? ` (${r.deltaPct > 0 ? "+" : ""}${r.deltaPct}%)` : ""}` : null],
      ["tokens", receiptTokens(r)],
      ["grid", r.gridSource === "mock" ? "mock (synthetic, not a measurement)" : r.gridSource],
      ["signature", r.signature ? h("span", { class: "tag tag-completed" }, "signed ✓") : h("span", { class: "tag tag-muted" }, "unsigned")],
    ]),
    r.signature ? h("p", { class: "muted small" }, "Verify: ", h("code", {}, `tidegap verify ${t.task_id}`)) : null);
}

/** "Claude Code session d76db676", for a task an agent session queued. */
function originAgent(t) {
  if (!t.origin_agent || !t.origin_session_id) return null;
  const name = t.origin_agent === "claude-code" ? "Claude Code" : t.origin_agent === "codex" ? "Codex" : t.origin_agent;
  return `${name} session ${String(t.origin_session_id).slice(0, 8)}`;
}

/** How the run used the origin session: a copy (with the command that opens it) or a fresh session and why. */
function runSession(t) {
  const run = t.run_session;
  if (!run) return [];
  if (run.mode === "fork") {
    const out = [h("p", {}, "Ran in a copy of this session.")];
    if (t.fork_command) {
      out.push(h("div", { class: "cmd" },
        h("code", { class: "cmd-text", id: "fork-cmd" }, `$ ${t.fork_command}`),
        h("button", { type: "button", class: "btn btn-sm", "data-action": "copy-resume", "data-copy": t.fork_command }, "Copy")));
      out.push(h("p", { class: "muted small" }, "Opens the copy with the task and its answer; the original session is unchanged."));
    }
    return out;
  }
  const tokens = typeof run.context_tokens === "number" && run.reason === "too-large" ? `, about ${Math.round(run.context_tokens / 1000)}k tokens` : "";
  return [h("p", {}, `Ran in a fresh session: ${run.reason_text ?? "no session"}${tokens}.`)];
}

function origin(t) {
  const where = [originAgent(t) ?? t.origin_host, t.origin_cwd].filter(Boolean).join(" · ");
  const body = [h("p", {}, where || h("span", { class: "muted" }, "Origin not recorded (older task)."))];
  if (t.resume_command) {
    body.push(h("div", { class: "cmd" },
      h("code", { class: "cmd-text", id: "resume-cmd" }, `$ ${t.resume_command}`),
      h("button", { type: "button", class: "btn btn-sm", "data-action": "copy-resume", "data-copy": t.resume_command }, "Copy")));
    body.push(h("p", { class: "muted small" }, "Back to the Claude Code session that created this task."));
  } else if (t.origin_session_id) {
    body.push(h("p", { class: "muted small" }, `Session ${t.origin_session_id}`));
  }
  body.push(...runSession(t));
  return section("Origin", body);
}

function chainSection(t) {
  const items = [];
  if (t.parent) {
    items.push(h("p", {}, "Reply to ", t.parent.missing ? h("code", {}, shortId(t.parent.task_id)) : h("a", { href: taskHref(t.parent.task_id) }, title(t.parent))));
  }
  if (t.children?.length) {
    items.push(h("p", { class: "muted small" }, "Replies"));
    items.push(h("ul", { class: "links" }, t.children.map((c) => h("li", {}, h("a", { href: taskHref(c.task_id) }, title(c)), " ", statusTag(c)))));
  }
  const s = t.series;
  if (s) {
    const next = (s.next_deadlines || [])[0];
    items.push(h("p", {},
      s.ended ? "Series ended" : `Series: ${REPEAT_LABEL[s.repeat] || s.repeat}`,
      ` · ${s.occurrences} occurrence${s.occurrences === 1 ? "" : "s"}`,
      next && !s.ended ? ` · next by ${when(parse(next))}` : ""));
    const runs = drawerState.series?.occurrences || [];
    if (runs.length > 1) {
      items.push(h("ol", { class: "links series-runs" }, runs.slice(-8).reverse().map((o) =>
        h("li", {},
          o.task_id === t.task_id ? h("span", {}, "this run") : h("a", { href: taskHref(o.task_id) }, when(parse(o.completed_at || o.scheduled_for || o.deadline)) || o.task_id),
          " ", statusTag(o)))));
    }
  }
  return items.length ? section(s ? "Chain and series" : "Chain", items) : null;
}

// ── actions owned by the drawer ─────────────────────────────────────────

let replying = false;

export async function sendReply() {
  if (replying) return;
  const id = drawerState.id;
  const box = el().querySelector("textarea.reply-input");
  const text = box?.value.trim();
  if (!id || !text) {
    box?.focus();
    return;
  }
  const send = el().querySelector('[data-action="reply-send"]');
  if (send) send.disabled = true;
  replying = true;
  try {
    const child = await api.reply(id, text);
    drawerState.draft = "";
    toast("Reply queued · runs on the next tick");
    location.hash = taskHref(child.task_id);
  } catch (err) {
    if (err instanceof SessionExpired) {
      state.expired = true;
      notify();
      return;
    }
    errorToast(`Reply failed: ${err.message}`);
    if (send) send.disabled = false;
  } finally {
    replying = false;
  }
}

export async function copyResume(button) {
  const text = button.dataset.copy;
  try {
    await navigator.clipboard.writeText(text);
    button.textContent = "Copied";
    toast("Resume command copied");
    setTimeout(() => (button.textContent = "Copy"), 2000);
  } catch {
    // No clipboard permission: select the text so the user can copy it.
    const code = button.previousElementSibling ?? el().querySelector("#resume-cmd");
    const range = document.createRange();
    range.selectNodeContents(code);
    const sel = getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
    toast("Selected. Press Ctrl+C (⌘C) to copy.");
  }
}

export function retryDetail() {
  drawerState.error = null;
  drawerState.loading = true;
  renderDetail();
  void loadDetail();
}

/** The task the drawer shows, with the optimistic patch. */
export function detailTask() {
  if (!drawerState.data) return null;
  const live = findTask(drawerState.id);
  return { ...drawerState.data, ...(live?._op ? live._op.patch : {}), actions: live?.actions ?? drawerState.data.actions };
}
