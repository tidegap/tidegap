process.env.TZ = "UTC";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { after, before, describe, it } from "node:test";
import { NO_TOKEN_MESSAGE, OFFLINE_MESSAGE, UNPAIRED_MESSAGE, api } from "../src/lib/api.js";
import { CONFIRM, EMPTY_TEXT, TASK_LIMIT, JOBS_NOTE, doneLine, headerLine, jobButtons, jobSection, limitsLine, readinessLine, rowButtons, rowsFrom, statusFor } from "../src/popup/model.js";
import { job, laterOptions, startFakeServer, task } from "./fake-server.js";

const NOW = Date.parse("2026-10-17T09:00:00.000Z");
const html = readFileSync(new URL("../src/popup/popup.html", import.meta.url), "utf8");
const NOT_READY = { ready: false, line: "Tasks will not run: no tick daemon. Run `tidegap install`.", problems: [{ code: "no_daemon" }] };

describe("popup model", () => {
  it("cuts to 20 rows after the job runs are filtered out, keeping the server's first 20", () => {
    const jobRuns = Array.from({ length: 5 }, (_, i) => ({ task_id: `j${i}`, job_id: "job-a", status: "queued", scheduled_for: "2026-10-17T10:00:00.000Z" }));
    const own = Array.from({ length: 30 }, (_, i) => ({ task_id: `t${i}`, status: "queued", scheduled_for: "2026-10-17T11:00:00.000Z" }));
    const ids = rowsFrom({ tasks: [...jobRuns, ...own] }, NOW).map((r) => r.id);
    assert.equal(TASK_LIMIT, 20);
    assert.equal(ids.length, 20);
    assert.deepEqual(ids, own.slice(0, 20).map((t) => t.task_id));
  });

  it("maps a list answer to rows in scheduled_for order, titles as text", () => {
    const body = {
      tasks: [
        { task_id: "c", display_title: "Later", status: "scheduled", scheduled_for: "2026-10-18T14:00:00.000Z" },
        { task_id: "a", display_title: "<i>Soon</i>", status: "queued", scheduled_for: "2026-10-17T11:00:00.000Z" },
        { task_id: "b", display_title: "Busy", status: "running", scheduled_for: null },
      ],
    };
    assert.deepEqual(
      rowsFrom(body, NOW).map(({ id, title, status, when }) => ({ id, title, status, when })),
      [
        { id: "a", title: "<i>Soon</i>", status: "queued", when: "11:00" },
        { id: "c", title: "Later", status: "scheduled", when: "Sun 14:00" },
        { id: "b", title: "Busy", status: "running", when: "running" },
      ],
    );
  });

  it("a row with actions.runNow false renders Run now disabled", () => {
    const [row] = rowsFrom({ tasks: [task("t", { actions: { cancel: true, runNow: false, later: true } })] }, NOW);
    assert.deepEqual(rowButtons(row), [
      { action: "later", label: "Later", disabled: false },
      { action: "cancel", label: "Cancel", disabled: false },
      { action: "runNow", label: "Run now", disabled: true },
    ]);
  });

  it("Later lists the presets with their local times; an unavailable one carries its reason", () => {
    const [row] = rowsFrom({ tasks: [task("t")] }, NOW);
    assert.deepEqual(row.later, [
      { preset: "1h", label: "One hour later", when: "15:00", available: true, reason: "" },
      { preset: "tonight", label: "Tonight", when: "22:00", available: true, reason: "" },
      { preset: "tomorrow_morning", label: "Tomorrow morning", when: "Sun 09:00", available: true, reason: "" },
      { preset: "after_limit_reset", label: "After limit reset", when: "", available: false, reason: "needs the reset time" },
    ]);
  });

  it("a 0.19.0 item without later_options gets no Later button", () => {
    const [row] = rowsFrom({ tasks: [{ ...task("t"), later_options: undefined }] }, NOW);
    assert.equal(row.later, null);
    assert.deepEqual(rowButtons(row).map((b) => b.action), ["cancel", "runNow"]);
  });

  it("Cancel and Run now ask for confirmation", () => {
    assert.equal(CONFIRM.cancel.question, "Cancel this task?");
    assert.equal(CONFIRM.runNow.question, "Run this task on the next tick?");
    assert.equal(CONFIRM.later, undefined);
  });

  it("each action reports one line", () => {
    assert.equal(doneLine("later", { scheduled_for: "2026-10-17T22:00:00.000Z" }, NOW), "Moved to 22:00.");
    assert.equal(doneLine("cancel", {}, NOW), "Cancelled.");
    assert.equal(doneLine("runNow", {}, NOW), "Runs on the next tick.");
  });

  it("readiness not ready gives the line; ready or absent gives nothing", () => {
    assert.equal(readinessLine({ readiness: NOT_READY }), NOT_READY.line);
    assert.equal(readinessLine({ readiness: { ready: true, line: null, problems: [] } }), null);
    assert.equal(readinessLine({}), null);
  });

  it("the popup has no quick add, a readiness line and the empty text", () => {
    assert.doesNotMatch(html, /<form|<textarea|id="(add|prompt|preset|add-btn|add-msg)"|Queue a task/);
    assert.match(html, /id="readiness"[^>]*hidden/);
    assert.match(html, /id="limits"[^>]*hidden/);
    assert.ok(html.includes(`<p id="empty" class="muted" hidden>${EMPTY_TEXT}</p>`));
    assert.equal(EMPTY_TEXT, "No tasks queued. Ask your agent to schedule one.");
    assert.equal(typeof api.addTask, "undefined");
  });

  it("a 400 shows the server's message", () => {
    assert.deepEqual(statusFor({ state: "error", status: 400, message: "deadline must be in the future" }), { kind: "error", text: "deadline must be in the future", options: false });
  });

  it("each status maps to its message", () => {
    assert.deepEqual(statusFor({ state: "unpaired", message: UNPAIRED_MESSAGE }), { kind: "unpaired", text: UNPAIRED_MESSAGE, options: true });
    assert.match(statusFor({ state: "unpaired", message: NO_TOKEN_MESSAGE }).text, /not paired/i);
    assert.match(statusFor({ state: "unpaired", message: UNPAIRED_MESSAGE }).text, /not paired.*revoked, or tidegap is older than 0\.19/i);
    assert.deepEqual(statusFor({ state: "offline", message: OFFLINE_MESSAGE }), { kind: "offline", text: OFFLINE_MESSAGE, options: false });
    assert.match(OFFLINE_MESSAGE, /run `tidegap ui`/i);
  });

  it("the header line shows the clean window", () => {
    assert.equal(headerLine({ region: "FR", clean_window: { start: "2026-10-17T14:00:00.000Z", end: "2026-10-17T17:00:00.000Z", now: false, fallback: false } }), "clean 14:00-17:00 FR");
    assert.equal(headerLine({ clean_window: null, forecast_ok: false }), "Forecast unavailable");
  });
});

