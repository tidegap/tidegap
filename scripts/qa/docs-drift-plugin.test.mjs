// Tests for scripts/qa/docs-drift-plugin.mjs (node --test): the pass and failure paths of the
// S7.3, S7.4, K22, K24 and K25 plugin drift rules, with each exemption, on small fixture texts
// and a fake core.
import { test } from "node:test";
import assert from "node:assert/strict";
import { commandToolProblems, examplePathProblems, sentences, SKILL_MAX_LINES, skillFactProblems, skillLengthProblems, skillNameProblems } from "./docs-drift-plugin.mjs";

// TOOL_SURFACE cut down to what S7.3 and S7.4 read.
const CORE = {
  TOOL_SURFACE: [
    { name: "schedule_task", params: [{ name: "prompt" }, { name: "deadline" }, { name: "retry_delay" }, { name: "repeat", values: ["none", "daily", "weekly", "quota_reset"] }] },
    { name: "check_queue_status", params: [{ name: "task_id" }] },
  ],
};
const COMMANDS = new Map([
  ["queue add", ["--by", "--runner"]],
  ["queue wait", ["--timeout"]],
  ["status", []],
]);
const SLASH = ["defer", "check"];
const skill = (text, flags = []) => skillNameProblems({ text, core: CORE, commands: COMMANDS, unknownFlags: () => flags, slashCommands: SLASH });
const GOOD_SKILL = "Use `/tidegap:defer`, `schedule_task` or `tidegap queue add --by 4h`; `tidegap status` says more.";

test("S7.4 passes a skill that names real commands, slash commands and tools", () => {
  assert.deepEqual(skill(GOOD_SKILL), []);
});

test("S7.4 lets a tool parameter and a field suffix pass as tool-shaped names", () => {
  assert.deepEqual(skill(`${GOOD_SKILL} Pass \`retry_delay\`; read \`task_id\` and \`result_path\`.`), []);
});

test("S7.4 fails an unknown tool", () => {
  assert.deepEqual(skill(`${GOOD_SKILL} Call \`cancel_everything\`.`), ["unknown tool cancel_everything"]);
});

test("S7.4 fails an unknown tidegap command and the flags the CLI lacks", () => {
  assert.deepEqual(skill(`${GOOD_SKILL} Run \`tidegap frobnicate\`.`, [{ cmd: "queue add", flag: "--nope" }]), ["tidegap queue add --nope", "unknown command tidegap frobnicate"]);
});

test("S7.4 fails an unknown slash command", () => {
  assert.deepEqual(skill(`${GOOD_SKILL} Or \`/tidegap:teleport\`.`), ["unknown slash command /tidegap:teleport"]);
});

test("S7.4 fails a skill that names no tool or no slash command", () => {
  assert.deepEqual(skill("Run `tidegap status`."), ["the skill names no /tidegap: slash command", "the skill names no tool"]);
});

const commandFile = (text) => commandToolProblems({ files: [{ name: "commands/x.md", text }], core: CORE });

test("S7.3 passes real tools and arguments, a tool parameter and a field suffix", () => {
  assert.deepEqual(commandFile("Call `schedule_task` with prompt: <text> and deadline: <iso>.\nPass `retry_delay` and read `task_id` or `result_path`."), []);
});

test("S7.3 fails an unknown tool with its line", () => {
  assert.deepEqual(commandFile("ok\nCall `schedule_tasks` now."), ["commands/x.md:2 unknown tool schedule_tasks"]);
});

test("S7.3 fails an unknown argument on a line that names a tool", () => {
  assert.deepEqual(commandFile("Call `schedule_task` with run_mode: fast."), ["commands/x.md:1 unknown argument run_mode"]);
});

test("S7.3 reads arguments only on a line that names a tool", () => {
  assert.deepEqual(commandFile("Set run_mode: fast in the shell."), []);
});

// K22: a skill with the four facts in their sections; each test breaks one.
const NOTICE = "Tidegap: 1 task queued from this session finished:";
const renderNoticeBlock = (items) => ({ text: items.length ? `${NOTICE}\n- t-1 completed stub` : "" });
const RUNNERS = ["anthropic", "command"];
const FACTS = `# Skill

## What Tidegap is

A queue. One task is one run of one runner: \`anthropic\` or \`command\`, e.g. a shell
command; never more.

## Recurring work: use Tidegap, not cron

Pass \`--repeat\` with \`daily\` or \`weekly\`.

## How the result comes back

### Claude Code with the Tidegap plugin

The notice starts \`${NOTICE}\`. Use \`--wake\`, \`tidegap queue wait <id>\` or
\`tidegap queue events <id>\`.

### OpenClaw

The gateway sends it.

## When a task runs

\`--not-before\` is the earliest start, not a run time.
`;
const facts = (text) => skillFactProblems({ text, file: "SKILL.md", runners: RUNNERS, renderNoticeBlock, core: CORE });

