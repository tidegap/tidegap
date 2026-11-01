#!/usr/bin/env node
// QA area "mcp": S6.3–S6.21, each tool called over stdio against the built
// server on the stream's temp ledger. Prints `PASS` or the failed case ids + log path.
//
//   node scripts/qa/mcp-tools.mjs [--stream mcp] [--port-base 47903] [--log-dir <dir>] [--keep]

import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { connectMcp, CORE, expect, inHours, scheduleTask, startStream } from "./env.mjs";

const s = startStream("mcp-tools", { portBase: 47903 });
const { cli, step } = s;
const show = (id) => s.show(id);
const count = () => JSON.parse(cli(["queue", "list", "--json"]).stdout).tasks.length;
const noStack = (text) => !/\n\s+at .+:\d+:\d+/.test(text);

cli(["install", "--no-load"]);
const m = await connectMcp(s, s.qa.db);
const { call } = m;
const schedule = (title, extra = {}) => scheduleTask(call, { prompt: title, title, ...extra });
/** Queues a task and runs it with the fake claude; `mode` picks its canned reply. */
const finished = async (title, mode = "success") => {
  const id = await schedule(title);
  cli(["queue", "run-now", id]);
  cli(["tick", "--once", "--no-notify"], { env: { FAKE_CLAUDE_MODE: mode } });
  return id;
};

await step("S6.3", "get_grid_forecast FR 24h: 24 points, source named", async () => {
  const r = await call("get_grid_forecast", { region: "FR", hours: 24 });
  expect(!r.isError, r.text.split("\n")[0]);
  const n = (r.text.match(/^\d{2}:\d{2} \|/gm) ?? []).length;
  expect(n === 24, `${n} points, want 24`);
  expect(/^Source: \S+/m.test(r.text), "no source named");
});

await step("S6.4", "recommend_window: inside the deadline, nothing saved", async () => {
  const before = count();
  const deadline = inHours(12);
  const r = await call("recommend_window", { region: "FR", deadline });
  expect(!r.isError, r.text.split("\n")[0]);
  const start = /(\d{4}-\d{2}-\d{2}T[\d:.]+Z)/.exec(r.text)?.[1];
  expect(start && Date.parse(start) <= Date.parse(deadline), `window start ${start} is not inside the deadline`);
  expect(count() === before, "recommend_window saved a task");
});

await step("S6.5", "schedule_task dry_run saves nothing; real reply ends with readiness or Runs at", async () => {
  const before = count();
  const dry = await call("schedule_task", { prompt: "qa dry", region: "FR", provider: "claude-code", deadline: inHours(24), dry_run: true });
  expect(!dry.isError && count() === before, "dry_run saved a task");
  const real = await call("schedule_task", { prompt: "qa real", title: "qa real", region: "FR", provider: "claude-code", deadline: inHours(24) });
  expect(!real.isError && count() === before + 1, "the real call saved no task");
  const last = real.text.trim().split("\n").pop();
  expect(/Tasks will not run|Runs at/i.test(last), `last line: ${last}`);
});

let done;
await step("S6.6", "check_queue_status all and one (with the receipt when done)", async () => {
  done = await finished("qa status done");
  const all = await call("check_queue_status", {});
  expect(!all.isError && all.text.includes(done), "the list misses the task");
  const one = await call("check_queue_status", { task_id: done });
  expect(/completed/.test(one.text), "status is not completed");
  expect(/receipt|signature/i.test(one.text), "no receipt in the one-task answer");
});

// The product spawns /usr/bin/security by absolute path, so no PATH shim can
// see a Keychain read; the answer itself must show that no limit was read.
await step("S6.7", "tidegap_usage with TIDEGAP_USAGE=off: disabled, no limit data", async () => {
  const r = await call("tidegap_usage", {});
  expect(!r.isError, r.text.split("\n")[0]);
  const start = r.text.indexOf("{");
  expect(start >= 0, "no JSON document in the answer");
  const doc = JSON.parse(r.text.slice(start));
  const claude = doc.claude ?? {};
  expect(claude.status === "disabled", `claude.status is ${claude.status}`);
  const read = ["source", "fetched_at", "five_hour", "seven_day", "error"].filter((k) => claude[k] !== undefined);
  if ((claude.scoped ?? []).length) read.push("scoped");
  if (doc.target_reset !== undefined) read.push("target_reset");
  expect(read.length === 0, `limit fields present: ${read.join(", ")}`);
});

await step("S6.8", "cancel_task cancels; a finished task stays unchanged", async () => {
  const id = await schedule("qa cancel");
  await call("cancel_task", { task_id: id });
  expect(show(id).status === "cancelled", `status ${show(id).status}`);
  expect(done, "S6.6 left no finished task");
  await call("cancel_task", { task_id: done });
  expect(show(done).status === "completed", `finished task became ${show(done).status}`);
});

