#!/usr/bin/env node
// QA area "docs": docs against code. K5 (MCP tool counts), K6 and S11.10
// (test-count claims against tests.generated.ts), K7 (site CLI table), K11 and S7.4
// (every documented `tidegap` flag exists), S5.7 (Telegram /help vs the site
// table), S7.3 (plugin commands name real tools and arguments), S8.4
// (OpenClaw install text and version), S11.7 (K5 + K7 + K11), K12 (grid region
// docs: source names, unknown-zone examples, approximate time zones, request template),
// K13 (notifications docs: kinds vs the registry, quoted error codes vs code,
// `tidegap channels` subcommands and --help blocks vs the CLI).
// Prints `PASS` or the failed case ids + log path.
//
//   node scripts/qa/docs-drift.mjs [--stream docs] [--log-dir <dir>] [--keep]

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { pathToFileURL } from "node:url";

import { CORE, discoverCommands, expect, missingFromSiteTable, ROOT, startStream } from "./env.mjs";

const s = startStream("docs-drift", { portBase: 47905 });
const { step, cli } = s;
const core = await import(pathToFileURL(CORE).href);
const read = (p) => readFileSync(join(ROOT, p), "utf8");
const rel = (p) => relative(ROOT, p);

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
  const install = read("apps/web/content/docs/01-install.md");
  const bad = [...(missing.length ? [`03-cli.md misses ${missing.join(", ")}`] : []), ...(/tidegap status/.test(install) ? [] : ["01-install.md never names `tidegap status`"])];
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

await track("S5.7", "Telegram /help equals the 07-telegram.md command table", () => {
  const help = core.HELP_TEXT;
  expect(typeof help === "string", "core does not export HELP_TEXT");
  const table = read("apps/web/content/docs/07-telegram.md");
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
  const config = read("apps/web/content/docs/09-config.md");
  const bad = [];
  if (!/\{#region\}/.test(config)) bad.push("09-config.md lost its {#region} heading");
  if (!/<!--\s*embed:regions\s*-->/.test(config)) bad.push("09-config.md lost <!-- embed:regions -->");
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
  const page = read("apps/web/content/docs/06-notifications.md");
  const bad = [];
  // Kinds: one {#notify-<kind>} section per ready descriptor, in card order, each with its generated embed.
  const kinds = Object.values(core.KIND_DESCRIPTORS).filter((d) => d.ready);
  if (kinds.length === 0) bad.push("KIND_DESCRIPTORS has no ready kind");
  const sections = [...page.matchAll(/^### .+ \{#notify-([a-z]+)\}$/gm)].map((m) => m[1]);
  const kindSections = sections.filter((k) => Object.hasOwn(core.KIND_DESCRIPTORS, k));
  if (kindSections.length === 0) bad.push("06-notifications.md has no {#notify-<kind>} section");
  const want = kinds.map((d) => d.kind);
  if (kindSections.join(",") !== want.join(",")) bad.push(`kind sections ${kindSections.join(",")} vs registry ${want.join(",")}`);
  for (const d of kinds) {
    if (d.docsAnchor !== `notify-${d.kind}`) bad.push(`${d.kind}: docsAnchor ${d.docsAnchor}`);
    const body = page.split(`{#notify-${d.kind}}`)[1]?.split(/^### /m)[0] ?? "";
    if (!new RegExp(`<!--\\s*embed:channel-${d.kind}\\s*-->`).test(body)) bad.push(`${d.kind}: section lacks <!-- embed:channel-${d.kind} -->`);
  }
  // Error codes quoted in the hand-written text exist in the code (descriptor errors, host sentences, driver codes).
  const src = ["packages/cli/src/channels/channel-setup.ts", "packages/cli/src/channels/http.ts", "packages/cli/src/channels/url-policy.ts", ...walk("packages/cli/src/channels/drivers", /\.ts$/)].map(read).join("\n");
  const known = new Set([
    ...kinds.flatMap((d) => Object.keys(d.errors ?? {})),
    ...[...src.matchAll(/^\s+([a-z]+(?:_[a-z0-9]+)*): "[A-Z]/gm)].map((m) => m[1]),
    ...[...src.matchAll(/(?:DeliveryError\(|code: )"([a-z]+(?:_[a-z0-9]+)*)"/g)].map((m) => m[1]),
  ]);
  if (known.size < 10) bad.push(`only ${known.size} delivery codes found in the code`);
  const notCodes = new Set([...core.EVENT_KINDS, ...kinds.flatMap((d) => d.fields.map((f) => f.name)), "redact_in_receipt"]);
  const quoted = [...new Set([...page.matchAll(/`([a-z]+_[a-z0-9_]+)`/g)].map((m) => m[1]))].filter((c) => !notCodes.has(c) && !/^task_/.test(c));
  if (quoted.length === 0) bad.push("06-notifications.md quotes no error code");
  for (const c of quoted) if (!known.has(c)) bad.push(`quoted code \`${c}\` is not in the code`);
  // CLI: every `tidegap channels <sub>` the page names exists; every subcommand is on this page or the Telegram page.
  const subs = [...commands.keys()].filter((k) => k.startsWith("channels ")).map((k) => k.split(" ")[1]);
  if (subs.length < 5) bad.push(`only ${subs.length} channels subcommands found`);
  const named = new Set([...page.matchAll(/tidegap channels ([a-z]+)/g)].map((m) => m[1]));
  for (const n of named) if (!subs.includes(n)) bad.push(`page names unknown \`tidegap channels ${n}\``);
  const telegram = read("apps/web/content/docs/07-telegram.md");
  for (const sub of subs) if (!named.has(sub) && !telegram.includes(`tidegap channels ${sub}`)) bad.push(`\`tidegap channels ${sub}\` is on neither page`);
  // Every quoted `tidegap channels … --help` block equals the CLI's output.
  const blocks = [...page.matchAll(/^`tidegap (channels(?: [a-z]+)?) --help`:\n\n```\n([\s\S]*?)\n```/gm)];
  if (blocks.length === 0) bad.push("06-notifications.md quotes no `tidegap channels … --help` block");
  for (const [, cmd, text] of blocks) {
    const r = cli([...cmd.split(" "), "--help"]);
    if (r.code !== 0 || r.stdout.trimEnd() !== text.trimEnd()) bad.push(`\`tidegap ${cmd} --help\` block differs from the CLI output`);
  }
  expect(bad.length === 0, bad.slice(0, 8).join("; "));
});

await step("S11.7", "docs vs code: tool counts, CLI table, flags (K5, K7, K11)", () => {
  const failed = ["K5", "K7", "K11"].filter((id) => !results[id]);
  expect(failed.length === 0, `failing: ${failed.join(", ")}`);
});

await s.finish();
