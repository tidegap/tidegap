/**
 * Job routes of `tidegap ui` (jobs U7, KTD13): the scope matrix (the page
 * and a `macos` token author jobs, an extension never does), the body
 * rules, `actions` per caller, secrets by name only, history paging, the
 * summary fields and the change stream.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { mockGridFeed, pauseJob, Scheduler, TaskStore } from "@tidegap/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { listJobSecretNames, setJobSecret } from "../src/jobs/secrets.js";
import { ClientRegistry } from "../src/ui/clients.js";
import { JOB_PREVIEWS_PER_MINUTE, JOB_WRITES_PER_MINUTE } from "../src/ui/jobs-api.js";
import { startUiServer, type UiServer } from "../src/ui/server.js";

const PAGE = "page-token-jobs-0123456789";
const EXT_ORIGIN = "chrome-extension://abcdefghijklmnop";
const SECRET = "imap-fixture-Q7f3kLm9";

let dir: string;
let ui: UiServer;
let mac: string;
let ext: string;
let secretsFile: string;
/** Raw response texts: none may hold the secret value. */
let texts: string[];

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "tidegap-ui-jobs-"));
  secretsFile = join(dir, "job-secrets.json");
  texts = [];
  const registry = new ClientRegistry(dir);
  mac = registry.add({ name: "Mac", kind: "macos" }).token;
  ext = registry.add({ name: "Chrome", kind: "extension" }).token;
  ui = await startUiServer({
    token: PAGE,
    dbPath: join(dir, "queue.db"),
    stateDir: dir,
    assetDir: dir,
    feed: mockGridFeed(),
    defaultRegion: "FR",
    quota: () => ({}),
    daemonStatus: () => "unknown",
    pollMs: 50,
    jobSecretNames: () => listJobSecretNames(secretsFile),
  });
});
afterEach(async () => {
  for (const t of texts) expect(t).not.toContain(SECRET);
  await ui.close();
  rmSync(dir, { recursive: true, force: true });
});

interface Call {
  token?: string;
  origin?: string;
  json?: unknown;
  type?: string;
  method?: string;
}
async function api(path: string, call: Call = {}): Promise<{ status: number; body: Record<string, any> }> {
  const headers: Record<string, string> = { authorization: `Bearer ${call.token ?? PAGE}` };
  if (call.origin) headers.origin = call.origin;
  let body: string | undefined;
  if (call.json !== undefined) {
    headers["content-type"] = call.type ?? "application/json";
    body = JSON.stringify(call.json);
  }
  const res = await fetch(`${ui.url}${path.replace(/^\//, "")}`, { method: call.method ?? (body === undefined ? "GET" : "POST"), headers, body });
  const text = await res.text();
  texts.push(text);
  return { status: res.status, body: text ? (JSON.parse(text) as Record<string, any>) : {} };
}
const post = (path: string, json?: unknown, call: Call = {}) => api(path, { method: "POST", ...(json === undefined ? {} : { json }), ...call });

const PROMPT_JOB = { title: "Mail triage", cadence: { kind: "daily" }, window: { start: "00:00", end: "08:00" }, time_zone: "Europe/Berlin", runner: "prompt", prompt: "check mail" };
const COMMAND_JOB = { title: "Logs", cadence: { kind: "hours", every: 6 }, runner: "command", command: "echo x", prompt: "say what broke", secrets: ["IMAP_PASSWORD"], caps: { command_timeout_s: 60 } };

async function created(job: unknown = PROMPT_JOB): Promise<Record<string, any>> {
  const res = await post("/api/jobs", job);
  expect(res.status).toBe(201);
  return res.body;
}

