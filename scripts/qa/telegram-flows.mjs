#!/usr/bin/env node
// QA area "telegram": S5.2–S5.6, S5.13–S5.15 and S1.28 against the fake Bot API
// (packages/core-ts/test/fixtures/fake-telegram.ts, run as a script on the
// stream's fake Telegram port). Prints `PASS` or the failed case ids + log path.
//
//   node scripts/qa/telegram-flows.mjs [--stream telegram] [--port-base 47902] [--log-dir <dir>] [--keep]

import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { CLI, connectMcp, CORE, expect, FAKE_TG_TOKEN, ROOT, scheduleTask, startFakeTelegram, startStream, waitFor, writeEnvFile } from "./env.mjs";

const { LAST_TICK_META_KEY, TaskStore, TICK_BY_META_KEY, TICK_SLEEP_META_KEY } = await import(pathToFileURL(CORE).href);
const { readSleep } = await import(pathToFileURL(join(ROOT, "packages/cli/dist/platform/sleep.js")).href);

const s = startStream("telegram-flows", { portBase: 47902 });
const { cli, step } = s;
const CHAT = 1001;
const showJson = s.show;

cli(["install", "--no-load"]);
writeEnvFile(s.home, [`TIDEGAP_TELEGRAM_BOT_TOKEN=${FAKE_TG_TOKEN}`]);
const tg = await startFakeTelegram(s, s.qa.ports.tg);
s.log(`fake telegram ${tg.base}`);

let mcp;
const schedule = async (title, extra = {}) => {
  mcp ??= await connectMcp(s, s.qa.db);
  return scheduleTask(mcp.call, { prompt: title, title, ...extra });
};

/** Runs `channels add telegram --no-load`, sends `send(code)` from the chat, resolves with the exit and output. */
async function pair(send) {
  const child = s.spawnChild(process.execPath, [CLI, "channels", "add", "telegram", "--no-load"]);
  const exited = new Promise((ok) => child.once("exit", (code) => ok(code)));
  const code = await waitFor(() => /\/pair (\d{6})\b/.exec(child.output)?.[1], 15_000);
  expect(code, `no 6-digit code printed: ${child.output.trim().split("\n")[0] ?? ""}`);
  for (const text of send(code)) await tg.message(CHAT, text);
  const timer = setTimeout(() => child.kill("SIGTERM"), 20_000);
  const exit = await exited;
  clearTimeout(timer);
  s.log(`$ tidegap channels add telegram --no-load → exit ${exit}`);
  s.log(child.output.trim().replace(/^/gm, "  | "));
  return { exit, code, output: child.output };
}

/**
 * Sends `texts` from the paired chat, runs one `channels serve --once`, and
 * returns the replies to the last text. Task numbers live in the listener
 * process, so a numbered command goes in the same batch as its /queue.
 */
async function say(...texts) {
  for (const text of texts) await tg.message(CHAT, text);
  const r = cli(["channels", "serve", "--once"], { timeout: 60_000 });
  expect(r.code === 0, `serve --once exit ${r.code}`);
  const sent = await tg.sent(CHAT);
  const replies = sent.slice(sent.length - 1);
  s.log(`  tg ${JSON.stringify(texts)} → ${JSON.stringify(replies).slice(0, 600)}`);
  return replies.join("\n");
}

await step("S5.2", "channels add --no-load: wrong code refused, right code pairs", async () => {
  const r = await pair((code) => [`/pair ${code === "000000" ? "111111" : "000000"}`, `/pair ${code}`]);
  expect(r.exit === 0, `channels add exit ${r.exit}`);
  const sent = (await tg.sent(CHAT)).join("\n");
  expect(/Wrong code/.test(sent), "the wrong code got no refusal");
  expect(/Paired/.test(sent), "no 'Paired' reply");
  s.skip("S5.2", "part: a code after 10 minutes needs a 10-minute wait; pairing has no time override outside tests");
});

await step("S1.28", "channels add: 6-digit code, list --json shows the chat", () => {
  const list = JSON.parse(cli(["channels", "list", "--json"]).stdout).channels;
  expect(list.some((c) => c.kind === "telegram" && c.config?.chat_id === CHAT), "list --json misses the paired chat");
});

await step("S5.3", "deep link /start <code> pairs the same way", async () => {
  const r = await pair((code) => [`/start ${code}`]);
  expect(r.exit === 0, `channels add exit ${r.exit}`);
  expect(/Paired/.test((await tg.sent(CHAT)).slice(-1)[0] ?? ""), "no 'Paired' reply to /start");
});

const ids = [];
await step("S5.4", "serve --once, /queue lists the next tasks numbered", async () => {
  for (const t of ["tg one", "tg two", "tg three"]) ids.push(await schedule(t));
  const reply = await say("/queue");
  expect(/^\s*1[.)]/m.test(reply) && /tg one|tg two|tg three/.test(reply), `reply: ${reply.split("\n")[0]}`);
});

