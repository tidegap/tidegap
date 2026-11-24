#!/usr/bin/env node
// QA area "channels" (integrations plan U5, U15): the notification channels
// against the fake sink (packages/cli/test/fixtures/fake-sink.ts, run as a
// script on the stream's sink port, portBase + 60). The built-in transport
// cases drive a webhook row through `tidegap tick --once`; each channel
// stream adds `scripts/qa/channels/<kind>.mjs` exporting `{ kind, cases }`,
// where a case is `{ id, title, run(ctx) }` and `ctx` is the one built below.
// Prints `PASS` or the failed case ids + log path.
//
//   node scripts/qa/channels-flows.mjs [--stream channels] [--port-base 47906] [--log-dir <dir>] [--keep]

import { chmodSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { connectMcp, CORE, expect, scheduleTask, startFakeSink, startStream } from "./env.mjs";

const s = startStream("channels-flows", { portBase: 47906 });
const { cli, step } = s;
const sink = await startFakeSink(s, s.qa.ports.sink);
s.log(`fake sink ${sink.base}`);

/** Secret values the cases put in the secrets file: none may appear in the log. */
const secretValues = new Set();
const secretsFile = join(s.home, ".config", "tidegap", "channel-secrets.json");

/** Writes the secrets of channel `id` into the QA home's channel-secrets.json (0600). */
function writeChannelSecrets(id, map) {
  mkdirSync(dirname(secretsFile), { recursive: true, mode: 0o700 });
  let data = {};
  try {
    data = JSON.parse(readFileSync(secretsFile, "utf8"));
  } catch {
    // first write
  }
  data[id] = map;
  for (const v of Object.values(map)) secretValues.add(String(v));
  writeFileSync(secretsFile, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
  chmodSync(secretsFile, 0o600);
}

const { TaskStore } = await import(pathToFileURL(CORE).href);
/** Opens the QA ledger for one call and closes it. */
function withStore(fn) {
  const store = new TaskStore({ dbPath: s.qa.db });
  try {
    return fn(store);
  } finally {
    store.close();
  }
}

/** Inserts (or replaces) a channel row of `kind` with id = kind (Q1: one channel per kind); like Connect, it ends a backoff. */
function addChannel(kind, { events = ["task_done", "task_failed"], config = {} } = {}) {
  withStore((store) => {
    store.removeChannel(kind);
    store.deleteMeta(`channel_last:${kind}`);
    store.insertChannel({ id: kind, kind, enabled: true, events, config, createdAt: new Date().toISOString() });
  });
}

const lastDelivery = (id) => withStore((store) => JSON.parse(store.getMeta(`channel_last:${id}`) ?? "null"));

let mcp;
/** Schedules a claude-code task, marks it run-now and runs one tick; returns the task id and the tick output. */
async function runTask(title) {
  mcp ??= await connectMcp(s, s.qa.db);
  const id = await scheduleTask(mcp.call, { prompt: "Reply with the word OK", title });
  expect(cli(["queue", "run-now", id]).code === 0, "run-now failed");
  const tick = cli(["tick", "--once", "--no-notify"]);
  expect(tick.code === 0 && /1 dispatched/.test(tick.stdout), `tick: ${tick.stdout.trim().split("\n")[0]}`);
  return { id, tick };
}

const ctx = { s, cli, sink, addChannel, writeChannelSecrets, runTask, lastDelivery, expect };

const HOOK = "/hook/qa-transport-sEcReT-7781";

await step("transport-1", "a webhook row gets the done event through tick --once; channel_last ok", async () => {
  await sink.clear();
  addChannel("webhook");
  writeChannelSecrets("webhook", { url: `${sink.base}${HOOK}` });
  const { id, tick } = await runTask("qa channels one");
  const reqs = await sink.requests(HOOK);
  expect(reqs.length === 1, `sink got ${reqs.length} request(s)`);
  const body = JSON.parse(reqs[0].body);
  expect(body.version === 1 && body.event === "task_done" && body.task?.id === id, `body: ${reqs[0].body.slice(0, 200)}`);
  expect(!/not sent/.test(tick.stdout + tick.stderr), "the tick logged a failed send");
  expect(lastDelivery("webhook")?.ok === true, "channel_last:webhook is not ok");
});

await step("transport-2", "500 then 200: two attempts with one X-Tidegap-Delivery", async () => {
  await sink.clear();
  await sink.script(HOOK, [{ status: 500 }, { status: 200 }]);
  await runTask("qa channels two");
  const reqs = await sink.requests(HOOK);
  expect(reqs.length === 2, `sink got ${reqs.length} request(s)`);
  const ids = new Set(reqs.map((r) => r.headers["x-tidegap-delivery"]));
  expect(ids.size === 1 && [...ids][0], `delivery ids: ${[...ids].join(", ")}`);
});

await step("transport-3", "404: one warning line with the code, no URL; channel_last records http_404 and a 1 min backoff; the next tick skips the channel", async () => {
  await sink.clear();
  await sink.script(HOOK, [{ status: 404 }]);
  const { tick } = await runTask("qa channels three");
  const out = tick.stdout + tick.stderr;
  expect(/webhook: task_done not sent: delivery failed: http_404/.test(out), "no http_404 warning line");
  const last = lastDelivery("webhook");
  expect(last?.code === "http_404" && last.fails === 1, `channel_last: ${JSON.stringify(last)}`);
  const wait = Date.parse(last.retry_at) - Date.parse(last.at);
  expect(wait === 60_000, `backoff ${wait} ms, want 60000`);
  await runTask("qa channels three b");
  const reqs = await sink.requests(HOOK);
  expect(reqs.length === 1, `the channel in backoff got ${reqs.length} request(s)`);
});

// A readable job notice: a command job with the default summarize prompt, run through the fake claude.
const S40_REPORT = [
  "[monitor] signup-funnel 2026-11-14T10:04:51Z env=qa window=24h baseline=7d",
  "visits|18911|base 18204|d +3.9%|thr 15%|OK",
  "referral_share|9.1%|base 11.8%|d -22.9%|thr 15%|WARN",
  "summary: 1 WARN, 1 OK",
].join("\n");
let s40Job;

/** Marks a job's planned occurrence due (queue run-now); returns its id. */
function runPlanned(jobId) {
  const runId = JSON.parse(cli(["jobs", "show", jobId, "--json"]).stdout).next_run?.task_id;
  expect(runId, `job ${jobId} has no next run`);
  const run = cli(["queue", "run-now", runId]);
  expect(run.code === 0, `queue run-now exit ${run.code}: ${run.stderr.trim()}`);
  return runId;
}

/** Runs the S40 job's planned occurrence now with the fake claude in `mode` (plus `env`); returns the run id and the webhook body. */
async function runS40(mode, env = {}) {
  await sink.clear();
  const runId = runPlanned(s40Job);
  const tick = cli(["tick", "--once", "--no-notify"], { env: { FAKE_CLAUDE_MODE: mode, ...env } });
  expect(tick.code === 0, `tick: ${tick.stdout.trim().split("\n")[0]}`);
  const reqs = await sink.requests(HOOK);
  expect(reqs.length === 1, `sink got ${reqs.length} request(s)`);
  return { runId, body: JSON.parse(reqs[0].body) };
}

await step("S40.1", "a command job with --summarize: the webhook text leads with the status emoji, the title and the verdict, then • lines; holds no raw report; queue show keeps the report", async () => {
  addChannel("webhook");
  writeChannelSecrets("webhook", { url: `${sink.base}${HOOK}` });
  writeFileSync(join(s.home, "qa-s40-report.txt"), `${S40_REPORT}\n`);
  const add = cli(["jobs", "add", "--title", "qa s40 monitor", "--command", "cat qa-s40-report.txt", "--summarize", "--every", "24h", "--notify", "every", "--json"]);
  expect(add.code === 0, `jobs add exit ${add.code}: ${add.stderr.trim()}`);
  s40Job = JSON.parse(add.stdout).job_id;
  const { runId, body } = await runS40("notice");
  expect(body.event === "task_done" && body.text.startsWith("⚠️ qa s40 monitor — Referral share dropped; the rest is normal."), `text: ${String(body.text).slice(0, 300)}`);
  expect(body.title === "qa s40 monitor: needs a look", `title: ${body.title}`);
  const bullets = body.text.split("\n").filter((l) => l.startsWith("• "));
  expect(bullets.length === 3 && bullets[0].startsWith("• Checked:"), `bullets: ${JSON.stringify(bullets)}`);
  expect(!body.text.includes("|"), `the notice holds the raw report: ${String(body.text).slice(0, 300)}`);
  const show = cli(["queue", "show", runId, "--no-mark-read"]);
  expect(show.stdout.includes(`Result:\n${S40_REPORT}`), `queue show: ${show.stdout.slice(0, 600)}`);
  expect(show.stdout.includes("Summary:\nATTENTION: Referral share dropped; the rest is normal."), "queue show has no Summary block");
});

await step("S40.2", "the same job with its summarize step over budget: the run completes; the text has a No summary line and the report", async () => {
  expect(s40Job, "S40.1 made no job");
  const { runId, body } = await runS40("budget");
  const shown = JSON.parse(cli(["queue", "show", runId, "--json", "--no-mark-read"]).stdout);
  expect(shown.status === "completed", `run ${runId} is ${shown.status}: ${shown.error ?? ""}`);
  expect(body.text.includes("No summary: summarize:"), `text: ${String(body.text).slice(0, 400)}`);
  expect(body.text.includes(S40_REPORT.split("\n")[0]), `text: ${String(body.text).slice(0, 400)}`);
});

await step("S41.1", "the same job, a reply with a verdict and a paragraph: ☑️ and one • line per sentence", async () => {
  expect(s40Job, "S40.1 made no job");
  const { body } = await runS40("notice-paragraph");
  expect(body.text.startsWith("☑️ qa s40 monitor — Referral share dropped; the rest is normal."), `text: ${String(body.text).slice(0, 300)}`);
  const bullets = body.text.split("\n").filter((l) => l.startsWith("• "));
  expect(bullets.length === 3, `bullets: ${JSON.stringify(bullets)}`);
  expect(body.title === "qa s40 monitor: done", `title: ${body.title}`);
});

await step("S41.2", "tidegap language set ru: the next summarize input holds the reply language line; reset removes it", async () => {
  expect(s40Job, "S40.1 made no job");
  const set = cli(["language", "set", "ru"]);
  expect(set.code === 0 && set.stdout.includes("ru (Russian)"), `language set: ${set.code} ${set.stdout.trim()} ${set.stderr.trim()}`);
  const log = join(s.home, "qa-s41-claude-log");
  await runS40("notice", { FAKE_CLAUDE_LOG: log });
  const stdin = readFileSync(join(log, "stdin"), "utf8");
  expect(stdin.includes("Reply language: Russian (ru). Use another language only when the prompt above asks for it.\n\nJob title: qa s40 monitor"), `stdin: ${stdin.slice(0, 1200)}`);
  const reset = cli(["language", "reset"]);
  expect(reset.code === 0 && reset.stdout.includes("unset: the job title's language"), `language reset: ${reset.stdout.trim()}`);
  cli(["jobs", "remove", s40Job]);
});

await step("S41.3", "a command job writes a PNG and a CSV into TIDEGAP_ATTACH_DIR: the webhook text holds the 📎 line, the body has no new key, queue show lists the files", async () => {
  addChannel("webhook");
  writeChannelSecrets("webhook", { url: `${sink.base}${HOOK}` });
  const command = `printf '\\211PNG\\r\\n\\032\\n' > "$TIDEGAP_ATTACH_DIR/funnel.png"; printf 'metric,value\\nvisits,18911\\n' > "$TIDEGAP_ATTACH_DIR/weekly.csv"; mkdir "$TIDEGAP_ATTACH_DIR/charts"; echo qa attach report`;
  const add = cli(["jobs", "add", "--title", "qa s41 attach", "--command", command, "--every", "24h", "--notify", "every", "--json"]);
  expect(add.code === 0, `jobs add exit ${add.code}: ${add.stderr.trim()}`);
  const jobId = JSON.parse(add.stdout).job_id;
  try {
    await sink.clear();
    const runId = runPlanned(jobId);
    const tick = cli(["tick", "--once", "--no-notify"]);
    expect(tick.code === 0, `tick: ${tick.stdout.trim().split("\n")[0]}`);
    const reqs = await sink.requests(HOOK);
    expect(reqs.length === 1, `sink got ${reqs.length} request(s)`);
    const body = JSON.parse(reqs[0].body);
    const want = "📎 funnel.png (8 B), weekly.csv (26 B), not attached: charts (a folder)";
    expect(String(body.text).split("\n").includes(want), `text: ${String(body.text).slice(0, 400)}`);
    expect(!("attachments" in body), "the webhook body has an attachments key");
    const show = cli(["queue", "show", runId]);
    expect(/Attachments:\n  1\. funnel\.png \(8 B\): \S+\/attachments\/\S+\/1\.png\n  2\. weekly\.csv \(26 B\): \S+\/2\.csv\n  not attached: charts \(a folder\)/.test(show.stdout), `queue show: ${show.stdout.slice(-500)}`);
  } finally {
    cli(["jobs", "remove", jobId]);
  }
});

await step("S13.14", "daily summary: one digest through tick --once, the done alert folds into it, a second tick sends nothing", async () => {
  await sink.clear();
  addChannel("webhook", { events: ["task_done", "digest"] });
  writeChannelSecrets("webhook", { url: `${sink.base}${HOOK}` });
  // Clock override through the ledger: send time 00:00 and a last summary 30 h ago make the summary due now.
  withStore((st) => {
    st.setMeta("digest_at", "00:00");
    st.setMeta("notified:digest", new Date(Date.now() - 30 * 3_600_000).toISOString());
  });
  await runTask("qa digest one");
  let reqs = await sink.requests(HOOK);
  expect(reqs.length === 1, `sink got ${reqs.length} request(s)`);
  const body = JSON.parse(reqs[0].body);
  expect(body.event === "digest" && /Tidegap daily summary: \d+ done/.test(body.text) && body.text.includes("- qa digest one"), `body: ${reqs[0].body.slice(0, 300)}`);
  const again = cli(["tick", "--once", "--no-notify"]);
  expect(again.code === 0, `second tick exit ${again.code}`);
  reqs = await sink.requests(HOOK);
  expect(reqs.length === 1, `after a second tick the sink has ${reqs.length} request(s)`);
  const show = cli(["channels", "digest"]);
  expect(show.code === 0 && /Daily summary at 00:00 local time\. Last sent: \d{4}-/.test(show.stdout) && /Channels: webhook\./.test(show.stdout), `channels digest: ${show.stdout.trim()}`);
  withStore((st) => {
    st.deleteMeta("digest_at");
    st.deleteMeta("notified:digest");
    st.deleteMeta("digest_sent");
  });
});

// Channel streams: one file per kind.
const kindsDir = join(dirname(fileURLToPath(import.meta.url)), "channels");
for (const file of readdirSync(kindsDir).filter((f) => f.endsWith(".mjs")).sort()) {
  const { kind, cases } = await import(pathToFileURL(join(kindsDir, file)).href);
  for (const c of cases ?? []) {
    await sink.clear();
    await step(c.id, `${kind}: ${c.title}`, () => c.run(ctx));
  }
}

await step("secrets-log", "no secret value from channel-secrets.json is in the QA log", () => {
  const text = readFileSync(s.logPath, "utf8");
  // A URL secret also counts when only its path (the webhook's secret part) is in the log.
  const hits = [...secretValues].filter((v) => text.includes(v) || (/^https?:\/\//.test(v) && text.includes(new URL(v).pathname)));
  expect(hits.length === 0, `${hits.length} secret value(s) in the log`);
});

await mcp?.close().catch(() => {});
await s.finish();
