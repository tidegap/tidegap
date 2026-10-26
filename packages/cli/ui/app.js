// tidegap ui front end: bootstrap, router, actions, dispatcher banner.
// Dependency-free ES modules, no build step. Every task string is rendered
// through text nodes (dom.js); nothing here writes HTML from data.

import { api, ApiError, hasToken, parseFragment, SessionExpired, setToken } from "./api.js";
import { renderAgenda, ranNow, cleanest } from "./agenda.js";
import {
  actionMenu,
  closeDialog,
  confirmDialog,
  dayName,
  helpDialog,
  initDialog,
  laterDialog,
  movedText,
  rescheduleDialog,
} from "./dialog.js";
import { initDnd, isDragging } from "./dnd.js";
import {
  closeDetail,
  copyResume,
  detailId,
  detailTask,
  focusReply,
  onDetailEvent,
  openDetail,
  renderDetail,
  retryDetail,
  sendReply,
  trapFocus,
} from "./detail.js";
import { initClients } from "./clients.js";
import { initSettings, mountSettings, settingsMounted, unmountSettings } from "./integrations.js";
import { initUsage } from "./usage.js";
import { ago, agoAwake, h, isUnread, parse, relDay, swapChildren, taskHref, title, when } from "./dom.js";
import { invalidateJournal, renderJournal, toggleExpand } from "./journal.js";
import { closeHistory, findJob, historyOpen, jobAction, jobHref, jobsState, loadJobs, onHistoryEvent, openHistory, removeJob, renderJobs } from "./jobs.js";
import { closeJobForm, jobFormHash, jobFormOpen, leaveJobForm, onJobFormEvent, openJobForm } from "./job-form.js";
import { initKeys } from "./keys.js";
import {
  cancelPending,
  cancelWithUndo,
  findTask,
  finishedTasks,
  flushDelayed,
  notify,
  onTaskEvent,
  perform,
  postponeWithUndo,
  refresh,
  refreshStatus,
  state,
  stream,
  subscribe,
} from "./state.js";
import { renderTimeline, selectMarker } from "./timeline.js";
import { errorToast, toast } from "./toast.js";

const VIEWS = { agenda: renderAgenda, timeline: renderTimeline, journal: renderJournal, jobs: renderJobs };
const HOUR = 3_600_000;
/** A job occurrence's task id: `<job>~<seq>`, `r` for the retry (a repeat series uses `<series>~<n>` too). */
const OCCURRENCE = /^(.+)~\d+r?$/;

let currentView = "agenda";
let viewHash = "#/agenda";
let deferred = false;
let bannerNote = null;
let renderedOp = null;

// ── routing ─────────────────────────────────────────────────────────────

function parseRoute() {
  const task = /^#\/task\/([^?]+)$/.exec(location.hash);
  if (task) {
    try {
      return { taskId: decodeURIComponent(task[1]) };
    } catch {
      return { taskId: task[1] };
    }
  }
  if (location.hash === "#/settings") return { view: "settings" };
  const job = /^#\/jobs\/([^/?]+)(\/history)?$/.exec(location.hash);
  if (job) {
    if (job[1] === "new" && !job[2]) return { view: "jobs", job: { id: null } };
    let id = job[1];
    try {
      id = decodeURIComponent(id);
    } catch {
      // keep the raw segment; the server answers 404 for an unknown id
    }
    return { view: "jobs", job: { id, history: !!job[2] } };
  }
  const view = /^#\/(agenda|timeline|journal|jobs)(\?.*)?$/.exec(location.hash);
  return { view: view ? view[1] : "agenda" };
}

let routing = Promise.resolve();

function onRoute() {
  // One route change at a time: a dirty job form may ask before it closes.
  routing = routing.then(route, route);
}

