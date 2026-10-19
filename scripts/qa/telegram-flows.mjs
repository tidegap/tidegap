#!/usr/bin/env node
// QA area "telegram": S5.2–S5.6, S5.13 and S1.28 against the fake Bot API
// (packages/core-ts/test/fixtures/fake-telegram.ts, run as a script on the
// stream's fake Telegram port). Prints `PASS` or the failed case ids + log path.
//
//   node scripts/qa/telegram-flows.mjs [--stream telegram] [--port-base 47902] [--log-dir <dir>] [--keep]

import { CLI, connectMcp, expect, FAKE_TG_TOKEN, scheduleTask, startFakeTelegram, startStream, waitFor, writeEnvFile } from "./env.mjs";

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
