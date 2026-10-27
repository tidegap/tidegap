#!/usr/bin/env node
// QA area "cli": the S1 iso cases, S9.2, S9.8, S13.10 (channels), S14.1 (region) and S20 (jobs) of the QA plan, in a temp
// HOME with a fake `claude`. Prints `PASS` or the failed case ids + log path.
//
//   node scripts/qa/cli-flows.mjs [--stream cli] [--port-base 47901] [--log-dir <dir>] [--keep]

import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import {
  CLI,
  CLI_VERSION,
  connectMcp,
  discoverCommands,
  expect,
  inHours,
  missingFromSiteTable,
  scheduleTask,
  startFakeSink,
  startStream,
  waitFor,
  writeEnvFile,
} from "./env.mjs";

const s = startStream("cli-flows", { portBase: 47901 });
const { cli, step, home } = s;
const noStack = (r) => !/\n\s+at .+\(.+:\d+:\d+\)/.test(r.stderr + r.stdout);
const oneLineError = (r) => r.code !== 0 && noStack(r) && (r.stderr.trim() || r.stdout.trim()).split("\n").length <= 2;
const showJson = s.show;
const listJson = (...a) => JSON.parse(cli(["queue", "list", "--json", ...a]).stdout).tasks;

let mcp;
const schedule = async (args) => {
  mcp ??= await connectMcp(s, s.qa.db);
  return scheduleTask(mcp.call, args);
};

// Fresh home first: status and tick run before anything creates ~/.tidegap.

await step("S1.1", "tidegap --version", () => {
  const r = cli(["--version"]);
  expect(r.code === 0 && r.stdout.trim() === CLI_VERSION, `printed "${r.stdout.trim()}", want ${CLI_VERSION}`);
});

await step("S1.2", "--help on every command; the site CLI table lists them", () => {
  const leaves = [...discoverCommands(cli).keys()];
  expect(leaves.length >= 20, `only ${leaves.length} commands found in --help`);
  const missing = missingFromSiteTable(leaves);
  expect(missing.length === 0, `site CLI table misses: ${missing.join(", ")}`);
});

await step("S1.3", "status on a fresh home", () => {
  const r = cli(["status"]);
  expect(r.code !== 0, "status exited 0 on a fresh home");
  expect(/no tick daemon/.test(r.stdout + r.stderr), "no 'no tick daemon' line");
  expect(/tidegap install/.test(r.stdout + r.stderr), "no `tidegap install` fix line");
});

await step("S1.9", "tick --once on a fresh home, then status shows the tick", () => {
  const r = cli(["tick", "--once", "--no-notify"]);
  expect(r.code === 0, `tick exit ${r.code}: ${(r.stderr || r.stdout).trim().split("\n")[0]}`);
  expect(noStack(r), "stack trace in the output");
  const st = cli(["status"]);
  expect(!/Last tick:\s+never/.test(st.stdout), "status still says Last tick: never");
});

await step("S1.5", "install --no-load writes the unit, loads nothing, is idempotent", () => {
  const unit =
    process.platform === "darwin"
      ? join(home, "Library", "LaunchAgents", "com.tidegap.tick.plist")
      : join(home, ".config", "systemd", "user", "tidegap-tick.service");
  const r1 = cli(["install", "--no-load"]);
  expect(r1.code === 0, `install exit ${r1.code}`);
  expect(existsSync(unit), `no unit file under the temp home`);
  const first = readFileSync(unit, "utf8");
  const r2 = cli(["install", "--no-load"]);
  expect(r2.code === 0, `second install exit ${r2.code}`);
  expect(readFileSync(unit, "utf8") === first, "second run changed the unit file");
  const loads = s.qa.shimCalls().filter((l) => /^launchctl (bootstrap|load|kickstart)/.test(l));
  expect(loads.length === 0, `install --no-load ran: ${loads.join("; ")}`);
});

let ranId;
await step("S1.10", "claude-code task, run-now, tick --once with the fake claude", async () => {
  ranId = await schedule({ prompt: "Reply with the word OK", title: "qa cli ok" });
  expect(cli(["queue", "run-now", ranId]).code === 0, "run-now failed");
  const t = cli(["tick", "--once", "--no-notify"]);
  expect(t.code === 0 && /1 dispatched/.test(t.stdout), `tick: ${t.stdout.trim()}`);
  const rec = showJson(ranId);
  expect(rec.status === "completed", `status ${rec.status}`);
  expect(rec.receipt?.signature, "no signed receipt");
  const human = cli(["queue", "show", ranId, "--no-mark-read"]);
  expect(/\bOK\b/.test(human.stdout), "queue show does not print the result");
});