// expedite_task and retry_task refuse claude-code tasks by design (only the
// tick starts Claude Code) and dispatch an API task at once, so these two
// cases use an anthropic task against a loopback fake of the Messages API.
const fakeApi = createServer((req, res) => {
  fakeApi.hits = (fakeApi.hits ?? 0) + 1;
  req.resume();
  req.on("end", () => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        id: "msg_qa",
        type: "message",
        role: "assistant",
        model: "claude-haiku-5-5",
        content: [{ type: "text", text: "OK" }],
        stop_reason: "end_turn",
        stop_sequence: null,
        usage: { input_tokens: 5, output_tokens: 1 },
      }),
    );
  });
});
await new Promise((ok) => fakeApi.listen(s.args.portBase + 100, "127.0.0.1", ok));
const api = await connectMcp(s, s.qa.db, { ANTHROPIC_API_KEY: "sk-ant-qa-fake", ANTHROPIC_BASE_URL: `http://127.0.0.1:${s.args.portBase + 100}` });

await step("S6.9", "expedite_task: due on the next tick", async () => {
  const id = await schedule("qa expedite", { provider: "anthropic" });
  const r = await api.call("expedite_task", { task_id: id });
  expect(!r.isError, r.text.split("\n")[0]);
  const rec = show(id);
  expect(rec.status === "completed" || Date.parse(rec.scheduledFor) <= Date.now() + 60_000, `status ${rec.status}, scheduled_for ${rec.scheduledFor}`);
  expect(fakeApi.hits > 0, "the fake Messages API got no call (ANTHROPIC_BASE_URL ignored?)");
});

await step("S6.10", "update_deadline: rescored against the new deadline", async () => {
  const id = await schedule("qa deadline", { deadline: inHours(72) });
  const deadline = inHours(6);
  const r = await call("update_deadline", { task_id: id, deadline });
  expect(!r.isError, r.text.split("\n")[0]);
  const rec = show(id);
  expect(Date.parse(rec.deadline) === Date.parse(deadline), `deadline ${rec.deadline}, want ${deadline}`);
  expect(Date.parse(rec.scheduledFor) <= Date.parse(deadline), `scheduled_for ${rec.scheduledFor} is past the new deadline`);
});

await step("S6.11", "postpone_task presets move later; an earlier target is refused", async () => {
  const id = await schedule("qa postpone", { deadline: inHours(96) });
  const bad = [];
  for (const args of [{ preset: "1h" }, { preset: "tonight" }, { preset: "tomorrow_morning" }, { delay_minutes: 30 }]) {
    const before = Date.parse(show(id).scheduledFor);
    const r = await call("postpone_task", { task_id: id, ...args });
    const after = Date.parse(show(id).scheduledFor);
    if (after < before) bad.push(`${JSON.stringify(args)} moved earlier`);
    else if (after === before && !/already planned/i.test(r.text)) bad.push(`${JSON.stringify(args)}: ${r.text.split("\n")[0]}`);
  }
  const early = await call("postpone_task", { task_id: id, until: inHours(0.05) });
  if (!/already planned for/i.test(early.text)) bad.push(`earlier target: ${early.text.split("\n")[0]}`);
  expect(bad.length === 0, bad.join("; "));
});

await step("S6.12", "reply_task on a completed task: child task with history", async () => {
  expect(done, "S6.6 left no finished task");
  const r = await call("reply_task", { task_id: done, text: "And again, please." });
  expect(!r.isError, r.text.split("\n")[0]);
  const child = /task_id: (\S+)/.exec(r.text)?.[1];
  expect(child && child !== done, "no child task id");
  const rec = show(child);
  expect(Array.isArray(rec.history) && rec.history.length >= 2, `child history has ${rec.history?.length ?? 0} messages`);
});

