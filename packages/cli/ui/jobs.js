// Jobs view (jobs plan U9): the list of recurring jobs, their row states and
// the history drawer. `jobsModel` and `jobStatusLine` are pure; the render
// functions only build nodes through `h()`, so job titles, prompts, commands
// and run previews reach the page as text. Buttons come from the server's
// `actions` flags for this caller.

import { api, ApiError, errorText, SessionExpired } from "./api.js";
import { copyChip } from "./copy.js";
import { confirmDialog } from "./dialog.js";
import { grams, h, parse, shortId, swapChildren } from "./dom.js";
import { notify, state } from "./state.js";
import { errorToast, toast } from "./toast.js";
import { emptyState, errorCard, skeletonRows } from "./views.js";

const MINUTE = 60_000;
const DAY = 86_400_000;
/** A planned run this late, and not running, waits for the machine (it was off or asleep). */
const OVERDUE_MS = 10 * MINUTE;
/** Failed runs in a row before a job pauses itself (core outcome policy). */
const AUTO_PAUSE_AFTER = 3;

export const VIEWER_TZ = Intl.DateTimeFormat().resolvedOptions().timeZone;

/** Readiness codes that mean no tick daemon runs, so no job runs. */
const TICKER_CODES = new Set(["no_daemon", "daemon_not_loaded", "daemon_stale"]);

export const DAEMON_LINE = "The tick daemon is not running, so jobs will not run. Run: tidegap install";

// ── time in the job's zone ──────────────────────────────────────────────