async function route() {
  if (/^#token=/.test(location.hash)) {
    location.reload();
    return;
  }
  const r = parseRoute();
  const onForm = r.job && !r.job.history;
  if (jobFormOpen() && !(onForm && location.hash === jobFormHash())) {
    if (!(await leaveJobForm(location.hash))) return;
  }
  if (!r.job?.history) closeHistory();
  if (r.taskId) {
    void openDetail(r.taskId);
  } else {
    currentView = r.view;
    viewHash = r.job ? "#/jobs" : location.hash.startsWith(`#/${r.view}`) ? location.hash : `#/${r.view}`;
    closeDetail();
    if (r.view === "jobs" && !jobsState.loaded) void loadJobs();
    if (r.job?.history) void openHistory(r.job.id);
    else if (r.job) {
      const hash = location.hash;
      void openJobForm(r.job.id, hash).then((ok) => {
        // A read-only caller (an extension token) gets the job's history instead of its form.
        // Replace, not push: Back must leave the job, not land on the refused form again.
        if (!ok && location.hash === hash) location.replace(r.job.id ? jobHref(r.job.id, true) : "#/jobs");
      });
    }
  }
  render();
}

function jobDrawerOpen() {
  return jobFormOpen() || historyOpen();
}

function go(view) {
  location.hash = view === "journal" && viewHash.startsWith("#/journal") ? viewHash : `#/${view}`;
}

function closeDrawer() {
  if (jobDrawerOpen()) location.hash = "#/jobs";
  else if (location.hash.startsWith("#/task/")) location.hash = viewHash;
  else closeDetail();
}

// ── render ──────────────────────────────────────────────────────────────

function render() {
  if (state.expired) return showExpired();
  if (isDragging()) {
    deferred = true;
    return;
  }
  const view = document.getElementById("view");
  // Settings is a view without a tab; it keeps its own DOM and polling, so
  // a task event does not redraw it (and lose a half-typed token).
  if (currentView === "settings") {
    if (!settingsMounted()) {
      mountSettings(view, {
        onExpired: () => {
          state.expired = true;
          render();
        },
      });
    }
    finishRender();
    return;
  }
  if (settingsMounted()) unmountSettings();
  if (currentView !== "jobs" && jobFormOpen()) closeJobForm();
  const focused = document.activeElement?.closest?.("#view .row[data-task-id]")?.dataset.taskId;
  const focusedSelect = document.activeElement?.closest?.("#view select")?.name;
  const focusedJob = jobFocus();
  const wrap = h("div", { class: `view-inner view-${currentView}` });
  // currentView comes from the hash; parseRoute already limits it to the
  // three names, and this lookup refuses anything else on its own.
  const renderView = Object.hasOwn(VIEWS, currentView) ? VIEWS[currentView] : renderAgenda;
  renderView(wrap, { selectedId: detailId(), width: view.clientWidth - 2 * gutter() });
  // Keep the live DOM when nothing changed, so a click or hover in flight
  // is not lost to an identical redraw (the stream fires on every tick).
  if (view.firstElementChild?.isEqualNode(wrap)) {
    finishRender();
    return;
  }
  view.replaceChildren(wrap);
  if (focused) view.querySelector(`.row[data-task-id="${CSS.escape(focused)}"]`)?.focus({ preventScroll: true });
  if (focusedSelect) view.querySelector(`select[name="${focusedSelect}"]`)?.focus({ preventScroll: true });
  if (focusedJob) restoreJobFocus(view, focusedJob);
  finishRender();
}

/** The focused control in a Jobs row: its row id and its action or link. */
function jobFocus() {
  const el = document.activeElement;
  const row = el?.closest?.("#view .job[data-job-id]");
  if (!row) return null;
  return { id: row.dataset.jobId, action: el.dataset?.action || null, href: el.getAttribute?.("href") || null };
}

/** Focus the same control in the rebuilt row; a control that is gone or disabled hands focus to the row's title link. */
function restoreJobFocus(view, f) {
  const row = view.querySelector(`.job[data-job-id="${CSS.escape(f.id)}"]`);
  if (!row) return;
  const same = f.action
    ? row.querySelector(`[data-action="${CSS.escape(f.action)}"]:not(:disabled)`)
    : f.href && row.querySelector(`a[href="${CSS.escape(f.href)}"]`);
  (same || row.querySelector(".job-title"))?.focus({ preventScroll: true });
}

