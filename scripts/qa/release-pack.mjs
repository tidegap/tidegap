#!/usr/bin/env node
// QA area "release": S12.2–S12.6 from the packed tarballs in a temp prefix,
// temp HOME and empty npm cache; S12.10 (registry, after a publish) with
// `--registry`. Prints `PASS` or the failed case ids + log path.
//
//   node scripts/qa/release-pack.mjs [--stream release] [--port-base 47904] [--log-dir <dir>] [--keep] [--registry]
//
// Needs `pnpm build` and the network (npm installs the third-party dependencies).

import { spawnSync } from "node:child_process";
import { mkdirSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { connectMcp, expect, REAL_HOME, ROOT, startStream, waitFor } from "./env.mjs";

const s = startStream("release-pack", { portBase: 47904 });
const { step, home, env } = s;
const PACKAGES = [
  ["@tidegap/core", "packages/core-ts"],
  ["@tidegap/cli", "packages/cli"],
  ["@tidegap/mcp", "packages/mcp-server"],
];
const version = JSON.parse(readFileSync(join(ROOT, "packages/cli/package.json"), "utf8")).version;
const packs = join(home, "packs");
const prefix = join(home, "prefix");
mkdirSync(packs, { recursive: true });

/** Runs a command in the QA env; logs the exit and the first lines. */
function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { env: { ...env, ...opts.env }, cwd: opts.cwd ?? home, encoding: "utf8", timeout: opts.timeout ?? 300_000 });
  const out = { code: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
  s.log(`$ ${cmd} ${args.join(" ")} → exit ${out.code}`);
  for (const [mark, text] of [["|", out.stdout], ["!", out.stderr]]) {
    const lines = text.trim().split("\n").filter(Boolean);
    if (lines.length) s.log(lines.slice(-12).map((l) => `  ${mark} ${l}`).join("\n"));
  }
  return out;
}

