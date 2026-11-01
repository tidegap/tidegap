// Tests for the Claude Code plugin hooks prompt-hint.sh, cron-guard.sh
// (jobs U14, R30-R32, AE13, AE14, and the queue add runner rule),
// session-notice.sh and session-wake.sh. Pipes hook JSON
// into each script with /bin/sh and an empty environment, so no network and
// no real config: the notice and wake hooks get a temp HOME and a stub `tidegap`.
// Run: node --test scripts/plugin-hooks.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PLUGIN = join(ROOT, "packages/claude-code-plugin");
const HINT = join(PLUGIN, "hooks/prompt-hint.sh");
const GUARD = join(PLUGIN, "hooks/cron-guard.sh");
const NOTICE = join(PLUGIN, "hooks/session-notice.sh");
const WAKE = join(PLUGIN, "hooks/session-wake.sh");

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

test("cron guard: quoted, split or variable jobs words still ask, as for queue add", () => {
  for (const cmd of [
    "tidegap jobs 'add' --command x --daily",
    'tidegap jobs "add" --command x --daily',
    "tidegap 'jobs' add --command x --daily",
    '"tidegap" jobs add --command x --daily',
    "tidegap jobs add --comm'and' x --daily",
    "tidegap jobs add --'file' job.json",
    "tidegap jobs \\\nadd --command x --daily",
    "c=add; tidegap jobs $c --command x --daily",
    "$TG jobs add --command x --daily",
    "tidegap jobs 'edit' job_1 --command y",
    "tidegap jobs 'secrets' set X",
    'tidegap jobs secrets "set" X',
    "tidegap jobs secrets $verb X",
  ]) {
    const json = JSON.parse(guard(cmd));
    assert.equal(json.hookSpecificOutput.permissionDecision, "ask", cmd);
    assert.match(json.hookSpecificOutput.permissionDecisionReason, /authored by the user/, cmd);
  }
  for (const cmd of ["tidegap jobs 'list'", "tidegap 'jobs' add --title t --daily --prompt 'summarize'", "tidegap jobs $c --prompt x", "tidegap jobs secrets 'list'"]) {
    assert.equal(guard(cmd), "", cmd);
  }
});

test("cron guard: a double quote inside a word or a substituted binary does not split the words", () => {
  for (const [cmd, reason] of [
    ['tidegap jobs add --comm"and" x --daily', /authored by the user/],
    ['tidegap jobs a"d"d --command x', /authored by the user/],
    ['tidegap jobs secrets s"et" X', /authored by the user/],
    ["$(command -v tidegap) jobs add --command x --daily", /authored by the user/],
    ['node "$(command -v tidegap)" jobs secrets set X', /authored by the user/],
    ['tidegap queue add --run"ner" command --cwd /tmp --by 10m x', /shell command task/],
    ['tidegap queue a"dd" --runner command --cwd /tmp --by 10m x', /shell command task/],
    ["`command -v tidegap` queue add --runner command --by 10m x", /shell command task/],
  ]) {
    const json = JSON.parse(guard(cmd));
    assert.equal(json.hookSpecificOutput.permissionDecision, "ask", cmd);
    assert.match(json.hookSpecificOutput.permissionDecisionReason, reason, cmd);
  }
  for (const cmd of ['tidegap queue add --runner claude-code --title "say \\"hi\\"" --by 1h x', 'tidegap jobs "list"', 'echo "tidegap" > notes.txt']) {
    assert.equal(guard(cmd), "", cmd);
  }
});