describe("job routes: create, read, change", () => {
  it("POST /api/jobs creates a job with its guarantee and first run; GET lists and shows it", async () => {
    const job = await created();
    expect(job).toMatchObject({
      title: "Mail triage",
      status: "active",
      revision: expect.any(Number),
      guarantee: "runs every day between 00:00 and 08:00",
      runner: "prompt",
      provider: "claude-code",
      tools: "none",
      cwd: "~",
      notify: "every_run",
      origin_host: "page",
      caps: { command_timeout_s: 300, llm_timeout_s: 600, max_budget_usd: 1, output_cap_bytes: 10485760 },
      actions: { edit: true, pause: true, resume: false, run_now: true, remove: true },
    });
    expect(job.next_run.task_id).toBe(`${job.job_id}~1`);
    const list = await api("/api/jobs");
    expect(list.body.jobs.map((j: { job_id: string }) => j.job_id)).toEqual([job.job_id]);
    const detail = await api(`/api/jobs/${job.job_id}`);
    expect(detail.body.recent).toHaveLength(1);
    expect(detail.body.recent[0]).toMatchObject({ task_id: `${job.job_id}~1`, receipt_id: null, preview: null });
    expect((await api("/api/jobs/job-00000000")).status).toBe(404);
  });

  it("a command job: the summarize prompt shows as prompt, caps in seconds, missing_secrets names an unset secret", async () => {
    const job = await created(COMMAND_JOB);
    expect(job).toMatchObject({ runner: "command", command: "echo x", prompt: "say what broke", secrets: ["IMAP_PASSWORD"], missing_secrets: ["IMAP_PASSWORD"] });
    expect(job.caps.command_timeout_s).toBe(60);
    setJobSecret("IMAP_PASSWORD", SECRET, secretsFile);
    expect((await api(`/api/jobs/${job.job_id}`)).body.missing_secrets).toEqual([]);
    expect((await api("/api/jobs/secrets")).body).toEqual({ names: ["IMAP_PASSWORD"] });
  });

  it("update needs the current revision: a stale one gets 409; a partial body changes only its fields", async () => {
    const job = await created();
    const stale = await post(`/api/jobs/${job.job_id}/update`, { revision: job.revision - 1, title: "x" });
    expect(stale.status).toBe(409);
    expect(stale.body).toMatchObject({ code: "stale_revision", error: expect.stringMatching(/^job changed meanwhile \(revision \d+\)/) });
    const ok = await post(`/api/jobs/${job.job_id}/update`, { revision: job.revision, title: "Mail", window: null, notify: "failures" });
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ title: "Mail", window: null, notify: "failures", prompt: "check mail", guarantee: "runs at least every 24 h, never sooner than 12 h after the last run" });
    expect(ok.body.revision).toBeGreaterThan(job.revision);
    expect((await post(`/api/jobs/${job.job_id}/update`, { title: "x" })).status).toBe(400);
  });

  it("pause, run now on a paused job (409), resume, run now, remove; the core's sentences come back", async () => {
    const job = await created();
    expect((await post(`/api/jobs/${job.job_id}/pause`)).body).toMatchObject({ status: "paused", pause_reason: "manual", actions: { resume: true, pause: false } });
    expect(await post(`/api/jobs/${job.job_id}/run-now`)).toEqual({ status: 409, body: { error: "job is paused" } });
    expect((await post(`/api/jobs/${job.job_id}/resume`)).body.status).toBe("active");
    const run = await post(`/api/jobs/${job.job_id}/run-now`);
    expect(run.status).toBe(200);
    expect(run.body.next_run.task_id).toMatch(new RegExp(`^${job.job_id}~`));
    expect(await post(`/api/jobs/${job.job_id}/remove`)).toEqual({ status: 200, body: { job_id: job.job_id, status: "removed" } });
    expect((await api("/api/jobs")).body.jobs).toEqual([]);
    expect((await api("/api/jobs?status=removed")).body.jobs).toHaveLength(1);
    expect((await api("/api/jobs?status=gone")).status).toBe(400);
  });

  it("history pages with before; next_before is null at the end", async () => {
    const job = await created();
    const store = new TaskStore({ dbPath: join(dir, "queue.db") });
    for (let i = 2; i <= 3; i++) {
      store.upsert({ taskId: `${job.job_id}~${i}`, status: "cancelled", enqueuedAt: new Date(Date.now() + i * 1000).toISOString(), region: "FR", jobId: job.job_id } as never);
    }
    store.close();
    const first = await api(`/api/jobs/${job.job_id}/history?limit=2`);
    expect(first.body.runs.map((r: { task_id: string }) => r.task_id)).toEqual([`${job.job_id}~3`, `${job.job_id}~2`]);
    expect(first.body.next_before).toBe(`${job.job_id}~2`);
    const second = await api(`/api/jobs/${job.job_id}/history?limit=2&before=${first.body.next_before}`);
    expect(second.body).toEqual({ runs: [expect.objectContaining({ task_id: `${job.job_id}~1` })], next_before: null });
    expect((await api(`/api/jobs/${job.job_id}/history?limit=0`)).status).toBe(400);
    expect((await api(`/api/jobs/${job.job_id}/history?before=nope`)).status).toBe(400);
  });

  it("preview answers the guarantee and the first run without writing", async () => {
    const res = await post("/api/jobs/preview", { cadence: { kind: "daily" }, window: { start: "22:00", end: "06:00" }, time_zone: "Europe/Paris" });
    expect(res.status).toBe(200);
    expect(res.body.guarantee).toBe("runs every day between 22:00 and 06:00");
    expect(Object.keys(res.body.first_run).sort()).toEqual(["deadline", "earliest", "intensity_g_per_kwh", "planned_at"]);
    expect((await api("/api/jobs")).body.jobs).toEqual([]);
    expect((await post("/api/jobs/preview", { cadence: { kind: "hours", every: 1 } })).status).toBe(400);
  });

  it("task items carry job_id and job_title; /api/summary has job counts and the next job run", async () => {
    const job = await created();
    const second = await created({ ...PROMPT_JOB, title: "Other" });
    await post(`/api/jobs/${second.job_id}/pause`);
    const tasks = await api("/api/tasks");
    expect(tasks.body.tasks.find((t: { task_id: string }) => t.task_id === `${job.job_id}~1`)).toMatchObject({ job_id: job.job_id, job_title: "Mail triage" });
    const summary = await api("/api/summary");
    expect(summary.body.jobs).toEqual({ active: 1, paused: 1 });
    expect(summary.body.next_job_run).toMatchObject({ job_id: job.job_id, title: "Mail triage", at: expect.any(String) });
  });
});