function finishRender() {

  for (const v of [...Object.keys(VIEWS), "settings"]) {
    const a = document.getElementById(`nav-${v}`);
    if (v === currentView) a.setAttribute("aria-current", "page");
    else a.removeAttribute("aria-current");
  }
  const unread = finishedTasks().filter(isUnread).length;
  const count = document.getElementById("unread-count");
  count.textContent = String(unread);
  count.hidden = unread === 0;
  count.setAttribute("aria-label", `${unread} unread`);
  document.getElementById("conn").hidden = state.connected;
  renderDispatcher();
  syncDetail();
}

/** Re-draw the drawer when the optimistic state of its task changed. */
function syncDetail() {
  const id = detailId();
  if (!id) return;
  const op = findTask(id)?._op || null;
  if (op !== renderedOp) {
    renderedOp = op;
    renderDetail();
  }
}

function gutter() {
  return window.innerWidth < 720 ? 16 : 32;
}

function showExpired() {
  unmountSettings();
  closeDialog();
  document.getElementById("drawer").hidden = true;
  document.getElementById("scrim").hidden = true;
  document.getElementById("conn").hidden = true;
  document.getElementById("banner").hidden = true;
  document.getElementById("view").replaceChildren(
    h("div", { class: "empty empty-full" },
      h("div", { class: "empty-glyph", "aria-hidden": "true" }, "⏻"),
      h("p", { class: "empty-title" }, "This link expired."),
      h("p", { class: "empty-body" }, "Run ", h("code", {}, "tidegap ui"), " again to get a new link. Links work for one run of the server.")),
  );
}

// ── dispatcher pill and banner ──────────────────────────────────────────

function dispatcherInfo() {
  const st = state.status;
  if (!st) return null;
  const d = st.dispatcher || {
    state: st.last_tick_at ? "stale" : "never",
    last_tick_at: st.last_tick_at,
    interval_s: 300,
    ui_child: null,
  };
  return d;
}

/** The server's readiness (coherence R7), or null on a server without it. */
function readinessInfo() {
  const r = state.status?.readiness;
  return r && typeof r.ready === "boolean" ? r : null;
}

/** Problems a dispatcher started here can fix (the ticker ones). */
const TICKER_CODES = new Set(["no_daemon", "daemon_not_loaded", "daemon_stale"]);

function renderDispatcher() {
  const d = dispatcherInfo();
  const pill = document.getElementById("dispatcher-pill");
  const text = document.getElementById("dispatcher-text");
  const banner = document.getElementById("banner");
  if (!d) {
    pill.dataset.state = "unknown";
    text.textContent = "Dispatcher";
    banner.hidden = true;
    return;
  }
  const last = parse(d.last_tick_at);
  const child = d.ui_child?.alive ? d.ui_child : null;
  const readiness = readinessInfo();
  const blocked = readiness && !readiness.ready;
  // Never green while tasks cannot run: a running dispatcher with a
  // readiness problem (no runner, for example) shows amber.
  pill.dataset.state = d.state === "running" && blocked ? "blocked" : d.state;
  text.textContent =
    d.state === "running"
      ? blocked
        ? "Running · nothing can run"
        : child && !(Number.isFinite(last) && Date.now() - last <= 2 * d.interval_s * 1000)
          ? `Dispatcher running · PID ${child.pid}`
          : `Dispatcher ran ${agoAwake(last, readiness?.ticker)}`
      : d.state === "stale"
        ? `Dispatcher idle · ${agoAwake(last, readiness?.ticker)}`
        : "No dispatcher";
  pill.title = blocked && readiness.line ? readiness.line : "Dispatcher status";

  if (bannerNote) {
    banner.dataset.tone = "info";
    swapChildren(banner, [
      h("span", { class: "banner-icon", "aria-hidden": "true" }, "●"),
      h("span", { class: "banner-text" }, bannerNote),
      h("button", { type: "button", class: "icon-btn banner-close", "aria-label": "Dismiss", "data-action": "banner-dismiss" }, "×"),
    ]);
    banner.hidden = false;
    return;
  }
  if (readiness) {
    if (readiness.ready) {
      banner.hidden = true;
      return;
    }
    // "Tasks will not run": the server's sentence and its fix (R3, R7).
    const canStart = d.state !== "running" && readiness.problems.some((p) => TICKER_CODES.has(p.code));
    banner.dataset.tone = "warn";
    swapChildren(banner, [
      h("span", { class: "banner-icon", "aria-hidden": "true" }, "!"),
      h("span", { class: "banner-text", "data-readiness": readiness.problems[0]?.code || "" }, readiness.line || "Tasks will not run."),
      canStart ? h("button", { type: "button", class: "btn btn-sm btn-primary", "data-action": "start-dispatcher" }, "Start dispatcher") : null,
    ]);
    banner.hidden = false;
    return;
  }
  if (d.state === "running") {
    banner.hidden = true;
    return;
  }
  const waiting = state.pending.length;
  banner.dataset.tone = waiting ? "warn" : "quiet";
  const msg =
    d.state === "never"
      ? "No dispatcher has run on this ledger yet."
      : `No dispatcher has run for ${agoAwake(last, readiness?.ticker).replace(" ago", "")}.`;
  swapChildren(banner, [
    h("span", { class: "banner-icon", "aria-hidden": "true" }, waiting ? "!" : "i"),
    h("span", { class: "banner-text" }, msg, " ", waiting ? `${waiting} pending task${waiting === 1 ? "" : "s"} will not run.` : "Nothing is pending."),
    h("button", { type: "button", class: "btn btn-sm btn-primary", "data-action": "start-dispatcher" }, "Start dispatcher"),
  ]);
  banner.hidden = false;
}

