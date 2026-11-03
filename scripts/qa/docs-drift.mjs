#!/usr/bin/env node
// QA area "docs": docs against code. K5 (MCP tool counts; the public site files
// install.md, llms.txt and architecture.html and the README badge MCP-<n>%20tools
// must state the MCP count), K6 and S11.10
// (test-count claims against tests.generated.ts), K7 (site CLI table), K11 and S7.4
// (every documented `tidegap` flag exists; S7.4 also checks that each slash command and
// tool name in the skill exists), S5.7 (Telegram /help vs the site
// table), S7.3 (plugin commands name real tools and arguments), S8.4
// (OpenClaw install text and version), S11.7 (K5 + K7 + K11), K12 (grid region
// docs: source names, unknown-zone examples, approximate time zones, request template),
// K13 (notifications docs: kinds vs the registry, quoted error codes vs code,
// `tidegap channels` subcommands and --help blocks vs the CLI), K14 (the site's
// agent block copy equals the core's AGENTS_BLOCK), K15 (jobs docs: `repeat` values in the
// parameter table, the cadence table and the tools page, and job parameters, exist in TOOL_SURFACE;
// the every-N-hours range is the every_hours min and max; every quoted guarantee sentence is what
// guaranteeText prints, and each cadence kind has one), K16 (jobs docs state the job caps, the
// stderr tail, retry delay, auto-pause count, scrub minimum and the job write and preview rate
// limits the code enforces), K17 (the "every night" window of the schedule_task text is the one
// the jobs page, defer.md, the skill and the agent block use), K18 (the jobs page's Python ticker
// sentence names exactly core-py's _TS_ONLY_PROVIDERS, and only real TickResult fields),
// K19 (the handoff page's ledger contract: every listed tasks column exists in the store's schema,
// and the task_events columns, the status values and the event kinds equal the code's), K20 (the
// protected-folder list on the handoff page and the tools page equals the core's PROTECTED_HOME_DIRS),
// K21 (the `queue add --json` keys on the handoff page equal the command's QUEUE_ADD_JSON_KEYS),
// K22 (the tidegap skill states four facts in their sections: one task is one run of one runner,
// with QUEUE_ADD_RUNNERS; `--not-before` is not a run time; the notice line renderNoticeBlock prints
// and the wake, wait and events commands; recurring work through `--repeat` with every job repeat value).
// Prints `PASS` or the failed case ids + log path.
//
//   node scripts/qa/docs-drift.mjs [--stream docs] [--log-dir <dir>] [--keep]

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { join, relative } from "node:path";
import { pathToFileURL } from "node:url";

import { channelsDocsProblems } from "./docs-drift-channels.mjs";
import { jobLimitProblems, jobsSurfaceProblems, nightWindowProblems, pythonTickerProblems } from "./docs-drift-jobs.mjs";
import { CORE, discoverCommands, docPage, expect, missingFromSiteTable, ROOT, startStream } from "./env.mjs";

const s = startStream("docs-drift", { portBase: 47905 });
const { step, cli } = s;
const core = await import(pathToFileURL(CORE).href);
const read = (p) => readFileSync(join(ROOT, p), "utf8");
const rel = (p) => relative(ROOT, p);
const INSTALL = docPage("install");
const CLI_PAGE = docPage("cli");
const NOTIFY = docPage("notifications");
const TELEGRAM = docPage("telegram");
const CONFIG = docPage("config");
const JOBS = docPage("jobs");
const TOOLS_PAGE = docPage("tools");
const HANDOFF = docPage("handoff");

/** Files under `dir` (repo-relative) whose name matches `re`, skipping build output. */
function walk(dir, re, out = []) {
  const abs = join(ROOT, dir);
  if (!existsSync(abs)) return out;
  for (const name of readdirSync(abs)) {
    if (/^(node_modules|dist|\.next|out|build|coverage|\.venv)$/.test(name)) continue;
    const p = join(abs, name);
    if (statSync(p).isDirectory()) walk(rel(p), re, out);
    else if (re.test(name)) out.push(rel(p));
  }
  return out;
}

const DOCS = [
  "README.md",
  ...["QUICKSTART.md", "CONTRIBUTING.md"].filter((f) => existsSync(join(ROOT, f))),
  ...walk("apps/web/content/docs", /\.md$/),
  ...walk("packages/claude-code-plugin", /\.md$/),
  ...walk("packages/openclaw-plugin", /^README\.md$/),
  ...walk("packages/mcp-server", /^README\.md$/),
  ...walk("packages/cli", /^README\.md$/),
];
const SITE_PAGES = walk("apps/web/src", /\.tsx?$/);

