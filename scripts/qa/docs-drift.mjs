#!/usr/bin/env node
// QA area "docs": docs against code. K5 (MCP tool counts), K6 and S11.10
// (test-count claim against a fresh run), K7 (site CLI table), K11 and S7.4
// (every documented `tidegap` flag exists), S5.7 (Telegram /help vs the site
// table), S7.3 (plugin commands name real tools and arguments), S8.4
// (OpenClaw install text and version), S11.7 (K5 + K7 + K11).
// Prints `PASS` or the failed case ids + log path.
//
//   node scripts/qa/docs-drift.mjs [--stream docs] [--log-dir <dir>] [--keep] [--no-measure]

import { spawnSync } from "node:child_process";
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

function measureTests() {
  // The unit suites set their own TIDEGAP_* values; the QA presets would fail some.
  const env = Object.fromEntries(Object.entries(s.env).filter(([k]) => !k.startsWith("TIDEGAP_")));
  const counts = {};
  for (const [name, dir] of [
    ["core", "packages/core-ts"],
    ["cli", "packages/cli"],
    ["mcp", "packages/mcp-server"],
    ["openclaw", "packages/openclaw-plugin"],
  ]) {
    const r = spawnSync("pnpm", ["exec", "vitest", "run", "--reporter=dot"], { cwd: join(ROOT, dir), env, encoding: "utf8", timeout: 300_000 });
    const m = /Tests\s+(\d+) passed/.exec((r.stdout ?? "").replace(/\x1b\[[0-9;]*m/g, ""));
    counts[name] = m ? Number(m[1]) : NaN;
  }
  const py = join(ROOT, "packages/core-py/.venv/bin/pytest");
  if (existsSync(py)) {
    const r = spawnSync(py, ["-q", "--co"], { cwd: join(ROOT, "packages/core-py"), env, encoding: "utf8", timeout: 120_000 });
    const m = /(\d+) tests? collected/.exec(r.stdout ?? "");
    if (m) counts.python = Number(m[1]);
  }
  return counts;
}

const claimFiles = ["README.md", "apps/web/src/app/about/page.tsx", "apps/web/src/components/home/proof.tsx", "docs/claims.md"];
const claims = claimFiles.flatMap((f) =>
  // "1,423 tests", value: "1,423" … "Automated tests", and the badge "tests-1423%20passing".
  [...read(f).matchAll(/\b(\d{1,2},\d{3})\b[^\n]{0,60}?\btests\b|\btests-(\d+)%20/gi)].map((m) => ({ f, n: Number((m[1] ?? m[2]).replace(",", "")) })),
);
let measured;
if (process.argv.includes("--no-measure")) {
  s.skip("K6", "--no-measure");
  s.skip("S11.10", "--no-measure");
} else {
  measured = measureTests();
  const ts = ["core", "cli", "mcp", "openclaw"].reduce((a, k) => a + measured[k], 0);
  s.note(`measured tests: ${JSON.stringify(measured)}; TypeScript total ${ts}${measured.python ? `, with Python ${ts + measured.python}` : ""}`);
  const valid = new Set([ts, measured.python ? ts + measured.python : ts]);
  const check = () => {
    expect(Number.isFinite(ts), "a package's vitest count could not be read");
    expect(claims.length > 0, "no test-count claim found");
    const stale = claims.filter((c) => !valid.has(c.n));
    expect(stale.length === 0, `claims ${[...new Set(stale.map((c) => `${c.n} (${c.f})`))].join(", ")} vs measured ${[...valid].join(" or ")}`);
  };
  const k6 = await step("K6", "test-count claim matches a fresh run", check);
  await step("S11.10", "claims (K6) match a fresh measurement", () => expect(k6, "see K6"));
}

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

await track("S5.7", "Telegram /help equals the 06-telegram.md command table", () => {
  const help = core.HELP_TEXT;
  expect(typeof help === "string", "core does not export HELP_TEXT");
  const table = read("apps/web/content/docs/06-telegram.md");
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

await step("S11.7", "docs vs code: tool counts, CLI table, flags (K5, K7, K11)", () => {
  const failed = ["K5", "K7", "K11"].filter((id) => !results[id]);
  expect(failed.length === 0, `failing: ${failed.join(", ")}`);
});

await s.finish();