test("cron guard: queue add with a runner other than an LLM runner asks, fail-closed", () => {
  for (const cmd of [
    "tidegap queue add --runner command --cwd /tmp --by 10m 'echo hello > /tmp/tg-hello.txt'",
    "tidegap queue add --runner=command --by 10m 'make test'",
    "tidegap queue add --runner 'command' --by 10m x",
    'tidegap queue add --runner "command" --by 10m x',
    "tidegap queue add --runner $R --by 10m x",
    'tidegap queue add --runner "$R" --by 10m x',
    'tidegap queue add --runner "$(echo command)" --by 10m x',
    "tidegap queue add --runner `echo command` --by 10m x",
    "tidegap queue add --by 10m --runner com\\mand x",
    "tidegap queue add --by 10m x --runner",
    "tidegap queue add --runner claude-code --by 1h x; tidegap queue add --runner command --by 1h y",
    "cd /tmp && npx @tidegap/cli queue add --runner command --by 1h 'ls'",
    // Quoted, continued or variable words still read as queue add.
    "tidegap queue 'add' --runner command --by 10m x",
    "tidegap 'queue' add --runner command --by 10m x",
    '"tidegap" queue add --runner command --by 10m x',
    "tidegap queue \\\nadd --runner command --by 10m x",
    "c=add; tidegap queue $c --runner command --by 10m x",
    "$TG queue add --runner command --by 10m x",
    "tidegap queue add --run'ner' command --by 10m x",
  ]) {
    const json = JSON.parse(guard(cmd));
    assert.equal(json.hookSpecificOutput.permissionDecision, "ask", cmd);
    assert.match(json.hookSpecificOutput.permissionDecisionReason, /shell command task/, cmd);
  }
  for (const cmd of [
    "tidegap queue add --runner claude-code --cwd /tmp --by 1h 'review the diff'",
    "tidegap queue add --runner=anthropic --by 2h 'summarize'",
    "tidegap queue add --runner 'openai' --by 2h x",
    'tidegap queue add --runner "gemini" --by 2h x',
    "tidegap queue add --runner ollama --by 2h x",
    "tidegap queue add --by 2h 'summarize the notes'",
    "tidegap queue 'add' --runner claude-code --by 1h x",
    "tidegap queue list --runner command",
    "tidegap queue wait t-1 --timeout 1m",
  ]) {
    assert.equal(guard(cmd), "", cmd);
  }
});

test("cron guard: never denies, and malformed input exits 0 with no output", () => {
  for (const input of ["", "nope", "{", JSON.stringify({ tool_name: "Bash", tool_input: {} })]) {
    const r = run(GUARD, input);
    assert.equal(r.code, 0);
    assert.equal(r.stdout, "");
  }
  for (const f of [HINT, GUARD, NOTICE, WAKE]) assert.doesNotMatch(readFileSync(f, "utf8"), /"deny"|curl|wget|nc /);
});