await step("S1.19", "run-now records event expedited, actor cli, and the tick runs it", () => {
  expect(ranId, "S1.10 did not queue a task");
  const ev = showJson(ranId).events ?? [];
  expect(ev.some((e) => e.kind === "expedited" && e.actor === "cli"), `events: ${ev.map((e) => `${e.kind}/${e.actor}`).join(",")}`);
  expect(ev.some((e) => e.kind === "completed"), "no completed event");
});

await step("S1.12", "tick --daemon --interval 2: three cycles, SIGTERM exits 0", async () => {
  const d = s.spawnChild(process.execPath, [CLI, "tick", "--daemon", "--interval", "2", "--no-notify"]);
  const ticks = () => (d.output.match(/^tick: /gm) ?? []).length;
  await waitFor(() => ticks() >= 3, 15_000);
  expect(ticks() >= 3, `${ticks()} tick lines in 15 s`);
  const exited = new Promise((ok) => d.once("exit", (code, sig) => ok({ code, sig })));
  d.kill("SIGTERM");
  const { code, sig } = await exited;
  expect(code === 0, `exit ${code} signal ${sig}`);
});

const seed = join(home, "seed.db");
const seeded = s.seedLedger(seed);

await step("S1.13", "queue list filters on a seeded ledger", () => {
  expect(seeded, "ui-seed failed");
  const all = listJson("--db", seed);
  expect(all.length >= 5, `${all.length} seeded rows`);
  const completed = listJson("--db", seed, "--status", "completed");
  expect(completed.length > 0 && completed.every((t) => t.status === "completed"), "--status completed");
  const quota = listJson("--db", seed, "--kind", "quota_reset");
  expect(quota.length > 0 && quota.every((t) => t.deadline_kind === "quota_reset"), "--kind quota_reset");
  const unread = listJson("--db", seed, "--unread");
  expect(unread.length > 0 && unread.every((t) => !t.read_at && ["completed", "failed"].includes(t.status)), "--unread");
  const series = all.find((t) => t.series_id)?.series_id;
  expect(series, "no seeded series");
  const occ = listJson("--db", seed, "--series", series);
  expect(occ.length > 0 && occ.every((t) => t.series_id === series), "--series");
  const bad = cli(["queue", "list", "--db", seed, "--status", "bogus"]);
  expect(oneLineError(bad), `bad --status: exit ${bad.code}, not a one-line error`);
  const badKind = cli(["queue", "list", "--db", seed, "--kind", "bogus"]);
  expect(oneLineError(badKind), `bad --kind: exit ${badKind.code}, not a one-line error`);
});

await step("S1.23", "stats and stats --json match the seeded receipts", () => {
  expect(seeded, "ui-seed failed");
  const human = cli(["stats", "--db", seed]);
  expect(human.code === 0, `stats exit ${human.code}`);
  const st = JSON.parse(cli(["stats", "--json", "--db", seed]).stdout).stats;
  const receipts = cli(["receipts", "list", "--db", seed]);
  expect(receipts.code === 0, `receipts list exit ${receipts.code}`);
  const withReceipt = listJson("--db", seed, "--status", "completed").filter((t) => showJson(t.task_id, seed).receipt).length;
  expect(st.taskCount === withReceipt, `stats taskCount ${st.taskCount}, completed tasks with a receipt ${withReceipt}`);
});

await step("S1.17", "queue later: every form moves later, never earlier", async () => {
  const id = await schedule({ prompt: "later target", title: "qa later", deadline: inHours(96) });
  const at = () => Date.parse(showJson(id).scheduledFor ?? "");
  const forms = [
    ["--until", "+2h"],
    ["--until", "tonight"],
    ["--until", "tomorrow"],
    ["--until", "23:30"],
    ["--preset", "1h"],
    ["--delay", "30"],
    ["--until", "after-limit-reset", "--reset-at", "23:45"],
    ["--preset", "after_limit_reset", "--reset-at", "23:45"],
  ];
  const bad = [];
  for (const f of forms) {
    const before = at();
    const r = cli(["queue", "later", id, ...f]);
    const after = at();
    const refused = /already planned for/i.test(r.stdout + r.stderr);
    if (after < before) bad.push(`${f.join(" ")} moved earlier`);
    else if (r.code !== 0 && !refused) bad.push(`${f.join(" ")} exit ${r.code}: ${(r.stderr || r.stdout).trim().split("\n")[0]}`);
    else if (!noStack(r)) bad.push(`${f.join(" ")} stack trace`);
  }
  // `+<dur>` counts from the planned start; an earlier target needs an absolute time.
  const earlier = cli(["queue", "later", id, "--until", inHours(0.2)]);
  if (!/already planned for (\d{4}-\d{2}-\d{2} )?\d{1,2}:\d{2}/i.test(earlier.stdout + earlier.stderr)) bad.push("an earlier target did not get 'already planned for HH:MM'");
  expect(bad.length === 0, bad.join("; "));
});

