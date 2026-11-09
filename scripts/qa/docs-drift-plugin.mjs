// The plugin drift rules of docs-drift.mjs, as pure functions: S7.3 (the plugin commands name
// only real tools and arguments), S7.4 (the tidegap skill names only real commands, flags,
// slash commands and tools), K22 (the skill states four facts in their sections), K24 (no
// example output path under a protected home folder) and K25 (the skill's line cap). Each takes file texts and code values and returns the list of
// problems; docs-drift.mjs reads the files and the built modules. Tests:
// docs-drift-plugin.test.mjs (node --test).

// A tool-shaped name: a tool prefix and a snake_case rest, unless the rest ends like a field
// (`task_id`, `result_path`) or the name is a parameter of a tool (`retry_delay`).
const TOOL_NAME_RE = /\b((?:get|recommend|schedule|check|cancel|expedite|update|postpone|reply|retry)_[a-z_]+|tidegap_[a-z]+)\b/g;
const FIELD_SUFFIX_RE = /_(id|at|kind|g|path|for|pct|source)$/;

/** Tool name -> its parameter names, from TOOL_SURFACE. */
const toolParams = (core) => new Map(core.TOOL_SURFACE.map((t) => [t.name, new Set(t.params.map((p) => p.name))]));
const isParam = (tools, name) => [...tools.values()].some((ps) => ps.has(name));

/**
 * S7.4: every `tidegap <command>` and its flags, every /tidegap:<name> and every tool-shaped name
 * in the skill exist. `commands` is the CLI's command map (keys like "queue add"), `unknownFlags`
 * returns the `{ cmd, flag }` entries of the skill that the CLI lacks, and `slashCommands` lists
 * the file names (without `.md`) in the plugin's commands folder. A skill that names no slash
 * command or no tool fails, so the rule never passes on nothing.
 */