/** True when `tz` is an IANA zone this browser knows. */
export function validZone(tz) {
  if (typeof tz !== "string" || !tz) return false;
  try {
    new Intl.DateTimeFormat("en-GB", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

function zoned(ms, tz) {
  const parts = {};
  for (const p of new Intl.DateTimeFormat("en-GB", {
    timeZone: tz,
    weekday: "short",
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
    timeZoneName: "short",
  }).formatToParts(ms)) {
    parts[p.type] = p.value;
  }
  const num = new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(ms);
  return { ...parts, ymd: num };
}

function offsetOf(ms, tz) {
  return new Intl.DateTimeFormat("en-GB", { timeZone: tz, timeZoneName: "longOffset" }).formatToParts(ms).find((p) => p.type === "timeZoneName")?.value;
}

/**
 * An instant in the job's zone: "02:00" today, "tomorrow 02:00", "Fri 02:00"
 * within a week, else "29 Oct 02:00". The zone's abbreviation is added when
 * its offset differs from the viewer's.
 */
export function jobTime(iso, tz, { now = Date.now(), viewerTz = VIEWER_TZ } = {}) {
  const ms = typeof iso === "number" ? iso : parse(iso);
  if (!Number.isFinite(ms)) return "";
  const zone = validZone(tz) ? tz : viewerTz;
  const p = zoned(ms, zone);
  const today = zoned(now, zone);
  const days = Math.round((Date.parse(p.ymd) - Date.parse(today.ymd)) / DAY);
  const hm = `${p.hour}:${p.minute}`;
  let text;
  if (days === 0) text = hm;
  else if (days === 1) text = `tomorrow ${hm}`;
  else if (days === -1) text = `yesterday ${hm}`;
  else if (Math.abs(days) < 7) text = `${p.weekday} ${hm}`;
  else text = `${p.day} ${p.month} ${hm}`;
  if (zone !== viewerTz && offsetOf(ms, zone) !== offsetOf(ms, viewerTz)) text += ` ${p.timeZoneName}`;
  return text;
}

// ── row model ───────────────────────────────────────────────────────────

/** The reason after "auto: ", or null for a manual pause. */
export function autoPauseReason(job) {
  const r = job.pause_reason;
  return typeof r === "string" && r.startsWith("auto:") ? r.slice(5).trim() : null;
}

function lastPart(job, t) {
  const last = job.last_run;
  if (!last) return null;
  const at = t(last.completed_at || last.started_at);
  const late = last.late === true ? ", ran late" : "";
  if (last.outcome === "ok") return `last: ok, ${at}${late}`;
  if (last.outcome === "failed") {
    const n = job.consecutive_failures;
    return job.status === "active" && n > 0 ? `last: failed ${at} (${n} of ${AUTO_PAUSE_AFTER})${late}` : `last: failed ${at}${late}`;
  }
  return `last: ${last.outcome}, ${at}${late}`;
}

function nextPart(job, t, now) {
  const next = job.next_run;
  if (!next) return null;
  if (next.status === "running") return next.started_at ? `running since ${t(next.started_at)}` : "running now";
  if (next.status === "submitted") return `in a provider batch, by ${t(next.deadline)}`;
  // A usage limit holds the run: its planned hour may be past, the machine is not to blame.
  if (next.deferred_until) return `deferred until ${t(next.deferred_until)}`;
  const planned = parse(next.scheduled_for);
  const deadline = parse(next.deadline);
  if ((Number.isFinite(planned) && planned < now - OVERDUE_MS) || (Number.isFinite(deadline) && deadline < now)) {
    return "waiting to run - the machine was off or asleep";
  }
  if (next.via_batch) return `next: by ${t(next.deadline)} via Batch`;
  // Core names the one retry after a failure `<job>~<seq>r` (its failure
  // count stays unchanged until the retry fails too).
  const retrying = job.last_run?.outcome === "failed" && /r$/.test(next.task_id || "");
  if (retrying) {
    const at = t(next.scheduled_for || next.earliest);
    return job.window ? `retry planned ${at}, before ${t(next.deadline)}` : `retry planned ${at}`;
  }
  // A run-anchored job (every N hours) shows its latest time, not a planned hour.
  if (job.cadence?.kind === "hours") return `next ~${t(next.deadline)}`;
  if (!Number.isFinite(planned)) {
    return job.window
      ? `next: between ${job.window.start} and ${job.window.end}, hour picked when the forecast covers it`
      : `next: by ${t(next.deadline)}, hour picked when the forecast covers it`;
  }
  const g = next.intensity_g_per_kwh;
  return `next ${t(next.scheduled_for)}${typeof g === "number" && Number.isFinite(g) ? ` (${Math.round(g)} g)` : ""}`;
}

/** One status line for a job row (the plan's row-state table). */
export function jobStatusLine(job, { now = Date.now(), viewerTz = VIEWER_TZ } = {}) {
  if (job.status === "paused") {
    const reason = autoPauseReason(job);
    return reason ? `paused after ${job.consecutive_failures || AUTO_PAUSE_AFTER} failures: ${reason}` : "paused";
  }
  if (job.status === "removed") return "removed";
  const t = (iso) => jobTime(iso, job.time_zone, { now, viewerTz });
  const next = nextPart(job, t, now);
  // A running job says only that: its last result is not what it is doing now.
  if (job.next_run?.status === "running") return next;
  const last = lastPart(job, t);
  return [last, next].filter(Boolean).join(" · ") || "waiting for its first run";
}

/** The buttons a row shows, from the server's `actions` (and History, always). */
export function jobButtons(job) {
  const a = job.actions || {};
  const out = [];
  if (a.pause) out.push("pause");
  if (a.resume) out.push("resume");
  if (a.run_now) out.push("run-now");
  if (a.edit) out.push("edit");
  out.push("history");
  // An active job is removed from its form's footer (R27); a paused one here too.
  if (a.remove && job.status === "paused") out.push("remove");
  return out;
}

function sortKey(job) {
  const n = job.next_run;
  const at = parse(n?.scheduled_for) || parse(n?.deadline) || parse(n?.earliest);
  return Number.isFinite(at) ? at : Infinity;
}

/**
 * The Jobs view model: `banner` when no tick daemon runs (readiness), the
 * rows (active before paused, then by next run), `empty`, `canCreate`.
 * `ops` maps a job id to its in-flight action label.
 */
export function jobsModel(jobs, readiness, { canAuthor = false, ops = new Map(), now = Date.now(), viewerTz = VIEWER_TZ } = {}) {
  const daemonDown = !!readiness && readiness.ready === false && (readiness.problems || []).some((p) => TICKER_CODES.has(p.code));
  const rows = [...jobs]
    .filter((j) => j.status !== "removed")
    .sort((a, b) => (a.status === b.status ? 0 : a.status === "active" ? -1 : 1) || sortKey(a) - sortKey(b) || String(a.title).localeCompare(String(b.title)))
    .map((job) => ({
      id: job.job_id,
      title: job.title,
      status: job.status,
      running: job.next_run?.status === "running",
      guarantee: job.guarantee,
      line: jobStatusLine(job, { now, viewerTz }),
      preview: job.status === "paused" ? null : job.last_run?.preview || null,
      missingSecrets: job.missing_secrets || [],
      buttons: jobButtons(job),
      op: ops.get(job.job_id) || null,
    }));
  return { banner: daemonDown ? DAEMON_LINE : null, rows, empty: rows.length === 0, canCreate: canAuthor };
}

// ── state ───────────────────────────────────────────────────────────────

export const jobsState = {
  loaded: false,
  error: null,
  jobs: [],
  /** null until the secrets probe answers: true for the page and a macos token. */
  canAuthor: null,
  secretNames: [],
  /** job id -> label of its in-flight action ("Pausing…") */
  ops: new Map(),
};

let seq = 0;

/** A local write to the list (KTD17): a list answer that started before it is older, so it is dropped. */
function setJobs(jobs) {
  seq++;
  jobsState.jobs = jobs;
}

/** On a 401, flag the session as expired; true when `err` was one. */
export function expire(err) {
  if (!(err instanceof SessionExpired)) return false;
  state.expired = true;
  notify();
  return true;
}

/** Re-fetch the job list (and, once, whether this caller may author jobs). */
export async function loadJobs() {
  const mine = ++seq;
  if (jobsState.canAuthor === null) void probeAuthor();
  try {
    const out = await api.jobs();
    if (mine !== seq) return;
    jobsState.jobs = out.jobs;
    jobsState.loaded = true;
    jobsState.error = null;
  } catch (err) {
    if (mine !== seq || expire(err)) return;
    jobsState.error = err;
  }
  notify();
}

/** The secrets route answers the page and a macos token; 403 means read-only jobs here. */
export async function probeAuthor() {
  try {
    jobsState.secretNames = (await api.jobSecrets()).names || [];
    jobsState.canAuthor = true;
  } catch (err) {
    if (expire(err)) return jobsState.canAuthor;
    // 403: this caller only reads jobs. Anything else: ask again on the next load.
    jobsState.canAuthor = err instanceof ApiError && err.status === 403 ? false : null;
  }
  notify();
  return jobsState.canAuthor;
}

export function findJob(id) {
  return jobsState.jobs.find((j) => j.job_id === id);
}

/** Put a fresh `Job` answer in the list (or drop it when removed). */
export function upsertJob(job) {
  const rest = jobsState.jobs.filter((j) => j.job_id !== job.job_id);
  setJobs(job.status === "removed" ? rest : [...rest, job]);
  notify();
}

// ── actions ─────────────────────────────────────────────────────────────

const ACTION = {
  pause: { label: "Pausing…", verb: "Pause", done: (j) => `Paused “${j.title}”` },
  resume: { label: "Resuming…", verb: "Resume", done: (j) => `Resumed “${j.title}”` },
  "run-now": { label: "Queuing…", verb: "Run now", done: (j) => `“${j.title}” runs on the next tick` },
};

function optimistic(job, action) {
  const a = { ...job.actions };
  if (action === "pause") return { ...job, status: "paused", pause_reason: "manual", next_run: null, actions: { ...a, pause: false, resume: true, run_now: false } };
  if (action === "resume") return { ...job, status: "active", pause_reason: null, actions: { ...a, pause: true, resume: false } };
  return { ...job, actions: { ...a, run_now: false } };
}

/** Pause, resume or run now: the row changes at once; a refusal rolls it back with the server's sentence. */
export async function jobAction(action, id) {
  const job = findJob(id);
  const spec = ACTION[action];
  if (!job || !spec || jobsState.ops.has(id)) return;
  jobsState.ops.set(id, spec.label);
  setJobs(jobsState.jobs.map((j) => (j.job_id === id ? optimistic(j, action) : j)));
  notify();
  try {
    const fresh = await api.jobAction(id, action);
    jobsState.ops.delete(id);
    upsertJob(fresh);
    toast(spec.done(fresh));
  } catch (err) {
    jobsState.ops.delete(id);
    setJobs(jobsState.jobs.map((j) => (j.job_id === id ? job : j)));
    notify();
    if (expire(err)) return;
    const why = err instanceof ApiError && (err.status === 400 || err.status === 409 || err.status === 429) ? err.message : "the server could not apply it; nothing changed.";
    errorToast(`${spec.verb} failed: ${err instanceof ApiError ? why : "Network error; nothing changed."}`);
    void loadJobs();
  }
}

/** The "Remove this job?" confirm, shared by the list and the form. */
export function confirmRemove(name) {
  return confirmDialog({
    heading: "Remove this job?",
    body: `“${name}” stops for good. Its runs stay in the Journal.`,
    confirm: "Remove job",
    danger: true,
  });
}

/**
 * Remove after a confirm, from the list or the job's form (which passes
 * the title it shows). Resolves true when the job is gone.
 */
export async function removeJob(id, title) {
  const job = findJob(id) || (historyState.job?.job_id === id ? historyState.job : null);
  const name = title || job?.title || id;
  if (!(await confirmRemove(name))) return false;
  try {
    await api.jobAction(id, "remove");
    setJobs(jobsState.jobs.filter((j) => j.job_id !== id));
    notify();
    toast(`Removed “${name}”`);
    return true;
  } catch (err) {
    if (!expire(err)) errorToast(`Remove failed: ${errorText(err)}`);
    void loadJobs();
    return false;
  }
}

// ── list render ─────────────────────────────────────────────────────────

const enc = encodeURIComponent;
export const jobHref = (id, history = false) => `#/jobs/${enc(id)}${history ? "/history" : ""}`;

/**
 * A job route in the address: `{id: null}` for the new-job form, `{id,
 * history}` for a job, `{unknown: true}` for an id made of dots and
 * slashes only (`.`, `..`, `../`: as a path step it would leave
 * `/api/jobs/`), null when `hash` is no job route.
 */
export function jobRoute(hash) {
  const m = /^#\/jobs\/([^/?]+)(\/history)?$/.exec(hash);
  if (!m) return null;
  if (m[1] === "new" && !m[2]) return { id: null, history: false };
  let id = m[1];
  try {
    id = decodeURIComponent(id);
  } catch {
    // keep the raw segment; the server answers 404 for an unknown id
  }
  return /^[./\\]+$/.test(id) ? { unknown: true } : { id, history: !!m[2] };
}

const BUTTON = { pause: "Pause", resume: "Resume", "run-now": "Run now", remove: "Remove" };

function rowButton(name, row) {
  if (name === "edit") return h("a", { class: "btn btn-sm", href: jobHref(row.id) }, "Edit");
  if (name === "history") return h("a", { class: "btn btn-sm", href: jobHref(row.id, true) }, "History");
  return h("button", {
    type: "button",
    class: ["btn btn-sm", name === "remove" && "btn-danger"],
    "data-action": `job-${name}`,
    disabled: !!row.op,
  }, BUTTON[name]);
}

function jobItem(row) {
  return h("li", { class: ["job", `job-${row.status}`, row.op && "job-pending"], "data-job-id": row.id },
    h("div", { class: "job-head" },
      h("span", { class: "job-dot", "aria-hidden": "true" }, row.status === "active" ? "●" : "○"),
      h("a", { class: "job-title", href: jobHref(row.id, true) }, row.title),
      h("span", { class: `tag job-state tag-${row.status === "active" ? (row.running ? "running" : "accent") : "muted"}` },
        row.status === "active" && row.running ? "active · running" : row.status)),
    row.guarantee ? h("p", { class: "job-line job-guarantee" }, row.guarantee) : null,
    h("p", { class: "job-line job-status" }, row.op ? h("span", { class: "row-op" }, row.op) : row.line),
    row.preview ? h("p", { class: "job-line job-preview" }, `“${row.preview}”`) : null,
    row.missingSecrets.length
      ? h("p", { class: "job-line job-warn" }, `${row.missingSecrets.join(", ")} not set; run: tidegap jobs secrets set ${row.missingSecrets[0]}`)
      : null,
    h("div", { class: "job-actions" }, row.buttons.map((b) => rowButton(b, row))));
}

function newJobButton() {
  return h("a", { class: "btn btn-sm btn-primary", href: "#/jobs/new" }, "New job");
}

/** The Jobs view. */
export function renderJobs(root) {
  const readiness = state.status?.readiness;
  const m = jobsModel(jobsState.jobs, readiness && typeof readiness.ready === "boolean" ? readiness : null, {
    canAuthor: jobsState.canAuthor === true,
    ops: jobsState.ops,
  });
  root.append(h("div", { class: "view-head" },
    h("h1", { class: "view-title" }, "Jobs"),
    m.canCreate && !m.empty ? h("span", { class: "view-head-end" }, newJobButton()) : null));
  if (m.banner) {
    root.append(h("p", { class: "jobs-banner", role: "note", "data-readiness": "daemon" },
      h("span", { class: "banner-icon", "aria-hidden": "true" }, "!"), h("span", {}, m.banner)));
  }
  if (!jobsState.loaded) {
    root.append(jobsState.error ? errorCard("Could not load jobs.") : skeletonRows(3));
    return;
  }
  if (jobsState.error) root.append(errorCard("Could not refresh jobs. Showing the last data."));
  if (m.empty) {
    const empty = emptyState({
      title: "No jobs yet.",
      body: "A job runs a prompt or a command at the cleanest hour, every day or week.",
      glyph: "↻",
    });
    empty.append(
      m.canCreate ? h("p", { class: "empty-actions" }, newJobButton()) : null,
      h("p", { class: "empty-body" }, "Or ask your agent: “check my mail every morning”."));
    root.append(empty);
    return;
  }
  root.append(h("ul", { class: "jobs" }, m.rows.map(jobItem)));
}

// ── history drawer ──────────────────────────────────────────────────────

export const historyState = { id: null, job: null, runs: [], next: null, loading: false, more: false, error: null, seq: 0 };

const RUN_WORD = { completed: "ok", failed: "failed", cancelled: "cancelled", running: "running", queued: "queued", scheduled: "planned", submitted: "in a provider batch" };

/** One history line's parts: when, outcome word and tone, grams, receipt id, quoted text. */
export function runLine(run, tz, opts = {}) {
  const word = Object.hasOwn(RUN_WORD, run.status) ? RUN_WORD[run.status] : "planned";
  // A submitted run already says it is in a provider batch.
  const batch = run.via_batch && run.status !== "submitted" ? `${word} (Batch)` : word;
  return {
    when: jobTime(run.completed_at || run.started_at || run.scheduled_for, tz, opts),
    word: run.late === true ? `${batch}, ran late` : batch,
    tone: run.status,
    carbon: typeof run.carbon_g === "number" ? grams(run.carbon_g) : "",
    receipt: run.receipt_id || null,
    text: run.error || run.preview || "",
  };
}

function drawerEl() {
  return document.getElementById("drawer");
}

/** Show `nodes` in the shared drawer (the task drawer's shell). */
export function showDrawer(nodes, owner) {
  const root = drawerEl();
  root.removeAttribute("data-task-id");
  root.dataset.owner = owner;
  swapChildren(root, nodes);
  root.hidden = false;
  document.getElementById("scrim").hidden = false;
  document.body.classList.add("drawer-open");
}

export function hideDrawer(owner) {
  const root = drawerEl();
  if (root.dataset.owner !== owner) return;
  delete root.dataset.owner;
  root.hidden = true;
  root.replaceChildren();
  document.getElementById("scrim").hidden = true;
  document.body.classList.remove("drawer-open");
}

/** After a job drawer closes, focus the link that opened it (`href`), when the view shows one. */
export function returnFocus(href) {
  if (!href) return;
  requestAnimationFrame(() => document.querySelector(`#view a[href="${CSS.escape(href)}"]`)?.focus({ preventScroll: true }));
}

export function drawerHead(text, sub) {
  return [
    h("div", { class: "drawer-head" },
      h("h2", { id: "drawer-title", class: "drawer-title", tabindex: "-1" }, text),
      h("button", { type: "button", class: "icon-btn drawer-close", "data-action": "close", "aria-label": "Close (Esc)", title: "Close (Esc)" }, "×")),
    sub ? h("p", { class: "drawer-meta" }, sub) : null,
  ];
}

export function historyOpen() {
  return historyState.id !== null;
}

export async function openHistory(id) {
  if (historyState.id !== id) {
    Object.assign(historyState, { id, job: findJob(id) || null, runs: [], next: null, error: null });
    historyState.loading = true;
    renderHistory();
    requestAnimationFrame(() => drawerEl().querySelector(".drawer-close")?.focus());
  }
  await loadHistory();
}

async function loadHistory() {
  const id = historyState.id;
  const mine = ++historyState.seq;
  try {
    const [job, page] = await Promise.all([api.job(id), api.jobHistory(id)]);
    if (mine !== historyState.seq || historyState.id !== id) return;
    Object.assign(historyState, { job, ...mergeRuns(historyState, page), error: null, loading: false });
  } catch (err) {
    if (mine !== historyState.seq || historyState.id !== id || expire(err)) return;
    Object.assign(historyState, { error: err, loading: false });
  }
  renderHistory();
}

/**
 * A refreshed first page plus the older runs already loaded below it, so a
 * refresh does not drop pages the user opened with Show older. The kept
 * runs start after the fresh page's last run; the cursor stays theirs.
 */
export function mergeRuns(loaded, page) {
  const last = page.runs[page.runs.length - 1];
  const at = last ? loaded.runs.findIndex((r) => r.task_id === last.task_id) : -1;
  const fresh = new Set(page.runs.map((r) => r.task_id));
  const kept = at < 0 ? [] : loaded.runs.slice(at + 1).filter((r) => !fresh.has(r.task_id));
  return kept.length ? { runs: [...page.runs, ...kept], next: loaded.next } : { runs: page.runs, next: page.next_before };
}

async function olderRuns() {
  const id = historyState.id;
  if (!historyState.next || historyState.more) return;
  const mine = historyState.seq;
  historyState.more = true;
  renderHistory();
  try {
    const page = await api.jobHistory(id, historyState.next);
    // A refresh started meanwhile rebuilt the list; this page's cursor is stale.
    if (historyState.id !== id || historyState.seq !== mine) return;
    historyState.runs = [...historyState.runs, ...page.runs];
    historyState.next = page.next_before;
  } catch (err) {
    if (!expire(err)) errorToast(`Could not load older runs: ${errorText(err)}`);
  } finally {
    historyState.more = false;
    if (historyState.id === id) renderHistory();
  }
}

export function closeHistory() {
  if (historyState.id === null) return;
  const opener = jobHref(historyState.id, true);
  historyState.id = null;
  historyState.seq++;
  hideDrawer("history");
  returnFocus(opener);
}

/** Re-fetch the open history when a job changed. */
export function onHistoryEvent() {
  if (historyState.id !== null) void loadHistory();
}

function renderHistory() {
  if (historyState.id === null) return;
  const job = historyState.job;
  const name = job?.title || shortId(historyState.id);
  const body = [...drawerHead(`${name} - history`, job?.guarantee || null)];
  if (historyState.error) {
    const notFound = historyState.error instanceof ApiError && historyState.error.status === 404;
    body.push(h("div", { class: "error-card", role: "alert" },
      h("span", {}, notFound ? "This job does not exist on this ledger." : "Could not load the history."),
      notFound ? null : h("button", { type: "button", class: "btn btn-sm", onclick: () => void loadHistory() }, "Retry")));
  } else if (historyState.loading && historyState.runs.length === 0) {
    body.push(skeletonRows(3));
  } else if (historyState.runs.length === 0) {
    const first = job?.next_run ? jobTime(job.next_run.scheduled_for || job.next_run.deadline, job.time_zone) : "";
    body.push(h("p", { class: "muted" }, first ? `No runs yet. The first run is planned ${first}.` : "No runs yet."));
  } else {
    body.push(h("ul", { class: "runs" }, historyState.runs.map((run) => {
      const r = runLine(run, job?.time_zone);
      return h("li", { class: "run", "data-run-id": run.task_id },
        h("span", { class: "run-when" }, r.when),
        h("span", { class: `tag tag-${r.tone}` }, r.word),
        h("span", { class: "run-g" }, r.carbon),
        r.receipt ? copyChip(`tidegap verify ${r.receipt}`, "verify command", { shown: `receipt ${shortId(r.receipt)}`, className: "run-receipt" }) : h("span", {}),
        r.text ? h("span", { class: "run-text" }, `“${r.text}”`) : null);
    })));
    if (historyState.next) {
      body.push(h("p", {}, h("button", { type: "button", class: "btn btn-sm", disabled: historyState.more, onclick: () => void olderRuns() },
        historyState.more ? "Loading…" : "Show older")));
    }
  }
  if (job?.actions?.edit) body.push(h("p", { class: "drawer-foot" }, h("a", { class: "btn btn-sm", href: jobHref(job.job_id) }, "Edit job")));
  showDrawer(body, "history");
}