await step("S1.26", "register-wake --dry-run prints pmset and runs nothing", async () => {
  const id = await schedule({ prompt: "wake target", title: "qa wake" });
  const r = cli(["register-wake", id, "--dry-run"]);
  expect(r.code === 0, `exit ${r.code}`);
  expect(/pmset/.test(r.stdout), "no pmset command printed");
  const ran = s.qa.shimCalls().filter((l) => /^pmset (schedule|repeat|-a|-b|-c)/.test(l) || /^pmset .*wake/.test(l) || /^sudo .*pmset/.test(l));
  expect(ran.length === 0, `pmset ran: ${ran.join("; ")}`);
});

await step("S1.27", "clients add / list / revoke; a revoked token gets 401", async () => {
  const added = cli(["clients", "add", "--name", "qa", "--kind", "extension", "--json"]);
  const { client_id: cid, token } = JSON.parse(added.stdout);
  expect(/^tgc_/.test(token ?? ""), "no tgc_ token");
  const list = cli(["clients", "list", "--json"]);
  expect(list.stdout.includes(cid) && !list.stdout.includes(token), "list misses the client or shows the token");
  const ui = s.spawnChild(process.execPath, [CLI, "ui", "--no-open", "--port", String(s.args.portBase), "--region", "FR"]);
  await waitFor(() => /tidegap ui:/.test(ui.output), 20_000);
  expect(/tidegap ui:/.test(ui.output), "tidegap ui did not start");
  const get = () => fetch(`http://127.0.0.1:${s.args.portBase}/api/summary`, { headers: { authorization: `Bearer ${token}` } }).then((r) => r.status);
  expect((await get()) === 200, "the new client token is refused");
  expect(cli(["clients", "revoke", cid]).code === 0, "revoke failed");
  const after = await get();
  ui.kill("SIGTERM");
  expect(after === 401, `revoked token got ${after}`);
});

await step("S1.29", "error paths: unknown id, bad --until, missing option", () => {
  const cases = [
    ["queue", "show", "t-nope"],
    ["queue", "cancel", "t-nope"],
    ["queue", "later", ranId ?? "t-nope", "--until", "whenever"],
    ["clients", "add", "--name", "x"],
    ["verify", "t-nope"],
  ];
  const bad = cases.filter((c) => !oneLineError(cli(c))).map((c) => c.join(" "));
  expect(bad.length === 0, `not a one-line error: ${bad.join("; ")}`);
});

await step("S1.30", "--db uses that ledger only", () => {
  const other = join(home, "other", "queue.db");
  mkdirSync(join(home, "other"), { recursive: true });
  const homeDb = s.qa.db;
  const stamp = () => [homeDb, `${homeDb}-wal`].map((p) => (existsSync(p) ? `${statSync(p).mtimeMs}:${statSync(p).size}` : "-")).join("|");
  const before = stamp();
  const cmds = [
    ["status", "--db", other],
    ["tick", "--once", "--no-notify", "--db", other],
    ["queue", "list", "--db", other],
    ["receipts", "list", "--db", other],
    ["stats", "--db", other],
    ["channels", "list", "--db", other],
  ];
  const failed = cmds.filter((c) => {
    const r = cli(c);
    return c[0] === "status" ? !noStack(r) : r.code !== 0;
  });
  expect(failed.length === 0, `failed: ${failed.map((c) => c.slice(0, 2).join(" ")).join("; ")}`);
  expect(existsSync(other), "the --db ledger was not created");
  expect(stamp() === before, "the temp home ledger changed");
});

