/**
 * JSON API handlers for `tidegap ui`. Reads go through the `TaskStore`. Writes
 * (ui v2) go through `ctx.scheduler`, a `Scheduler` built with NO adapters:
 * cancel, reschedule, run now and reply only write the ledger, with a
 * compare-and-set, and the dispatcher (`tidegap tick` or the OpenClaw loop)
 * runs the task. Nothing here dispatches a provider call. A refused action
 * returns 409 with the core's one-line rule, never a stack or a path.
 *
 * Task strings are untrusted (prompts and model output). They leave here as
 * JSON values; the page renders them with `textContent` only.
 */

import {
  CarbonBudgetExceededError,
  claudeCodeToolsError,
  DEFAULT_MODEL_BY_PROVIDER,
  deadlineKindLabel,
  InvalidDeadlineError,
  LAST_TICK_META_KEY,
  nextQuotaReset,
  resolveQuotaDeadline,
  resumeCommand,
  TaskActionError,
  taskActions,
  taskHistory,
  taskPrompt,
  taskResultText,
  type DeadlineKind,
  type GridFeed,
  type ProviderName,
  type QuotaResetConfig,
  type RescheduleTarget,
  type Scheduler,
  type TaskRecord,
  type TaskStatus,
  type TaskStore,
} from "@tidegap/core";

import {
  rawPayload,
  sortSeries,
  taskSummary,
  VALID_KINDS,
  VALID_STATUSES,
  withoutRaw,
} from "../commands/queue.js";
import type { DaemonStatus } from "../platform/index.js";
import { CLIENT_KINDS, ClientRegistryError, cleanClientName, isClientKind, type ClientRegistry } from "./clients.js";
import { buildSummary, type ForecastPoint } from "./summary.js";
import type { DispatcherControl } from "./dispatcher.js";

export interface ApiContext {
  store: TaskStore;
  dbPath: string;
  feed: GridFeed;
  defaultRegion: string;
  /** Read per request so a config edit shows without a restart. */
  quota: () => QuotaResetConfig;
  daemonStatus: () => DaemonStatus;
  now?: () => Date;
  /** Write path (ui v2): a Scheduler with no adapters. Absent = read-only. */
  scheduler?: Scheduler;
  /** Start dispatcher and dispatcher state (ui v2). */
  dispatcher?: DispatcherControl;
  /** Anthropic model for quick add without one (`TIDEGAP_DEFAULT_MODEL`). */
  defaultModel?: string;
  /** Client token registry (native clients); absent = no `/api/clients` routes. */
  clients?: ClientRegistry;
}

/** Longest reply text, in characters. */
export const REPLY_MAX_CHARS = 32_000;

/**
 * How each POST route treats its body (KTD9). `json`: the route reads a
 * JSON object (Content-Type application/json required). `none`: no body.
 */
export function postBodyKind(pathname: string): "json" | "none" | undefined {
  const route = pathname.split("/").filter(Boolean).slice(1);
  if (route.length === 2 && route[0] === "dispatcher" && route[1] === "start") return "none";
  if (route.length === 1 && route[0] === "tasks") return "json";
  if (route.length === 1 && route[0] === "clients") return "json";
  if (route.length === 3 && route[0] === "clients" && route[2] === "revoke") return "none";
  if (route.length !== 3 || route[0] !== "tasks") return undefined;
  if (route[2] === "cancel" || route[2] === "reschedule" || route[2] === "reply") return "json";
  if (route[2] === "read" || route[2] === "unread" || route[2] === "run-now") return "none";
  return undefined;
}

export interface ApiResponse {
  status: number;
  body?: unknown;
  /** Task ids this request changed; the server pushes them to the stream. */
  changedIds?: string[];
}

/** Most hours of forecast one request returns. */
export const MAX_FORECAST_HOURS = 72;

/**
 * How long one forecast answer is reused. The page asks on every change
 * event; without a cache each one would spend the grid provider's quota,
 * which the tick needs for scheduling.
 */
export const FORECAST_CACHE_MS = 10 * 60_000;