test("K22 passes a skill with the four facts in their sections", () => {
  assert.deepEqual(facts(FACTS), []);
});

test("K22 sentences: e.g., i.e. and a semicolon do not end a sentence; a capital or a backtick after a stop does", () => {
  assert.deepEqual(sentences("Use e.g. `x`; then go. Next, i.e. `y` vs. z. `tidegap` runs"), ["Use e.g. `x`; then go.", "Next, i.e. `y` vs. z.", "`tidegap` runs"]);
});

test("K22 keeps the runner sentence whole across e.g. and a semicolon", () => {
  const text = FACTS.replace("e.g. a shell\ncommand; never more.", "e.g. a shell; or `ollama`.");
  assert.deepEqual(facts(text), ['"## What Tidegap is" runner sentence: on the page but not in QUEUE_ADD_RUNNERS: ollama']);
});

test("K22 fails a notice line and commands outside the Claude Code sub-section and names it", () => {
  const moved = FACTS.replace(/(### Claude Code with the Tidegap plugin\n\n)[\s\S]*?(### OpenClaw\n\n)/, "$1Automatic.\n\n$2").replace("The gateway sends it.", `The notice starts \`${NOTICE}\`. Use \`--wake\`, \`tidegap queue wait <id>\` or \`tidegap queue events <id>\`.`);
  assert.deepEqual(facts(moved), [
    `"### Claude Code with the Tidegap plugin" does not quote the notice line \`${NOTICE}\``,
    '"### Claude Code with the Tidegap plugin" has no `--wake…` span',
    '"### Claude Code with the Tidegap plugin" has no `tidegap queue wait…` span',
    '"### Claude Code with the Tidegap plugin" has no `tidegap queue events…` span',
  ]);
});

test("K22 fails a missing sub-section, a missing earliest-start fact and a missing repeat value", () => {
  const text = FACTS.replace("### Claude Code with the Tidegap plugin", "### Claude Code").replace("not a run time", "a run time").replace(" or `weekly`", "");
  assert.deepEqual(facts(text), [
    '"## When a task runs" has no sentence that says `--not-before` is "not a run time"',
    '"## How the result comes back" has no "### Claude Code with the Tidegap plugin" section',
    '"## Recurring work: use Tidegap, not cron" has no `weekly` span',
  ]);
});

const paths = (text) => examplePathProblems({ files: [{ name: "commands/x.md", text }], protectedDirs: [".tidegap", "Library"] });

test("K24 fails an example output path under a protected home folder", () => {
  assert.deepEqual(paths("/tidegap:defer x --output ~/.tidegap/inbox/x.json"), ["commands/x.md:1 example path ~/.tidegap/inbox/x.json is under a protected folder"]);
  assert.deepEqual(paths('result_path: "/Users/someone/library/out.md"'), ["commands/x.md:1 example path /Users/someone/library/out.md is under a protected folder"]);
  assert.deepEqual(paths('--output "$HOME/.tidegap/a.json"\noutput_path=${HOME}/Library/b.json'), [
    "commands/x.md:1 example path $HOME/.tidegap/a.json is under a protected folder",
    "commands/x.md:2 example path ${HOME}/Library/b.json is under a protected folder",
  ]);
});

test("K24 passes a temp path and skips placeholders and prose", () => {
  assert.deepEqual(paths("--output /tmp/tidegap-x.json, --result-path <abs-path>, `output_path` names a JSON file, --output ~/.tidegapx/a.json"), []);
});

test("K24 fails when it reads no concrete example path", () => {
  assert.deepEqual(paths("--output <path>"), ["no concrete example output path found in the plugin files and READMEs"]);
});

test("K25 passes the cap and fails one line over it", () => {
  const lines = (n) => `${Array.from({ length: n }, (_, i) => `line ${i}`).join("\n")}\n`;
  assert.deepEqual(skillLengthProblems({ text: lines(SKILL_MAX_LINES), file: "SKILL.md" }), []);
  assert.deepEqual(skillLengthProblems({ text: lines(261), file: "SKILL.md" }), ["SKILL.md has 261 lines, the cap is 260"]);
});