await step("S5.5", "/later n with each grammar; bad grammar gets the usage line", async () => {
  const bad = [];
  for (const arg of ["1h", "tonight", "tomorrow", "reset 23:45", "23:30"]) {
    const first = () => ids.map((id) => showJson(id)).sort((a, b) => Date.parse(a.scheduledFor) - Date.parse(b.scheduledFor))[0];
    const target = first();
    const reply = await say("/queue", `/later 1 ${arg}`);
    const after = Date.parse(showJson(target.taskId).scheduledFor);
    const before = Date.parse(target.scheduledFor);
    if (after < before) bad.push(`${arg} moved earlier`);
    else if (after === before && !/already planned/i.test(reply)) bad.push(`${arg}: not moved, reply "${reply.split("\n")[0]}"`);
  }
  const usage = await say("/queue", "/later 1 whenever");
  if (!/Usage/i.test(usage)) bad.push("bad grammar got no usage line");
  expect(bad.length === 0, bad.join("; "));
});

await step("S5.6", "/run, /cancel, /result (finished and pending)", async () => {
  const runReply = await say("/queue", "/run 2");
  expect(runReply.trim() && !/Send \/queue first/.test(runReply), `/run 2: ${runReply.split("\n")[0]}`);
  const pendingResult = await say("/queue", "/result 3");
  expect(pendingResult.trim() && !/error/i.test(pendingResult), `/result on a pending task: ${pendingResult.split("\n")[0]}`);
  cli(["tick", "--once", "--no-notify"]);
  const ran = ids.find((id) => showJson(id).status === "completed");
  expect(ran, "/run 2 did not make a task due");
  const finished = await say(`/result ${ran}`);
  expect(/\bOK\b/.test(finished), `/result on the finished task: ${finished.split("\n")[0]}`);
  const cancelReply = await say("/queue", "/cancel 1");
  expect(cancelReply.trim() && !/Send \/queue first/.test(cancelReply), `/cancel 1: ${cancelReply.split("\n")[0]}`);
  expect(ids.some((id) => showJson(id).status === "cancelled"), "/cancel 1 cancelled nothing");
  s.skip("S5.6", "part: a number older than 10 minutes needs a 10-minute wait");
});

await step("S5.15", "/jobs lists recurring jobs; /jobs pause, resume and run act on job 1 or its id; bad grammar gets the usage line", async () => {
  const added = cli(["jobs", "add", "--title", "tg job", "--daily", "--prompt", "tg job", "--provider", "anthropic", "--json", "--db", s.qa.db]);
  expect(added.code === 0, `jobs add exit ${added.code}: ${added.stderr.trim().split("\n")[0]}`);
  const jobId = JSON.parse(added.stdout).job_id;
  const status = () => {
    const st = new TaskStore({ dbPath: s.qa.db });
    try {
      return st.getJob(jobId).status;
    } finally {
      st.close();
    }
  };
  const bad = [];
  try {
    const help = await say("/help");
    if (!help.includes("/jobs [pause|resume|run <n|id>]")) bad.push("/help misses /jobs");
    const list = await say("/jobs");
    if (!/^Jobs \(1 active\)\n1\. tg job - every day - next /.test(list)) bad.push(`/jobs: ${JSON.stringify(list.split("\n").slice(0, 2))}`);
    const paused = await say("/jobs", "/jobs pause 1");
    if (paused !== "Paused: tg job." || status() !== "paused") bad.push(`pause: "${paused}", status ${status()}`);
    const resumed = await say("/jobs", "/jobs resume 1");
    if (!/^Resumed: tg job\./.test(resumed) || status() !== "active") bad.push(`resume: "${resumed}", status ${status()}`);
    const ran = await say("/jobs", "/jobs run 1");
    if (ran !== "Runs at the next tick: tg job.") bad.push(`run: "${ran}"`);
    // Pause again so no due occurrence is left for the ticks of S5.14 and S5.13.
    const pausedAgain = await say("/jobs", `/jobs pause ${jobId}`);
    if (pausedAgain !== "Paused: tg job." || status() !== "paused") bad.push(`pause by id: "${pausedAgain}", status ${status()}`);
    const usage = await say("/jobs stop 1");
    if (!/^Usage: \/jobs/.test(usage)) bad.push(`bad grammar: "${usage}"`);
  } finally {
    // A throw before the last pause must not leave an active job for the ticks of S5.14 and S5.13.
    if (status() !== "paused") cli(["jobs", "pause", jobId, "--db", s.qa.db]);
  }
  expect(bad.length === 0, bad.join("; "));
});