describe("popup model against a fake tidegap ui", () => {
  let fake;
  before(async () => {
    fake = await startFakeServer({ tasks: [task("t1"), task("t2", { later_options: laterOptions(false) })], readiness: NOT_READY });
  });
  after(() => fake.close());

  it("a summary without limits gives no limit line", async () => {
    const r = await api.summary(fake.settings);
    assert.equal(r.body.limits, undefined);
    assert.equal(limitsLine(r.body), null);
  });

  it("the summary's readiness becomes the popup line", async () => {
    const r = await api.summary(fake.settings);
    assert.equal(readinessLine(r.body), NOT_READY.line);
  });

  it("Later on an available preset moves the row; the list shows the new time", async () => {
    const r = await api.postpone(fake.settings, "t1", { preset: "1h" });
    assert.equal(doneLine("later", r.body, NOW), "Moved to 15:00.");
    const rows = rowsFrom((await api.activeTasks(fake.settings)).body, NOW);
    assert.equal(rows.find((x) => x.id === "t1").when, "15:00");
  });

  it("an empty task list renders the empty text (no rows)", async () => {
    const empty = await startFakeServer({ tasks: [] });
    try {
      assert.deepEqual(rowsFrom((await api.activeTasks(empty.settings)).body, NOW), []);
    } finally {
      await empty.close();
    }
  });
});