const results = {};
const track = async (id, title, fn) => {
  results[id] = await step(id, title, fn);
};

const NUMBER = { eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, thirteen: 13 };
// "12 tools", "twelve new tools", "11 MCP tools", and the "## MCP tools (12)" heading.
const TOOL_COUNT_RE = /\b(\d{1,2}|eight|nine|ten|eleven|twelve|thirteen)\s+(?:new\s+)?(?:MCP\s+|agent\s+|canonical\s+)?tools\b|\btools\s*\((\d{1,2})\)/gi;
// Public site files state only the MCP count, so a count there must equal it; elsewhere
// either host's count passes.
const PUBLIC_TOOL_PAGES = ["apps/web/public/install.md", "apps/web/public/llms.txt", "apps/web/public/architecture.html"];
// The README badge "MCP-12%20tools" has no space before "tools", so TOOL_COUNT_RE skips it.
const MCP_BADGE_RE = /\bMCP-(\d+)%20tools\b/g;
await track("K5", "MCP tool counts in docs and the README badge match toolsForHost (mcp 12, openclaw 11)", () => {
  const want = { mcp: core.toolsForHost("mcp").length, openclaw: core.toolsForHost("openclaw").length };
  s.note(`tool counts in code: mcp ${want.mcp}, openclaw ${want.openclaw}`);
  const bad = [];
  const silent = [];
  for (const f of [...DOCS, ...SITE_PAGES, "packages/mcp-server/src/server.ts", ...PUBLIC_TOOL_PAGES]) {
    const strict = PUBLIC_TOOL_PAGES.includes(f);
    let counts = 0;
    read(f)
      .split("\n")
      .forEach((line, i) => {
        for (const m of line.matchAll(TOOL_COUNT_RE)) {
          counts++;
          const word = m[1] ?? m[2];
          const n = NUMBER[word.toLowerCase()] ?? Number(word);
          if (n !== want.mcp && (strict || n !== want.openclaw)) bad.push(`${f}:${i + 1} "${m[0]}"`);
        }
      });
    if (strict && counts === 0) silent.push(f);
  }
  // The badge states the MCP count; a README without it fails rather than passing on nothing.
  let badges = 0;
  read("README.md")
    .split("\n")
    .forEach((line, i) => {
      for (const m of line.matchAll(MCP_BADGE_RE)) {
        badges++;
        if (Number(m[1]) !== want.mcp) bad.push(`README.md:${i + 1} "${m[0]}"`);
      }
    });
  expect(silent.length === 0, `no tool count found in ${silent.join(", ")}`);
  expect(badges > 0, "README.md has no MCP-<n>%20tools badge");
  expect(bad.length === 0, `stale counts: ${bad.slice(0, 8).join("; ")}${bad.length > 8 ? ` (+${bad.length - 8})` : ""}`);
});

// K6 / S11.10: every test count in the docs and the site equals the generated
// one (apps/web/src/lib/tests.generated.ts, written by `pnpm gen:tests`). The
// check reads files only, so it is deterministic; `pnpm gen:tests:check` is what
// proves the generated file matches the code.
const generated = readFileSync(join(ROOT, "apps/web/src/lib/tests.generated.ts"), "utf8");
const total = Number(/"total":\s*(\d+)/.exec(generated)?.[1]);
const TESTS_RE = /\b(\d{1,2},\d{3}|\d{3,5})\s+(?:automated\s+)?tests\b|\btests-(\d+)(?:%20|-)/gi;
const claimFiles = ["README.md", "apps/web/public/install.md", ...DOCS.filter((f) => f !== "README.md"), ...SITE_PAGES.filter((f) => !f.endsWith(".generated.ts"))];
const k6 = await step("K6", "test-count claims match tests.generated.ts", () => {
  expect(Number.isFinite(total), "tests.generated.ts has no readable total");
  const claims = claimFiles.flatMap((f) => [...read(f).matchAll(TESTS_RE)].map((m) => ({ f, n: Number((m[1] ?? m[2]).replace(",", "")) })));
  const stale = claims.filter((c) => c.n !== total);
  expect(stale.length === 0, `claims ${[...new Set(stale.map((c) => `${c.n} (${c.f})`))].join(", ")} vs generated ${total}`);
  const readme = read("README.md");
  expect(/<!-- tests:start -->[\s\S]+<!-- tests:end -->/.test(readme), "README.md lost its <!-- tests:start --> block");
  const pages = ["apps/web/src/app/about/page.tsx", "apps/web/src/components/home/proof.tsx"];
  const unwired = pages.filter((f) => !/TEST_COUNTS/.test(read(f)));
  expect(unwired.length === 0, `not reading TEST_COUNTS: ${unwired.join(", ")}`);
});
await step("S11.10", "claims (K6) match the generated test count", () => expect(k6, "see K6"));

