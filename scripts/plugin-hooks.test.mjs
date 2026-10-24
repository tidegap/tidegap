// Tests for the Claude Code plugin hooks prompt-hint.sh and cron-guard.sh
// (jobs U14, R30-R32, AE13, AE14). Pipes hook JSON into each script with
// /bin/sh and an empty environment, so no HOME, no network, no real config.
// Run: node --test scripts/plugin-hooks.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PLUGIN = join(ROOT, "packages/claude-code-plugin");
const HINT = join(PLUGIN, "hooks/prompt-hint.sh");
const GUARD = join(PLUGIN, "hooks/cron-guard.sh");

/** Run a hook script with `input` on stdin; returns exit code, stdout and wall time in ms. */
function run(script, input) {
  const t0 = process.hrtime.bigint();
  const r = spawnSync("/bin/sh", [script], { input, encoding: "utf8", env: { PATH: "/usr/bin:/bin" } });
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  return { code: r.status, stdout: r.stdout, stderr: r.stderr, ms };
}

const prompt = (text) => JSON.stringify({ session_id: "abc12345", cwd: "/tmp/cron-tools", hook_event_name: "UserPromptSubmit", prompt: text });
const bash = (command) =>
  JSON.stringify({ session_id: "abc12345", cwd: "/tmp", hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command, description: "x" } });

function hint(text) {
  const r = run(HINT, prompt(text));
  assert.equal(r.code, 0, text);
  return r.stdout;
}

function guard(command) {
  const r = run(GUARD, bash(command));
  assert.equal(r.code, 0, command);
  return r.stdout;
}

const median = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];

test("prompt hint: a cron request gets the Tidegap context line, as valid hook JSON (AE13)", () => {
  const out = hint("set up a cron that runs the tests every night");
  const json = JSON.parse(out);
  assert.equal(json.hookSpecificOutput.hookEventName, "UserPromptSubmit");
  const ctx = json.hookSpecificOutput.additionalContext;
  assert.match(ctx, /Tidegap/);
  // The three R31 steps: propose, ask one question, then schedule_task or tidegap jobs add.
  assert.match(ctx, /Propose it in one line/);
  assert.match(ctx, /ask one question/);
  assert.match(ctx, /schedule_task with repeat/);
  assert.match(ctx, /tidegap jobs add --command/);
  assert.match(ctx, /cron anyway/);
  assert.match(ctx, /22:00-08:00/);
  // Conditional: a one-off "later" task or a question about cron code is told to ignore it.
  assert.match(ctx, /not a one-off later task/);
  assert.match(ctx, /Otherwise ignore this note/);
});

test("prompt hint: every R30 phrase matches, English and Russian, any case", () => {
  for (const text of [
    "Schedule this for me",
    "do it every day at noon",
    "every night pull the logs",
    "Every morning summarize my inbox",
    "send me a daily digest",
    "a weekly report on the repo",
    "run the nightly build check",
    "an hourly health ping",
    "set up a cronjob for backups",
    "use crons for this",
    "check the build every 6 hours",
    "run it every 2h",
    "once a day ping the API",
    "at least once a day, check my mail and tell me what matters",
    "make it a recurring task",
    "add a CRON entry",
    "edit my crontab",
    "write a launchd plist",
    "launchctl load it",
    "a systemd timer for backups",
    "set up a job that cleans tmp",
    "каждый день проверяй почту",
    "Каждую ночь собирай логи",
    "запускай по расписанию",
    "добавь в крон",
    "настрой кронтаб",
    "проверяй раз в день",
    "каждое утро присылай сводку",
    "ежедневно собирай отчёт",
  ]) {
    assert.notEqual(hint(text), "", text);
  }
});

test("prompt hint: ordinary prompts get nothing (AE13)", () => {
  for (const text of [
    "fix the typo in README",
    "what is an acronym",
    "explain the micron unit",
    "refactor the scheduler module",
    "почини опечатку в README",
    "какая крона у дуба",
    "",
  ]) {
    assert.equal(hint(text), "", text);
  }
});

test("prompt hint: the cwd and other fields never trigger it, only the prompt", () => {
  assert.equal(run(HINT, JSON.stringify({ cwd: "/home/u/crontab-daily", prompt: "fix the typo" })).stdout, "");
  // An escaped quote inside the prompt does not end the match early.
  assert.notEqual(hint('rename "x" and then run it every day'), "");
});

test("prompt hint: malformed or empty input exits 0 with no output", () => {
  for (const input of ["", "not json", "{", '{"prompt": 42}', "\u0000ÿ"]) {
    const r = run(HINT, input);
    assert.equal(r.code, 0);
    assert.equal(r.stdout, "");
  }
});

test("prompt hint: a large pasted prompt still answers inside the budget", () => {
  const big = "lorem ipsum ".repeat(20000) + " every day";
  const r = run(HINT, prompt(big));
  assert.equal(r.code, 0);
  assert.ok(r.ms < 1000, `${r.ms} ms`);
});