async function startDispatcher(button) {
  if (button) button.disabled = true;
  try {
    const meta = await api.startDispatcher();
    bannerNote = `Dispatcher started · PID ${meta.pid} · log ${meta.log}`;
    toast(`Dispatcher started · PID ${meta.pid}`);
  } catch (err) {
    if (err instanceof SessionExpired) {
      state.expired = true;
    } else if (err instanceof ApiError && err.status === 409) {
      // Two refusals share 409: a child of this page runs, or another
      // dispatcher ticked the ledger recently. The server's line says which.
      toast(`Not started: ${err.message}.`);
    } else {
      errorToast(`Could not start the dispatcher${err instanceof ApiError ? `: ${err.message}.` : "."}`);
    }
  } finally {
    if (button) button.disabled = false;
  }
  await refreshStatus();
}

function dispatcherDialog() {
  const d = dispatcherInfo();
  if (!d) return;
  const st = state.status;
  const last = parse(d.last_tick_at);
  const rows = [
    ["state", d.state === "running" ? "running" : d.state === "stale" ? "idle (stale)" : "never ran"],
    ["last tick", Number.isFinite(last) ? agoAwake(last, readinessInfo()?.ticker) : "never"],
    ["interval", `${d.interval_s} s`],
    ["daemon", st.daemon === "installed" ? "installed" : st.daemon === "not_installed" ? "not installed" : String(st.daemon)],
    ["started here", d.ui_child ? `PID ${d.ui_child.pid}${d.ui_child.alive ? "" : " (exited)"}` : null],
    ["log", d.ui_child?.log],
    ["ledger", st.db_path],
  ];
  const dl = h("dl", { class: "kv" });
  for (const [k, v] of rows) if (v) dl.append(h("dt", {}, k), h("dd", {}, v));
  const dlg = document.getElementById("dialog");
  if (dlg.open) dlg.close();
  dlg.className = "dialog";
  dlg.replaceChildren(
    h("header", { class: "dialog-head" }, h("h2", { class: "dialog-title", id: "dialog-title" }, "Dispatcher"),
      h("p", { class: "dialog-sub" }, "tidegap ui never runs tasks itself. A dispatcher (", h("code", {}, "tidegap tick"), " or the OpenClaw loop) does.")),
    dl,
    h("footer", { class: "dialog-foot" },
      h("button", { type: "button", class: "btn btn-ghost", onclick: () => dlg.close() }, "Close"),
      d.state !== "running" ? h("button", { type: "button", class: "btn btn-primary", onclick: () => { dlg.close(); void startDispatcher(); } }, "Start dispatcher") : null),
  );
  dlg.showModal();
}

// ── actions ─────────────────────────────────────────────────────────────