export function skillNameProblems({ text, core, commands, unknownFlags, slashCommands }) {
  const bad = unknownFlags().map((b) => `tidegap ${b.cmd} ${b.flag}`);
  const top = new Set([...commands.keys()].map((k) => k.split(" ")[0]));
  for (const m of text.matchAll(/`tidegap ([a-z][a-z-]*)/g)) if (!top.has(m[1])) bad.push(`unknown command tidegap ${m[1]}`);
  const slash = [...new Set([...text.matchAll(/\/tidegap:([a-z][a-z-]*)/g)].map((m) => m[1]))];
  if (slash.length === 0) bad.push("the skill names no /tidegap: slash command");
  for (const name of slash) if (!slashCommands.includes(name)) bad.push(`unknown slash command /tidegap:${name}`);
  const tools = toolParams(core);
  const named = [...new Set([...text.matchAll(TOOL_NAME_RE)].map((m) => m[1]))].filter((n) => !FIELD_SUFFIX_RE.test(n) && !isParam(tools, n));
  if (named.length === 0) bad.push("the skill names no tool");
  for (const name of named) if (!tools.has(name)) bad.push(`unknown tool ${name}`);
  return bad;
}

/**
 * S7.3: in each plugin command file (`files`: `{ name, text }`), every tool-shaped name is a tool,
 * a tool parameter or a field, and on a line that names a tool every `snake_name:` or
 * `snake_name=` argument is a tool or a tool parameter.
 */
export function commandToolProblems({ files, core }) {
  const tools = toolParams(core);
  const bad = [];
  for (const { name, text } of files) {
    text.split("\n").forEach((line, i) => {
      for (const m of line.matchAll(TOOL_NAME_RE)) {
        if (!tools.has(m[1]) && !isParam(tools, m[1]) && !FIELD_SUFFIX_RE.test(m[1])) bad.push(`${name}:${i + 1} unknown tool ${m[1]}`);
      }
      if (![...tools.keys()].some((t) => line.includes(t))) return;
      for (const m of line.matchAll(/\b([a-z]+(?:_[a-z]+)+)\s*[:=]\s/g)) {
        if (!tools.has(m[1]) && !isParam(tools, m[1])) bad.push(`${name}:${i + 1} unknown argument ${m[1]}`);
      }
    });
  }
  return bad;
}

/** Both-way difference of a documented list and the code's; an empty side is a problem too. */
export function listProblems(where, got, want, codeName) {
  if (got.length === 0) return [`${where}: the list is empty`];
  if (want.length === 0) return [`no ${codeName} found in the code`];
  const bad = [];
  const twice = got.filter((x, i) => got.indexOf(x) !== i);
  if (twice.length > 0) bad.push(`${where}: listed twice: ${twice.join(" ")}`);
  const missing = want.filter((x) => !got.includes(x));
  if (missing.length > 0) bad.push(`${where}: in ${codeName} but not on the page: ${missing.join(" ")}`);
  const extra = got.filter((x) => !want.includes(x));
  if (extra.length > 0) bad.push(`${where}: on the page but not in ${codeName}: ${extra.join(" ")}`);
  return bad;
}

/**
 * The text under the exact `heading` line (`## X` or `### X`) to the next heading of the same or a
 * higher level; a `#` line in a code fence is no heading. Undefined when the heading is missing.
 */
export function headingSection(text, heading) {
  const level = /^#+/.exec(heading)[0].length;
  const lines = text.split("\n");
  const at = lines.findIndex((l) => l.trimEnd() === heading);
  if (at < 0) return undefined;
  const rest = lines.slice(at + 1);
  const ends = new RegExp(`^#{1,${level}} `);
  let fenced = false;
  const end = rest.findIndex((l) => {
    if (/^\s*(```|~~~)/.test(l)) fenced = !fenced;
    return !fenced && ends.test(l);
  });
  return (end < 0 ? rest : rest.slice(0, end)).join("\n");
}

/**
 * Sentences of `t` with whitespace folded. A sentence ends at `.`, `!` or `?` followed by a space
 * and a capital letter or a backtick, except after `e.g.`, `i.e.`, `etc.` and `vs.`; `;` ends none.
 */
export const sentences = (t) => t.replace(/\s+/g, " ").split(/(?<!\b(?:e\.g|i\.e|etc|vs)\.)(?<=[.!?]) (?=[A-Z`])/);
const spans = (t) => [...t.replace(/\s+/g, " ").matchAll(/`([^`]+)`/g)].map((m) => m[1]);

const CLAUDE_CODE = "### Claude Code with the Tidegap plugin";

/**
 * K22: the skill states four facts, each in its own section, so a fact that moves or goes fails.
 * "## What Tidegap is" has one sentence with "one run of one runner" whose one-word code spans are
 * `runners`; "## When a task runs" says `--not-before` is "not a run time"; the Claude Code
 * sub-section of "## How the result comes back" quotes the notice line `renderNoticeBlock` prints
 * for one task and has `--wake`, `tidegap queue wait` and `tidegap queue events` spans; "## Recurring
 * work: use Tidegap, not cron" has `--repeat` and each job repeat value of schedule_task (the enum
 * without none and quota_reset, as in K15).
 */
export function skillFactProblems({ text, file, runners, renderNoticeBlock, core }) {
  const bad = [];
  const section = (heading, within = text, where = file) => {
    const body = headingSection(within, heading);
    if (body === undefined) bad.push(`${where} has no "${heading}" section`);
    return body;
  };
  const what = section("## What Tidegap is");
  if (what !== undefined) {
    const hits = sentences(what).filter((t) => t.includes("one run of one runner"));
    if (hits.length !== 1) bad.push(`"## What Tidegap is": ${hits.length} sentences say "one run of one runner", want 1`);
    else bad.push(...listProblems('"## What Tidegap is" runner sentence', [...hits[0].matchAll(/`([^`\s]+)`/g)].map((m) => m[1]), [...(runners ?? [])], "QUEUE_ADD_RUNNERS"));
  }
  const runs = section("## When a task runs");
  if (runs !== undefined && !sentences(runs).some((t) => t.includes("`--not-before`") && t.includes("not a run time"))) {
    bad.push('"## When a task runs" has no sentence that says `--not-before` is "not a run time"');
  }
  const stub = { record: { taskId: "t-1", status: "completed", title: "stub" } };
  const rendered = typeof renderNoticeBlock === "function";
  const noticeLine = rendered ? (renderNoticeBlock([stub]).text.split("\n")[0] ?? "") : "";
  if (!rendered) bad.push("the CLI exports no renderNoticeBlock");
  else if (!noticeLine) bad.push("renderNoticeBlock prints no notice line for one task");
  else if (renderNoticeBlock([]).text !== "") bad.push("renderNoticeBlock prints text for no task");
  const back = section("## How the result comes back");
  const claude = back === undefined ? undefined : section(CLAUDE_CODE, back, '"## How the result comes back"');
  if (claude !== undefined) {
    const got = spans(claude);
    if (noticeLine && !got.includes(noticeLine)) bad.push(`"${CLAUDE_CODE}" does not quote the notice line \`${noticeLine}\``);
    for (const lead of ["--wake", "tidegap queue wait", "tidegap queue events"]) {
      if (!got.some((x) => x.startsWith(lead))) bad.push(`"${CLAUDE_CODE}" has no \`${lead}…\` span`);
    }
  }
  const repeating = section("## Recurring work: use Tidegap, not cron");
  const tool = core.TOOL_SURFACE.find((t) => t.name === "schedule_task");
  const repeats = [...new Set((tool?.params ?? []).filter((p) => p.name === "repeat").flatMap((p) => p.values ?? []))].filter((v) => v !== "none" && v !== "quota_reset");
  if (repeats.length === 0) bad.push("schedule_task repeat has no job values");
  if (repeating !== undefined) {
    const got = spans(repeating);
    for (const want of ["--repeat", ...repeats]) if (!got.includes(want)) bad.push(`"## Recurring work: use Tidegap, not cron" has no \`${want}\` span`);
  }
  return bad;
}

// An example output path: the token after `--output`, `--result-path`, `output_path` or `result_path`.
const OUTPUT_PATH_RE = /(?:--output|--result-path|\boutput_path\b|\bresult_path\b)[\s=:"'`]+([^\s"'`,)]+)/g;
// A concrete path starts at the root, the home folder or the current folder; `<abs-path>` is a placeholder.
const CONCRETE_RE = /^(?:\/|~\/|\$HOME\/|\$\{HOME\}\/|\.\.?\/)/;

/**
 * K24: no concrete example output path in `files` (`{ name, text }`) lies under a protected home
 * folder: `~/`, `$HOME/`, `${HOME}/`, `/Users/<name>/` or `/home/<name>/` followed by a `protectedDirs` entry
 * (PROTECTED_HOME_DIRS of the built core, matched without case). A rule that reads no concrete
 * path fails, so it never passes on nothing.
 */
export function examplePathProblems({ files, protectedDirs }) {
  const bad = [];
  if (protectedDirs.length === 0) return ["no PROTECTED_HOME_DIRS found in the code"];
  const dirs = protectedDirs.map((d) => d.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|");
  const guarded = new RegExp(`^(?:~|\\$HOME|\\$\\{HOME\\}|/Users/[^/]+|/home/[^/]+)/(?:${dirs})(?:/|$)`, "i");
  let concrete = 0;
  for (const { name, text } of files) {
    text.split("\n").forEach((line, i) => {
      for (const m of line.matchAll(OUTPUT_PATH_RE)) {
        if (!CONCRETE_RE.test(m[1])) continue;
        concrete++;
        if (guarded.test(m[1])) bad.push(`${name}:${i + 1} example path ${m[1]} is under a protected folder`);
      }
    });
  }
  if (concrete === 0) bad.push("no concrete example output path found in the plugin files and READMEs");
  return bad;
}

export const SKILL_MAX_LINES = 260;

/** K25: the skill has at most SKILL_MAX_LINES lines (a final newline ends the last line, it adds none). */
export function skillLengthProblems({ text, file }) {
  const lines = text.replace(/\n$/, "").split("\n").length;
  return lines > SKILL_MAX_LINES ? [`${file} has ${lines} lines, the cap is ${SKILL_MAX_LINES}`] : [];
}