await step("S6.13", "retry_task: failed requeued, completed refused", async () => {
  const failed = await schedule("qa retry", { provider: "anthropic" });
  const { TaskStore } = await import(pathToFileURL(CORE).href);
  const store = new TaskStore({ dbPath: s.qa.db });
  try {
    store.upsert({ ...store.get(failed), status: "failed", completedAt: new Date().toISOString(), result: { error: "qa: seeded failure" } });
  } finally {
    store.close();
  }
  expect(show(failed).status === "failed", `setup: status ${show(failed).status}, want failed`);
  const r = await api.call("retry_task", { task_id: failed });
  expect(!r.isError, r.text.split("\n")[0]);
  expect(show(failed).status !== "failed", `after retry: ${show(failed).status}`);
  const refused = await api.call("retry_task", { task_id: done });
  expect(refused.isError || /only|cannot|can't|not failed/i.test(refused.text), `completed task: ${refused.text.split("\n")[0]}`);
  expect(show(done).status === "completed", "the completed task changed");
});

await step("S6.14", "cancel_all: every pending task cancelled, count returned", async () => {
  await schedule("qa all one");
  await schedule("qa all two");
  const pending = JSON.parse(cli(["queue", "list", "--json"]).stdout).tasks.filter((t) => ["queued", "scheduled"].includes(t.status)).length;
  const r = await call("cancel_all", {});
  expect(!r.isError, r.text.split("\n")[0]);
  expect(new RegExp(`\\b${pending}\\b`).test(r.text), `answer does not report ${pending}: ${r.text.split("\n")[0]}`);
  const left = JSON.parse(cli(["queue", "list", "--json"]).stdout).tasks.filter((t) => ["queued", "scheduled"].includes(t.status));
  expect(left.length === 0, `${left.length} pending left`);
});

await step("S6.16", "bad arguments: an error text, no stack, nothing saved", async () => {
  const before = count();
  const calls = [
    ["get_grid_forecast", { region: "", hours: -1 }],
    ["recommend_window", { region: "FR", deadline: "not a date" }],
    ["schedule_task", { prompt: "", region: "FR" }],
    ["schedule_task", { prompt: "x", region: "FR", deadline: "2000-01-01T00:00:00Z" }],
    ["check_queue_status", { task_id: "t-nope" }],
    ["tidegap_usage", { include_spend: "yes" }],
    ["cancel_task", { task_id: "t-nope" }],
    ["expedite_task", { task_id: "t-nope" }],
    ["update_deadline", { task_id: "t-nope", deadline: "soon" }],
    ["postpone_task", { task_id: "t-nope", preset: "never" }],
    ["reply_task", { task_id: "t-nope", text: "" }],
    ["retry_task", { task_id: "t-nope" }],
    ["cancel_all", { status: "done" }],
  ];
  const bad = [];
  for (const [name, args] of calls) {
    let r;
    try {
      r = await call(name, args);
    } catch (err) {
      r = { isError: true, text: String(err?.message ?? err) };
    }
    if (!r.isError && !/not found|invalid|error|must|unknown|no task/i.test(r.text)) bad.push(`${name} accepted ${JSON.stringify(args)}`);
    else if (!noStack(r.text)) bad.push(`${name} stack trace`);
  }
  expect(count() === before, `bad calls saved ${count() - before} task(s)`);
  expect(bad.length === 0, bad.join("; "));
});

await step("S6.17", "schedule_task repeat: create a job, list it, refuse a command, end it", async () => {
  const r = await call("schedule_task", { prompt: "qa nightly job", repeat: "daily", window: "00:00-08:00", time_zone: "UTC" });
  expect(!r.isError, r.text.split("\n")[0]);
  const jobId = /job_id: (job-[0-9a-f]{8})/.exec(r.text)?.[1];
  const first = /first_task_id: (\S+)/.exec(r.text)?.[1];
  expect(jobId && first, `no job id in: ${r.text.split("\n")[0]}`);
  expect(r.text.includes("runs every day between 00:00 and 08:00"), "reply has no guarantee");
  const listed = await call("check_queue_status", {});
  expect(new RegExp(`^\\s+${jobId} \\| active \\|`, "m").test(listed.text), "job missing from check_queue_status");
  const refused = await call("schedule_task", { prompt: "qa logs", repeat: "daily", command: "tail -n 5 /var/log/x" });
  expect(refused.isError && refused.text.includes("tidegap jobs add"), "command job was not refused");
  const ended = await call("cancel_task", { task_id: first, series: true });
  expect(ended.text.includes(`job ${jobId}: ended`), ended.text.split("\n")[0]);
  expect(show(first).status === "cancelled", `first run is ${show(first).status}`);
  const after = await call("check_queue_status", {});
  expect(!new RegExp(`^\\s+${jobId} \\|`, "m").test(after.text), "removed job still listed");
});

// S6.18-S6.20: the handoff parameters of schedule_task. The server runs in the QA home, so it has no project folder:
// the task's own cwd and the temp folder are the allowed folders.
const repo = join(s.home, "s618-repo");
mkdirSync(repo, { recursive: true });

await step("S6.18", "schedule_task with cwd, permission_profile and result_path; check_queue_status shows them", async () => {
  const out = join(repo, "review.md");
  const r = await call("schedule_task", { prompt: "qa s6.18 review", region: "FR", deadline: inHours(6), provider: "claude-code", cwd: repo, permission_profile: "read", result_path: out });
  expect(!r.isError, r.text.split("\n")[0]);
  const id = /task_id: (\S+)/.exec(r.text)?.[1];
  expect(id, "no task id");
  for (const line of ["provider: claude-code", `cwd: ${repo}`, "profile: read", "tools: Read, Grep, Glob", `result_path: ${out}`]) {
    expect(r.text.includes(line), `reply misses "${line}"`);
  }
  const before = await call("check_queue_status", { task_id: id });
  for (const line of [`cwd: ${repo}`, "profile: read", "tools: Read, Grep, Glob", `result_path: ${out}`, "result_file: not written yet"]) {
    expect(before.text.includes(line), `check_queue_status misses "${line}"`);
  }
  cli(["queue", "run-now", id]);
  cli(["tick", "--once", "--no-notify"]);
  expect(show(id).status === "completed", `status ${show(id).status}`);
  expect(existsSync(out) && readFileSync(out, "utf8") === "OK", "the result file does not hold the result");
  const after = await call("check_queue_status", { task_id: id });
  expect(after.text.includes("result_file: written, 2 bytes"), "check_queue_status does not show the written file");
});

await step("S6.19", "schedule_task runner command is refused and names the CLI line; output_path at a protected path is refused", async () => {
  const before = count();
  for (const args of [{ runner: "command" }, { provider: "command" }]) {
    const r = await call("schedule_task", { prompt: "echo hi", region: "FR", deadline: inHours(6), ...args });
    expect(r.isError && r.text.includes("tidegap queue add --runner command --cwd <dir> --by <when> '<cmd>'"), `${JSON.stringify(args)}: ${r.text.split("\n")[0]}`);
    expect(noStack(r.text), "stack trace");
  }
  mkdirSync(join(s.home, "Library", "LaunchAgents"), { recursive: true });
  mkdirSync(join(s.home, ".tidegap"), { recursive: true });
  for (const path of [join(s.home, "Library", "LaunchAgents", "x.plist"), join(s.home, ".tidegap", "out.json"), join(s.home, ".zshrc")]) {
    for (const key of ["output_path", "result_path"]) {
      const r = await call("schedule_task", { prompt: "x", region: "FR", deadline: inHours(6), [key]: path });
      expect(r.isError && /allowed folders: /.test(r.text), `${key} ${path}: ${r.text.split("\n")[0]}`);
    }
  }
  expect(count() === before, `refused calls saved ${count() - before} task(s)`);
});

await step("S6.20", "schedule_task runner is an alias of provider; a mismatch and a web profile with a cwd are refused; dry_run previews the shape", async () => {
  const before = count();
  const alias = await call("schedule_task", { prompt: "qa s6.20 alias", region: "FR", deadline: inHours(6), runner: "claude-code" });
  expect(!alias.isError && alias.text.includes("provider: claude-code"), alias.text.split("\n")[0]);
  const mismatch = await call("schedule_task", { prompt: "x", region: "FR", deadline: inHours(6), runner: "claude-code", provider: "anthropic" });
  expect(mismatch.isError && mismatch.text.includes("differ"), mismatch.text.split("\n")[0]);
  const web = await call("schedule_task", { prompt: "x", region: "FR", deadline: inHours(6), provider: "claude-code", cwd: repo, permission_profile: "web" });
  expect(web.isError && web.text.includes("cannot take a cwd"), web.text.split("\n")[0]);
  const dry = await call("schedule_task", { prompt: "x", region: "FR", deadline: inHours(6), provider: "claude-code", cwd: repo, dry_run: true });
  expect(!dry.isError && dry.text.includes(`cwd: ${repo}`) && dry.text.includes("profile: read"), dry.text.split("\n")[0]);
  expect(count() === before + 1, `saved ${count() - before} task(s), want 1`);
});

await step("S6.21", "schedule_task wake_session without a session origin is refused, also with an unchecked origin_session_id; nothing is saved", async () => {
  const before = count();
  for (const extra of [{}, { origin_session_id: "qa000621-aaaa-4000-8000-000000000621" }]) {
    const r = await call("schedule_task", { prompt: "qa s6.21 wake", region: "FR", deadline: inHours(6), wake_session: true, ...extra });
    expect(r.isError && r.text.includes("a wake needs a task queued from a Claude Code session"), `${JSON.stringify(extra)}: ${r.text.split("\n")[0]}`);
  }
  expect(count() === before, `saved ${count() - before} task(s), want 0`);
  expect(!existsSync(join(s.home, ".tidegap", "sessions", "wake")), "a wake marker folder was written");
});

await m.close();
await api.close();
fakeApi.close();
await s.finish();
