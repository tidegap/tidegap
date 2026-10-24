// A fake `tidegap ui` for the client tests: the client routes of
// docs/spec/ui-client-api.md over real HTTP on 127.0.0.1, with in-memory
// tasks. Not the real server: the CLI's own tests cover its rules.

import { createServer } from "node:http";

export const TOKEN = "tgc_fake";

export function laterOptions(available = true) {
  return [
    { preset: "1h", label: "One hour later", not_before: "2026-10-17T15:00:00.000Z", available },
    { preset: "tonight", label: "Tonight", not_before: "2026-10-17T22:00:00.000Z", available },
    { preset: "tomorrow_morning", label: "Tomorrow morning", not_before: "2026-10-18T09:00:00.000Z", available },
    { preset: "after_limit_reset", label: "After limit reset", not_before: null, available: false, reason: "needs the reset time" },
  ];
}

export function task(id, extra = {}) {
  return {
    task_id: id,
    title: id,
    display_title: id,
    status: "scheduled",
    scheduled_for: "2026-10-17T14:00:00.000Z",
    not_before: null,
    actions: { cancel: true, stopSeries: false, reschedule: true, runNow: true, later: true, reply: false, markRead: false },
    later_options: laterOptions(),
    ...extra,
  };
}

/** A `Job` as `GET /api/jobs` lists it for an extension caller (no edit, no remove). */
export function job(id, extra = {}) {
  return {
    job_id: id,
    title: id,
    status: "active",
    revision: 1,
    next_run: { task_id: `${id}~2`, status: "scheduled", earliest: "2026-10-17T22:00:00.000Z", deadline: "2026-10-18T06:00:00.000Z", scheduled_for: "2026-10-18T02:00:00.000Z" },
    last_run: { task_id: `${id}~1`, outcome: "ok", started_at: "2026-10-17T03:11:00.000Z", completed_at: "2026-10-17T03:12:00.000Z", preview: null },
    consecutive_failures: 0,
    pause_reason: null,
    actions: { edit: false, pause: true, resume: false, run_now: true, remove: false },
    ...extra,
  };
}

const PAUSED_ACTIONS = { edit: false, pause: false, resume: true, run_now: false, remove: false };
const ACTIVE_ACTIONS = { edit: false, pause: true, resume: false, run_now: true, remove: false };

/**
 * Starts the server on a free port. `readiness` and `limits` are the
 * summary's objects of those names (undefined: the field is left out).
 * `jobs` undefined plays a server older than the job routes: no `jobs`
 * summary counts and 404 on `/api/jobs*`.
 */
export async function startFakeServer({ tasks = [task("t1")], readiness, limits, jobs } = {}) {
  const state = {
    tasks: new Map(tasks.map((t) => [t.task_id, structuredClone(t)])),
    jobs: jobs === undefined ? null : new Map(jobs.map((j) => [j.job_id, structuredClone(j)])),
    requests: [],
    readiness,
    limits,
  };
  const send = (res, status, body) => {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  };
  const server = createServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const url = new URL(req.url, "http://127.0.0.1");
    state.requests.push({ method: req.method, path: url.pathname, search: url.search, auth: req.headers.authorization, type: req.headers["content-type"], body: raw });
    if (req.headers.authorization !== `Bearer ${TOKEN}`) return send(res, 401, { error: "unauthorized" });
    if (req.method === "GET" && url.pathname === "/api/summary") {
      const active = [...state.tasks.values()].filter((t) => t.status !== "cancelled").length;
      const body = { generated_at: "2026-10-17T10:00:00.000Z", region: "FR", active, unread: 0, clean_window: null, forecast_ok: true, cursor: "2026-10-17T10:00:00.000Z" };
      if (state.readiness !== undefined) body.readiness = state.readiness;
      if (state.limits !== undefined) body.limits = state.limits;
      if (state.jobs) {
        const all = [...state.jobs.values()];
        body.jobs = { active: all.filter((j) => j.status === "active").length, paused: all.filter((j) => j.status === "paused").length };
      }
      return send(res, 200, body);
    }
    if (url.pathname.startsWith("/api/jobs")) return jobRoute(req, res, url);
    if (req.method === "GET" && url.pathname === "/api/tasks") return send(res, 200, { last_tick_at: null, tasks: [...state.tasks.values()] });
    const m = /^\/api\/tasks\/([^/]+)\/(postpone|cancel|run-now)$/.exec(url.pathname);
    if (req.method !== "POST" || !m) return send(res, 404, { error: "not found" });
    const t = state.tasks.get(decodeURIComponent(m[1]));
    if (!t) return send(res, 404, { error: "task not found" });
    if (m[2] === "postpone") {
      const choice = JSON.parse(raw || "{}");
      const opt = t.later_options.find((o) => o.preset === choice.preset);
      if (!opt) return send(res, 400, { error: "preset must be one of 1h, tonight, tomorrow_morning, after_limit_reset" });
      if (!opt.available) return send(res, 409, { error: opt.reason });
      Object.assign(t, { not_before: opt.not_before, scheduled_for: opt.not_before });
    } else if (m[2] === "cancel") {
      Object.assign(t, { status: "cancelled", actions: { ...t.actions, cancel: false, runNow: false, later: false } });
    } else {
      if (!t.actions.runNow) return send(res, 409, { error: "task cannot run now" });
      Object.assign(t, { status: "queued", scheduled_for: "2026-10-17T10:00:00.000Z" });
    }
    return send(res, 200, t);
  });
  function jobRoute(req, res, url) {
    if (!state.jobs) return send(res, 404, { error: "not found" });
    if (req.method === "GET" && url.pathname === "/api/jobs") return send(res, 200, { jobs: [...state.jobs.values()] });
    const m = /^\/api\/jobs\/([^/]+)\/(pause|resume|run-now)$/.exec(url.pathname);
    if (req.method !== "POST" || !m) return send(res, 404, { error: "not found" });
    const j = state.jobs.get(decodeURIComponent(m[1]));
    if (!j) return send(res, 404, { error: "job not found" });
    if (m[2] === "pause") {
      if (j.status === "paused") return send(res, 409, { error: "job is already paused" });
      Object.assign(j, { status: "paused", pause_reason: "manual", next_run: null, actions: PAUSED_ACTIONS });
    } else if (m[2] === "resume") {
      if (j.status !== "paused") return send(res, 409, { error: "job is not paused" });
      Object.assign(j, { status: "active", pause_reason: null, consecutive_failures: 0, actions: ACTIVE_ACTIONS });
      j.next_run = { task_id: `${j.job_id}~9`, status: "queued", earliest: "2026-10-17T10:00:00.000Z", deadline: "2026-10-18T10:00:00.000Z", scheduled_for: null };
    } else {
      if (j.status === "paused") return send(res, 409, { error: "job is paused" });
      if (!j.actions.run_now) return send(res, 409, { error: "an occurrence is already running" });
      j.next_run = { ...j.next_run, status: "queued", scheduled_for: "2026-10-17T10:00:00.000Z" };
    }
    return send(res, 200, j);
  }
  await new Promise((ok) => server.listen(0, "127.0.0.1", ok));
  return {
    state,
    settings: { port: server.address().port, token: TOKEN },
    close: () => new Promise((ok) => server.close(ok)),
  };
}