test("cron guard: crontab edits ask with a reason naming Tidegap; crontab -l passes (AE14)", () => {
  for (const cmd of ["crontab -e", "crontab -r", "crontab /tmp/jobs.txt", 'echo "0 3 * * * x" | crontab -', "sudo crontab -e", "/usr/bin/crontab -e", "crontab", 'bash -c "crontab -e"', "crontab -l > /tmp/c && crontab /tmp/c", "sudo -u root crontab -e", "FOO=1 crontab -e", "command crontab /tmp/f", "xargs crontab < /tmp/f", "time crontab -r"]) {
    const json = JSON.parse(guard(cmd));
    assert.equal(json.hookSpecificOutput.hookEventName, "PreToolUse", cmd);
    assert.equal(json.hookSpecificOutput.permissionDecision, "ask", cmd);
    assert.match(json.hookSpecificOutput.permissionDecisionReason, /Tidegap/, cmd);
    assert.match(json.hookSpecificOutput.permissionDecisionReason, /tidegap jobs add/, cmd);
  }
  for (const cmd of ["crontab -l", "crontab -l | grep backup", "crontab -l 2>/dev/null", "crontab -u bob -l", "man crontab", "ls ~/crontab-notes"]) {
    assert.equal(guard(cmd), "", cmd);
  }
});

test("cron guard: launchctl load|bootstrap and systemctl --user enable ask; other subcommands pass", () => {
  for (const cmd of ["launchctl load ~/Library/LaunchAgents/x.plist", "launchctl bootstrap gui/501 x.plist", "systemctl --user enable x.timer", "systemctl --user enable --now x.timer", "systemctl enable --user x.timer"]) {
    assert.equal(JSON.parse(guard(cmd)).hookSpecificOutput.permissionDecision, "ask", cmd);
  }
  for (const cmd of ["launchctl list", "launchctl print gui/501", "systemctl --user status x", "systemctl --user disable x.timer", "systemctl status cron", "systemctl enable x.timer"]) {
    assert.equal(guard(cmd), "", cmd);
  }
});

test("cron guard: an agent-authored command job or secret asks; other tidegap jobs commands pass (KD10)", () => {
  for (const cmd of ["tidegap jobs add --command 'x' --daily", "tidegap jobs add --title t --daily --command=x", "tidegap jobs edit job_1 --command 'y'", "tidegap jobs add --file job.json", "tidegap jobs secrets set X", "cd /tmp && tidegap jobs add --title 'a | b' --command z --daily", "npx -y @tidegap/cli jobs add --command x --daily", "npx @tidegap/cli@0.20.0 jobs secrets set X"]) {
    const json = JSON.parse(guard(cmd));
    assert.equal(json.hookSpecificOutput.permissionDecision, "ask", cmd);
    assert.match(json.hookSpecificOutput.permissionDecisionReason, /authored by the user/, cmd);
  }
  for (const cmd of ["tidegap jobs list", "tidegap jobs", "tidegap jobs add --title t --daily --prompt 'summarize'", "tidegap jobs show job_1", "tidegap jobs secrets list", "git commit -m 'run crontab later'"]) {
    assert.equal(guard(cmd), "", cmd);
  }
});

test("cron guard: never denies, and malformed input exits 0 with no output", () => {
  for (const input of ["", "nope", "{", JSON.stringify({ tool_name: "Bash", tool_input: {} })]) {
    const r = run(GUARD, input);
    assert.equal(r.code, 0);
    assert.equal(r.stdout, "");
  }
  for (const f of [HINT, GUARD]) assert.doesNotMatch(readFileSync(f, "utf8"), /"deny"|curl|wget|nc /);
});

test("both hooks finish inside the latency budget (median of 5 runs under 100 ms)", () => {
  for (const [script, input] of [
    [HINT, prompt("set up a cron that runs the tests every night")],
    [HINT, prompt("fix the typo in README")],
    [GUARD, bash("crontab -e")],
    [GUARD, bash("ls -la")],
  ]) {
    const times = Array.from({ length: 5 }, () => run(script, input).ms);
    assert.ok(median(times) < 100, `${script}: ${times.map((t) => t.toFixed(1)).join(", ")} ms`);
  }
});

test("hooks.json parses, registers both hooks, and every script path exists", () => {
  const hooks = JSON.parse(readFileSync(join(PLUGIN, "hooks/hooks.json"), "utf8")).hooks;
  const prompt = hooks.UserPromptSubmit?.flatMap((e) => e.hooks) ?? [];
  const pre = hooks.PreToolUse?.filter((e) => e.matcher === "Bash").flatMap((e) => e.hooks) ?? [];
  assert.ok(prompt.some((h) => h.command.includes("prompt-hint.sh")));
  assert.ok(pre.some((h) => h.command.includes("cron-guard.sh")));
  for (const h of Object.values(hooks).flat().flatMap((e) => e.hooks)) {
    assert.match(h.command, /exit 0$/);
    assert.ok(h.timeout <= 10);
    for (const m of h.command.matchAll(/\$\{CLAUDE_PLUGIN_ROOT\}\/([\w./-]+)/g)) assert.ok(existsSync(join(PLUGIN, m[1])), m[1]);
  }
});