describe("job status fields (KTD15)", () => {
  /** Change one occurrence row and add events to it, from a second store (the tick's view). */
  function ledger(fn: (store: TaskStore) => void): void {
    const store = new TaskStore({ dbPath: join(dir, "queue.db") });
    try {
      fn(store);
    } finally {
      store.close();
    }
  }

  it("a running occurrence has next_run.started_at from its dispatched event; a scheduled one has null", async () => {
    const job = await created();
    const taskId = job.next_run.task_id as string;
    expect(job.next_run).toMatchObject({ started_at: null, deferred_until: null });
    let dispatchedAt = "";
    ledger((store) => {
      store.upsert({ ...store.get(taskId)!, status: "running" });
      store.recordEvent(taskId, { kind: "dispatched", actor: "tick" });
      dispatchedAt = store.listTaskEvents(taskId).at(-1)!.at;
    });
    const running = (await api(`/api/jobs/${job.job_id}`)).body;
    expect(running.next_run).toMatchObject({ status: "running", started_at: dispatchedAt, deferred_until: null });
  });

  it("deferred_until is the retry_at of the newest deferred event while it is ahead; a past one or a later dispatch gives null", async () => {
    const job = await created();
    const taskId = job.next_run.task_id as string;
    const ahead = new Date(Date.now() + 3_600_000).toISOString();
    ledger((store) => {
      // The tick's deferral: the row waits until retry_at.
      store.upsert({ ...store.get(taskId)!, notBefore: ahead });
      store.recordEvent(taskId, { kind: "dispatched", actor: "tick" });
      store.recordEvent(taskId, { kind: "deferred", actor: "tick", details: { retry_at: ahead, reason: "usage limit" } });
    });
    expect((await api(`/api/jobs/${job.job_id}`)).body.next_run).toMatchObject({ status: "scheduled", started_at: null, deferred_until: ahead });
    ledger((store) => store.recordEvent(taskId, { kind: "dispatched", actor: "tick" }));
    expect((await api(`/api/jobs/${job.job_id}`)).body.next_run.deferred_until).toBeNull();

    const other = await created({ ...PROMPT_JOB, title: "Past" });
    const past = new Date(Date.now() - 60_000).toISOString();
    ledger((store) => store.recordEvent(other.next_run.task_id, { kind: "deferred", actor: "tick", details: { retry_at: past } }));
    expect((await api(`/api/jobs/${other.job_id}`)).body.next_run.deferred_until).toBeNull();
  });

  it("Run now on a deferred run clears deferred_until (the row no longer waits for retry_at)", async () => {
    const job = await created();
    const taskId = job.next_run.task_id as string;
    const ahead = new Date(Date.now() + 3_600_000).toISOString();
    ledger((store) => {
      store.upsert({ ...store.get(taskId)!, notBefore: ahead });
      store.recordEvent(taskId, { kind: "deferred", actor: "tick", details: { retry_at: ahead, reason: "usage limit" } });
    });
    expect((await api(`/api/jobs/${job.job_id}`)).body.next_run.deferred_until).toBe(ahead);
    const run = await post(`/api/jobs/${job.job_id}/run-now`);
    expect(run.status).toBe(200);
    expect(run.body.next_run).toMatchObject({ task_id: taskId, deferred_until: null });
  });

  it("late is true for a run that finished after its deadline, false before; last_run matches", async () => {
    const job = await created();
    const base = Date.parse("2026-10-20T00:00:00.000Z");
    ledger((store) => {
      const row = store.get(job.next_run.task_id)!;
      for (const [n, finishMs] of [[2, base + 3_600_000], [3, base - 3_600_000]] as const) {
        store.upsert({
          ...row,
          taskId: `${job.job_id}~${n}`,
          status: "completed",
          enqueuedAt: new Date(Date.now() + n * 1000).toISOString(),
          deadline: new Date(base).toISOString(),
          completedAt: new Date(finishMs).toISOString(),
        });
      }
      store.updateJobIf({ ...store.getJob(job.job_id)!, lastTaskId: `${job.job_id}~2`, lastOutcome: "ok" }, store.getJob(job.job_id)!.revision);
    });
    const runs = (await api(`/api/jobs/${job.job_id}/history`)).body.runs as Array<{ task_id: string; late: boolean }>;
    expect(Object.fromEntries(runs.map((r) => [r.task_id, r.late]))).toEqual({ [`${job.job_id}~3`]: false, [`${job.job_id}~2`]: true, [`${job.job_id}~1`]: false });
    expect((await api(`/api/jobs/${job.job_id}`)).body.last_run).toMatchObject({ task_id: `${job.job_id}~2`, late: true });
  });

  it("a stale revision from a second writer gets the core's stale_revision refusal as 409", async () => {
    const job = await created();
    const first = await post(`/api/jobs/${job.job_id}/update`, { revision: job.revision, title: "First" });
    expect(first.status).toBe(200);
    const second = await post(`/api/jobs/${job.job_id}/update`, { revision: job.revision, title: "Second" });
    expect(second).toEqual({ status: 409, body: { error: `job changed meanwhile (revision ${first.body.revision}); reload it and try again`, code: "stale_revision" } });
    expect((await api(`/api/jobs/${job.job_id}`)).body.title).toBe("First");
  });

  it("a stale partial patch that no longer fits the job still gets 409 stale_revision, not a 400 rule", async () => {
    const job = await created(COMMAND_JOB);
    const switched = await post(`/api/jobs/${job.job_id}/update`, { revision: job.revision, runner: "prompt", prompt: "check mail", secrets: [] });
    expect(switched.status).toBe(200);
    const stale = await post(`/api/jobs/${job.job_id}/update`, { revision: job.revision, command: "echo y" });
    expect(stale).toEqual({ status: 409, body: { error: `job changed meanwhile (revision ${switched.body.revision}); reload it and try again`, code: "stale_revision" } });
  });
});