function taskFor(id) {
  const fromList = findTask(id);
  if (fromList) return fromList;
  const d = detailTask();
  return d && d.task_id === id ? d : null;
}

function nextTickHint() {
  const d = dispatcherInfo();
  if (!d || d.state === "running") return { text: "Runs on the next tick" };
  return {
    text: "Runs on the next tick. No dispatcher is running.",
    action: { label: "Start dispatcher", run: () => void startDispatcher() },
  };
}

async function runNow(task) {
  ranNow.add(task.task_id);
  const out = await perform({
    id: task.task_id,
    action: "run now",
    label: "Queuing to run now…",
    patch: { scheduled_for: new Date().toISOString(), not_before: null },
    send: () => api.runNow(task.task_id),
    confirm: () => {
      const hint = nextTickHint();
      return { text: `“${title(task)}” ${hint.text.charAt(0).toLowerCase()}${hint.text.slice(1)}`, action: hint.action };
    },
  });
  // A refused or failed run-now leaves the task where it was.
  if (out === undefined) {
    ranNow.delete(task.task_id);
    notify();
  }
  return out;
}

/** Rough run time inside a day, for the optimistic row: the cleanest hour. */
function guessInDay(task, start, bounds) {
  const from = Date.parse(bounds.day_start);
  const to = Date.parse(bounds.day_end);
  const best = cleanest(task.region, from, to);
  if (best) return Math.max(best.ms, from);
  const at = parse(task.scheduled_for);
  const offset = Number.isFinite(at) ? at - new Date(at).setHours(0, 0, 0, 0) : 12 * HOUR;
  return Math.min(Math.max(start + offset, from), to - HOUR);
}

function moveToDay(task, start, bounds) {
  if (!bounds) {
    errorToast("That day is over. Pick a later day.");
    return;
  }
  const guess = guessInDay(task, start, bounds);
  const label = dayName(start);
  return perform({
    id: task.task_id,
    action: "move",
    label: `Moving to ${relDay(start)}…`,
    patch: { scheduled_for: new Date(guess).toISOString(), deadline: bounds.day_end, deadline_kind: "absolute" },
    send: () => api.reschedule(task.task_id, bounds),
    confirm: (fresh) => movedText(fresh, `Moved to ${label}`, true),
  });
}

/** "Tonight · 22:00": what a Later toast says. */
function laterText(option, at) {
  return Number.isFinite(at) ? `${option.label} · from ${when(at)}` : option.label;
}

function later(task) {
  laterDialog(task, {
    postpone: (option) =>
      postponeWithUndo(
        task,
        option,
        `Moved “${title(task)}”: ${laterText(option, parse(option.not_before))}`,
        (fresh) => movedText(fresh, option.label),
      ),
    pick: () => pickLater(task),
  });
}

/**
 * Later → Pick a time: postpone `until` the exact time. The server refuses
 * a time at or before the planned start (409 "already planned for HH:MM"),
 * so Later never moves a task earlier; Reschedule is the way to do that.
 */
function pickLater(task) {
  rescheduleDialog(
    task,
    (target, _summary, ms) =>
      perform({
        id: task.task_id,
        action: "later",
        label: "Moving…",
        patch: { not_before: target.at, scheduled_for: target.at },
        send: () => api.postpone(task.task_id, { until: target.at }),
        confirm: (fresh) => movedText(fresh, `Moved to ${when(ms)}`),
      }),
    { later: true },
  );
}

function reschedule(task) {
  rescheduleDialog(task, (target, summary, ms) => {
    if (target.day_start) return moveToDay(task, ms, target);
    const patch = target.at
      ? { scheduled_for: target.at, deadline: parse(task.deadline) >= ms ? task.deadline : target.at, deadline_kind: "absolute" }
      : { deadline: target.deadline, deadline_kind: "absolute", scheduled_for: new Date(Math.min(parse(task.scheduled_for) || ms, ms)).toISOString() };
    return perform({
      id: task.task_id,
      action: "reschedule",
      label: "Rescheduling…",
      patch,
      send: () => api.reschedule(task.task_id, target),
      confirm: (fresh) => movedText(fresh, summary),
    });
  });
}