const commands = discoverCommands(cli);
await track("K7", "site CLI docs list every command; install page names tidegap status", () => {
  const missing = missingFromSiteTable([...commands.keys()]);
  const install = read(INSTALL.path);
  const bad = [...(missing.length ? [`${CLI_PAGE.name} misses ${missing.join(", ")}`] : []), ...(/tidegap status/.test(install) ? [] : [`${INSTALL.name} never names \`tidegap status\``])];
  expect(bad.length === 0, bad.join("; "));
});

/** `{ file, line, cmd, flag }` for each `--flag` that follows a `tidegap <command>` in a code span or block. */
function documentedFlags(files) {
  const found = [];
  const paths = [...commands.keys()].sort((a, b) => b.length - a.length);
  for (const f of files) {
    const text = read(f);
    const spans = [...text.matchAll(/`([^`\n]+)`/g), ...text.matchAll(/```[a-z]*\n([\s\S]*?)```/g)].flatMap((m) => m[1].split("\n"));
    for (const span of spans) {
      for (const m of span.matchAll(/\btidegap\s+([a-z][a-z -]*?)((?:\s+(?:<[^>]+>|\[[^\]]+\]|"[^"]*"|[^\s|#;&]+))*)/g)) {
        const words = `${m[1]}${m[2]}`.trim().split(/\s+/);
        const cmd = paths.find((p) => words.slice(0, p.split(" ").length).join(" ") === p);
        if (!cmd) continue;
        for (const flag of `${m[2]}`.match(/--[a-z][a-z-]*/g) ?? []) found.push({ f, cmd, flag });
      }
    }
  }
  return found;
}
const unknownFlags = (files) =>
  documentedFlags(files).filter(({ cmd, flag }) => {
    const opts = commands.get(cmd) ?? [];
    return !opts.includes(flag) && !(flag.startsWith("--no-") && opts.includes(`--${flag.slice(5)}`)) && flag !== "--help" && flag !== "--version";
  });

await track("K11", "every documented `tidegap … --flag` exists in the CLI", () => {
  const bad = unknownFlags(DOCS);
  expect(bad.length === 0, bad.slice(0, 8).map((b) => `${b.f}: tidegap ${b.cmd} ${b.flag}`).join("; "));
});

// A tool-shaped name (S7.3, S7.4): a tool prefix and a snake_case rest, unless the rest ends like a field.
const TOOL_NAME_RE = /\b((?:get|recommend|schedule|check|cancel|expedite|update|postpone|reply|retry)_[a-z_]+|tidegap_[a-z]+)\b/g;
const FIELD_SUFFIX_RE = /_(id|at|kind|g|path|for|pct|source)$/;
const SKILL = "packages/claude-code-plugin/skills/tidegap/SKILL.md";

await track("S7.4", "skills/tidegap/SKILL.md names only real commands, flags, slash commands and tools", () => {
  const text = read(SKILL);
  const bad = unknownFlags([SKILL]).map((b) => `tidegap ${b.cmd} ${b.flag}`);
  const unknownCmds = [...text.matchAll(/`tidegap ([a-z][a-z-]*)/g)]
    .map((m) => m[1])
    .filter((c) => ![...commands.keys()].some((k) => k.split(" ")[0] === c));
  bad.push(...unknownCmds.map((c) => `unknown command tidegap ${c}`));
  // Each /tidegap:<name> is a file in commands/, and each tool-shaped name is a TOOL_SURFACE tool.
  const slash = [...new Set([...text.matchAll(/\/tidegap:([a-z][a-z-]*)/g)].map((m) => m[1]))];
  if (slash.length === 0) bad.push("the skill names no /tidegap: slash command");
  for (const name of slash) if (!existsSync(join(ROOT, "packages/claude-code-plugin/commands", `${name}.md`))) bad.push(`unknown slash command /tidegap:${name}`);
  const tools = new Set(core.TOOL_SURFACE.map((t) => t.name));
  const named = [...new Set([...text.matchAll(TOOL_NAME_RE)].map((m) => m[1]))].filter((n) => !FIELD_SUFFIX_RE.test(n));
  if (named.length === 0) bad.push("the skill names no tool");
  for (const name of named) if (!tools.has(name)) bad.push(`unknown tool ${name}`);
  expect(bad.length === 0, bad.slice(0, 8).join("; "));
});