describe("job routes: scopes and body rules (KTD13)", () => {
  it("the page and a macos token create; an extension token or origin gets 403 on create, update, remove, preview and secrets", async () => {
    expect((await post("/api/jobs", PROMPT_JOB, { token: mac })).status).toBe(201);
    const job = await created();
    const update = { revision: job.revision, title: "x" };
    for (const call of [{ token: ext }, { token: ext, origin: EXT_ORIGIN }, { token: mac, origin: EXT_ORIGIN }]) {
      expect((await post("/api/jobs", PROMPT_JOB, call)).status).toBe(403);
      expect((await post(`/api/jobs/${job.job_id}/update`, update, call)).status).toBe(403);
      expect((await post(`/api/jobs/${job.job_id}/remove`, undefined, call)).status).toBe(403);
      expect((await post("/api/jobs/preview", { cadence: { kind: "daily" } }, call)).status).toBe(403);
      expect((await api("/api/jobs/secrets", call)).status).toBe(403);
    }
    expect((await post(`/api/jobs/${job.job_id}/pause`, undefined, { token: ext, origin: EXT_ORIGIN })).status).toBe(200);
    expect((await post(`/api/jobs/${job.job_id}/resume`, undefined, { token: ext })).status).toBe(200);
  });

  it("actions follow the caller: edit and remove are false for an extension token; a macos token matches the page", async () => {
    const job = await created();
    const page = (await api(`/api/jobs/${job.job_id}`)).body.actions;
    expect((await api(`/api/jobs/${job.job_id}`, { token: mac })).body.actions).toEqual(page);
    expect((await api(`/api/jobs/${job.job_id}`, { token: ext })).body.actions).toEqual({ ...page, edit: false, remove: false });
    expect((await api("/api/jobs", { token: ext, origin: EXT_ORIGIN })).body.jobs[0].actions).toMatchObject({ edit: false, remove: false, pause: true });
  });

  it("GET on an action is 405; /api//jobs routes like /api/jobs (and keeps the scope); text/plain is 415; an unknown key is 400; a body on an action is 400", async () => {
    const job = await created();
    expect((await api(`/api/jobs/${job.job_id}/pause`)).status).toBe(405);
    expect((await api("/api//jobs")).status).toBe(200);
    expect((await post("/api//jobs", PROMPT_JOB, { token: ext })).status).toBe(403);
    expect((await post("/api/jobs", PROMPT_JOB, { type: "text/plain" })).status).toBe(415);
    expect(await post("/api/jobs", { ...PROMPT_JOB, shell: true })).toEqual({ status: 400, body: { error: "unknown field shell" } });
    expect((await post(`/api/jobs/${job.job_id}/pause`, {})).status).toBe(400);
    expect((await post("/api/jobs", { ...PROMPT_JOB, runner: "command" })).body.error).toBe("command must be a non-empty string");
    expect((await post("/api/jobs", { ...PROMPT_JOB, cadence: { kind: "hourly" } })).status).toBe(400);
  });
});