const HOOK = "/hook/qa-cli-sEcReT-6620";
let sink;
await step("S13.10", "channels add webhook --format text --secrets-stdin: exit 0, the sink gets the test message", async () => {
  sink = await startFakeSink(s, s.qa.ports.sink);
  const r = cli(["channels", "add", "webhook", "--format", "text", "--secrets-stdin"], { input: JSON.stringify({ url: `${sink.base}${HOOK}` }) });
  expect(r.code === 0 && r.stdout.startsWith("Connected webhook. Test message sent."), `exit ${r.code}: ${(r.stdout + r.stderr).split("\n")[0]}`);
  const reqs = await sink.requests(HOOK);
  expect(reqs.length === 1 && JSON.parse(reqs[0].body).text === "Test message from Tidegap. Notifications work.", `sink got ${reqs.length} request(s)`);
  expect(!(r.stdout + r.stderr).includes(HOOK), "the output shows the secret URL");
});

await step("S13.10b", "channels add slack --url <value>: usage error, exit 2, the value is not echoed", () => {
  const r = cli(["channels", "add", "slack", "--url", "https://hooks.slack.com/services/T0/B0/qaSeCrEt"]);
  expect(r.code === 2 && /unknown option --url/.test(r.stderr), `exit ${r.code}: ${r.stderr.trim()}`);
  expect(!(r.stdout + r.stderr).includes("qaSeCrEt"), "the value was echoed");
  const email = cli(["channels", "add", "email", "--preset", "gmail", "--user", "qa@example.com"], { input: "" });
  expect(email.code === 2 && /--secrets-stdin/.test(email.stderr), `email without stdin: exit ${email.code}`);
});

await step("S13.10c", "channels list --json has hints only; set, disconnect, test, connect and remove work by id", async () => {
  const list = JSON.parse(cli(["channels", "list", "--json"]).stdout).channels;
  const hook = list.find((c) => c.id === "webhook");
  expect(hook?.state === "connected" && hook.fields?.format === "text", `list: ${JSON.stringify(hook)}`);
  expect(!JSON.stringify(list).includes(HOOK), "list --json shows the secret URL");
  expect(cli(["channels", "set", "webhook", "--events", "task_failed", "--quiet", "night"]).code === 0, "set failed");
  expect(cli(["channels", "disconnect", "webhook"]).code === 0, "disconnect failed");
  expect(cli(["channels", "test", "webhook"]).code === 1, "test on a disconnected channel did not exit 1");
  expect(cli(["channels", "connect", "webhook"]).code === 0, "connect failed");
  expect(cli(["channels", "test", "webhook"]).code === 0, "test failed");
  expect((await sink.requests(HOOK)).length === 3, `sink got ${(await sink.requests(HOOK)).length} request(s), want 3`);
  const after = JSON.parse(cli(["channels", "list", "--json"]).stdout).channels.find((c) => c.id === "webhook");
  expect(after.events.join() === "task_failed" && after.quiet === "night", `stored: ${after.events} ${after.quiet}`);
  expect(cli(["channels", "remove", "webhook"]).code === 0, "remove failed");
  const secrets = join(home, ".config", "tidegap", "channel-secrets.json");
  expect(!existsSync(secrets) || !readFileSync(secrets, "utf8").includes(HOOK), "the secret is still in channel-secrets.json");
});

await step("S14.1", "region show / set / detect under TZ=Europe/Kyiv; set UA exits 2", () => {
  const kyiv = { env: { TZ: "Europe/Kyiv", TIDEGAP_DEFAULT_REGION: "" } };
  const show = () => JSON.parse(cli(["region", "show", "--json"], kyiv).stdout);
  const first = show();
  expect(first.effective === "PL" && first.source === "timezone" && first.approximate?.country === "UA", `show: ${JSON.stringify(first)}`);
  const set = cli(["region", "set", "fr"], kyiv);
  expect(set.code === 0 && /^Region set to France \(FR\)\./.test(set.stdout), `set fr: ${set.code} ${set.stdout.split("\n")[0]}`);
  const config = readFileSync(join(home, ".tidegap", "config"), "utf8");
  expect(/^TIDEGAP_DEFAULT_REGION=FR$/m.test(config), "config has no TIDEGAP_DEFAULT_REGION=FR line");
  const after = show();
  expect(after.effective === "FR" && after.source === "setting", `show after set: ${after.effective} ${after.source}`);
  const detect = cli(["region", "detect"], kyiv);
  expect(detect.code === 0 && detect.stdout.startsWith("PL Poland"), `detect: ${detect.stdout.split("\n")[0]}`);
  const ua = cli(["region", "set", "UA"], kyiv);
  expect(ua.code === 2 && /Closest: PL\./.test(ua.stderr) && oneLineError(ua), `set UA: exit ${ua.code} ${ua.stderr.trim()}`);
  const auto = cli(["region", "set", "auto"], kyiv);
  expect(auto.code === 0 && show().source === "timezone", "set auto did not clear the setting");
  expect(cli(["region", "list"]).stdout.trim().split("\n").length === 31, "region list is not 31 zones");
});

