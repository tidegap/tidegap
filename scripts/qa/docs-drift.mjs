#!/usr/bin/env node
// QA area "docs": docs against code. K5 (MCP tool counts), K6 and S11.10
// (test-count claims against tests.generated.ts), K7 (site CLI table), K11 and S7.4
// (every documented `tidegap` flag exists), S5.7 (Telegram /help vs the site
// table), S7.3 (plugin commands name real tools and arguments), S8.4
// (OpenClaw install text and version), S11.7 (K5 + K7 + K11), K12 (grid region
// docs: source names, unknown-zone examples, approximate time zones, request template),
// K13 (notifications docs: kinds vs the registry, quoted error codes vs code,
// `tidegap channels` subcommands and --help blocks vs the CLI), K14 (the site's
// agent block copy equals the core's AGENTS_BLOCK), K15 (jobs docs: `repeat` values in the
// parameter table, the cadence table and the tools page, and job parameters, exist in TOOL_SURFACE;
// the every-N-hours range is the every_hours min and max; every quoted guarantee sentence is what
// guaranteeText prints, and each cadence kind has one), K16 (jobs docs state the job caps, retry
// delay, auto-pause count, scrub minimum and the job write and preview rate limits the code
// enforces), K17 (the "every night" window of the schedule_task text is the one the jobs page,
// defer.md, the skill and the agent block use).
// Prints `PASS` or the failed case ids + log path.
//
//   node scripts/qa/docs-drift.mjs [--stream docs] [--log-dir <dir>] [--keep]

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { pathToFileURL } from "node:url";

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
await track("K5", "MCP tool counts in docs match toolsForHost (mcp 12, openclaw 11)", () => {
  const want = { mcp: core.toolsForHost("mcp").length, openclaw: core.toolsForHost("openclaw").length };
  s.note(`tool counts in code: mcp ${want.mcp}, openclaw ${want.openclaw}`);
  const bad = [];
  for (const f of [...DOCS, ...SITE_PAGES, "packages/mcp-server/src/server.ts"]) {
    read(f)
      .split("\n")
      .forEach((line, i) => {
        for (const m of line.matchAll(/\b(\d{1,2}|eight|nine|ten|eleven|twelve|thirteen)\s+(?:MCP\s+|agent\s+|canonical\s+)?tools\b/gi)) {
          const n = NUMBER[m[1].toLowerCase()] ?? Number(m[1]);
          const host = /openclaw/i.test(line) ? "openclaw" : "mcp";
          if (n !== want[host] && n !== want.mcp && n !== want.openclaw) bad.push(`${f}:${i + 1} "${m[0]}"`);
        }
      });
  }
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

await track("S7.4", "skills/tidegap/SKILL.md names only real commands and flags", () => {
  const skill = "packages/claude-code-plugin/skills/tidegap/SKILL.md";
  const bad = unknownFlags([skill]).map((b) => `tidegap ${b.cmd} ${b.flag}`);
  const unknownCmds = [...read(skill).matchAll(/`tidegap ([a-z][a-z-]*)/g)]
    .map((m) => m[1])
    .filter((c) => ![...commands.keys()].some((k) => k.split(" ")[0] === c));
  expect(bad.length + unknownCmds.length === 0, [...bad, ...unknownCmds.map((c) => `unknown command tidegap ${c}`)].join("; "));
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
        for (const m of line.matchAll(/\b((?:get|recommend|schedule|check|cancel|expedite|update|postpone|reply|retry)_[a-z_]+|tidegap_[a-z]+)\b/g)) {
          if (!tools.has(m[1]) && !/_(id|at|kind|g|path|for|pct|source)$/.test(m[1])) bad.push(`${f}:${i + 1} unknown tool ${m[1]}`);
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

await track("K13", "notifications docs match the channels code (kinds, error codes, CLI subcommands and help)", () => {
  const page = read(NOTIFY.path);
  const bad = [];
  // Kinds: one {#notify-<kind>} section per ready descriptor, in card order, each with its generated embed.
  const kinds = Object.values(core.KIND_DESCRIPTORS).filter((d) => d.ready);
  if (kinds.length === 0) bad.push("KIND_DESCRIPTORS has no ready kind");
  const sections = [...page.matchAll(/^### .+ \{#notify-([a-z]+)\}$/gm)].map((m) => m[1]);
  const kindSections = sections.filter((k) => Object.hasOwn(core.KIND_DESCRIPTORS, k));
  if (kindSections.length === 0) bad.push(`${NOTIFY.name} has no {#notify-<kind>} section`);
  const want = kinds.map((d) => d.kind);
  if (kindSections.join(",") !== want.join(",")) bad.push(`kind sections ${kindSections.join(",")} vs registry ${want.join(",")}`);
  for (const d of kinds) {
    if (d.docsAnchor !== `notify-${d.kind}`) bad.push(`${d.kind}: docsAnchor ${d.docsAnchor}`);
    const body = page.split(`{#notify-${d.kind}}`)[1]?.split(/^### /m)[0] ?? "";
    if (!new RegExp(`<!--\\s*embed:channel-${d.kind}\\s*-->`).test(body)) bad.push(`${d.kind}: section lacks <!-- embed:channel-${d.kind} -->`);
  }
  // Error codes quoted in the hand-written text exist in the code: the host's DELIVERY_CODES plus each kind's own.
  const hostCodes = core.DELIVERY_CODES ?? [];
  if (hostCodes.length === 0) bad.push("core DELIVERY_CODES is empty");
  const known = new Set([...hostCodes, ...kinds.flatMap((d) => Object.keys(d.errors ?? {}))]);
  const notCodes = new Set([...core.EVENT_KINDS, ...kinds.flatMap((d) => d.fields.map((f) => f.name)), "redact_in_receipt"]);
  const quoted = [...new Set([...page.matchAll(/`([a-z]+_[a-z0-9_]+)`/g)].map((m) => m[1]))].filter((c) => !notCodes.has(c) && !/^task_/.test(c));
  if (quoted.length === 0) bad.push(`${NOTIFY.name} quotes no error code`);
  // A code in the "(`code`)" form is checked too, so a one-word code such as `timeout` is covered; kinds are not codes.
  const kindNames = new Set(core.CHANNEL_KINDS);
  if (kindNames.size === 0) bad.push("CHANNEL_KINDS is empty");
  const inParens = [...page.matchAll(/\(`([a-z]+(?:_[a-z0-9]+)*)`\)/g)].map((m) => m[1]).filter((c) => !notCodes.has(c) && !kindNames.has(c));
  for (const c of new Set([...quoted, ...inParens])) if (!known.has(c)) bad.push(`quoted code \`${c}\` is not in the code`);
  // CLI: every `tidegap channels <sub>` the page names exists; every subcommand is on this page or the Telegram page.
  const subs = [...commands.keys()].filter((k) => k.startsWith("channels ")).map((k) => k.split(" ")[1]);
  if (subs.length < 5) bad.push(`only ${subs.length} channels subcommands found`);
  const named = new Set([...page.matchAll(/tidegap channels ([a-z]+)/g)].map((m) => m[1]));
  for (const n of named) if (!subs.includes(n)) bad.push(`page names unknown \`tidegap channels ${n}\``);
  const telegram = read(TELEGRAM.path);
  for (const sub of subs) if (!named.has(sub) && !telegram.includes(`tidegap channels ${sub}`)) bad.push(`\`tidegap channels ${sub}\` is on neither page`);
  // Every quoted `tidegap channels … --help` block equals the CLI's output.
  const blocks = [...page.matchAll(/^`tidegap (channels(?: [a-z]+)?) --help`:\n\n```[a-z]*\n([\s\S]*?)\n```/gm)];
  if (blocks.length === 0) bad.push(`${NOTIFY.name} quotes no \`tidegap channels … --help\` block`);
  // A help body in any other shape would drop out of the match above: count every quoted Usage line.
  const usages = page.match(/^Usage: tidegap channels\b/gm)?.length ?? 0;
  if (usages !== blocks.length) bad.push(`${usages} quoted \`Usage: tidegap channels\` lines, but ${blocks.length} help blocks in the checked shape`);
  for (const [, cmd, text] of blocks) {
    const r = cli([...cmd.split(" "), "--help"]);
    if (r.code !== 0 || r.stdout.trimEnd() !== text.trimEnd()) bad.push(`\`tidegap ${cmd} --help\` block differs from the CLI output`);
  }
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

await track("K15", "jobs docs match the code (repeat values, job parameters and the every_hours range in TOOL_SURFACE; guarantee sentences from guaranteeText)", () => {
  const page = read(JOBS.path);
  const bad = [];
  // Parameter table: `| \`name\` | ... |` rows under "Agents and schedule_task".
  const section = page.split(/\{#jobs-agents\}/)[1]?.split(/^### /m)[0] ?? "";
  const rows = [...section.matchAll(/^\| `([a-z_]+)` \| (.+?) \|[ \t]*$/gm)].map((m) => ({ name: m[1], text: m[2] }));
  if (rows.length < 5) bad.push(`${JOBS.name} documents ${rows.length} schedule_task job parameters (want at least 5)`);
  const tool = core.TOOL_SURFACE.find((t) => t.name === "schedule_task");
  if (!tool) bad.push("TOOL_SURFACE has no schedule_task");
  const params = (tool?.params ?? []).filter((p) => p.name);
  const names = new Set(params.map((p) => p.name));
  for (const r of rows) if (!names.has(r.name)) bad.push(`documented parameter \`${r.name}\` is not a schedule_task parameter`);
  for (const must of ["repeat", "every_hours", "days", "window", "time_zone"]) {
    if (!names.has(must)) bad.push(`schedule_task lost parameter ${must}`);
    if (!rows.some((r) => r.name === must)) bad.push(`${JOBS.name} does not document \`${must}\``);
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
  if (cadenceRows.length < 3) bad.push(`${JOBS.name} cadence table has ${cadenceRows.length} rows (want at least 3)`);
  const cadenceGot = cadenceRows.flatMap((c) => [...c.matchAll(/`([a-z_]+)`/g)].map((m) => m[1])).sort();
  const cadenceWant = want.filter((v) => v !== "every_n_hours");
  if (cadenceGot.join(",") !== cadenceWant.join(",")) bad.push(`cadence table: docs ${cadenceGot.join(" ") || "-"} vs code ${cadenceWant.join(" ") || "-"}`);
  if (want.includes("every_n_hours") && !cadenceRows.includes("every N hours")) bad.push(`${JOBS.name} cadence table has no "every N hours" row`);
  // Tools page: the "`repeat` set to ... creates" list names the same values.
  const tools = read(TOOLS_PAGE.path);
  const toolsList = /`repeat` set to ((?:`[a-z_]+`(?:, | or )?)+) creates/.exec(tools)?.[1];
  if (!toolsList) bad.push(`${TOOLS_PAGE.name} has no "\`repeat\` set to ... creates" list`);
  else {
    const toolsGot = [...toolsList.matchAll(/`([a-z_]+)`/g)].map((m) => m[1]).sort();
    if (toolsGot.join(",") !== want.join(",")) bad.push(`${TOOLS_PAGE.name} repeat values: docs ${toolsGot.join(" ")} vs code ${want.join(" ") || "-"}`);
  }
  // `repeat: <value>` mentions on both pages are repeat values.
  const repeatRefs = [page, tools].flatMap((t) => [...t.matchAll(/`repeat: ([a-z_]+)`/g)].map((m) => m[1]));
  if (repeatRefs.length === 0) bad.push(`no \`repeat: <value>\` mention in ${JOBS.name} or ${TOOLS_PAGE.name}`);
  for (const v of repeatRefs) if (!enumValues.has(v)) bad.push(`\`repeat: ${v}\` is not a repeat value`);
  // every_hours range: the parameter row and the cadence table state the tool's min and max.
  const eh = params.find((p) => p.name === "every_hours");
  if (!Number.isInteger(eh?.min) || !Number.isInteger(eh?.max)) bad.push("schedule_task every_hours has no integer min and max");
  else {
    const range = `${eh.min} to ${eh.max}`;
    if (eh.min !== core.MIN_EVERY_HOURS || eh.max !== core.MAX_EVERY_HOURS) bad.push(`every_hours ${range} vs core ${core.MIN_EVERY_HOURS} to ${core.MAX_EVERY_HOURS}`);
    if (!rows.find((r) => r.name === "every_hours")?.text.includes(range)) bad.push(`every_hours row does not say ${range}`);
    if (!cadenceSection.includes(`N from ${range}`)) bad.push(`${JOBS.name} cadence table does not say N from ${range}`);
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
  if (missingShapes.length) bad.push(`${JOBS.name} quotes no guarantee sentence for: ${missingShapes.join(", ")}`);
  expect(bad.length === 0, bad.slice(0, 8).join("; "));
});

// K16: every job limit the jobs page states equals the constant the code enforces. Each
// claim must appear at least once (no vacuous pass), and every match must agree.
const WORD = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10 };
await track("K16", "jobs docs state the job limits the code enforces (caps, retry, auto-pause, scrub minimum, rate limits)", async () => {
  const page = read(JOBS.path);
  const api = await import(pathToFileURL(join(ROOT, "packages/cli/dist/ui/jobs-api.js")).href);
  const caps = core.DEFAULT_JOB_CAPS ?? {};
  const MIN = 60_000;
  const claims = [
    ["command time limit (minutes)", caps.commandTimeoutMs / MIN, /(?:time limit is |command time limit \()(\w+) minutes?/g],
    ["LLM time limit (minutes)", caps.llmTimeoutMs / MIN, /LLM time limit \((\w+) minutes?\)/g],
    ["LLM budget (USD)", caps.maxBudgetUsd, /LLM budget \((\d+(?:\.\d+)?) USD\)/g],
    ["output cap (MiB)", caps.outputCapBytes / 1024 ** 2, /Output is capped \((\d+) MiB\)/g],
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
    if (got.length === 0) bad.push(`${JOBS.name} does not state the ${what} (${code})`);
    for (const n of got) if (n !== code) bad.push(`${what}: docs ${n} vs code ${code}`);
  }
  expect(bad.length === 0, bad.slice(0, 8).join("; "));
});

// K17: "every night" means one window everywhere. The window comes from the schedule_task
// text; every sentence that names night and a window, in each source, must use it.
await track("K17", "the \"every night\" window of schedule_task is the one the jobs page, defer.md, the skill and the agent block use", () => {
  const strings = (v) => (typeof v === "string" ? [v] : v && typeof v === "object" ? Object.values(v).flatMap(strings) : []);
  const toolText = strings(core.TOOL_SURFACE.find((t) => t.name === "schedule_task")).join("\n");
  const want = /"every night" is 'daily' with window '(\d\d:\d\d-\d\d:\d\d)'/.exec(toolText)?.[1];
  const bad = [];
  if (!want) bad.push(`schedule_task text has no "every night" is 'daily' with window 'HH:MM-HH:MM'`);
  const sources = [
    ["schedule_task text", toolText],
    [JOBS.name, read(JOBS.path)],
    ["packages/claude-code-plugin/commands/defer.md", read("packages/claude-code-plugin/commands/defer.md")],
    ["packages/claude-code-plugin/skills/tidegap/SKILL.md", read("packages/claude-code-plugin/skills/tidegap/SKILL.md")],
    ["core AGENTS_BLOCK", core.AGENTS_BLOCK ?? ""],
  ];
  for (const [name, text] of sources) {
    const sentences = text.replace(/\s+/g, " ").split(/(?<=[.;!?])\s+/).filter((t) => /\bnight\b/i.test(t));
    const windows = sentences.flatMap((t) => [...t.matchAll(/\b\d\d:\d\d-\d\d:\d\d\b/g)].map((m) => m[0]));
    // Copy-paste daily commands (`--daily --window ...`, `--repeat daily --window ...`) are the night example too.
    windows.push(...[...text.matchAll(/--(?:daily|repeat daily) --window (\d\d:\d\d-\d\d:\d\d)\b/g)].map((m) => m[1]));
    if (windows.length === 0) bad.push(`${name} names no night window`);
    for (const w of windows) if (want && w !== want) bad.push(`${name}: night window ${w} vs schedule_task ${want}`);
  }
  expect(bad.length === 0, bad.slice(0, 8).join("; "));
});

await step("S11.7", "docs vs code: tool counts, CLI table, flags (K5, K7, K11)", () => {
  const failed = ["K5", "K7", "K11"].filter((id) => !results[id]);
  expect(failed.length === 0, `failing: ${failed.join(", ")}`);
});

await s.finish();