describe("popup against a server with limit state", () => {
  const LIMITS = { line: "Claude 5h: 72%, resets 16:30", status: "ok", window: "five_hour", pct: 72, resets_at: "2026-10-17T16:30:00.000Z" };
  const resetOptions = () =>
    laterOptions().map((o) =>
      o.preset === "after_limit_reset" ? { preset: o.preset, label: o.label, not_before: "2026-10-17T16:35:00.000Z", available: true } : o,
    );
  let fake;
  before(async () => {
    fake = await startFakeServer({ tasks: [task("t1", { later_options: resetOptions() })], limits: LIMITS });
  });
  after(() => fake.close());

  it("the summary's limit line becomes the popup line", async () => {
    const r = await api.summary(fake.settings);
    assert.equal(limitsLine(r.body), "Claude 5h: 72%, resets 16:30");
  });

  it("After limit reset is enabled with its time when the server marks it available, and moves the row", async () => {
    const list = await api.activeTasks(fake.settings);
    const reset = rowsFrom(list.body, NOW)[0].later.find((o) => o.preset === "after_limit_reset");
    assert.deepEqual(reset, { preset: "after_limit_reset", label: "After limit reset", when: "16:35", available: true, reason: "" });
    const r = await api.postpone(fake.settings, "t1", { preset: "after_limit_reset" });
    assert.equal(r.state, "ok");
  });
});

describe("popup jobs section", () => {
  const PAUSED = { edit: true, pause: false, resume: true, run_now: false, remove: true };
  const ok = (jobs) => ({ state: "ok", status: 200, body: { jobs } });
  const COUNTS = { jobs: { active: 1, paused: 1 } };

  it("builds one row per job: title, next and last line, buttons per actions", () => {
    const section = jobSection(COUNTS, ok([job("job-a", { title: "Mail triage" }), job("job-b", { title: "Weekly audit", status: "paused", pause_reason: "auto: exit 1", consecutive_failures: 3, next_run: null, actions: PAUSED })]), NOW);
    assert.deepEqual(
      section.rows.map(({ id, title, line }) => ({ id, title, line })),
      [
        { id: "job-a", title: "Mail triage", line: "next Sun 02:00 - last ok 03:12" },
        { id: "job-b", title: "Weekly audit", line: "paused after 3 failures" },
      ],
    );
    assert.deepEqual(jobButtons(section.rows[0]), [
      { action: "runJobNow", label: "Run now", disabled: false },
      { action: "pause", label: "Pause", disabled: false },
    ]);
    assert.deepEqual(jobButtons(section.rows[1]), [{ action: "resume", label: "Resume", disabled: false }]);
  });

  it("never offers Edit or Remove, even when the server allows them", () => {
    const [row] = jobSection(COUNTS, ok([job("j", { actions: { edit: true, pause: true, resume: false, run_now: true, remove: true } })]), NOW).rows;
    assert.deepEqual(jobButtons(row).map((b) => b.label), ["Run now", "Pause"]);
  });

  it("a running job keeps Run now, disabled; a manual pause says paused; no run yet says so", () => {
    const running = job("r", { next_run: { status: "running" }, last_run: null, actions: { pause: true, resume: false, run_now: false } });
    const manual = job("m", { status: "paused", pause_reason: "manual", next_run: null, actions: PAUSED });
    const [r, m] = jobSection(COUNTS, ok([running, manual]), NOW).rows;
    assert.equal(r.line, "running - no run yet");
    assert.deepEqual(jobButtons(r)[0], { action: "runJobNow", label: "Run now", disabled: true });
    assert.equal(m.line, "paused");
  });

  it("is hidden for an older server (no jobs counts, or 404) and when there are no jobs", () => {
    assert.equal(jobSection({}, ok([job("j")]), NOW), null);
    assert.equal(jobSection(COUNTS, { state: "error", status: 404, message: "tidegap ui answered 404." }, NOW), null);
    assert.equal(jobSection({ jobs: { active: 0, paused: 0 } }, ok([]), NOW), null);
  });

  it("another failure keeps the section with the message", () => {
    assert.deepEqual(jobSection(COUNTS, { state: "error", status: 500, message: "tidegap ui answered 500." }, NOW), { rows: [], message: "tidegap ui answered 500." });
  });

  it("job runs are left out of the queue rows", () => {
    const rows = rowsFrom({ tasks: [task("t1"), task("job-a~2", { job_id: "job-a", job_title: "Mail triage" })] }, NOW);
    assert.deepEqual(rows.map((r) => r.id), ["t1"]);
  });

  it("Run now asks first; Pause and Resume do not", () => {
    assert.equal(CONFIRM.runJobNow.question, "Run this job on the next tick?");
    assert.equal(CONFIRM.pause, undefined);
    assert.equal(CONFIRM.resume, undefined);
  });

  it("each job action reports one line", () => {
    assert.equal(doneLine("pause"), "Paused.");
    assert.equal(doneLine("resume"), "Resumed.");
    assert.equal(doneLine("runJobNow"), "Runs on the next tick.");
  });

  it("the popup has a hidden jobs section with the note and a Manage jobs link, and no job authoring", () => {
    assert.match(html, /<section id="jobs"[^>]*hidden/);
    assert.ok(html.includes(JOBS_NOTE));
    assert.equal(JOBS_NOTE, "Create or edit jobs in the Tidegap page or the Mac app.");
    assert.match(html, /id="manage-jobs"[^>]*>Manage jobs</);
    assert.doesNotMatch(html, />Edit</);
    for (const name of ["addJob", "createJob", "updateJob", "removeJob"]) assert.equal(api[name], undefined);
  });
});