function setRead(task, read) {
  return perform({
    id: task.task_id,
    action: read ? "mark read" : "mark unread",
    label: "Saving…",
    patch: { read_at: read ? new Date().toISOString() : null },
    send: () => (read ? api.read(task.task_id) : api.unread(task.task_id)),
    confirm: () => (read ? "Marked read" : "Marked unread"),
  });
}

async function stopSeries(task) {
  const ok = await confirmDialog({
    heading: "Stop this series?",
    body: `“${title(task)}” is cancelled and no further occurrences are created. Earlier runs stay in the Journal.`,
    confirm: "Stop series",
    danger: true,
  });
  if (ok) cancelWithUndo(task, { series: true });
}

function act(name, id, source) {
  if (name === "retry") {
    if (currentView === "jobs") void loadJobs();
    return void refresh();
  }
  if (name.startsWith("job-")) {
    const jobId = source?.closest?.("[data-job-id]")?.dataset.jobId;
    if (!jobId) return;
    if (name === "job-remove") return void removeJob(jobId);
    return void jobAction(name.slice(4), jobId);
  }
  if (name === "start-dispatcher") return void startDispatcher(source);
  if (name === "banner-dismiss") {
    bannerNote = null;
    return render();
  }
  if (name === "close") return closeDrawer();
  if (name === "detail-retry") return retryDetail();
  if (name === "reply-send") return void sendReply();
  if (name === "copy-resume") return void copyResume(source);
  if (!id) return;
  if (name === "expand") return toggleExpand(id);
  if (name === "open") return void (location.hash = taskHref(id));

  const task = taskFor(id);
  if (!task) return;
  if (task._op || cancelPending(id)) {
    toast("Still saving the last change to this task…");
    return;
  }
  const a = task.actions || {};
  const refuse = (what) => toast(`${what} is not available for a ${task.status} task.`);
  switch (name) {
    case "run-now":
      return a.runNow ? void runNow(task) : refuse("Run now");
    case "cancel":
      if (!a.cancel) return refuse("Cancel");
      keepFocusNear(id);
      return cancelWithUndo(task);
    case "stop-series":
      return a.stopSeries ? void stopSeries(task) : refuse("Stop series");
    case "reschedule":
      return a.reschedule ? reschedule(task) : refuse("Reschedule");
    case "later":
      return a.reschedule ? later(task) : refuse("Later");
    case "read":
      return a.markRead ? void setRead(task, true) : undefined;
    case "unread":
      return a.markRead ? void setRead(task, false) : undefined;
    case "toggle-read":
      return a.markRead ? void setRead(task, !task.read_at) : refuse("Read marker");
    case "reply-focus":
      if (!a.reply) return refuse("Reply");
      if (detailId() !== id) location.hash = taskHref(id);
      return void waitFor(() => focusReply());
    case "menu":
      return actionMenu(task, {
        open: () => (location.hash = taskHref(id)),
        runNow: () => act("run-now", id),
        later: () => act("later", id),
        reschedule: () => act("reschedule", id),
        cancel: () => act("cancel", id),
        stopSeries: () => act("stop-series", id),
        toggleRead: () => act("toggle-read", id),
      });
  }
}

/** When the focused row is about to leave the list, move focus to its neighbour. */
function keepFocusNear(id) {
  const rows = [...document.querySelectorAll("#view .row[data-task-id]")];
  const i = rows.findIndex((r) => r.dataset.taskId === id);
  if (i < 0 || document.activeElement !== rows[i]) return;
  const next = (rows[i + 1] || rows[i - 1])?.dataset.taskId;
  if (!next) return;
  setTimeout(() => document.querySelector(`#view .row[data-task-id="${CSS.escape(next)}"]`)?.focus({ preventScroll: true }), 0);
}

/** Retry `fn` for a short while until it returns true (drawer still loading). */
async function waitFor(fn, tries = 20) {
  for (let i = 0; i < tries; i++) {
    if (fn()) return;
    await new Promise((r) => setTimeout(r, 100));
  }
}