const tarballs = {};
await step("S12.2", "pack core, cli, mcp: dist, README, LICENSE, ui/; no tests, env files or local paths", () => {
  const bad = [];
  for (const [name, dir] of PACKAGES) {
    const r = run("pnpm", ["pack", "--pack-destination", packs], { cwd: join(ROOT, dir) });
    if (r.code !== 0) {
      bad.push(`${name} pack exit ${r.code}`);
      continue;
    }
    const file = readdirSync(packs).find((f) => f.startsWith(name.replace("@", "").replace("/", "-")) && f.endsWith(".tgz"));
    tarballs[name] = join(packs, file);
    const list = run("tar", ["-tzf", tarballs[name]]).stdout.split("\n").filter(Boolean);
    const has = (re) => list.some((f) => re.test(f));
    if (!has(/^package\/dist\//)) bad.push(`${name}: no dist/`);
    if (!has(/^package\/README\.md$/)) bad.push(`${name}: no README.md`);
    if (!has(/^package\/LICENSE$/)) bad.push(`${name}: no LICENSE`);
    if (name === "@tidegap/cli" && !has(/^package\/ui\//)) bad.push(`${name}: no ui/`);
    const tests = list.filter((f) => /(^|\/)(test|tests|__tests__)\/|\.test\.[cm]?[jt]s$|\.spec\./.test(f));
    if (tests.length) bad.push(`${name}: ${tests.length} test file(s), e.g. ${tests[0]}`);
    const envs = list.filter((f) => /(^|\/)\.env(\.|$)|(^|\/)env$/.test(f));
    if (envs.length) bad.push(`${name}: env file ${envs[0]}`);
    const x = join(home, "x", name.replace("/", "-"));
    mkdirSync(x, { recursive: true });
    run("tar", ["-xzf", tarballs[name], "-C", x]);
    const leak = run("grep", ["-rlF", "-e", REAL_HOME, "-e", ROOT, x]).stdout.trim();
    if (leak) bad.push(`${name}: local path in ${leak.split("\n")[0].slice(x.length)}`);
  }
  expect(bad.length === 0, bad.join("; "));
});

const bin = (name) => join(prefix, "bin", name);
const noMissingDep = (r) => !/Cannot find (module|package)|ERR_MODULE_NOT_FOUND|ERR_PACKAGE_PATH_NOT_EXPORTED/.test(r.stdout + r.stderr);

await step("S12.3", "cold install from the tarballs: --version and status work", () => {
  expect(Object.keys(tarballs).length === 3, "S12.2 produced no tarballs");
  const r = run("npm", ["install", "-g", "--prefix", prefix, "--no-audit", "--no-fund", ...Object.values(tarballs)], { timeout: 600_000 });
  expect(r.code === 0, `npm install exit ${r.code}`);
  const v = run(bin("tidegap"), ["--version"]);
  expect(v.code === 0 && v.stdout.trim() === version, `--version printed "${v.stdout.trim()}", want ${version}`);
  const st = run(bin("tidegap"), ["status"]);
  expect(noMissingDep(st) && /Daemon:/.test(st.stdout), `status: ${(st.stderr || st.stdout).trim().split("\n")[0]}`);
});

await step("S12.4", "cold npx of the mcp tarball: stdio handshake and 12 tools", async () => {
  expect(tarballs["@tidegap/mcp"], "S12.2 produced no mcp tarball");
  const npxCache = join(home, ".npm-npx");
  const m = await connectMcp(s, ":memory:", { npm_config_cache: npxCache }, {
    command: "npx",
    // The mcp server imports @tidegap/core and @tidegap/cli; without their
    // tarballs npx would take the registry versions instead of this build.
    args: ["-y", ...Object.values(tarballs).map((t) => `--package=${t}`), "tidegap-mcp"],
  });
  try {
    const { tools } = await m.client.listTools();
    expect(tools.length === 12, `${tools.length} tools, want 12`);
  } finally {
    await m.close();
  }
});

/** Starts `tidegap ui` from the prefix; resolves with its link, or its first output line as `error`. */
async function startUi() {
  const ui = s.spawnChild(bin("tidegap"), ["ui", "--no-open", "--port", String(s.args.portBase), "--region", "FR"]);
  const link = await waitFor(() => /(http:\/\/127\.0\.0\.1:\d+\/)\S*#token=/.exec(ui.output)?.[1] ?? (ui.exitCode !== null), 20_000);
  return typeof link === "string" ? { ui, link } : { ui, error: ui.output.trim().split("\n")[0] ?? "no output" };
}

await step("S12.5", "tidegap ui from the packed install: page and every static file load", async () => {
  // A new user may open the page before anything created ~/.tidegap: try
  // that first, then check the static files after `install --no-load`.
  const bad = [];
  let started = await startUi();
  if (started.error) {
    bad.push(`fresh home: ${started.error}`);
    run(bin("tidegap"), ["install", "--no-load"]);
    started = await startUi();
  }
  const { ui, link } = started;
  expect(link, [...bad, `after install: ${started.error}`].join("; "));
  const page = await fetch(link);
  expect(page.status === 200, `page ${page.status}`);
  const html = await page.text();
  const assets = [...html.matchAll(/(?:src|href)="(\/?[^"#:]+\.(?:js|css|svg|png|ico|webmanifest|json))"/g)].map((m) => m[1]);
  if (assets.length === 0) bad.push("the page names no static files");
  for (const a of new Set(assets)) {
    const res = await fetch(new URL(a, link));
    if (res.status !== 200) bad.push(`${a} ${res.status}`);
  }
  ui.kill("SIGTERM");
  expect(bad.length === 0, bad.join("; "));
});

await step("S12.6", "Python sdist and wheel build and install in a temp venv", () => {
  const uvEnv = { UV_CACHE_DIR: join(home, ".uv-cache"), UV_NO_CONFIG: "1" };
  const dist = join(home, "pydist");
  const b = run("uv", ["build", "--out-dir", dist, join(ROOT, "packages/core-py")], { env: uvEnv });
  expect(b.code === 0, `uv build exit ${b.code}`);
  const files = readdirSync(dist);
  const wheel = files.find((f) => f.endsWith(".whl"));
  expect(wheel && files.some((f) => f.endsWith(".tar.gz")), `built ${files.join(", ")}`);
  const venv = join(home, "venv");
  expect(run("uv", ["venv", venv], { env: uvEnv }).code === 0, "uv venv failed");
  const py = join(venv, "bin", "python");
  expect(run("uv", ["pip", "install", "--python", py, join(dist, wheel)], { env: uvEnv }).code === 0, "wheel install failed");
  const snippet = run(py, ["-c", "from tidegap import defer; print('ok')"]);
  expect(snippet.code === 0 && snippet.stdout.trim() === "ok", `import: ${snippet.stderr.trim().split("\n").pop()}`);
});

if (process.argv.includes("--registry")) {
  await step("S12.10", "registry, cold: npx @tidegap/cli --version and npx -y @tidegap/mcp", async () => {
    const cache = join(home, ".npm-registry");
    const v = run("npx", ["-y", "@tidegap/cli", "--version"], { env: { npm_config_cache: cache } });
    expect(v.code === 0 && v.stdout.trim() === version, `registry cli printed "${v.stdout.trim()}", repo is ${version}`);
    const m = await connectMcp(s, ":memory:", { npm_config_cache: cache }, { command: "npx", args: ["-y", "@tidegap/mcp"] });
    try {
      const { tools } = await m.client.listTools();
      expect(tools.length === 12, `${tools.length} tools, want 12`);
    } finally {
      await m.close();
    }
  });
} else {
  s.skip("S12.10", "post-publish case; run with --registry after the release");
}

await s.finish();