describe("popup jobs against a fake tidegap ui", () => {
  let fake;
  before(async () => {
    fake = await startFakeServer({ jobs: [job("job-a", { title: "Mail triage" })] });
  });
  after(() => fake.close());

  const section = async () => jobSection((await api.summary(fake.settings)).body, await api.jobs(fake.settings), NOW);

  it("the summary's counts and /api/jobs give the section", async () => {
    assert.deepEqual((await section()).rows.map((r) => [r.title, r.line]), [["Mail triage", "next Sun 02:00 - last ok 03:12"]]);
  });

  it("Pause posts to the job route; the refreshed row is paused with Resume", async () => {
    assert.equal((await api.pauseJob(fake.settings, "job-a")).state, "ok");
    const [row] = (await section()).rows;
    assert.equal(row.line, "paused");
    assert.deepEqual(jobButtons(row).map((b) => b.action), ["resume"]);
  });

  it("a 409 gives the server's sentence", async () => {
    const paused = await startFakeServer({ jobs: [job("job-p", { status: "paused" })] });
    try {
      const r = await api.pauseJob(paused.settings, "job-p");
      assert.equal(r.status, 409);
      assert.equal(statusFor(r).text, "job is already paused");
    } finally {
      await paused.close();
    }
  });

  it("the job routes refuse a body, like the real server", async () => {
    const res = await fetch(`http://127.0.0.1:${fake.settings.port}/api/jobs/job-a/pause`, {
      method: "POST",
      headers: { authorization: `Bearer ${fake.settings.token}`, "content-type": "application/json" },
      body: "{}",
    });
    assert.equal(res.status, 400);
  });

  it("an older server hides the section", async () => {
    const old = await startFakeServer();
    try {
      assert.equal(jobSection((await api.summary(old.settings)).body, await api.jobs(old.settings), NOW), null);
    } finally {
      await old.close();
    }
  });
});