function onClick(e) {
  const target = e.target instanceof Element ? e.target : null;
  if (!target) return;
  const marker = target.closest("[data-select]");
  if (marker) return selectMarker(marker.dataset.select);
  const button = target.closest("[data-action]");
  if (button && !button.disabled) {
    if (button.tagName === "BUTTON" && button.type === "submit") return; // the form's submit handler runs
    e.preventDefault();
    const holder = button.closest("[data-task-id]");
    return act(button.dataset.action, holder?.dataset.taskId, button);
  }
  const row = target.closest("#view .row[data-task-id]");
  if (row && !target.closest("a, button, select, input")) location.hash = taskHref(row.dataset.taskId);
}

// ── boot ────────────────────────────────────────────────────────────────

function boot() {
  const link = parseFragment(location.hash);
  if (link) {
    setToken(link.token);
    // The token stays in memory only: drop it from the address bar and history.
    history.replaceState(null, "", `${location.pathname}#/${link.view}`);
  }
  if (!hasToken()) {
    state.expired = true;
    showExpired();
    return;
  }

  initDialog();
  subscribe(render);
  onTaskEvent((ids, jobs) => {
    invalidateJournal(ids);
    onDetailEvent(ids);
    // `jobs: true` names a job change; an empty list follows a reconnect.
    if (jobs || ids.length === 0) {
      if (jobsState.loaded || currentView === "jobs") void loadJobs();
      onHistoryEvent();
      void onJobFormEvent();
    } else if (ids.some((id) => findJob(OCCURRENCE.exec(id)?.[1] ?? ""))) {
      // An occurrence started, got its hour or ended: the job row does not
      // change, but its status line, Run now and its history do.
      if (jobsState.loaded) void loadJobs();
      onHistoryEvent();
    }
  });
  initDnd({
    findTask: taskFor,
    onMove: (task, start, bounds) => void moveToDay(task, start, bounds),
    onRunNow: (task) => void runNow(task),
    onEnd: () => {
      if (deferred) {
        deferred = false;
        render();
      }
    },
  });
  initKeys({
    current: () => detailId(),
    open: (id, opts) => {
      if (opts?.keepFocus) {
        history.replaceState(null, "", taskHref(id));
        void openDetail(id);
        render();
      } else location.hash = taskHref(id);
    },
    close: closeDrawer,
    drawerOpen: () => !!detailId() || jobDrawerOpen(),
    act: (name, id) => act(name, id),
    view: go,
    filters: () => {
      if (currentView !== "journal") go("journal");
      void waitFor(() => {
        const sel = document.getElementById("filter-status");
        sel?.focus();
        return !!sel;
      });
    },
    help: helpDialog,
  });

  document.getElementById("view").addEventListener("click", onClick);
  document.getElementById("drawer").addEventListener("click", onClick);
  document.getElementById("banner").addEventListener("click", onClick);
  document.getElementById("drawer").addEventListener("keydown", (e) => {
    trapFocus(e);
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && e.target.classList?.contains("reply-input")) {
      e.preventDefault();
      if (!e.repeat) void sendReply();
    }
  });
  document.getElementById("drawer").addEventListener("submit", (e) => {
    // The job form handles its own submit.
    if (e.target instanceof Element && e.target.classList.contains("job-form")) return;
    e.preventDefault();
    void sendReply();
  });
  document.getElementById("scrim").addEventListener("click", closeDrawer);
  document.getElementById("help-btn").addEventListener("click", helpDialog);
  void initClients();
  void initSettings();
  initUsage();
  document.getElementById("dispatcher-pill").addEventListener("click", dispatcherDialog);
  document.getElementById("view").addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") {
      const marker = e.target instanceof Element ? e.target.closest("[data-select]") : null;
      if (marker) {
        e.preventDefault();
        selectMarker(marker.dataset.select);
      }
    }
  });

  window.addEventListener("hashchange", onRoute);
  window.addEventListener("pagehide", flushDelayed);
  let resizeTimer = null;
  window.addEventListener("resize", () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => currentView === "timeline" && render(), 150);
  });
  // Relative times ("ran 2 min ago", overdue) and the dispatcher state age.
  setInterval(() => void refreshStatus(), 30_000);
  setInterval(() => notify(), 60_000);

  onRoute();
  void refresh();
  void stream();
}

boot();
