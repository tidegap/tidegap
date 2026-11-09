// The plugin drift rules of docs-drift.mjs, as pure functions: S7.3 (the plugin commands name
// only real tools and arguments) and S7.4 (the tidegap skill names only real commands, flags,
// slash commands and tools). Each takes file texts and code values and returns the list of
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