await track("S5.7", `Telegram /help equals the ${TELEGRAM.name} command table`, () => {
  const help = core.HELP_TEXT;
  expect(typeof help === "string", "core does not export HELP_TEXT");
  const table = read(TELEGRAM.path);
  const inHelp = new Set(help.match(/\/[a-z]+/g));
  const inDocs = new Set([...table.matchAll(/^\| `(\/[a-z]+)/gm)].map((m) => m[1]));
  const onlyHelp = [...inHelp].filter((c) => !inDocs.has(c));
  const onlyDocs = [...inDocs].filter((c) => !inHelp.has(c));
  expect(onlyHelp.length + onlyDocs.length === 0, `only in /help: ${onlyHelp.join(" ") || "-"}; only in docs: ${onlyDocs.join(" ") || "-"}`);
});

await track("S7.3", "plugin commands name only real tools and arguments", () => {
  const tools = new Map(core.TOOL_SURFACE.map((t) => [t.name, new Set(t.params.map((p) => p.name))]));
  const bad = [];
  for (const f of walk("packages/claude-code-plugin/commands", /\.md$/)) {
    read(f)
      .split("\n")
      .forEach((line, i) => {
        for (const m of line.matchAll(TOOL_NAME_RE)) {
          if (!tools.has(m[1]) && !FIELD_SUFFIX_RE.test(m[1])) bad.push(`${f}:${i + 1} unknown tool ${m[1]}`);
        }
        const tool = [...tools.keys()].find((t) => line.includes(t));
        if (!tool) return;
        for (const m of line.matchAll(/\b([a-z]+(?:_[a-z]+)+)\s*[:=]\s/g)) {
          if (!tools.has(m[1]) && ![...tools.values()].some((ps) => ps.has(m[1]))) bad.push(`${f}:${i + 1} unknown argument ${m[1]}`);
        }
      });
  }
  expect(bad.length === 0, bad.slice(0, 8).join("; "));
});

await track("S8.4", "OpenClaw README install command and plugin version match the release", () => {
  const readme = read("packages/openclaw-plugin/README.md");
  const pkg = JSON.parse(read("packages/openclaw-plugin/package.json"));
  const manifest = JSON.parse(read("packages/openclaw-plugin/openclaw.plugin.json"));
  const release = JSON.parse(read("packages/cli/package.json")).version;
  const bad = [];
  if (!readme.includes("openclaw plugins install clawhub:@vitalini/tidegap")) bad.push("README misses `openclaw plugins install clawhub:@vitalini/tidegap`");
  if (manifest.version !== pkg.version) bad.push(`openclaw.plugin.json ${manifest.version} vs package.json ${pkg.version}`);
  if (pkg.version !== release) bad.push(`plugin ${pkg.version} vs release ${release}`);
  expect(bad.length === 0, bad.join("; "));
});

await track("K12", "grid region docs match the resolver (sources, unknown-zone text, approximate zones, request template)", () => {
  const config = read(CONFIG.path);
  const bad = [];
  if (!/\{#region\}/.test(config)) bad.push(`${CONFIG.name} lost its {#region} heading`);
  if (!/<!--\s*embed:regions\s*-->/.test(config)) bad.push(`${CONFIG.name} lost <!-- embed:regions -->`);
  // The precedence table names exactly the RegionSource values.
  const type = /export type RegionSource =([^;]+);/.exec(read("packages/core-ts/src/region.ts"))?.[1] ?? "";
  const sources = new Set([...type.matchAll(/"([a-z]+)"/g)].map((m) => m[1]));
  if (sources.size === 0) bad.push("RegionSource in packages/core-ts/src/region.ts yields no values");
  const regionSection = config.split(/\{#region\}/)[1]?.split(/^#{1,3} /m)[0] ?? "";
  const documented = new Set([...regionSection.matchAll(/^\| \d \| `([a-z]+)` \|/gm)].map((m) => m[1]));
  const onlyCode = [...sources].filter((x) => !documented.has(x));
  const onlyDocs = [...documented].filter((x) => !sources.has(x));
  if (onlyCode.length + onlyDocs.length) bad.push(`precedence table: missing ${onlyCode.join(" ") || "-"}, unknown ${onlyDocs.join(" ") || "-"}`);
  // Every quoted "Unknown zone X. Closest: …." is what the resolver prints for X.
  let quotes = 0;
  for (const f of [...DOCS, "docs/spec/ui-client-api.md"]) {
    for (const m of read(f).matchAll(/Unknown zone ([A-Za-z0-9_-]+)\.( Closest: [^.]+\.)?/g)) {
      quotes++;
      const want = core.unknownRegionMessage(m[1]).split(" Request a region:")[0];
      if (m[0] !== want) bad.push(`${f}: "${m[0]}" vs "${want}"`);
    }
  }
  if (quotes === 0) bad.push('no doc quotes "Unknown zone X. Closest: ..."');
  // The Ukraine paragraph lists exactly the approximate time zones.
  const ukraine = /\*\*Ukraine\.\*\*[^\n]*/.exec(config)?.[0] ?? "";
  const listed = new Set([...ukraine.matchAll(/`([A-Z][a-z]+\/[A-Za-z_]+)`/g)].map((m) => m[1]));
  const approx = Object.keys(core.APPROXIMATE_TIMEZONE_REGION);
  if (approx.length === 0) bad.push("APPROXIMATE_TIMEZONE_REGION is empty");
  if (listed.size !== approx.length || approx.some((tz) => !listed.has(tz))) bad.push(`Ukraine time zones: docs ${[...listed].join(" ")} vs code ${approx.join(" ")}`);
  // The request link names an issue template that exists.
  const template = /template=([\w.-]+)/.exec(core.regionRequestUrl())?.[1];
  if (!template || !existsSync(join(ROOT, ".github/ISSUE_TEMPLATE", template))) bad.push(`regionRequestUrl names a missing template ${template}`);
  expect(bad.length === 0, bad.slice(0, 8).join("; "));
});

// K13 lives in docs-drift-channels.mjs as a pure function (tests beside it); here it gets the
// page texts, the built core, the `channels` subcommands and the CLI's --help output.
await track("K13", "notifications docs match the channels code (kinds, error codes, CLI subcommands and help)", () => {
  const subs = [...commands.keys()].filter((k) => k.startsWith("channels ")).map((k) => k.split(" ")[1]);
  const help = (cmd) => cli([...cmd.split(" "), "--help"]);
  const bad = channelsDocsProblems({ page: read(NOTIFY.path), pageName: NOTIFY.name, telegram: read(TELEGRAM.path), core, subs, help });
  expect(bad.length === 0, bad.slice(0, 8).join("; "));
});

await track("K14", "the site's agent block equals the core's AGENTS_BLOCK and host list", () => {
  const f = "apps/web/src/lib/agent-snippet.ts";
  const src = read(f);
  const site = /export const AGENTS_BLOCK = `([^`]*)`;/.exec(src)?.[1];
  const hosts = /export const AGENT_SNIPPET_HOSTS = (\[[^\]]*\]);/.exec(src)?.[1];
  const bad = [];
  if (typeof core.AGENTS_BLOCK !== "string" || core.AGENTS_BLOCK.trim() === "") bad.push("core AGENTS_BLOCK is empty or missing");
  if (!site?.trim()) bad.push(`${f} has no AGENTS_BLOCK template literal`);
  else if (site !== core.AGENTS_BLOCK) bad.push(`${f} AGENTS_BLOCK differs from packages/core-ts/src/agent-snippet.ts; copy it`);
  const want = JSON.stringify((core.AGENT_HOSTS ?? []).filter((h) => h !== "generic"));
  if (want === "[]") bad.push("core AGENT_HOSTS is empty or missing");
  else if (!hosts || JSON.stringify(JSON.parse(hosts)) !== want) bad.push(`${f} AGENT_SNIPPET_HOSTS ${hosts ?? "missing"} vs core ${want}`);
  expect(bad.length === 0, bad.join("; "));
});

// K15-K18 live in docs-drift-jobs.mjs as pure functions (tests beside it); here they get
// the page texts, the built modules and the Python sources.
await track("K15", "jobs docs match the code (repeat values, job parameters and the every_hours range in TOOL_SURFACE; guarantee sentences from guaranteeText)", () => {
  const bad = jobsSurfaceProblems({ page: read(JOBS.path), pageName: JOBS.name, tools: read(TOOLS_PAGE.path), toolsName: TOOLS_PAGE.name, core });
  expect(bad.length === 0, bad.slice(0, 8).join("; "));
});

await track("K16", "jobs docs state the job limits the code enforces (caps, stderr tail, retry, auto-pause, scrub minimum, rate limits)", async () => {
  const api = await import(pathToFileURL(join(ROOT, "packages/cli/dist/ui/jobs-api.js")).href);
  const shell = await import(pathToFileURL(join(ROOT, "packages/cli/dist/jobs/run-shell.js")).href);
  const bad = jobLimitProblems({ page: read(JOBS.path), pageName: JOBS.name, core, api, shell });
  expect(bad.length === 0, bad.slice(0, 8).join("; "));
});

await track("K17", "the \"every night\" window of schedule_task is the one the jobs page, defer.md, the skill and the agent block use", () => {
  const files = ["packages/claude-code-plugin/commands/defer.md", "packages/claude-code-plugin/skills/tidegap/SKILL.md"].map((f) => [f, read(f)]);
  const bad = nightWindowProblems({ core, files: [[JOBS.name, read(JOBS.path)], ...files] });
  expect(bad.length === 0, bad.slice(0, 8).join("; "));
});

await track("K18", "the jobs page's Python ticker sentence matches core-py (_TS_ONLY_PROVIDERS, TickResult fields)", () => {
  const bad = pythonTickerProblems({
    page: read(JOBS.path),
    pageName: JOBS.name,
    scheduler: read("packages/core-py/src/tidegap/scheduler.py"),
    types: read("packages/core-py/src/tidegap/types.py"),
  });
  expect(bad.length === 0, bad.slice(0, 8).join("; "));
});

// K19: the `{#handoff-ledger}` section lists the stable ledger names in ```text blocks headed
// `-- <list>`. The schema is the one the built store creates (its CREATE TABLE plus the column
// migrations; `job_id` and `read_at` come from those) in an in-memory database. Every listed tasks
// column exists; the task_events columns, the status values (the CLI's VALID_STATUSES) and the event
// kinds (TASK_EVENT_KINDS) are equal both ways. An empty list on either side fails.
function schemaColumns() {
  const req = createRequire(join(ROOT, "packages/core-ts/package.json"));
  let db;
  try {
    db = new (req("node:sqlite").DatabaseSync)(":memory:");
  } catch {
    db = new (req("better-sqlite3"))(":memory:");
  }
  const store = new core.TaskStore({ dbPath: ":memory:", db });
  try {
    const columns = (table) => db.prepare(`SELECT name FROM pragma_table_info('${table}')`).all().map((r) => r.name);
    return { tasks: columns("tasks"), events: columns("task_events") };
  } finally {
    store.close();
  }
}

await track("K19", "the handoff page's ledger contract matches the schema (tasks and task_events columns, status values, event kinds)", async () => {
  const section = read(HANDOFF.path).split(/\{#handoff-ledger\}/)[1]?.split(/^### /m)[0] ?? "";
  const page = {};
  for (const m of section.matchAll(/^```text\n-- ([a-z_ ]+)\n([\s\S]*?)^```/gm)) page[m[1].trim()] = m[2].split(/[\s,]+/).filter(Boolean);
  const schema = schemaColumns();
  const queue = await import(pathToFileURL(join(ROOT, "packages/cli/dist/commands/queue.js")).href);
  const code = {
    "tasks columns": schema.tasks,
    "task_events columns": schema.events,
    "status values": [...(queue.VALID_STATUSES ?? [])],
    "event kinds": [...(core.TASK_EVENT_KINDS ?? [])],
  };
  const bad = [];
  for (const [name, want] of Object.entries(code)) {
    const got = page[name] ?? [];
    if (got.length === 0) bad.push(`${HANDOFF.name} has no "-- ${name}" list under {#handoff-ledger}`);
    if (want.length === 0) bad.push(`no ${name} found in the code`);
    if (got.length === 0 || want.length === 0) continue;
    const missing = got.filter((x) => !want.includes(x));
    if (missing.length > 0) bad.push(`${name} on the page but not in the code: ${missing.join(" ")}`);
    if (name === "tasks columns") continue;
    const unlisted = want.filter((x) => !got.includes(x));
    if (unlisted.length > 0) bad.push(`${name} in the code but not on the page: ${unlisted.join(" ")}`);
  }
  expect(bad.length === 0, bad.slice(0, 8).join("; "));
});

/** The text of a page from its `{#anchor}` heading to the next heading of any level; a `#` line in a code fence is no heading. */
function pageSection(text, anchor) {
  const at = text.indexOf(`{#${anchor}}`);
  if (at < 0) return "";
  const lines = text.slice(text.indexOf("\n", at) + 1).split("\n");
  let fenced = false;
  const end = lines.findIndex((l) => {
    if (/^\s*(```|~~~)/.test(l)) fenced = !fenced;
    return !fenced && /^#{1,6} /.test(l);
  });
  return (end < 0 ? lines : lines.slice(0, end)).join("\n");
}

/** The text under the exact `heading` line to the next level 1 or 2 heading; a `#` line in a code fence is no heading. */
function headingSection(text, heading) {
  const lines = text.split("\n");
  const at = lines.findIndex((l) => l.trimEnd() === heading);
  if (at < 0) return undefined;
  const rest = lines.slice(at + 1);
  let fenced = false;
  const end = rest.findIndex((l) => {
    if (/^\s*(```|~~~)/.test(l)) fenced = !fenced;
    return !fenced && /^#{1,2} /.test(l);
  });
  return (end < 0 ? rest : rest.slice(0, end)).join("\n");
}

/** Both-way difference of a documented list and the code's; an empty side is a problem too. */
function listProblems(where, got, want, codeName) {
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

/** The one bullet of `lines` that `match` picks, or a problem when there is none or more than one. */
function oneBullet(where, lines, match) {
  const hits = lines.filter((l) => l.startsWith("- ") && match(l));
  return hits.length === 1 ? { line: hits[0] } : { problem: `${where}: ${hits.length} matching bullets, want 1` };
}

// K20: the `~/<name>` code spans of the bullet that holds `~/.tidegap` in {#handoff-results} on the
// handoff page, and of the bullet that starts with `result_path` on the tools page, equal the
// core's PROTECTED_HOME_DIRS both ways.
await track("K20", "the protected-folder lists on the handoff and tools pages equal the core's PROTECTED_HOME_DIRS", () => {
  const want = [...(core.PROTECTED_HOME_DIRS ?? [])];
  const pages = [
    [`${HANDOFF.name} {#handoff-results}`, pageSection(read(HANDOFF.path), "handoff-results"), (l) => l.includes("`~/.tidegap`")],
    [TOOLS_PAGE.name, read(TOOLS_PAGE.path), (l) => l.startsWith("- `result_path`")],
  ];
  const bad = [];
  for (const [where, text, match] of pages) {
    const hit = oneBullet(where, text.split("\n"), match);
    if (hit.problem) {
      bad.push(hit.problem);
      continue;
    }
    const got = [...hit.line.matchAll(/`~\/([^`\s]+)`/g)].map((m) => m[1]);
    bad.push(...listProblems(where, got, want, "PROTECTED_HOME_DIRS"));
  }
  expect(bad.length === 0, bad.slice(0, 8).join("; "));
});

// K21: the code spans after "prints one object:" in the one {#handoff-queue} bullet that starts with
// "`--json` prints one object:" equal QUEUE_ADD_JSON_KEYS of the built CLI, both ways.
await track("K21", "the queue add --json keys on the handoff page equal the command's QUEUE_ADD_JSON_KEYS", async () => {
  const add = await import(pathToFileURL(join(ROOT, "packages/cli/dist/commands/queue-add.js")).href);
  const want = [...(add.QUEUE_ADD_JSON_KEYS ?? [])];
  const where = `${HANDOFF.name} {#handoff-queue}`;
  const lead = "- `--json` prints one object:";
  const hit = oneBullet(where, pageSection(read(HANDOFF.path), "handoff-queue").split("\n"), (l) => l.startsWith(lead));
  const bad = [];
  if (hit.problem) bad.push(hit.problem);
  else bad.push(...listProblems(where, [...hit.line.slice(lead.length).matchAll(/`([^`]+)`/g)].map((m) => m[1]), want, "QUEUE_ADD_JSON_KEYS"));
  expect(bad.length === 0, bad.slice(0, 8).join("; "));
});

// K22: each fact lives in its own `## ` section of the skill, so a fact that moves or goes fails here.
// Sentences split as in K17. The runner list, the notice line and the repeat values come from built code.
await track("K22", "the tidegap skill states the four facts an agent needs", async () => {
  const add = await import(pathToFileURL(join(ROOT, "packages/cli/dist/commands/queue-add.js")).href);
  const notices = await import(pathToFileURL(join(ROOT, "packages/cli/dist/handoff/notices.js")).href);
  const text = read(SKILL);
  const bad = [];
  const sentences = (t) => t.replace(/\s+/g, " ").split(/(?<=[.;!?])\s+/);
  const spans = (t) => [...t.replace(/\s+/g, " ").matchAll(/`([^`]+)`/g)].map((m) => m[1]);
  const section = (heading) => {
    const body = headingSection(text, heading);
    if (body === undefined) bad.push(`${SKILL} has no "${heading}" section`);
    return body;
  };
  // What a task is: one sentence, whose one-word code spans are the runners.
  const what = section("## What Tidegap is");
  if (what !== undefined) {
    const hits = sentences(what).filter((t) => t.includes("one run of one runner"));
    if (hits.length !== 1) bad.push(`"## What Tidegap is": ${hits.length} sentences say "one run of one runner", want 1`);
    else {
      const got = [...hits[0].matchAll(/`([^`\s]+)`/g)].map((m) => m[1]);
      bad.push(...listProblems('"## What Tidegap is" runner sentence', got, [...(add.QUEUE_ADD_RUNNERS ?? [])], "QUEUE_ADD_RUNNERS"));
    }
  }
  // When a task runs: `--not-before` is a bound, not a run time.
  const runs = section("## When a task runs");
  if (runs !== undefined && !sentences(runs).some((t) => t.includes("`--not-before`") && t.includes("not a run time"))) {
    bad.push('"## When a task runs" has no sentence that says `--not-before` is "not a run time"');
  }
  // How the result comes back: the notice line as the code prints it for one task, and the wake, wait and events commands.
  const back = section("## How the result comes back");
  const stub = { record: { taskId: "t-1", status: "completed", title: "stub" } };
  const render = notices.renderNoticeBlock;
  const noticeLine = typeof render === "function" ? (render([stub]).text.split("\n")[0] ?? "") : "";
  if (typeof render !== "function") bad.push("packages/cli/dist/handoff/notices.js exports no renderNoticeBlock");
  else if (!noticeLine) bad.push("renderNoticeBlock prints no notice line for one task");
  else if (render([]).text !== "") bad.push("renderNoticeBlock prints text for no task");
  if (back !== undefined) {
    const got = spans(back);
    if (noticeLine && !got.includes(noticeLine)) bad.push(`"## How the result comes back" does not quote the notice line \`${noticeLine}\``);
    for (const lead of ["--wake", "tidegap queue wait", "tidegap queue events"]) {
      if (!got.some((x) => x.startsWith(lead))) bad.push(`"## How the result comes back" has no \`${lead}…\` span`);
    }
  }
  // Recurring work: `--repeat` and each job repeat value (the repeat enum without none and quota_reset, as in K15).
  const repeating = section("## Recurring work: use Tidegap, not cron");
  const tool = core.TOOL_SURFACE.find((t) => t.name === "schedule_task");
  const repeats = [...new Set((tool?.params ?? []).filter((p) => p.name === "repeat").flatMap((p) => p.values ?? []))].filter((v) => v !== "none" && v !== "quota_reset");
  if (repeats.length === 0) bad.push("schedule_task repeat has no job values");
  if (repeating !== undefined) {
    const got = spans(repeating);
    for (const want of ["--repeat", ...repeats]) if (!got.includes(want)) bad.push(`"## Recurring work: use Tidegap, not cron" has no \`${want}\` span`);
  }
  expect(bad.length === 0, bad.slice(0, 8).join("; "));
});

await step("S11.7", "docs vs code: tool counts, CLI table, flags (K5, K7, K11)", () => {
  const failed = ["K5", "K7", "K11"].filter((id) => !results[id]);
  expect(failed.length === 0, `failing: ${failed.join(", ")}`);
});

await s.finish();