await step("S9.2", "modelUsage with two models: receipt model and tokens describe the same run", async () => {
  const variant = join(home, "fake-claude-two-models");
  const reply = {
    type: "result",
    subtype: "success",
    is_error: false,
    result: "OK",
    session_id: "0b6f2c1e-5d1a-4c0e-9a51-3f7e8d2c4b11",
    total_cost_usd: 0.002,
    usage: { input_tokens: 40, cache_creation_input_tokens: 1000, cache_read_input_tokens: 0, output_tokens: 50 },
    modelUsage: {
      "claude-sonnet-5": { inputTokens: 40, outputTokens: 50, cacheCreationInputTokens: 1000, costUSD: 0.0015 },
      "claude-haiku-5-5": { inputTokens: 3000, outputTokens: 900, costUSD: 0.0005 },
    },
  };
  writeFileSync(join(home, "two-models.json"), JSON.stringify(reply));
  writeFileSync(variant, `#!/bin/sh\ncat > /dev/null\ncat "${join(home, "two-models.json")}"\n`);
  chmodSync(variant, 0o755);
  const id = await schedule({ prompt: "two models", title: "qa two models" });
  cli(["queue", "run-now", id]);
  cli(["tick", "--once", "--no-notify"], { env: { TIDEGAP_CLAUDE_BIN: variant } });
  const r = showJson(id).receipt;
  expect(r, "no receipt");
  const u = reply.modelUsage[r.model];
  expect(u, `receipt model ${r.model} is not in modelUsage`);
  const named = (u.inputTokens ?? 0) + (u.cacheCreationInputTokens ?? 0) + (u.outputTokens ?? 0);
  s.note(`S9.2 receipt model=${r.model} totalTokens=${r.totalTokens}; that model's own tokens=${named}`);
  expect(r.totalTokens === named, `receipt names ${r.model} (${named} tokens) but counts ${r.totalTokens} tokens of another model (K4)`);
});

await step("S9.8", "a changed env-file setting reaches the next tick of a running daemon (K3b)", async () => {
  const fc = join(home, "fc-s98");
  const envFile = writeEnvFile(home, ["TIDEGAP_CLAUDE_CODE_MAX_BUDGET_USD=1.5"]);
  const d = s.spawnChild(process.execPath, [CLI, "tick", "--daemon", "--interval", "2", "--no-notify"], { env: { FAKE_CLAUDE_LOG: fc } });
  const runOnce = async (title) => {
    const id = await schedule({ prompt: title, title });
    cli(["queue", "run-now", id]);
    await waitFor(() => showJson(id).status === "completed", 20_000, 500);
  };
  const budget = (n) => {
    const argv = existsSync(join(fc, `argv.${n}`)) ? readFileSync(join(fc, `argv.${n}`), "utf8").split("\n") : [];
    return argv[argv.indexOf("--max-budget-usd") + 1];
  };
  await runOnce("qa env one");
  expect(budget(1) === "1.5", `first run budget ${budget(1)}, want 1.5`);
  writeFileSync(envFile, "TIDEGAP_CLAUDE_CODE_MAX_BUDGET_USD=2.5\n", { mode: 0o600 });
  await runOnce("qa env two");
  d.kill("SIGTERM");
  s.note(`S9.8 budget after the env file change: ${budget(2)} (file says 2.5)`);
  expect(budget(2) === "2.5", `the daemon kept ${budget(2)} after the env file changed to 2.5`);
});

