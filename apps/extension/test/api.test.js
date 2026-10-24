import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { job, startFakeServer, task } from "./fake-server.js";
import { NO_TOKEN_MESSAGE, OFFLINE_MESSAGE, UNPAIRED_MESSAGE, api, pageUrl, request } from "../src/lib/api.js";

const settings = { port: 47999, token: "tgc_abc" };

function stub(status, body) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    return new Response(body === undefined ? null : JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  };
  return { calls, fetchImpl };
}

describe("api", () => {
  it("200 gives ok with the parsed body", async () => {
    const { fetchImpl } = stub(200, { active: 3 });
    assert.deepEqual(await request(settings, "/api/summary", { fetchImpl }), { state: "ok", status: 200, body: { active: 3 } });
  });

  it("a refused connection gives offline", async () => {
    const fetchImpl = async () => {
      throw new TypeError("Failed to fetch");
    };
    assert.deepEqual(await request(settings, "/api/summary", { fetchImpl }), { state: "offline", message: OFFLINE_MESSAGE });
  });

  it("401 gives unpaired with the revoked-or-older message", async () => {
    const { fetchImpl } = stub(401, { error: "unauthorized" });
    const r = await request(settings, "/api/summary", { fetchImpl });
    assert.equal(r.state, "unpaired");
    assert.equal(r.message, UNPAIRED_MESSAGE);
    assert.match(r.message, /revoked, or tidegap is older than 0\.19/);
  });

  it("500 gives error without the body text", async () => {
    const { fetchImpl } = stub(500, { error: "secret stack /Users/x" });
    const r = await request(settings, "/api/summary", { fetchImpl });
    assert.equal(r.state, "error");
    assert.equal(r.status, 500);
    assert.doesNotMatch(r.message, /secret|Users/);
  });

  it("400 shows the server's one-line message", async () => {
    const { fetchImpl } = stub(400, { error: "prompt must not be blank\nsecond line" });
    const r = await request(settings, "/api/tasks", { method: "POST", body: { prompt: " " }, fetchImpl });
    assert.deepEqual(r, { state: "error", status: 400, message: "prompt must not be blank" });
  });

  it("every request carries the bearer token and goes to the configured port", async () => {
    const { calls, fetchImpl } = stub(200, {});
    await api.summary(settings, "2026-10-17T10:00:00.000Z", { fetchImpl });
    await api.activeTasks(settings, { fetchImpl });
    assert.equal(calls[0].url, "http://127.0.0.1:47999/api/summary?since=2026-10-17T10%3A00%3A00.000Z");
    assert.equal(calls[1].url, "http://127.0.0.1:47999/api/tasks?status=queued,scheduled,running,submitted&limit=20");
    for (const c of calls) assert.equal(c.init.headers.authorization, "Bearer tgc_abc");
    assert.equal(calls[0].init.headers["content-type"], undefined);
  });

  it("no token makes no request and gives unpaired", async () => {
    const { calls, fetchImpl } = stub(200, {});
    const r = await request({ port: 47821, token: "" }, "/api/summary", { fetchImpl });
    assert.deepEqual(r, { state: "unpaired", message: NO_TOKEN_MESSAGE });
    assert.equal(calls.length, 0);
  });

  it("the page link carries the token in the fragment", () => {
    assert.equal(pageUrl({ port: 47821, token: "tgc_a+b" }), "http://127.0.0.1:47821/#token=tgc_a%2Bb");
  });

  it("the page link can open a view, spelled as the Mac app does", () => {
    assert.equal(pageUrl({ port: 47821, token: "tgc_x", view: "jobs" }), "http://127.0.0.1:47821/#token=tgc_x&view=jobs");
  });
});

describe("task actions against a fake tidegap ui", () => {
  let fake;
  before(async () => {
    fake = await startFakeServer({ tasks: [task("t 1"), task("t2", { actions: { cancel: true, runNow: false, later: true } })] });
  });
  after(() => fake.close());

  it("postpone posts the preset as JSON to /api/tasks/<id>/postpone with the token", async () => {
    const r = await api.postpone(fake.settings, "t 1", { preset: "tonight" });
    assert.equal(r.state, "ok");
    assert.equal(r.body.not_before, "2026-10-17T22:00:00.000Z");
    const req = fake.state.requests.at(-1);
    assert.deepEqual([req.method, req.path, req.auth, req.type], ["POST", "/api/tasks/t%201/postpone", "Bearer tgc_fake", "application/json"]);
    assert.deepEqual(JSON.parse(req.body), { preset: "tonight" });
  });

  it("a 409 refusal comes back as an error with the server's line", async () => {
    const r = await api.postpone(fake.settings, "t 1", { preset: "after_limit_reset" });
    assert.deepEqual(r, { state: "error", status: 409, message: "needs the reset time" });
  });

  it("cancel posts {} to /cancel", async () => {
    const r = await api.cancel(fake.settings, "t2");
    assert.equal(r.body.status, "cancelled");
    const req = fake.state.requests.at(-1);
    assert.deepEqual([req.method, req.path, req.auth, req.body], ["POST", "/api/tasks/t2/cancel", "Bearer tgc_fake", "{}"]);
  });

  it("run-now posts with no body and no content-type", async () => {
    const r = await api.runNow(fake.settings, "t 1");
    assert.equal(r.state, "ok");
    const req = fake.state.requests.at(-1);
    assert.deepEqual([req.method, req.path, req.auth, req.type, req.body], ["POST", "/api/tasks/t%201/run-now", "Bearer tgc_fake", undefined, ""]);
  });
});

describe("job actions against a fake tidegap ui", () => {
  let fake;
  before(async () => {
    fake = await startFakeServer({ jobs: [job("job 1"), job("job-2", { status: "paused", pause_reason: "manual", next_run: null, actions: { edit: false, pause: false, resume: true, run_now: false, remove: false } })] });
  });
  after(() => fake.close());

  it("jobs reads /api/jobs with the token", async () => {
    const r = await api.jobs(fake.settings);
    assert.equal(r.state, "ok");
    assert.deepEqual(r.body.jobs.map((j) => j.job_id), ["job 1", "job-2"]);
    const req = fake.state.requests.at(-1);
    assert.deepEqual([req.method, req.path, req.auth], ["GET", "/api/jobs", "Bearer tgc_fake"]);
  });

  it("pause, resume and run-now post with no body to the job routes", async () => {
    assert.equal((await api.pauseJob(fake.settings, "job 1")).body.status, "paused");
    assert.equal((await api.resumeJob(fake.settings, "job 1")).body.status, "active");
    assert.equal((await api.runJobNow(fake.settings, "job 1")).body.next_run.status, "queued");
    assert.deepEqual(
      fake.state.requests.slice(-3).map((r) => [r.method, r.path, r.auth, r.type, r.body]),
      ["pause", "resume", "run-now"].map((a) => ["POST", `/api/jobs/job%201/${a}`, "Bearer tgc_fake", undefined, ""]),
    );
  });

  it("a 409 refusal comes back with the server's line", async () => {
    assert.deepEqual(await api.pauseJob(fake.settings, "job-2"), { state: "error", status: 409, message: "job is already paused" });
  });

  it("an older server answers 404 on /api/jobs", async () => {
    const old = await startFakeServer();
    try {
      const r = await api.jobs(old.settings);
      assert.deepEqual([r.state, r.status], ["error", 404]);
    } finally {
      await old.close();
    }
  });
});
