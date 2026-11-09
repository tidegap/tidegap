// Tests for scripts/qa/docs-drift-plugin.mjs (node --test): the pass and failure paths of the
// S7.3 and S7.4 plugin drift rules, with each exemption, on small fixture texts and a fake core.
import { test } from "node:test";
import assert from "node:assert/strict";
import { commandToolProblems, skillNameProblems } from "./docs-drift-plugin.mjs";

// TOOL_SURFACE cut down to what S7.3 and S7.4 read.
const CORE = {
  TOOL_SURFACE: [
    { name: "schedule_task", params: [{ name: "prompt" }, { name: "deadline" }, { name: "retry_delay" }] },
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