await step("S20", "jobs: a prompt job and a command job run on one tick with their successors; pause, resume, remove; the secret value never shows", () => {
  const SECRET = "qa-job-secret-Z8r2Lw";
  const outputs = [];
  const run = (args, opts) => {
    const r = cli(args, opts);
    outputs.push(r.stdout, r.stderr);
    return r;
  };
  /** Jobs this case made; `finally` removes the ones a failure left behind, and the secret. */
  const created = [];
  const json = (args) => {
    const r = run([...args, "--json"]);
    expect(r.code === 0, `tidegap ${args.join(" ")}: exit ${r.code} ${r.stderr.trim().split("\n")[0] ?? ""}`);
    return JSON.parse(r.stdout);
  };
  try {
    const set = run(["jobs", "secrets", "set", "QA_JOB_SECRET"], { input: `${SECRET}\n` });
    expect(set.code === 0 && set.stdout.trim() === "secret QA_JOB_SECRET saved", `secrets set: ${set.stdout.trim()}`);
    const prompt = json(["jobs", "add", "--title", "qa prompt job", "--every", "6h", "--prompt", "Reply with the word OK"]);
    created.push(prompt.job_id);
    const command = json(["jobs", "add", "--title", "qa command job", "--daily", "--command", 'echo "token=$QA_JOB_SECRET ok"', "--secret", "QA_JOB_SECRET"]);
    created.push(command.job_id);
    expect(command.missing_secrets.length === 0, `missing secrets: ${command.missing_secrets}`);
    expect(prompt.guarantee === "runs at least every 6 h, never sooner than 3 h after the last run", `guarantee: ${prompt.guarantee}`);
    for (const job of [prompt, command]) expect(run(["jobs", "run", job.job_id]).code === 0, `jobs run ${job.job_id} failed`);
    const t = run(["tick", "--once", "--no-notify"]);
    expect(t.code === 0, `tick: ${t.stdout.trim()}`);
    for (const job of [prompt, command]) {
      const first = showJson(`${job.job_id}~1`);
      expect(first.status === "completed", `${job.job_id}~1 is ${first.status}: ${first.error ?? ""}`);
      const now = json(["jobs", "show", job.job_id]);
      expect(now.next_run?.task_id === `${job.job_id}~2`, `${job.job_id}: next run ${now.next_run?.task_id}, want ~2 (successor in the same tick)`);
      expect(now.last_run?.outcome === "ok", `${job.job_id}: last run ${now.last_run?.outcome}`);
    }
    const cmdResult = run(["queue", "show", `${command.job_id}~1`, "--no-mark-read"]).stdout;
    expect(/token=\[redacted\] ok/.test(cmdResult), "the command output is not scrubbed to [redacted]");
    const history = run(["jobs", "history", command.job_id]);
    expect(new RegExp(`${command.job_id}~1 +completed .+${command.job_id}~1`).test(history.stdout), "history lists no receipt id for run 1");
    expect(/paused/.test(run(["jobs", "pause", prompt.job_id]).stdout), "pause");
    expect(json(["jobs", "show", prompt.job_id]).next_run === null, "a paused job kept a pending run");
    const refused = run(["jobs", "run", prompt.job_id]);
    expect(refused.code === 1 && refused.stderr.trim() === "job is paused", `run on a paused job: exit ${refused.code} ${refused.stderr.trim()}`);
    expect(/resumed/.test(run(["jobs", "resume", prompt.job_id]).stdout), "resume");
    for (const job of [prompt, command]) expect(run(["jobs", "remove", job.job_id]).code === 0, `remove ${job.job_id}`);
    expect(json(["jobs", "list"]).jobs.length === 0, "removed jobs still listed");
    const usage = run(["jobs", "add", "--title", "x", "--every", "1h", "--prompt", "p"]);
    expect(usage.code === 2 && /every N hours/.test(usage.stderr), `--every 1h: exit ${usage.code}`);
    const hits = [...outputs, readFileSync(s.logPath, "utf8")].filter((o) => o.includes(SECRET)).length;
    s.note(`S20 jobs ${prompt.job_id} ${command.job_id}; secret value hits in output and QA log: ${hits}`);
    expect(hits === 0, `the secret value shows ${hits} times in output or the QA log`);
  } finally {
    // A failed case must not leave jobs or the secret for the next case.
    let left;
    try {
      left = new Set((JSON.parse(cli(["jobs", "list", "--json"]).stdout).jobs ?? []).map((j) => j.job_id));
    } catch {
      left = new Set(created);
    }
    for (const id of created) if (left.has(id)) cli(["jobs", "remove", id]);
    cli(["jobs", "secrets", "remove", "QA_JOB_SECRET"]);
  }
});

await mcp?.close().catch(() => {});
await s.finish();
