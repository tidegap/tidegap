// The jobs drift rules of docs-drift.mjs, as pure functions: K15 (jobs docs vs the
// schedule_task surface and guaranteeText), K16 (the job limits the jobs page states vs
// the constants the code enforces), K17 (one "every night" window everywhere), K18 (the
// jobs page's Python ticker claim vs the Python source). Each takes page texts and code
// values and returns the list of problems; docs-drift.mjs reads the files and the built
// modules. Tests: docs-drift-jobs.test.mjs (node --test).

/**
 * K15: `repeat` values in the parameter table, the cadence table and the tools page, and the
 * job parameters, exist in TOOL_SURFACE; the every-N-hours range is the every_hours min and
 * max; every quoted guarantee sentence is what guaranteeText prints, and each cadence kind
 * has one. `core` needs TOOL_SURFACE, MIN_EVERY_HOURS, MAX_EVERY_HOURS and guaranteeText.
 */
export function jobsSurfaceProblems({ page, pageName, tools, toolsName, core }) {
  const bad = [];
  // Parameter table: `| \`name\` | ... |` rows under "Agents and schedule_task".
  const section = page.split(/\{#jobs-agents\}/)[1]?.split(/^### /m)[0] ?? "";
  const rows = [...section.matchAll(/^\| `([a-z_]+)` \| (.+?) \|[ \t]*$/gm)].map((m) => ({ name: m[1], text: m[2] }));
  if (rows.length < 5) bad.push(`${pageName} documents ${rows.length} schedule_task job parameters (want at least 5)`);
  const tool = core.TOOL_SURFACE.find((t) => t.name === "schedule_task");
  if (!tool) bad.push("TOOL_SURFACE has no schedule_task");
  const params = (tool?.params ?? []).filter((p) => p.name);
  const names = new Set(params.map((p) => p.name));
  for (const r of rows) if (!names.has(r.name)) bad.push(`documented parameter \`${r.name}\` is not a schedule_task parameter`);
  for (const must of ["repeat", "every_hours", "days", "window", "time_zone"]) {
    if (!names.has(must)) bad.push(`schedule_task lost parameter ${must}`);
    if (!rows.some((r) => r.name === must)) bad.push(`${pageName} does not document \`${must}\``);
  }
  // repeat values: the documented set is the repeat enum minus none and quota_reset (the older series, documented in prose).
  const repeat = rows.find((r) => r.name === "repeat");
  const enumValues = new Set(params.filter((p) => p.name === "repeat").flatMap((p) => p.values ?? []));
  if (enumValues.size === 0) bad.push("schedule_task repeat has no values");
  const want = [...enumValues].filter((v) => v !== "none" && v !== "quota_reset").sort();
  // Only the row's leading value list counts, so a backticked cross-reference later in the row is free.
  const lead = /^((?:`[a-z_]+`(?:, | or |,? and )?)+)/.exec(repeat?.text ?? "")?.[1] ?? "";
  const got = [...lead.matchAll(/`([a-z_]+)`/g)].map((m) => m[1]).sort();
  if (want.join(",") !== got.join(",")) bad.push(`repeat values: docs ${got.join(" ") || "-"} vs code ${want.join(" ") || "-"}`);
  // Cadence table: the backticked cadences are the repeat values, plus one "every N hours" row for every_n_hours.
  const cadenceSection = page.split(/\{#jobs-cadence\}/)[1]?.split(/^### /m)[0] ?? "";
  const cadenceRows = [...cadenceSection.matchAll(/^\| ([^|]+?) \| [^|]+ \|[ \t]*$/gm)].map((m) => m[1]).filter((c) => c !== "Cadence" && !/^-+$/.test(c));
  if (cadenceRows.length < 3) bad.push(`${pageName} cadence table has ${cadenceRows.length} rows (want at least 3)`);
  const cadenceGot = cadenceRows.flatMap((c) => [...c.matchAll(/`([a-z_]+)`/g)].map((m) => m[1])).sort();
  const cadenceWant = want.filter((v) => v !== "every_n_hours");
  if (cadenceGot.join(",") !== cadenceWant.join(",")) bad.push(`cadence table: docs ${cadenceGot.join(" ") || "-"} vs code ${cadenceWant.join(" ") || "-"}`);
  if (want.includes("every_n_hours") && !cadenceRows.includes("every N hours")) bad.push(`${pageName} cadence table has no "every N hours" row`);
  // Tools page: the "`repeat` set to ... creates" list names the same values.
  const toolsList = /`repeat` set to ((?:`[a-z_]+`(?:, | or )?)+) creates/.exec(tools)?.[1];
  if (!toolsList) bad.push(`${toolsName} has no "\`repeat\` set to ... creates" list`);
  else {
    const toolsGot = [...toolsList.matchAll(/`([a-z_]+)`/g)].map((m) => m[1]).sort();
    if (toolsGot.join(",") !== want.join(",")) bad.push(`${toolsName} repeat values: docs ${toolsGot.join(" ")} vs code ${want.join(" ") || "-"}`);
  }
  // `repeat: <value>` mentions on both pages are repeat values.
  const repeatRefs = [page, tools].flatMap((t) => [...t.matchAll(/`repeat: ([a-z_]+)`/g)].map((m) => m[1]));
  if (repeatRefs.length === 0) bad.push(`no \`repeat: <value>\` mention in ${pageName} or ${toolsName}`);
  for (const v of repeatRefs) if (!enumValues.has(v)) bad.push(`\`repeat: ${v}\` is not a repeat value`);
  // every_hours range: the parameter row and the cadence table state the tool's min and max.
  const eh = params.find((p) => p.name === "every_hours");
  if (!Number.isInteger(eh?.min) || !Number.isInteger(eh?.max)) bad.push("schedule_task every_hours has no integer min and max");
  else {
    const range = `${eh.min} to ${eh.max}`;
    if (eh.min !== core.MIN_EVERY_HOURS || eh.max !== core.MAX_EVERY_HOURS) bad.push(`every_hours ${range} vs core ${core.MIN_EVERY_HOURS} to ${core.MAX_EVERY_HOURS}`);
    if (!rows.find((r) => r.name === "every_hours")?.text.includes(range)) bad.push(`every_hours row does not say ${range}`);
    if (!cadenceSection.includes(`N from ${range}`)) bad.push(`${pageName} cadence table does not say N from ${range}`);
  }
  // days: the documented range names the first and the last weekday value.
  const daysEnum = params.find((p) => p.name === "days")?.values ?? [];
  const daysRow = rows.find((r) => r.name === "days")?.text ?? "";
  if (daysEnum.length === 0) bad.push("schedule_task days has no values");
  else if (!daysRow.includes(`\`${daysEnum[0]}\``) || !daysRow.includes(`\`${daysEnum[daysEnum.length - 1]}\``)) bad.push(`days row does not name \`${daysEnum[0]}\` to \`${daysEnum[daysEnum.length - 1]}\``);
  // Guarantee sentences: every quoted "runs ..." span equals guaranteeText of the schedule it describes.
  const quoted = [...page.matchAll(/`(runs [^`\n]+)`/g)].map((m) => m[1]);
  const shapes = new Set();
  const DAY = { Mon: "mon", Tue: "tue", Wed: "wed", Thu: "thu", Fri: "fri", Sat: "sat", Sun: "sun" };
  for (const q of quoted) {
    const window = /between (\d\d:\d\d) and (\d\d:\d\d)$/.exec(q);
    const hours = /^runs at least every (\d+) h,/.exec(q);
    const dayList = /^runs (?:once )?every ((?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)(?:, (?:Mon|Tue|Wed|Thu|Fri|Sat|Sun))*(?: and (?:Mon|Tue|Wed|Thu|Fri|Sat|Sun))?)(?: between|,|$)/.exec(q);
    let cadence = { kind: "daily" };
    if (hours) cadence = { kind: "hours", every: Number(hours[1]) };
    else if (/every weekday/.test(q)) cadence = { kind: "weekdays" };
    else if (dayList) cadence = { kind: "weekly", days: dayList[1].split(/, | and /).map((d) => DAY[d]) };
    shapes.add(cadence.kind === "daily" ? (window ? "daily with a window" : "daily") : cadence.kind === "hours" ? "every N hours" : cadence.kind);
    const schedule = { cadence, timeZone: "UTC", ...(window ? { window: { start: window[1], end: window[2] } } : {}) };
    let produced;
    try {
      produced = core.guaranteeText(schedule);
    } catch (err) {
      produced = `error: ${err.message}`;
    }
    if (produced !== q) bad.push(`quoted "${q}" vs guaranteeText "${produced}"`);
  }
  const missingShapes = ["daily with a window", "weekdays", "weekly", "every N hours"].filter((k) => !shapes.has(k));
  if (missingShapes.length) bad.push(`${pageName} quotes no guarantee sentence for: ${missingShapes.join(", ")}`);
  return bad;
}

const WORD = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10 };
const MIN = 60_000;

/**
 * K16: every job limit the jobs page states equals the constant the code enforces. Each
 * claim must appear at least once (no vacuous pass), and every match must agree. `core`
 * needs DEFAULT_JOB_CAPS, JOB_RETRY_DELAY_MS, JOB_AUTO_PAUSE_FAILURES and SCRUB_MIN_LENGTH;
 * `api` (packages/cli/dist/ui/jobs-api.js) JOB_WRITES_PER_MINUTE and JOB_PREVIEWS_PER_MINUTE;
 * `shell` (packages/cli/dist/jobs/run-shell.js) STDERR_TAIL_BYTES.
 */
export function jobLimitProblems({ page, pageName, core, api, shell }) {
  const caps = core.DEFAULT_JOB_CAPS ?? {};
  const claims = [
    ["command time limit (minutes)", caps.commandTimeoutMs / MIN, /(?:time limit is |command time limit \()(\w+) minutes?/g],
    ["LLM time limit (minutes)", caps.llmTimeoutMs / MIN, /LLM time limit \((\w+) minutes?\)/g],
    ["LLM budget (USD)", caps.maxBudgetUsd, /LLM budget \((\d+(?:\.\d+)?) USD\)/g],
    ["output cap (MiB)", caps.outputCapBytes / 1024 ** 2, /Output is capped \((\d+) MiB\)/g],
    // "errors keep their last 4 KiB"; the summarize claim below reads "(the last 200 KiB)".
    ["stderr tail (KiB)", shell.STDERR_TAIL_BYTES / 1024, /errors keep their last (\w+) KiB/g],
    ["summarize input (KiB)", caps.summarizeInputCapBytes / 1024, /the last (\d+) KiB\)/g],
    ["retry delay (minutes)", core.JOB_RETRY_DELAY_MS / MIN, /one retry (\w+) minutes later/g],
    ["auto-pause failed slots", core.JOB_AUTO_PAUSE_FAILURES, /After (\w+) failed slots in a row/g],
    ["scrub minimum (characters)", core.SCRUB_MIN_LENGTH, /at least (\w+) characters/g],
    ["job writes per minute", api.JOB_WRITES_PER_MINUTE, /at most (\w+) job writes/g],
    ["previews per minute", api.JOB_PREVIEWS_PER_MINUTE, /and (\w+) previews per minute/g],
  ];
  const bad = [];
  for (const [what, code, re] of claims) {
    if (!Number.isFinite(code) || code <= 0) {
      bad.push(`code has no ${what}`);
      continue;
    }
    const got = [...page.matchAll(re)].map((m) => WORD[m[1].toLowerCase()] ?? Number(m[1]));
    if (got.length === 0) bad.push(`${pageName} does not state the ${what} (${code})`);
    for (const n of got) if (n !== code) bad.push(`${what}: docs ${n} vs code ${code}`);
  }
  return bad;
}

/**
 * K17: "every night" means one window everywhere. The window comes from the schedule_task
 * text; every sentence that names night and a window, in each source, must use it. `files`
 * is `[name, text]` pairs; the schedule_task text and `core.AGENTS_BLOCK` are added as
 * sources from `core`.
 */
export function nightWindowProblems({ core, files }) {
  const strings = (v) => (typeof v === "string" ? [v] : v && typeof v === "object" ? Object.values(v).flatMap(strings) : []);
  const toolText = strings(core.TOOL_SURFACE.find((t) => t.name === "schedule_task")).join("\n");
  const want = /"every night" is 'daily' with window '(\d\d:\d\d-\d\d:\d\d)'/.exec(toolText)?.[1];
  const bad = [];
  if (!want) bad.push(`schedule_task text has no "every night" is 'daily' with window 'HH:MM-HH:MM'`);
  const sources = [["schedule_task text", toolText], ...files, ["core AGENTS_BLOCK", core.AGENTS_BLOCK ?? ""]];
  for (const [name, text] of sources) {
    const sentences = text.replace(/\s+/g, " ").split(/(?<=[.;!?])\s+/).filter((t) => /\bnight\b/i.test(t));
    const windows = sentences.flatMap((t) => [...t.matchAll(/\b\d\d:\d\d-\d\d:\d\d\b/g)].map((m) => m[0]));
    // Copy-paste daily commands (`--daily --window ...`, `--repeat daily --window ...`) are the night example too.
    windows.push(...[...text.matchAll(/--(?:daily|repeat daily) --window (\d\d:\d\d-\d\d:\d\d)\b/g)].map((m) => m[1]));
    if (windows.length === 0) bad.push(`${name} names no night window`);
    for (const w of windows) if (want && w !== want) bad.push(`${name}: night window ${w} vs schedule_task ${want}`);
  }
  return bad;
}

/**
 * K18: the jobs page's Python ticker claim matches the Python source, read as text. In the
 * {#jobs-versions} section, the Python ticker sentence names exactly the providers of
 * `_TS_ONLY_PROVIDERS` (`scheduler`: packages/core-py/src/tidegap/scheduler.py), and every
 * `TickResult.<field>` the section names is a field of `TickResult` (`types`:
 * packages/core-py/src/tidegap/types.py). Each part fails when it finds nothing.
 */
export function pythonTickerProblems({ page, pageName, scheduler, types }) {
  const bad = [];
  const set = /^_TS_ONLY_PROVIDERS = frozenset\(\{([^}]*)\}\)/m.exec(scheduler)?.[1];
  // Every item must be a "..." literal: one the parse skipped would go unchecked.
  const items = (set ?? "").split(",").map((t) => t.trim()).filter(Boolean);
  const literal = (t) => /^"([^"\\]+)"$/.exec(t)?.[1];
  const providers = items.map(literal).filter((p) => p !== undefined);
  if (set === undefined) bad.push('scheduler.py has no _TS_ONLY_PROVIDERS = frozenset({"..."}) line');
  else if (items.length === 0) bad.push("scheduler.py _TS_ONLY_PROVIDERS is empty");
  else if (providers.length < items.length) {
    bad.push(`scheduler.py _TS_ONLY_PROVIDERS has items K18 cannot read: ${items.filter((t) => literal(t) === undefined).join(", ")}`);
  }
  // The class body runs to the next line that starts at column 0.
  const body = /^class TickResult:\n([\s\S]*?)(?=^\S)/m.exec(types)?.[1] ?? "";
  const fields = new Set([...body.matchAll(/^ {4}([a-z_][a-z0-9_]*): \S/gm)].map((m) => m[1]));
  if (fields.size === 0) bad.push("types.py has no TickResult class with fields");
  const section = page.split(/\{#jobs-versions\}/)[1]?.split(/^#{1,3} /m)[0];
  if (section === undefined) return [...bad, `${pageName} has no {#jobs-versions} section`];
  const list = /The Python ticker [^.]*? holds every job run, whatever its provider, and every ((?:`[a-z0-9_-]+`(?:, | or |,? and )?)+) rows? it has no adapter for/.exec(section)?.[1];
  if (!list) {
    bad.push(`${pageName} {#jobs-versions} has no "The Python ticker ... holds every job run, whatever its provider, and every \`...\` row it has no adapter for" sentence`);
  } else if (providers.length > 0) {
    const named = [...list.matchAll(/`([a-z0-9_-]+)`/g)].map((m) => m[1]);
    for (const p of providers) if (!named.includes(p)) bad.push(`${pageName} Python ticker sentence does not name \`${p}\` (in _TS_ONLY_PROVIDERS)`);
    for (const p of named) if (!providers.includes(p)) bad.push(`${pageName} Python ticker sentence names \`${p}\`, not in _TS_ONLY_PROVIDERS`);
  }
  const named = [...section.matchAll(/`TickResult\.([a-z_][a-z0-9_]*)`/g)].map((m) => m[1]);
  if (named.length === 0) bad.push(`${pageName} {#jobs-versions} names no \`TickResult.<field>\``);
  if (fields.size > 0) for (const f of named) if (!fields.has(f)) bad.push(`${pageName} names \`TickResult.${f}\`, not a TickResult field`);
  return bad;
}
