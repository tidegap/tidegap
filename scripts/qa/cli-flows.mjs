#!/usr/bin/env node
// QA area "cli": the S1 iso cases (S1.32: `usage install-hook` in the sandbox ~/.claude), S9.2, S9.8, S13.10 (channels), S14.1 (region), S20 (jobs) and S29 (session
// notices, the watch commands, `queue add`, progress and the wake) of the QA plan, in a temp HOME with a fake `claude`. Prints `PASS` or
// the failed case ids + log path.
//
//   node scripts/qa/cli-flows.mjs [--stream cli] [--port-base 47901] [--log-dir <dir>] [--keep]

import { spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import {
  CLI,
  CLI_VERSION,
  CORE,
  connectMcp,
  discoverCommands,
  expect,
  inHours,
  missingFromSiteTable,
  ROOT,
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

await step("S1.32", "usage install-hook wraps a statusLine that prints a marker; the stored command prints it and records usage.json; --remove restores the seed", () => {
  const settings = join(home, ".claude", "settings.json");
  mkdirSync(join(home, ".claude"), { recursive: true });
  const marker = "qa marker: it's $5";
  const seedText = `${JSON.stringify({ model: "opus", statusLine: { type: "command", command: `printf '%s\\n' "qa marker: it's \\$5"`, padding: 1 } }, null, 2)}\n`;
  writeFileSync(settings, seedText);
  const r = cli(["usage", "install-hook"]);
  expect(r.code === 0 && r.stdout.startsWith("Wrapped your Claude Code statusLine in the Tidegap usage hook"), `install-hook exit ${r.code}: ${(r.stdout + r.stderr).trim().split("\n")[0]}`);
  const stored = JSON.parse(readFileSync(settings, "utf8")).statusLine;
  expect(stored.padding === 1 && stored.command.startsWith("sh -c '"), `stored: ${JSON.stringify(stored).slice(0, 120)}`);
  // As Claude Code runs it: through sh, its JSON on stdin. The sandbox sets TIDEGAP_USAGE=off, which
  // records nothing; this one child runs with it cleared (`usage hook` reads no Keychain).
  const env = { ...s.env };
  delete env.TIDEGAP_USAGE;
  const input = readFileSync(join(ROOT, "packages", "cli", "test", "fixtures", "usage", "statusline-input.json"));
  const ran = spawnSync("/bin/sh", ["-c", stored.command], { input, env, encoding: "utf8", cwd: home, timeout: 20_000 });
  s.log(`$ sh -c <stored statusLine command> → exit ${ran.status}\n  | ${(ran.stdout ?? "").trim()}`);
  expect(ran.status === 0 && ran.stdout === `${marker}\n`, `stored command: exit ${ran.status}, printed ${JSON.stringify(ran.stdout)}`);
  const usage = JSON.parse(readFileSync(join(home, ".tidegap", "usage.json"), "utf8"));
  expect(usage.claude?.statusline?.data?.five_hour?.pct === 72, "usage.json holds no five_hour reading");
  const again = cli(["usage", "install-hook"]);
  expect(again.code === 0 && again.stdout.startsWith("Already registered"), `second install-hook: ${again.stdout.trim()}`);
  const rm = cli(["usage", "install-hook", "--remove"]);
  expect(rm.code === 0 && readFileSync(settings, "utf8") === seedText, `--remove exit ${rm.code}; the file differs from the seed`);
});

/** Screen text from a terminal: no cursor escapes, `\r\n` as `\n`. */
// eslint-disable-next-line no-control-regex
const screen = (out) => out.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "").replace(/\r\n/g, "\n");

await step("S1.33", "install in a terminal: Ctrl-D at the statusLine question answers no", async () => {
  if (process.platform !== "darwin" || spawnSync("/bin/sh", ["-c", "command -v script"]).status !== 0) {
    return s.skip("S1.33", "needs the macOS script(1) for a terminal; the unit test covers the question");
  }
  // S1.32 left its seed: the user's own statusLine, so install asks to wrap it.
  const settings = join(home, ".claude", "settings.json");
  const before = readFileSync(settings);
  // macOS script(1) refuses a socket as its stdin, and Node's pipes are sockets: cat hands it a real pipe.
  // The node and CLI paths reach the shell through the environment, never as part of the program.
  const child = spawn("/bin/sh", ["-c", 'cat | exec script -q /dev/null "$S133_NODE" "$S133_CLI" install --no-load'], {
    env: { ...s.env, S133_NODE: process.execPath, S133_CLI: CLI },
    cwd: home,
    stdio: ["pipe", "pipe", "pipe"],
  });
  let out = "";
  child.stdout.on("data", (d) => (out += d));
  child.stderr.on("data", (d) => (out += d));
  const exited = new Promise((ok) => child.once("exit", (code) => ok(code)));
  // Ctrl-D only once the question shows: readline has the terminal by then. Earlier, the terminal itself would take it.
  const asked = await waitFor(() => out.includes("[y/N] "), 30_000);
  if (asked) child.stdin.write("\x04");
  await waitFor(() => / run: .*usage install-hook/.test(out.slice(out.indexOf("[y/N] "))), 15_000);
  child.stdin.end();
  const code = await Promise.race([exited, new Promise((ok) => setTimeout(() => ok("no exit in 15 s"), 15_000))]);
  if (typeof code !== "number") child.kill("SIGKILL");
  const shown = screen(out);
  const after = shown.slice(shown.lastIndexOf("[y/N] "));
  s.log(`$ script -q /dev/null tidegap install --no-load, Ctrl-D at [y/N] → exit ${code}\n  | ${after.trim().replace(/\n/g, "\n  | ")}`);
  expect(asked, `no [y/N] question: ${shown.slice(-300)}`);
  expect(code === 0, `exit ${code}`);
  expect(/^\[y\/N\] \nSkipped\. To connect later, run: .+usage install-hook\n/.test(after), `after the question: ${JSON.stringify(after.slice(0, 200))}`);
  expect(readFileSync(settings).equals(before), "settings.json changed");
});

await step("S1.34", "the stored statusLine command prints the user's line when the Tidegap launcher fails", async () => {
  const { guardedCommand } = await import(pathToFileURL(join(ROOT, "packages", "cli", "dist", "commands", "statusline-setup.js")).href);
  // A runtime that is there but fails: node runs a script that exits 1 and prints nothing.
  const failing = join(home, "s134-tidegap.cjs");
  writeFileSync(failing, "process.exit(1);\n");
  const stored = guardedCommand([process.execPath, failing], "printf '%s\\n' 's134 marker'");
  const input = readFileSync(join(ROOT, "packages", "cli", "test", "fixtures", "usage", "statusline-input.json"));
  const ran = spawnSync("/bin/sh", ["-c", stored], { input, env: s.env, encoding: "utf8", cwd: home, timeout: 20_000 });
  s.log(`$ sh -c <stored statusLine command over a launcher that exits 1> → exit ${ran.status}\n  | ${(ran.stdout ?? "").trim()}`);
  expect(ran.status === 0 && ran.stdout === "s134 marker\n", `exit ${ran.status}, printed ${JSON.stringify(ran.stdout)}`);
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

await step("S9.2", "modelUsage with two models: the receipt bills both and lists each with its own tokens", async () => {
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
  // Per model: input + cache writes (cache reads stay out), and output.
  const own = Object.entries(reply.modelUsage).map(([model, u]) => ({
    model,
    inputTokens: (u.inputTokens ?? 0) + (u.cacheCreationInputTokens ?? 0),
    outputTokens: u.outputTokens ?? 0,
  }));
  const sum = own.reduce((n, m) => n + m.inputTokens + m.outputTokens, 0);
  const listed = (r.models ?? []).map((m) => `${m.model}:${m.inputTokens}/${m.outputTokens}`);
  s.note(`S9.2 receipt model=${r.model} totalTokens=${r.totalTokens} (sum over models ${sum}); models ${listed.join(", ")}`);
  expect(r.totalTokens === sum, `receipt counts ${r.totalTokens} tokens, the models used ${sum}`);
  expect(r.model === "claude-haiku-5-5", `receipt model ${r.model} is not the model with the most output tokens`);
  expect(
    listed.join(",") === "claude-haiku-5-5:3000/900,claude-sonnet-5:1040/50",
    `receipt models ${listed.join(", ")} are not both models with their own tokens, most output first`,
  );
  expect((r.models ?? []).every((m) => typeof m.carbonGCo2 === "number"), "a receipt model has no grams");
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

// S29: a session follows the tasks it handed off. S29.1 and S29.2 read a seeded two-session
// ledger; S29.3 and S29.4 run a fake-claude task through tick --once on the home ledger.
const S29_DB = join(home, "s29.db");
const SA = "qa000029-aaaa-4000-8000-00000000000a";
const SB = "qa000029-bbbb-4000-8000-00000000000b";
const s29Seeded = await (async () => {
  const { TaskStore } = await import(pathToFileURL(CORE).href);
  const store = new TaskStore({ dbPath: S29_DB });
  try {
    const row = (taskId, status, session, extra = {}) => ({
      taskId,
      status,
      enqueuedAt: new Date(Date.now() - 600_000).toISOString(),
      scheduledFor: inHours(3),
      deadline: inHours(6),
      region: "FR",
      title: `qa ${taskId}`,
      originSessionId: session,
      bodyJson: JSON.stringify({ type: "provider_call", provider: "anthropic", model: "m", prompt: "p", origin: { agent: "claude-code", via: "env" } }),
      ...extra,
    });
    store.upsert(row("t-s29-a1", "scheduled", SA), { kind: "created", actor: "agent:mcp" });
    store.recordEvent("t-s29-a1", { kind: "postponed", actor: "page", details: { preset: "1h" } });
    store.recordEvent("t-s29-a1", { kind: "expedited", actor: "cli" });
    store.upsert(row("t-s29-a2", "completed", SA, { completedAt: new Date().toISOString(), result: { text: "done" } }), { kind: "completed", actor: "tick" });
    store.upsert(row("t-s29-b1", "scheduled", SB), { kind: "created", actor: "agent:mcp" });
    return true;
  } finally {
    store.close();
  }
})().catch((err) => {
  s.log(`S29 seed failed: ${err.message}`);
  return false;
});

await step("S29.1", "queue list --json --session filters a seeded two-session ledger", () => {
  expect(s29Seeded, "the S29 seed failed");
  const a = cli(["queue", "list", "--json", "--db", S29_DB, "--session", SA]);
  expect(a.code === 0, `--session ${SA}: exit ${a.code}`);
  const json = JSON.parse(a.stdout);
  expect(json.session_id === SA, `session_id ${json.session_id}`);
  expect(json.tasks.map((t) => t.task_id).join(",") === "t-s29-a1,t-s29-a2", `tasks ${json.tasks.map((t) => t.task_id)}`);
  expect(json.tasks.every((t) => "status" in t && "scheduled_for" in t), "a task without status or scheduled_for");
  const current = JSON.parse(cli(["queue", "list", "--json", "--db", S29_DB, "--session", "current"], { env: { CLAUDE_CODE_SESSION_ID: SB } }).stdout);
  expect(current.session_id === SB && current.tasks.map((t) => t.task_id).join(",") === "t-s29-b1", `--session current: ${JSON.stringify(current).slice(0, 200)}`);
  const outside = cli(["queue", "list", "--json", "--db", S29_DB, "--session", "current"]);
  expect(outside.code === 2 && /--session <id>/.test(outside.stderr), `outside a session: exit ${outside.code} ${outside.stderr.trim()}`);
});

await step("S29.2", "queue events --json and --after on a seeded task", () => {
  expect(s29Seeded, "the S29 seed failed");
  const r = cli(["queue", "events", "t-s29-a1", "--json", "--db", S29_DB]);
  expect(r.code === 0, `events exit ${r.code}`);
  const json = JSON.parse(r.stdout);
  expect(json.task_id === "t-s29-a1" && json.status === "scheduled" && json.scheduled_for, `envelope ${r.stdout.slice(0, 200)}`);
  expect(json.events.map((e) => e.kind).join(",") === "created,postponed,expedited", `kinds ${json.events.map((e) => e.kind)}`);
  const after = JSON.parse(cli(["queue", "events", "t-s29-a1", "--json", "--db", S29_DB, "--after", String(json.events[0].id)]).stdout);
  expect(after.events.map((e) => e.kind).join(",") === "postponed,expedited", `--after: ${after.events.map((e) => e.kind)}`);
  const text = cli(["queue", "events", "t-s29-a1", "--db", S29_DB]).stdout.trim().split("\n");
  expect(text.length === 3 && text[0].startsWith(`${json.events[0].id} `), `text form: ${text[0]}`);
  const missing = cli(["queue", "events", "t-s29-none", "--db", S29_DB]);
  expect(missing.code === 2, `unknown id: exit ${missing.code}`);
});

await step("S29.3", "queue wait returns 0 after tick --once completes a fake-claude task", async () => {
  const id = await schedule({ prompt: "Reply with the word OK", title: "qa s29 wait" });
  // The waiter starts before run-now, so its first read comes before the tick completes the task
  // and --events has a completed event to print.
  const waiter = s.spawnChild(process.execPath, [CLI, "queue", "wait", id, "--timeout", "2m", "--events"]);
  const exited = new Promise((ok) => waiter.once("exit", (code) => ok(code)));
  expect(cli(["queue", "run-now", id]).code === 0, "run-now failed");
  const t = cli(["tick", "--once", "--no-notify"]);
  expect(t.code === 0, `tick: ${t.stdout.trim().split("\n")[0]}`);
  const code = await Promise.race([exited, new Promise((ok) => setTimeout(() => ok("still waiting"), 30_000))]);
  expect(code === 0, `wait exit ${code}: ${waiter.output.trim().slice(0, 300)}`);
  expect(/\bOK\b/.test(waiter.output), "wait did not print the result");
  expect(/ completed by tick/.test(waiter.output), "--events printed no completed event");
  expect(showJson(id).readAt, "wait did not mark the task read");
});

await step("S29.4", "tick writes the notice marker; queue notices --hook prints once, claims, removes the marker", async () => {
  const SID = "qa000029-cccc-4000-8000-00000000000c";
  const marker = join(home, ".tidegap", "sessions", "notices", SID);
  const session = await connectMcp(s, s.qa.db, { CLAUDECODE: "1", CLAUDE_CODE_SESSION_ID: SID });
  let id;
  try {
    id = await scheduleTask(session.call, { prompt: "Reply with the word OK", title: "qa s29 notice" });
  } finally {
    await session.close().catch(() => {});
  }
  expect(showJson(id).originSessionId === SID, "the task does not name the QA session");
  expect(cli(["queue", "run-now", id]).code === 0, "run-now failed");
  expect(!existsSync(marker), "a marker exists before the task ran");
  const t = cli(["tick", "--once", "--no-notify"]);
  expect(t.code === 0, `tick: ${t.stdout.trim().split("\n")[0]}`);
  expect(showJson(id).status === "completed", `status ${showJson(id).status}`);
  expect(existsSync(marker), "tick --once wrote no marker");
  expect((statSync(marker).mode & 0o777) === 0o600, `marker mode ${(statSync(marker).mode & 0o777).toString(8)}`);
  const input = JSON.stringify({ session_id: SID, hook_event_name: "UserPromptSubmit", prompt: "status?" });
  const first = cli(["queue", "notices", "--hook", "--hook-input", "-"], { input });
  expect(first.code === 0, `notices exit ${first.code}`);
  expect(first.stdout.startsWith("Tidegap: 1 task queued from this session finished:"), `notice: ${first.stdout.slice(0, 200)}`);
  expect(first.stdout.includes(`- ${id} completed "qa s29 notice"`), `notice line: ${first.stdout.slice(0, 300)}`);
  expect(!/\bOK\b/.test(first.stdout), "the notice holds the result text");
  const second = cli(["queue", "notices", "--hook", "--hook-input", "-"], { input });
  expect(second.code === 0 && second.stdout === "", `second notice: exit ${second.code} "${second.stdout.slice(0, 100)}"`);
  expect(!existsSync(marker), "the marker is still there");
  const notified = showJson(id).events.filter((e) => e.kind === "notified");
  expect(notified.length === 1 && notified[0].details.via === "prompt" && notified[0].details.session_id === SID, `notified: ${JSON.stringify(notified)}`);
});

// S29.5-S29.8: a session queues the real work shape with `queue add`: a one-off command, a claude-code run in another
// folder with a result file, the notice through the plugin's prompt hook, and the refusals.
const S29_WORK = join(home, "s29-work");
const S29_APP = join(home, "s29-app");
const S29_REPO = join(home, "s29-repo");
for (const d of [S29_WORK, S29_APP, S29_REPO]) mkdirSync(d, { recursive: true });
const SID5 = "qa000029-dddd-4000-8000-00000000000d";
const SID6 = "0d290006-0000-4000-8000-000000000006";
let s295Id;

await step("S29.5", "queue add --runner command, tick --once, wait exit 0, the file exists, events list created, dispatched, completed", async () => {
  const file = join(S29_WORK, "tg-hello.txt");
  const add = cli(["queue", "add", "--runner", "command", "--cwd", S29_WORK, "--by", "10m", "--title", "qa s29 command", `echo hello > ${file}`], {
    env: { CLAUDE_CODE_SESSION_ID: SID5 },
  });
  expect(add.code === 0, `queue add exit ${add.code}: ${add.stderr.trim()}`);
  const id = add.stdout.split("\n")[0].trim();
  expect(/^t-[0-9a-f-]{36}$/.test(id), `first line is not a task id: ${add.stdout.slice(0, 120)}`);
  s295Id = id;
  const shown = cli(["queue", "show", id, "--no-mark-read"]).stdout;
  expect(/^status: scheduled$/m.test(shown) && /^runner: command$/m.test(shown) && shown.includes(`cwd: ${S29_WORK}`), `show: ${shown.slice(0, 300)}`);
  expect(cli(["queue", "run-now", id]).code === 0, "run-now failed");
  const t = cli(["tick", "--once", "--no-notify"]);
  expect(t.code === 0, `tick: ${t.stdout.trim().split("\n")[0]}`);
  const wait = cli(["queue", "wait", id, "--timeout", "1m", "--no-mark-read"]);
  expect(wait.code === 0, `wait exit ${wait.code}: ${wait.stderr.trim()}`);
  expect(existsSync(file) && readFileSync(file, "utf8") === "hello\n", "the command did not write its file");
  const kinds = JSON.parse(cli(["queue", "events", id, "--json"]).stdout).events.map((e) => e.kind);
  const at = ["created", "dispatched", "completed"].map((k) => kinds.indexOf(k));
  expect(at.every((i) => i >= 0) && at[0] < at[1] && at[1] < at[2], `events ${kinds.join(",")}`);
});

await step("S29.6", "queue add --runner claude-code --cwd <tmp repo> --profile read --result-path <new file> with the fake claude: the argv and the file", async () => {
  const out = join(S29_REPO, "review.md");
  const claudeLog = join(home, "s29-claude-log");
  const add = cli(["queue", "add", "--runner", "claude-code", "--cwd", S29_REPO, "--profile", "read", "--result-path", out, "--by", "1h", "--json", "Review the change"], {
    env: { CLAUDE_CODE_SESSION_ID: SID6, CLAUDE_PROJECT_DIR: S29_APP },
    cwd: S29_APP,
  });
  expect(add.code === 0, `queue add exit ${add.code}: ${add.stderr.trim()}`);
  const json = JSON.parse(add.stdout);
  expect(json.runner === "claude-code" && json.result_path === out && json.origin_session_id === SID6, `json ${add.stdout.slice(0, 300)}`);
  expect(cli(["queue", "run-now", json.task_id]).code === 0, "run-now failed");
  const t = cli(["tick", "--once", "--no-notify"], { env: { FAKE_CLAUDE_LOG: claudeLog } });
  expect(t.code === 0, `tick: ${t.stdout.trim().split("\n")[0]}`);
  const argv = readFileSync(join(claudeLog, "argv"), "utf8").split("\n");
  const after = (flag) => argv[argv.indexOf(flag) + 1];
  expect(after("--tools") === "Read,Grep,Glob", `--tools ${after("--tools")}`);
  expect(after("--allowedTools") === `Read(/${S29_REPO}/**)`, `--allowedTools ${after("--allowedTools")}`);
  expect(after("--permission-mode") === "dontAsk", "not dontAsk");
  expect(!argv.includes("--resume") && !argv.some((a) => /^(Bash|Write|Edit)/.test(a)), "a resume or a write tool in argv");
  const ranIn = readFileSync(join(claudeLog, "cwd"), "utf8").trim();
  expect(realpathSync(ranIn) === realpathSync(S29_REPO), `the run worked in ${ranIn}`);
  expect(readFileSync(join(claudeLog, "stdin"), "utf8").startsWith(`This task was queued from a Claude Code session in ${S29_APP}.`), "no origin header");
  expect(existsSync(out) && readFileSync(out, "utf8") === "OK", "the result file does not hold the result");
  expect((statSync(out).mode & 0o777) === 0o600, `result file mode ${(statSync(out).mode & 0o777).toString(8)}`);
  const shown = showJson(json.task_id);
  expect(shown.result_file?.written === true && shown.profile === "read" && shown.cwd === S29_REPO, `show --json ${JSON.stringify(shown.result_file)}`);
  const wait = JSON.parse(cli(["queue", "wait", json.task_id, "--json", "--timeout", "1m", "--no-mark-read"]).stdout);
  expect(wait.result_file?.written === true && wait.result_path === out, `wait --json ${JSON.stringify(wait).slice(0, 300)}`);
});

await step("S29.7", "the notice of S29.5 prints once through the hook script with a stub HOME", () => {
  expect(s295Id, "S29.5 queued nothing");
  const bin = join(home, "s29-bin");
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, "tidegap"), `#!/bin/sh\nexec "${process.execPath}" "${CLI}" "$@"\n`);
  chmodSync(join(bin, "tidegap"), 0o755);
  const hook = join(ROOT, "packages", "claude-code-plugin", "hooks", "session-notice.sh");
  const input = JSON.stringify({ session_id: SID5, hook_event_name: "UserPromptSubmit", prompt: "status?" });
  const run = () => spawnSync("/bin/sh", [hook], { input, encoding: "utf8", env: { ...s.env, PATH: `${bin}:${s.env.PATH}` }, cwd: home });
  const first = run();
  s.log(`$ session-notice.sh → exit ${first.status}\n  | ${(first.stdout ?? "").trim().replace(/\n/g, "\n  | ")}`);
  expect(first.status === 0, `hook exit ${first.status}`);
  expect(first.stdout.startsWith("Tidegap: 1 task queued from this session finished:"), `notice: ${first.stdout.slice(0, 200)}`);
  expect(first.stdout.includes(`- ${s295Id} completed "qa s29 command"`), `notice line: ${first.stdout.slice(0, 300)}`);
  expect(!/hello/.test(first.stdout), "the notice holds the command output");
  const second = run();
  expect(second.status === 0 && second.stdout === "", `second run printed: ${second.stdout.slice(0, 100)}`);
  const notified = showJson(s295Id).events.filter((e) => e.kind === "notified");
  expect(notified.length === 1 && notified[0].details.via === "prompt", `notified: ${JSON.stringify(notified)}`);
});

await step("S29.8", "queue add refusals: no --by, a protected or existing result path, --profile on anthropic", () => {
  const before = listJson().length;
  writeFileSync(join(S29_WORK, "exists.md"), "x");
  mkdirSync(join(home, ".ssh"), { recursive: true });
  const cases = [
    [["queue", "add", "summarize"], /--by is required: a duration \(30m, 2h, 3d, 1w\), an ISO-8601 time, or quota-reset/],
    [["queue", "add", "--by", "1h", "--cwd", S29_WORK, "--runner", "command", "--result-path", join(home, ".ssh", "config"), "ls"], /protected folder/],
    [["queue", "add", "--by", "1h", "--result-path", join(S29_WORK, "exists.md"), "summarize"], /already exists/],
    [["queue", "add", "--by", "1h", "--runner", "anthropic", "--profile", "read", "summarize"], /--profile applies to runner claude-code only/],
  ];
  for (const [args, want] of cases) {
    const r = cli(args, { cwd: S29_WORK });
    expect(r.code === 2 && want.test(r.stderr) && oneLineError(r), `${args.join(" ")}: exit ${r.code} ${r.stderr.trim()}`);
  }
  expect(listJson().length === before, "a refused queue add saved a task");
});

// S29.9-S29.10: progress lines of a long command task, and the wake of an idle session through the plugin's Stop hook.
await step("S29.9", "a 22 s command task reports progress events 15 s apart and queue wait --events prints them", async () => {
  const add = cli(["queue", "add", "--runner", "command", "--cwd", S29_WORK, "--by", "10m", "--title", "qa s29 progress", "for i in $(seq 1 22); do echo \"step $i\"; sleep 1; done"]);
  expect(add.code === 0, `queue add exit ${add.code}: ${add.stderr.trim()}`);
  const id = add.stdout.split("\n")[0].trim();
  // The waiter starts before the tick, so --events prints the progress lines as they are written.
  const waiter = s.spawnChild(process.execPath, [CLI, "queue", "wait", id, "--timeout", "2m", "--events", "--no-mark-read"]);
  const exited = new Promise((ok) => waiter.once("exit", (code) => ok(code)));
  expect(cli(["queue", "run-now", id]).code === 0, "run-now failed");
  const t = cli(["tick", "--once", "--no-notify"]);
  expect(t.code === 0, `tick: ${t.stdout.trim().split("\n")[0]}`);
  const code = await Promise.race([exited, new Promise((ok) => setTimeout(() => ok("still waiting"), 30_000))]);
  expect(code === 0, `wait exit ${code}: ${waiter.output.trim().slice(0, 300)}`);
  const events = JSON.parse(cli(["queue", "events", id, "--json"]).stdout).events;
  const progress = events.filter((e) => e.kind === "progress");
  // 2 for a 22 s run; a third only when load stretched the run past 35 s.
  expect(progress.length >= 2 && progress.length <= 3, `progress events: ${JSON.stringify(progress).slice(0, 400)}`);
  expect(progress.every((e, i) => e.actor === "tick" && e.details.seq === i + 1 && /^step \d+$/.test(e.details.line)), `progress details: ${JSON.stringify(progress)}`);
  const gap = Date.parse(progress[1].at) - Date.parse(progress[0].at);
  expect(gap >= 14_500, `progress events ${gap} ms apart`);
  const kinds = events.map((e) => e.kind);
  expect(kinds.indexOf("dispatched") < kinds.indexOf("progress") && kinds.lastIndexOf("progress") < kinds.indexOf("completed"), `order ${kinds.join(",")}`);
  expect(/ progress by tick - step \d+/.test(waiter.output), `--events printed no progress line: ${waiter.output.slice(0, 300)}`);
  expect(/step 22/.test(waiter.output), "wait did not print the whole result");
});

await step("S29.10", "queue notices --wait --rewake exits 2 with the notice on stderr after tick --once completes a wake task", async () => {
  const SID10 = "qa000029-eeee-4000-8000-0000000000e1";
  const marker = join(home, ".tidegap", "sessions", "wake", SID10);
  const pidFile = join(home, ".tidegap", "sessions", "waiters", `${SID10}.pid`);
  const add = cli(["queue", "add", "--runner", "command", "--cwd", S29_WORK, "--by", "10m", "--wake", "--title", "qa s29 wake", "echo woke"], {
    env: { CLAUDE_CODE_SESSION_ID: SID10 },
  });
  expect(add.code === 0, `queue add --wake exit ${add.code}: ${add.stderr.trim()}`);
  const id = add.stdout.split("\n")[0].trim();
  expect(/^wake: on /m.test(add.stdout), `queue add output: ${add.stdout.slice(0, 300)}`);
  expect(existsSync(marker) && (statSync(marker).mode & 0o777) === 0o600, "no 0600 wake marker after queue add --wake");
  expect(showJson(id).wake === true, "queue show --json does not name the wake");
  // The Stop hook under a stand-in `claude` process: a node binary reached through a link named claude, so the
  // waiter finds it as its nearest claude ancestor. No real claude runs.
  const bin = join(home, "s29-wake-bin");
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, "tidegap"), `#!/bin/sh\nexec "${process.execPath}" "${CLI}" "$@"\n`);
  chmodSync(join(bin, "tidegap"), 0o755);
  const claude = join(home, "s29-fake-claude", "claude");
  mkdirSync(join(home, "s29-fake-claude"), { recursive: true });
  if (!existsSync(claude)) symlinkSync(process.execPath, claude);
  const hook = join(ROOT, "packages", "claude-code-plugin", "hooks", "session-wake.sh");
  const parent = join(home, "s29-wake-parent.mjs");
  writeFileSync(
    parent,
    [
      'import { spawn } from "node:child_process";',
      `const child = spawn("/bin/sh", [${JSON.stringify(hook)}], { stdio: ["pipe", "pipe", "pipe"] });`,
      `child.stdin.end(${JSON.stringify(JSON.stringify({ session_id: SID10, hook_event_name: "Stop", stop_hook_active: false }))});`,
      'let out = "", err = "";',
      "child.stdout.on(\"data\", (d) => (out += d));",
      "child.stderr.on(\"data\", (d) => (err += d));",
      'child.on("close", (code) => process.stdout.write(JSON.stringify({ code, out, err })));',
    ].join("\n"),
  );
  const stop = s.spawnChild(claude, [parent], { env: { PATH: `${bin}:${s.env.PATH}` } });
  const ended = new Promise((ok) => stop.once("exit", () => ok(true)));
  const started = await waitFor(() => existsSync(pidFile), 15_000);
  expect(started, `the waiter wrote no pid file: ${stop.output.slice(0, 300)}`);
  expect(cli(["queue", "run-now", id]).code === 0, "run-now failed");
  const t = cli(["tick", "--once", "--no-notify"]);
  expect(t.code === 0, `tick: ${t.stdout.trim().split("\n")[0]}`);
  const done = await Promise.race([ended, new Promise((ok) => setTimeout(() => ok(false), 30_000))]);
  expect(done, "the Stop hook did not return within 30 s of the tick");
  const r = JSON.parse(stop.output);
  s.log(`$ session-wake.sh under a stand-in claude → exit ${r.code}\n  | ${r.err.trim().replace(/\n/g, "\n  | ")}`);
  expect(r.code === 2, `hook exit ${r.code}: ${r.err.slice(0, 300)}`);
  expect(r.out === "", `hook stdout: ${r.out.slice(0, 200)}`);
  expect(r.err.startsWith("Tidegap: 1 task queued from this session finished:"), `notice: ${r.err.slice(0, 200)}`);
  expect(r.err.includes(`- ${id} completed "qa s29 wake"`), `notice line: ${r.err.slice(0, 300)}`);
  expect(!/\bwoke\b/.test(r.err), "the notice holds the command output");
  const notified = showJson(id).events.filter((e) => e.kind === "notified");
  expect(notified.length === 1 && notified[0].details.via === "rewake" && notified[0].details.session_id === SID10, `notified: ${JSON.stringify(notified)}`);
  expect(!existsSync(marker) && !existsSync(pidFile), "the wake marker or the pid file is still there");
  const input = JSON.stringify({ session_id: SID10, hook_event_name: "UserPromptSubmit", prompt: "status?" });
  const prompt = cli(["queue", "notices", "--hook", "--hook-input", "-"], { input });
  expect(prompt.code === 0 && prompt.stdout === "", `the prompt hook repeated the notice: ${prompt.stdout.slice(0, 200)}`);
});

await mcp?.close().catch(() => {});
await s.finish();