await step("S5.14", "not-ready alert: a gap the machine slept through sends nothing; an awake gap alerts once; a manual tick --once says nothing; the next unit tick says running again", async () => {
  const now = readSleep();
  if (!now) return s.skip("S5.14", "no sleep counter on this platform");
  const ledger = (fn) => {
    const st = new TaskStore({ dbPath: s.qa.db });
    try {
      fn(st);
    } finally {
      st.close();
    }
  };
  // The last tick was the unit's, 21 minutes ago, with the reading it took then.
  const gap = (sleptMin) =>
    ledger((st) => {
      const at = Date.now() - 21 * 60_000;
      st.setMeta(LAST_TICK_META_KEY, new Date(at).toISOString());
      st.setMeta(TICK_SLEEP_META_KEY, JSON.stringify({ boot_at: now.boot_at, slept_ms: now.slept_ms - sleptMin * 60_000, at }));
      st.setMeta(TICK_BY_META_KEY, "unit");
    });
  const serve = () => expect(cli(["channels", "serve", "--once"], { timeout: 60_000 }).code === 0, "serve --once failed");
  // An empty long poll idles the harness's keep-alive socket past the fixture's timeout: retry once.
  const sent = () => tg.sent(CHAT).catch(() => tg.sent(CHAT));
  ledger((st) => st.deleteMeta("notified:not_ready"));
  const base = (await sent()).length;

  gap(19);
  serve();
  const slept = (await sent()).slice(base);
  expect(slept.length === 0, `sleep gap sent: ${JSON.stringify(slept)}`);

  gap(0);
  serve();
  serve();
  const alert = (await sent()).slice(base);
  // The sandbox's launchctl shim reports the unit not loaded, so the advice is `tidegap install`.
  expect(alert.length === 1 && /^Tidegap: the tick daemon is not running\./.test(alert[0]) && alert[0].includes("Run `tidegap install`."), `awake gap: ${JSON.stringify(alert)}`);

  // A tick from a shell proves nothing about the unit: no "running again".
  cli(["tick", "--once", "--no-notify"], { env: { XPC_SERVICE_NAME: "0", INVOCATION_ID: "" } });
  serve();
  const manual = (await sent()).slice(base);
  expect(manual.length === 1, `manual tick: ${JSON.stringify(manual)}`);

  // A tick the unit started (launchd sets XPC_SERVICE_NAME to the job label).
  cli(["tick", "--once", "--no-notify"], { env: { XPC_SERVICE_NAME: "com.tidegap.tick" } });
  serve();
  const after = (await sent()).slice(base);
  expect(after.length === 2 && after[1] === "Tidegap: the tick daemon is running again.", `recovery: ${JSON.stringify(after)}`);
});

await step("S5.13", "tick --daemon running; Integrations → Remove token; the next tick sends nothing (K3a)", async () => {
  const ui = s.spawnChild(process.execPath, [CLI, "ui", "--no-open", "--port", String(s.args.portBase), "--region", "FR"]);
  const page = await waitFor(() => /#token=([\w-]+)/.exec(ui.output)?.[1], 20_000);
  expect(page, "tidegap ui printed no page token");
  const d = s.spawnChild(process.execPath, [CLI, "tick", "--daemon", "--interval", "2", "--no-notify"]);
  const runOne = async (title) => {
    const id = await schedule(title);
    cli(["queue", "run-now", id]);
    await waitFor(() => showJson(id).status === "completed", 20_000, 500);
    await new Promise((r) => setTimeout(r, 1500));
  };
  const before = (await tg.sent(CHAT)).length;
  await runOne("tg daemon one");
  const afterFirst = (await tg.sent(CHAT)).length;
  expect(afterFirst > before, "the daemon sent no done message while paired (baseline)");
  const res = await fetch(`http://127.0.0.1:${s.args.portBase}/api/integrations/telegram/disconnect`, {
    method: "POST",
    headers: { authorization: `Bearer ${page}`, "content-type": "application/json" },
    body: JSON.stringify({ forget_token: true }),
  });
  expect(res.status === 200, `disconnect returned ${res.status}`);
  await runOne("tg daemon two");
  const afterRemove = (await tg.sent(CHAT)).length;
  d.kill("SIGTERM");
  ui.kill("SIGTERM");
  expect(afterRemove === afterFirst, `the daemon sent ${afterRemove - afterFirst} message(s) after Remove token`);
});

await step("S1.28", "channels remove <id> unpairs", async () => {
  writeEnvFile(s.home, [`TIDEGAP_TELEGRAM_BOT_TOKEN=${FAKE_TG_TOKEN}`]);
  const r = await pair((code) => [`/pair ${code}`]);
  expect(r.exit === 0, `re-pair exit ${r.exit}`);
  const rm = cli(["channels", "remove", `telegram-${CHAT}`]);
  expect(rm.code === 0, `remove exit ${rm.code}`);
  const list = JSON.parse(cli(["channels", "list", "--json"]).stdout).channels;
  expect(!list.some((c) => c.kind === "telegram"), "the chat is still listed");
});

await mcp?.close().catch(() => {});
await s.finish();