test("both hooks finish inside the latency budget (median of 5 runs under 100 ms)", () => {
  for (const [script, input] of [
    [HINT, prompt("set up a cron that runs the tests every night")],
    [HINT, prompt("fix the typo in README")],
    [GUARD, bash("crontab -e")],
    [GUARD, bash("ls -la")],
    [GUARD, bash("tidegap queue add --runner command --by 10m 'echo hi'")],
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
    for (const m of h.command.matchAll(/\$\{CLAUDE_PLUGIN_ROOT\}\/([\w./-]+)/g)) assert.ok(existsSync(join(PLUGIN, m[1])), m[1]);
    // The background wake waiter has its own rules (the asyncRewake test below).
    if (h.asyncRewake === true) continue;
    assert.match(h.command, /exit 0$/);
    assert.ok(h.timeout <= 10);
  }
});

test("hooks.json has exactly one asyncRewake entry, on Stop: session-wake.sh with a 12 h timeout, exit code passed through", () => {
  const hooks = JSON.parse(readFileSync(join(PLUGIN, "hooks/hooks.json"), "utf8")).hooks;
  const all = Object.entries(hooks).flatMap(([event, entries]) => entries.flatMap((e) => e.hooks.map((h) => ({ event, h }))));
  const rewake = all.filter(({ h }) => h.asyncRewake === true || h.async === true);
  assert.equal(rewake.length, 1);
  const [{ event, h }] = rewake;
  assert.equal(event, "Stop");
  assert.equal(h.asyncRewake, true);
  assert.equal(h.type, "command");
  assert.equal(h.command, 'sh "${CLAUDE_PLUGIN_ROOT}/hooks/session-wake.sh"');
  assert.equal(h.timeout, 43200);
  assert.ok(h.timeout >= 3600);
  // Exit code 2 must reach Claude Code: no trailing `exit 0`.
  assert.doesNotMatch(h.command, /exit 0/);
});

// ── session-notice.sh ───────────────────────────────────────────────────────

const SID = "5e551013-0000-4000-8000-00000000c0de";
const STUB_OUT = "Tidegap: 1 task queued from this session finished:\n- t-1 completed \"qa\"\nRead one with: tidegap queue show <id> (or check_queue_status task_id=<id>).";

/**
 * A temp HOME and a stub `tidegap` that logs its arguments and stdin. With
 * STUB_MODE=old it fails as a tidegap without `queue notices` would.
 */
function noticeSandbox() {
  const root = mkdtempSync(join(tmpdir(), "tidegap-notice-hook-"));
  const home = join(root, "home");
  const bin = join(root, "bin");
  mkdirSync(home);
  mkdirSync(bin);
  const log = join(root, "calls.log");
  const stdin = join(root, "stdin.txt");
  writeFileSync(
    join(bin, "tidegap"),
    `#!/bin/sh
printf '%s\\n' "$*" >> "${log}"
cat > "${stdin}"
if [ "\${STUB_MODE:-}" = old ]; then echo "error: unknown command 'notices'" >&2; echo "Usage: tidegap queue"; exit 1; fi
printf '%s\\n' '${STUB_OUT.replace(/'/g, "'\\''")}'
`,
  );
  chmodSync(join(bin, "tidegap"), 0o755);
  const marker = (id = SID) => {
    mkdirSync(join(home, ".tidegap", "sessions", "notices"), { recursive: true });
    writeFileSync(join(home, ".tidegap", "sessions", "notices", id), "x\n");
  };
  const run = (input, env = {}) => {
    const t0 = process.hrtime.bigint();
    const r = spawnSync("/bin/sh", [NOTICE], { input, encoding: "utf8", env: { PATH: `${bin}:/usr/bin:/bin`, HOME: home, ...env } });
    const ms = Number(process.hrtime.bigint() - t0) / 1e6;
    return { code: r.status, stdout: r.stdout, stderr: r.stderr, ms };
  };
  const calls = () => (existsSync(log) ? readFileSync(log, "utf8").split("\n").filter(Boolean) : []);
  return { root, home, marker, run, calls, stdin: () => readFileSync(stdin, "utf8"), dispose: () => rmSync(root, { recursive: true, force: true }) };
}

const noticeInput = (sessionId = SID) =>
  JSON.stringify({ session_id: sessionId, transcript_path: "/tmp/t.jsonl", cwd: "/tmp", hook_event_name: "UserPromptSubmit", prompt: 'say "hi"\nthen stop' });

test("session-notice.sh prints nothing and never starts tidegap without a marker", () => {
  const box = noticeSandbox();
  try {
    const r = box.run(noticeInput());
    assert.equal(r.code, 0);
    assert.equal(r.stdout, "");
    assert.deepEqual(box.calls(), []);
    // A marker of another session does not count.
    box.marker("aaaa1111-other-session");
    assert.equal(box.run(noticeInput()).stdout, "");
    assert.deepEqual(box.calls(), []);
  } finally {
    box.dispose();
  }
});

test("with a marker it passes the session id to tidegap queue notices --hook --hook-input - and prints its stdout", () => {
  const box = noticeSandbox();
  try {
    box.marker();
    const r = box.run(noticeInput());
    assert.equal(r.code, 0);
    assert.equal(r.stdout, `${STUB_OUT}\n`);
    assert.deepEqual(box.calls(), ["queue notices --hook --hook-input -"]);
    // Only the checked id goes on: no prompt text, valid JSON however large the input.
    assert.equal(box.stdin(), JSON.stringify({ session_id: SID }));
  } finally {
    box.dispose();
  }
});

test("a prompt over the 256 KiB input cap still gets its notice", () => {
  const box = noticeSandbox();
  try {
    box.marker();
    const input = JSON.stringify({ session_id: SID, hook_event_name: "UserPromptSubmit", prompt: "x".repeat(300_000) });
    const r = box.run(input);
    assert.equal(r.code, 0);
    assert.equal(r.stdout, `${STUB_OUT}\n`);
    assert.equal(box.stdin(), JSON.stringify({ session_id: SID }));
  } finally {
    box.dispose();
  }
});

test("an older tidegap that rejects the command leaves the hook silent with exit 0", () => {
  const box = noticeSandbox();
  try {
    box.marker();
    const r = box.run(noticeInput(), { STUB_MODE: "old" });
    assert.equal(r.code, 0);
    assert.equal(r.stdout, "");
    assert.equal(r.stderr, "");
    assert.equal(box.calls().length, 1);
  } finally {
    box.dispose();
  }
});

test("a session id with a slash or dots never reaches a path", () => {
  const box = noticeSandbox();
  try {
    // Files where a path built from these ids would land.
    mkdirSync(join(box.home, ".tidegap", "sessions", "notices"), { recursive: true });
    writeFileSync(join(box.home, ".tidegap", "evil-session-id"), "x\n");
    box.marker("a.b.c.d.e.f.g.h");
    for (const id of ["../../evil-session-id", "a.b.c.d.e.f.g.h", "notices/../../x1234567", "short"]) {
      const r = box.run(noticeInput(id));
      assert.equal(r.code, 0, id);
      assert.equal(r.stdout, "", id);
    }
    for (const input of ["", "not json", "{", JSON.stringify({ prompt: "hi" }), "\u0000ÿ"]) {
      const r = box.run(input);
      assert.equal(r.code, 0);
      assert.equal(r.stdout, "");
    }
    assert.deepEqual(box.calls(), []);
  } finally {
    box.dispose();
  }
});

test("session-notice.sh finishes inside the latency budget (median of 5 runs under 100 ms) without a marker", () => {
  const box = noticeSandbox();
  try {
    const times = Array.from({ length: 5 }, () => box.run(noticeInput()).ms);
    assert.ok(median(times) < 100, times.map((t) => t.toFixed(1)).join(", "));
    assert.deepEqual(box.calls(), []);
  } finally {
    box.dispose();
  }
});

test("hooks.json registers prompt-hint.sh and session-notice.sh on UserPromptSubmit and keeps the SessionStart command", () => {
  const hooks = JSON.parse(readFileSync(join(PLUGIN, "hooks/hooks.json"), "utf8")).hooks;
  const prompt = hooks.UserPromptSubmit.flatMap((e) => e.hooks);
  assert.ok(prompt.some((h) => h.command === 'sh "${CLAUDE_PLUGIN_ROOT}/hooks/prompt-hint.sh"; exit 0'));
  const notice = prompt.find((h) => h.command.includes("session-notice.sh"));
  assert.equal(notice?.command, 'sh "${CLAUDE_PLUGIN_ROOT}/hooks/session-notice.sh"; exit 0');
  assert.equal(notice?.timeout, 10);
  assert.equal(
    hooks.SessionStart[0].hooks[0].command,
    "input=$(cat); if command -v tidegap >/dev/null 2>&1; then printf '%s' \"$input\" | tidegap queue list --unread --hook --hook-input - 2>/dev/null || tidegap queue list --unread --hook 2>/dev/null; elif command -v ebb >/dev/null 2>&1; then ebb queue list --unread --hook 2>/dev/null; fi; exit 0",
  );
});

// ── session-wake.sh ─────────────────────────────────────────────────────────

const WAKE_NOTICE = "Tidegap: 1 task queued from this session finished:\n- t-1 completed \"tg wake\"\nRead one with: tidegap queue show <id> (or check_queue_status task_id=<id>).";

/**
 * A temp HOME and a stub `tidegap` that logs its arguments and stdin, then
 * acts as STUB_MODE says: `wake` (the notice on stderr, exit 2), `warn` (a
 * Node warning first), `junk` (exit 2 with no notice), `old` (an older CLI
 * that rejects the options), anything else exits 0 silently.
 */
function wakeSandbox() {
  const root = mkdtempSync(join(tmpdir(), "tidegap-wake-hook-"));
  const home = join(root, "home");
  const bin = join(root, "bin");
  mkdirSync(home);
  mkdirSync(bin);
  const log = join(root, "calls.log");
  const stdin = join(root, "stdin.txt");
  const notice = WAKE_NOTICE.replace(/'/g, "'\\''");
  writeFileSync(
    join(bin, "tidegap"),
    `#!/bin/sh
printf '%s\\n' "$*" >> "${log}"
cat > "${stdin}"
case "\${STUB_MODE:-}" in
  wake) echo "stdout must not leak"; printf '%s\\n' '${notice}' >&2; exit 2 ;;
  warn) printf '%s\\n' '(node:1) ExperimentalWarning: SQLite is an experimental feature' '${notice}' >&2; exit 2 ;;
  junk) echo "Error: something broke" >&2; exit 2 ;;
  old) echo "error: unknown option '--wait'" >&2; exit 1 ;;
esac
exit 0
`,
  );
  chmodSync(join(bin, "tidegap"), 0o755);
  const marker = (id = SID) => {
    mkdirSync(join(home, ".tidegap", "sessions", "wake"), { recursive: true });
    writeFileSync(join(home, ".tidegap", "sessions", "wake", id), "x\n");
  };
  const run = (input, env = {}) => {
    const t0 = process.hrtime.bigint();
    const r = spawnSync("/bin/sh", [WAKE], { input, encoding: "utf8", env: { PATH: `${bin}:/usr/bin:/bin`, HOME: home, ...env } });
    const ms = Number(process.hrtime.bigint() - t0) / 1e6;
    return { code: r.status, stdout: r.stdout, stderr: r.stderr, ms };
  };
  const calls = () => (existsSync(log) ? readFileSync(log, "utf8").split("\n").filter(Boolean) : []);
  return { home, marker, run, calls, stdin: () => readFileSync(stdin, "utf8"), dispose: () => rmSync(root, { recursive: true, force: true }) };
}

const stopInput = (sessionId = SID) =>
  JSON.stringify({ session_id: sessionId, transcript_path: "/tmp/t.jsonl", cwd: "/tmp", hook_event_name: "Stop", stop_hook_active: false, last_assistant_message: 'done "x"' });

test("session-wake.sh never starts tidegap without a wake marker", () => {
  const box = wakeSandbox();
  try {
    const r = box.run(stopInput(), { STUB_MODE: "wake" });
    assert.equal(r.code, 0);
    assert.equal(r.stdout, "");
    assert.equal(r.stderr, "");
    assert.deepEqual(box.calls(), []);
    // A notice marker, or the wake marker of another session, does not count.
    mkdirSync(join(box.home, ".tidegap", "sessions", "notices"), { recursive: true });
    writeFileSync(join(box.home, ".tidegap", "sessions", "notices", SID), "x\n");
    box.marker("aaaa1111-other-session");
    assert.equal(box.run(stopInput(), { STUB_MODE: "wake" }).code, 0);
    assert.deepEqual(box.calls(), []);
  } finally {
    box.dispose();
  }
});

test("session-wake.sh finishes inside the latency budget (median of 5 runs under 100 ms) without a marker", () => {
  const box = wakeSandbox();
  try {
    const times = Array.from({ length: 5 }, () => box.run(stopInput()).ms);
    assert.ok(median(times) < 100, times.map((t) => t.toFixed(1)).join(", "));
    assert.deepEqual(box.calls(), []);
  } finally {
    box.dispose();
  }
});

test("session-wake.sh passes exit code 2 through with the notice on stderr and prints nothing on stdout", () => {
  const box = wakeSandbox();
  try {
    box.marker();
    const r = box.run(stopInput(), { STUB_MODE: "wake" });
    assert.equal(r.code, 2);
    assert.equal(r.stdout, "");
    assert.equal(r.stderr, `${WAKE_NOTICE}\n`);
    assert.deepEqual(box.calls(), ["queue notices --wait --rewake --hook-input -"]);
    // Only the checked id goes on.
    assert.equal(box.stdin(), JSON.stringify({ session_id: SID }));
    // A Node warning before the notice is not part of it.
    const warned = box.run(stopInput(), { STUB_MODE: "warn" });
    assert.equal(warned.code, 2);
    assert.equal(warned.stderr, `${WAKE_NOTICE}\n`);
  } finally {
    box.dispose();
  }
});

test("session-wake.sh exits 0 silently on every other outcome: idle, an older tidegap, or exit 2 without a notice", () => {
  const box = wakeSandbox();
  try {
    box.marker();
    for (const mode of ["", "old", "junk"]) {
      const r = box.run(stopInput(), { STUB_MODE: mode });
      assert.equal(r.code, 0, mode);
      assert.equal(r.stdout, "", mode);
      assert.equal(r.stderr, "", mode);
    }
    assert.equal(box.calls().length, 3);
    // No tidegap on PATH.
    const bare = spawnSync("/bin/sh", [WAKE], { input: stopInput(), encoding: "utf8", env: { PATH: "/usr/bin:/bin", HOME: box.home } });
    assert.equal(bare.status, 0);
    assert.equal(bare.stdout + bare.stderr, "");
  } finally {
    box.dispose();
  }
});

test("session-wake.sh: a session id with a slash or dots never reaches a path, and malformed input exits 0", () => {
  const box = wakeSandbox();
  try {
    mkdirSync(join(box.home, ".tidegap", "sessions", "wake"), { recursive: true });
    writeFileSync(join(box.home, ".tidegap", "evil-session-id"), "x\n");
    box.marker("a.b.c.d.e.f.g.h");
    for (const id of ["../../evil-session-id", "a.b.c.d.e.f.g.h", "wake/../../x1234567", "short"]) {
      const r = box.run(stopInput(id), { STUB_MODE: "wake" });
      assert.equal(r.code, 0, id);
      assert.equal(r.stdout + r.stderr, "", id);
    }
    for (const input of ["", "not json", "{", JSON.stringify({ hook_event_name: "Stop" }), "\u0000ÿ"]) {
      assert.equal(box.run(input, { STUB_MODE: "wake" }).code, 0);
    }
    assert.deepEqual(box.calls(), []);
  } finally {
    box.dispose();
  }
});