const forecastCache = new WeakMap<ApiContext, Map<string, { at: number; body: unknown }>>();

const REGION_RE = /^[A-Za-z0-9_-]{1,64}$/;

function error(status: number, message: string): ApiResponse {
  return { status, body: { error: message } };
}

function listSummary(r: TaskRecord<unknown>): Record<string, unknown> {
  return {
    ...taskSummary(r),
    parent_task_id: r.parentTaskId ?? null,
    estimated_carbon_g: r.estimatedCarbonGCo2 ?? null,
    // What the task cost (receipt) or is expected to cost (schedule time).
    carbon_g: r.receipt?.actualCarbonGCo2 ?? r.estimatedCarbonGCo2 ?? null,
    intensity_g_per_kwh: r.receipt?.intensityGCo2PerKwh ?? null,
    actions: taskActions(r),
  };
}

const MAX_LIST_LIMIT = 1000;

function listTasks(ctx: ApiContext, params: URLSearchParams): ApiResponse {
  const statuses = (params.get("status") ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  for (const s of statuses) {
    if (!VALID_STATUSES.has(s as TaskStatus)) return error(400, `unknown status ${s}`);
  }
  const kind = params.get("kind") ?? undefined;
  if (kind !== undefined && !VALID_KINDS.has(kind as DeadlineKind)) {
    return error(400, `unknown kind ${kind}`);
  }
  const unread = params.get("unread") === "1" || params.get("unread") === "true";
  const series = params.get("series") ?? undefined;
  const rawLimit = params.get("limit");
  const limit = rawLimit === null ? undefined : Number(rawLimit);
  if (limit !== undefined && (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIST_LIMIT)) {
    return error(400, `limit must be an integer from 1 to ${MAX_LIST_LIMIT}`);
  }
  const base = {
    ...(kind ? { deadlineKind: kind as DeadlineKind } : {}),
    ...(unread ? { unread: true } : {}),
    ...(series ? { seriesId: series } : {}),
  };
  let rows =
    statuses.length === 0
      ? ctx.store.list(base)
      : statuses.flatMap((status) => ctx.store.list({ ...base, status: status as TaskStatus }));
  if (series) rows = sortSeries(rows);
  // `limit` keeps the newest rows by enqueue time; the order stays as listed.
  if (limit !== undefined && rows.length > limit) {
    const keep = new Set(
      [...rows]
        .sort((a, b) => b.enqueuedAt.localeCompare(a.enqueuedAt))
        .slice(0, limit)
        .map((r) => r.taskId),
    );
    rows = rows.filter((r) => keep.has(r.taskId));
  }
  return {
    status: 200,
    body: {
      last_tick_at: ctx.store.getMeta(LAST_TICK_META_KEY) ?? null,
      tasks: rows.map(listSummary),
    },
  };
}

function taskDetail(ctx: ApiContext, taskId: string): ApiResponse {
  const r = ctx.store.get(taskId);
  if (!r) return error(404, "task not found");
  const quota = ctx.quota();
  const schedule = r.deadlineKind === "quota_reset" ? quota[r.quotaProvider ?? ""] : undefined;
  return {
    status: 200,
    body: {
      ...listSummary(r),
      enqueued_at: r.enqueuedAt,
      origin_cwd: r.originCwd ?? null,
      origin_session_id: r.originSessionId ?? null,
      resume_command: resumeCommand(r) ?? null,
      parent: parentSummary(ctx, r),
      children: ctx.store
        .list()
        .filter((c) => c.parentTaskId === r.taskId)
        .map(listSummary),
      series: r.seriesId ? seriesInfo(ctx, r.seriesId) : null,
      deadline_label: deadlineKindLabel(r, quota),
      quota_margin_h: schedule?.marginH ?? null,
      prompt: taskPrompt(r) ?? null,
      history: taskHistory(r),
      result_text: taskResultText(r) ?? null,
      result: withoutRaw(r.result) ?? null,
      error: r.error ?? null,
      receipt: r.receipt ?? null,
      routing: r.receipt?.routing ?? r.routingDecision ?? null,
      raw: rawPayload(r) ?? null,
    },
  };
}

function parentSummary(ctx: ApiContext, r: TaskRecord<unknown>): Record<string, unknown> | null {
  if (!r.parentTaskId) return null;
  const p = ctx.store.get(r.parentTaskId);
  return p ? listSummary(p) : { task_id: r.parentTaskId, missing: true };
}

const DAY_MS = 86_400_000;

/**
 * Up to `count` deadlines after `fromMs` for a series rule: whole periods
 * for daily/weekly; the label's next resets minus margin for quota_reset
 * (+7 days without a config). Empty for an ended series.
 */
function projectDeadlines(
  rule: string,
  fromMs: number,
  label: string | undefined,
  quota: QuotaResetConfig,
  count: number,
): string[] {
  const out: string[] = [];
  const schedule = rule === "quota_reset" && label ? quota[label] : undefined;
  let t = fromMs;
  for (let i = 0; i < count; i++) {
    if (rule === "daily") t += DAY_MS;
    else if (rule === "weekly") t += 7 * DAY_MS;
    else if (rule === "quota_reset") {
      t = schedule ? resolveQuotaDeadline(schedule, new Date(t + 60_000)).deadline.getTime() : t + 7 * DAY_MS;
    } else break;
    out.push(new Date(t).toISOString());
  }
  return out;
}

function seriesInfo(ctx: ApiContext, seriesId: string): Record<string, unknown> | null {
  const rows = sortSeries(ctx.store.list({ seriesId }));
  if (rows.length === 0) return null;
  const last = rows[rows.length - 1]!;
  const rule = last.repeat ?? "none";
  const label = [...rows].reverse().find((r) => r.quotaProvider)?.quotaProvider;
  const lastDeadline = last.deadline ? Date.parse(last.deadline) : Number.NaN;
  return {
    series_id: seriesId,
    repeat: rule,
    ended: rule === "none",
    occurrences: rows.length,
    next_deadlines: Number.isFinite(lastDeadline)
      ? projectDeadlines(rule, lastDeadline, label, ctx.quota(), 8)
      : [],
  };
}

function seriesDetail(ctx: ApiContext, seriesId: string): ApiResponse {
  const info = seriesInfo(ctx, seriesId);
  if (!info) return error(404, "series not found");
  return {
    status: 200,
    body: {
      ...info,
      occurrences: sortSeries(ctx.store.list({ seriesId })).map(listSummary),
    },
  };
}

// ── Write actions (ui v2) ─────────────────────────────────────────────────

type Body = Record<string, unknown>;

function onlyKeys(body: Body, allowed: readonly string[]): string | undefined {
  const extra = Object.keys(body).filter((k) => !allowed.includes(k));
  return extra.length > 0 ? `unknown field ${extra[0]}` : undefined;
}

/** An ISO instant from the body, or the 400 message when it is not one. */
function instant(value: unknown, name: string): Date | string {
  if (typeof value !== "string" || value.length === 0 || value.length > 64) {
    return `${name} must be an ISO-8601 string`;
  }
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? `${name} is not an ISO-8601 instant` : d;
}

/**
 * Run one write through the action scheduler: 404 for an unknown task,
 * 409 with the core's rule when the task's state or input refuses it, 500
 * with a generic body for any other error.
 */
async function act(
  ctx: ApiContext,
  taskId: string,
  run: (s: Scheduler) => Promise<TaskRecord<unknown>> | TaskRecord<unknown>,
  status = 200,
): Promise<ApiResponse> {
  if (!ctx.scheduler) return error(405, "this server is read-only");
  if (!ctx.store.get(taskId)) return error(404, "task not found");
  let out: TaskRecord<unknown>;
  try {
    out = await run(ctx.scheduler);
  } catch (err) {
    // Only a refusal carries a rule safe to show; anything else is internal
    // and gets a generic body (no exception text, no path).
    if (err instanceof TaskActionError || err instanceof InvalidDeadlineError) {
      return error(409, oneLine(err));
    }
    return error(500, "action failed");
  }
  const fresh = ctx.store.get(out.taskId) ?? out;
  const changed = out.taskId === taskId ? [taskId] : [taskId, out.taskId];
  return { status, body: listSummary(fresh), changedIds: changed };
}

/** The core's message on one line, without anything after a newline. */
function oneLine(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  return msg.split("\n")[0]!.slice(0, 300);
}

function cancelAction(ctx: ApiContext, taskId: string, body: Body): Promise<ApiResponse> | ApiResponse {
  const bad = onlyKeys(body, ["series"]);
  if (bad) return error(400, bad);
  if (body.series !== undefined && typeof body.series !== "boolean") {
    return error(400, "series must be a boolean");
  }
  return act(ctx, taskId, (s) => {
    // The core cancel is idempotent; the API reports a finished task as a
    // refused action (409), so a second click says what happened.
    const current = ctx.store.get(taskId)!;
    if (!taskActions(current).cancel) {
      throw new TaskActionError(`cancel: task ${taskId} is ${current.status}; only pending tasks can be cancelled`);
    }
    return s.cancelTask(taskId, { series: body.series === true });
  });
}

function rescheduleAction(ctx: ApiContext, taskId: string, body: Body): Promise<ApiResponse> | ApiResponse {
  const bad = onlyKeys(body, ["deadline", "at", "day_start", "day_end"]);
  if (bad) return error(400, bad);
  const has = (k: string) => body[k] !== undefined;
  const shapes = [has("deadline"), has("at"), has("day_start") || has("day_end")].filter(Boolean);
  if (shapes.length !== 1) {
    return error(400, "pass exactly one of {deadline}, {at} or {day_start, day_end}");
  }
  const now = (ctx.now?.() ?? new Date()).getTime();
  let target: RescheduleTarget;
  if (has("deadline") || has("at")) {
    const key = has("deadline") ? "deadline" : "at";
    const d = instant(body[key], key);
    if (typeof d === "string") return error(400, d);
    if (d.getTime() < now - 5_000) return error(400, `${key} is in the past`);
    target = key === "deadline" ? { deadline: d } : { at: d };
  } else {
    const start = instant(body.day_start, "day_start");
    if (typeof start === "string") return error(400, start);
    const end = instant(body.day_end, "day_end");
    if (typeof end === "string") return error(400, end);
    const span = end.getTime() - start.getTime();
    if (span < 3_600_000 || span > 25 * 3_600_000) return error(400, "a day must span 1 to 25 hours");
    if (end.getTime() < now) return error(400, "day_end is in the past");
    target = { dayStart: start, dayEnd: end };
  }
  return act(ctx, taskId, (s) => s.rescheduleTask(taskId, target));
}

function replyAction(ctx: ApiContext, taskId: string, body: Body): Promise<ApiResponse> | ApiResponse {
  const bad = onlyKeys(body, ["text", "deadline"]);
  if (bad) return error(400, bad);
  if (typeof body.text !== "string" || body.text.trim().length === 0 || body.text.length > REPLY_MAX_CHARS) {
    return error(400, `text must be 1 to ${REPLY_MAX_CHARS} characters`);
  }
  let deadline: Date | undefined;
  if (body.deadline !== undefined) {
    const d = instant(body.deadline, "deadline");
    if (typeof d === "string") return error(400, d);
    deadline = d;
  }
  const text = body.text;
  return act(
    ctx,
    taskId,
    (s) => s.replyToTask(taskId, text, deadline ? { deadline } : {}),
    201,
  );
}

/** Longest quick-add title and model id, in characters. */
export const QUICK_ADD_TITLE_MAX = 200;
const QUICK_ADD_PROVIDERS: readonly ProviderName[] = ["anthropic", "openai", "gemini", "ollama", "claude-code"];
const DAY_DEFAULT_MS = 24 * 3_600_000;

/**
 * `POST /api/tasks` (native clients KTD7): queue a provider call from a
 * prompt. It goes through the adapter-less scheduler, so it is scheduled,
 * never dispatched; the tick runs it.
 */
async function quickAdd(ctx: ApiContext, body: Body): Promise<ApiResponse> {
  if (!ctx.scheduler) return error(404, "not found");
  const bad = onlyKeys(body, ["prompt", "deadline", "title", "provider", "model", "tools"]);
  if (bad) return error(400, bad);
  if (typeof body.prompt !== "string" || body.prompt.trim().length === 0 || body.prompt.length > REPLY_MAX_CHARS) {
    return error(400, `prompt must be 1 to ${REPLY_MAX_CHARS} characters`);
  }
  const now = (ctx.now?.() ?? new Date()).getTime();
  let deadline = new Date(now + DAY_DEFAULT_MS);
  if (body.deadline !== undefined) {
    const d = instant(body.deadline, "deadline");
    if (typeof d === "string") return error(400, d);
    if (d.getTime() <= now) return error(400, "deadline is in the past");
    deadline = d;
  }
  if (body.title !== undefined && (typeof body.title !== "string" || body.title.length > QUICK_ADD_TITLE_MAX)) {
    return error(400, `title must be a string of at most ${QUICK_ADD_TITLE_MAX} characters`);
  }
  const provider = body.provider ?? "anthropic";
  if (!QUICK_ADD_PROVIDERS.includes(provider as ProviderName)) {
    return error(400, `provider must be one of ${QUICK_ADD_PROVIDERS.join(", ")}`);
  }
  if (body.model !== undefined && (typeof body.model !== "string" || body.model.length === 0 || body.model.length > QUICK_ADD_TITLE_MAX)) {
    return error(400, `model must be 1 to ${QUICK_ADD_TITLE_MAX} characters`);
  }
  const toolsError = body.tools !== undefined ? claudeCodeToolsError(body.tools) : undefined;
  if (toolsError) return error(400, toolsError);
  // Same default as the MCP server: TIDEGAP_DEFAULT_MODEL is an Anthropic
  // override only, so a task never carries another vendor's model id.
  const model =
    (body.model as string | undefined) ??
    (provider === "anthropic" ? ctx.defaultModel ?? DEFAULT_MODEL_BY_PROVIDER.anthropic : DEFAULT_MODEL_BY_PROVIDER[provider as ProviderName]);
  let rec: TaskRecord<unknown>;
  try {
    rec = await ctx.scheduler.enqueueProviderCall(
      {
        type: "provider_call",
        provider: provider as ProviderName,
        model,
        prompt: body.prompt,
        ...(body.tools !== undefined ? { tools: body.tools as string[] } : {}),
      },
      { deadline, ...(typeof body.title === "string" && body.title.trim() ? { title: body.title.trim() } : {}) },
    );
  } catch (err) {
    if (err instanceof InvalidDeadlineError || err instanceof CarbonBudgetExceededError) return error(409, oneLine(err));
    return error(500, "could not queue the task");
  }
  const fresh = ctx.store.get(rec.taskId) ?? rec;
  return { status: 201, body: listSummary(fresh), changedIds: [rec.taskId] };
}

function startDispatcher(ctx: ApiContext): ApiResponse {
  if (!ctx.dispatcher) return error(404, "not found");
  try {
    const res = ctx.dispatcher.start();
    if (!res.ok && res.reason === "ui_child") {
      return { status: 409, body: { error: "a dispatcher started from this page is running", ...res.meta } };
    }
    if (!res.ok) {
      return {
        status: 409,
        body: { error: "a dispatcher is already ticking this ledger", last_tick_at: res.last_tick_at },
      };
    }
    return { status: 201, body: res.meta };
  } catch {
    // The spawn error can name paths; the page needs only the fact.
    return error(500, "could not start the dispatcher");
  }
}

function setRead(ctx: ApiContext, taskId: string, read: boolean): ApiResponse {
  const r = ctx.store.get(taskId);
  if (!r) return error(404, "task not found");
  if (r.status !== "completed" && r.status !== "failed") {
    return error(409, "only a completed or failed task has a read marker");
  }
  if (read) ctx.store.markRead(taskId, ctx.now?.() ?? new Date());
  else ctx.store.markUnread(taskId);
  return { status: 204, changedIds: [taskId] };
}

interface ForecastBody {
  region: string;
  source: string;
  generated_at: string;
  points: ForecastPoint[];
}

/**
 * One forecast per region and hour count, reused for FORECAST_CACHE_MS by
 * `/api/forecast` and `/api/summary` alike. Throws when the feed fails.
 */
async function cachedForecast(ctx: ApiContext, region: string, hours: number): Promise<ForecastBody> {
  const now = (ctx.now?.() ?? new Date()).getTime();
  let cache = forecastCache.get(ctx);
  if (!cache) forecastCache.set(ctx, (cache = new Map()));
  const key = `${region}|${hours}`;
  const hit = cache.get(key);
  if (hit && now - hit.at < FORECAST_CACHE_MS) return hit.body as ForecastBody;
  const f = await ctx.feed.fetchForecast(region, hours);
  for (const [k, v] of cache) if (now - v.at >= FORECAST_CACHE_MS) cache.delete(k);
  const body: ForecastBody = {
    region: f.region,
    source: f.source,
    generated_at: f.generatedAt,
    points: f.entries.slice(0, hours).map((e) => ({
      t: e.datetime,
      g: e.carbonIntensityGCo2PerKwh,
      band: e.band,
    })),
  };
  cache.set(key, { at: now, body });
  return body;
}

async function forecast(ctx: ApiContext, params: URLSearchParams): Promise<ApiResponse> {
  const region = params.get("region") || ctx.defaultRegion;
  if (!REGION_RE.test(region)) return error(400, "invalid region");
  const rawHours = Number(params.get("hours") ?? 24);
  const hours = Math.min(MAX_FORECAST_HOURS, Math.max(1, Number.isFinite(rawHours) ? Math.ceil(rawHours) : 24));
  try {
    return { status: 200, body: await cachedForecast(ctx, region, hours) };
  } catch {
    // The provider error can name a URL or key; the page needs only the fact.
    return error(502, "forecast unavailable");
  }
}

/** `GET /api/summary[?since=<iso>]` (native clients KTD5). */
async function summary(ctx: ApiContext, params: URLSearchParams): Promise<ApiResponse> {
  let since: Date | undefined;
  const rawSince = params.get("since");
  if (rawSince !== null) {
    const d = instant(rawSince, "since");
    if (typeof d === "string") return error(400, d);
    since = d;
  }
  let points: ForecastPoint[] | null;
  try {
    points = (await cachedForecast(ctx, ctx.defaultRegion, 24)).points;
  } catch {
    // A feed failure is a field in the answer, never a 5xx.
    points = null;
  }
  const now = ctx.now?.() ?? new Date();
  return {
    status: 200,
    body: buildSummary({ store: ctx.store, region: ctx.defaultRegion, now, points, ...(since ? { since } : {}) }),
  };
}

function status(ctx: ApiContext): ApiResponse {
  const now = ctx.now?.() ?? new Date();
  const quota = ctx.quota();
  return {
    status: 200,
    body: {
      daemon: ctx.daemonStatus(),
      db_path: ctx.dbPath,
      default_region: ctx.defaultRegion,
      last_tick_at: ctx.store.getMeta(LAST_TICK_META_KEY) ?? null,
      dispatcher: ctx.dispatcher?.state() ?? null,
      quota: Object.entries(quota).map(([label, s]) => ({
        label,
        next_reset: nextQuotaReset(s, now).toISOString(),
        margin_h: s.marginH,
      })),
    },
  };
}

// ── Connected apps (native clients, page token only) ─────────────────────

function clientsList(ctx: ApiContext): ApiResponse {
  if (!ctx.clients) return error(404, "not found");
  try {
    return { status: 200, body: { clients: ctx.clients.list() } };
  } catch {
    // Fixed body: a registry error names the file path. The CLI shows it.
    return error(500, "client registry unavailable");
  }
}

function clientsAdd(ctx: ApiContext, body: Body): ApiResponse {
  if (!ctx.clients) return error(404, "not found");
  const bad = onlyKeys(body, ["name", "kind"]);
  if (bad) return error(400, bad);
  // Input errors are 400 with their rule; a registry failure is a fixed 500.
  const name = cleanClientName(body.name);
  if (name instanceof ClientRegistryError) return error(400, name.message);
  const kind = body.kind ?? "extension";
  if (!isClientKind(kind)) return error(400, `kind must be one of ${CLIENT_KINDS.join(", ")}`);
  try {
    const { client, token } = ctx.clients.add({ name, kind }, ctx.now?.());
    return { status: 201, body: { client, token } };
  } catch {
    return error(500, "could not add the client");
  }
}

function clientsRevoke(ctx: ApiContext, id: string): ApiResponse {
  if (!ctx.clients) return error(404, "not found");
  try {
    return ctx.clients.revoke(id) ? { status: 200, body: { revoked: id } } : error(404, "client not found");
  } catch {
    return error(500, "could not revoke the client");
  }
}

/**
 * Route one authenticated `/api/*` request (SSE is handled by the server).
 * Returns 404 for an unknown path and 405 for a wrong method.
 */
export async function handleApi(
  ctx: ApiContext,
  method: string,
  pathname: string,
  params: URLSearchParams,
  /** Parsed JSON object of a body route (the server checked type and size). */
  body: Body = {},
): Promise<ApiResponse> {
  const parts = pathname.split("/").filter(Boolean); // ["api", ...]
  const route = parts.slice(1);
  const get = method === "GET";
  if (route.length === 1 && route[0] === "tasks") {
    return get ? listTasks(ctx, params) : method === "POST" ? quickAdd(ctx, body) : error(405, "method not allowed");
  }
  if (route.length === 1 && route[0] === "forecast") return get ? forecast(ctx, params) : error(405, "method not allowed");
  if (route.length === 1 && route[0] === "status") return get ? status(ctx) : error(405, "method not allowed");
  if (route.length === 1 && route[0] === "summary") return get ? summary(ctx, params) : error(405, "method not allowed");
  if (route.length === 2 && route[0] === "dispatcher" && route[1] === "start") {
    return method === "POST" ? startDispatcher(ctx) : error(405, "method not allowed");
  }
  if (route.length === 1 && route[0] === "clients") {
    return get ? clientsList(ctx) : method === "POST" ? clientsAdd(ctx, body) : error(405, "method not allowed");
  }
  if (route.length === 3 && route[0] === "clients" && route[2] === "revoke") {
    if (method !== "POST") return error(405, "method not allowed");
    let id: string;
    try {
      id = decodeURIComponent(route[1]!);
    } catch {
      return error(400, "bad client id");
    }
    return clientsRevoke(ctx, id);
  }
  if (route.length === 2 && route[0] === "series") {
    if (!get) return error(405, "method not allowed");
    let seriesId: string;
    try {
      seriesId = decodeURIComponent(route[1]!);
    } catch {
      return error(400, "bad series id");
    }
    return seriesDetail(ctx, seriesId);
  }
  if (route[0] === "tasks" && route.length >= 2) {
    let taskId: string;
    try {
      taskId = decodeURIComponent(route[1]!);
    } catch {
      return error(400, "bad task id");
    }
    if (route.length === 2) return get ? taskDetail(ctx, taskId) : error(405, "method not allowed");
    if (route.length === 3 && (route[2] === "read" || route[2] === "unread")) {
      return method === "POST" ? setRead(ctx, taskId, route[2] === "read") : error(405, "method not allowed");
    }
    if (route.length === 3) {
      const post = method === "POST";
      switch (route[2]) {
        case "cancel":
          return post ? cancelAction(ctx, taskId, body) : error(405, "method not allowed");
        case "reschedule":
          return post ? rescheduleAction(ctx, taskId, body) : error(405, "method not allowed");
        case "reply":
          return post ? replyAction(ctx, taskId, body) : error(405, "method not allowed");
        case "run-now":
          return post ? act(ctx, taskId, (s) => s.runNow(taskId)) : error(405, "method not allowed");
      }
    }
  }
  return error(404, "not found");
}