describe("job rate limits", () => {
  it("the limits keep their numbers: 60 job writes and 20 previews per minute", () => {
    expect(JOB_WRITES_PER_MINUTE).toBe(60);
    expect(JOB_PREVIEWS_PER_MINUTE).toBe(20);
  });

  it("over 60 job writes a minute from one token gets 429 with retry_after_s; another token is not limited", async () => {
    let last = 0;
    for (let i = 0; i < 61; i++) last = (await post("/api/jobs/nope/remove")).status;
    expect(last).toBe(429);
    const limited = await post("/api/jobs", PROMPT_JOB);
    expect(limited.status).toBe(429);
    expect(limited.body.retry_after_s).toBeGreaterThan(0);
    expect((await post("/api/jobs", PROMPT_JOB, { token: mac })).status).toBe(201);
    expect((await api("/api/jobs")).status).toBe(200);
  });

  it(`previews have their own limit of ${JOB_PREVIEWS_PER_MINUTE} a minute and do not spend the write budget`, async () => {
    let last = 0;
    for (let i = 0; i <= JOB_PREVIEWS_PER_MINUTE; i++) last = (await post("/api/jobs/preview", { cadence: { kind: "daily" } })).status;
    expect(last).toBe(429);
    expect((await post("/api/jobs", PROMPT_JOB)).status).toBe(201);
    expect((await post("/api/jobs/preview", { cadence: { kind: "daily" } }, { token: mac })).status).toBe(200);
  });

  it("/api//jobs/preview and /api/jobs//preview keep the preview scope and spend the preview limit", async () => {
    const body = { cadence: { kind: "daily" } };
    for (const path of ["/api//jobs/preview", "/api/jobs//preview"]) {
      expect((await post(path, body, { token: ext })).status).toBe(403);
      expect((await post(path, body)).status).toBe(200);
    }
    let last = 0;
    for (let i = 0; i < JOB_PREVIEWS_PER_MINUTE - 2; i++) last = (await post("/api/jobs/preview", body)).status;
    expect(last).toBe(200);
    expect((await post("/api/jobs//preview", body)).status).toBe(429);
    expect((await post("/api/jobs", PROMPT_JOB)).status).toBe(201);
  });
});

describe("job changes on the stream", () => {
  it("a pause from another store reaches subscribers with jobs: true within one poll", async () => {
    const job = await created();
    const seen: Array<{ ids: string[]; jobs?: boolean }> = [];
    ui.events.subscribe((ids, jobs) => seen.push({ ids, jobs }));
    const other = new Scheduler({ dbPath: join(dir, "queue.db"), feed: mockGridFeed(), eager: false, signing: false });
    await pauseJob(other, job.job_id);
    other.shutdown();
    ui.events.poll();
    expect(seen.some((e) => e.jobs === true && e.ids.includes(`${job.job_id}~1`))).toBe(true);
  });

  it("the server's own job write sends jobs: true", async () => {
    const seen: Array<boolean | undefined> = [];
    ui.events.subscribe((_ids, jobs) => seen.push(jobs));
    await created();
    expect(seen).toContain(true);
  });
});
