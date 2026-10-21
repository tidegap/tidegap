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
