// QA environment and case runner for the scripts under scripts/qa (QA plan
// docs/plans/2026-10-19-qa-matrix-all-surfaces.md, sections 2 and 6).
//
// Every stream gets a temp HOME, its own ports, a fake `claude`, a fake
// Telegram base, no provider secrets, and a PATH shim that stands in for
// `launchctl`, `pmset`, `systemctl`, `osascript` and `security`: launchd labels
// are per user, not per HOME, so a real `launchctl` from an isolated run would
// reach the owner's daemon. The shim logs each call; a mutating launchctl call
// fails the case that caused it.
//
// Before and after a stream it records the isolation proof: mtime and size of
// the real ~/.tidegap/queue.db, ~/.config/tidegap/env, ~/.claude/settings.json,
// and a fingerprint of the `launchctl print gui/$UID/com.tidegap.tick` and
// `com.tidegap.channels` state. It reports each as unchanged or changed, never
// the contents.

import { createHash, randomBytes } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
export const CLI = join(ROOT, "packages/cli/dist/index.js");
export const CORE = join(ROOT, "packages/core-ts/dist/index.js");
export const MCP_SERVER = join(ROOT, "packages/mcp-server/dist/server.js");
export const FAKE_CLAUDE = join(ROOT, "packages/cli/test/fixtures/fake-claude/claude");
export const FAKE_TELEGRAM = join(ROOT, "packages/core-ts/test/fixtures/fake-telegram.ts");
/** A token in the Bot API shape; only the fake Telegram ever sees it. */
export const FAKE_TG_TOKEN = "123456789:AAqaFakeTokenForTheTidegapHarness00";

export const REAL_HOME = userInfo().homedir;
export const PROOF_FILES = [".tidegap/queue.db", ".config/tidegap/env", ".claude/settings.json"];
export const PROOF_LABELS = ["com.tidegap.tick", "com.tidegap.channels"];
const MUTATING_LAUNCHCTL = /^(load|unload|bootstrap|bootout|enable|disable|kickstart|kill|start|stop|submit|remove)$/;

// ---------------------------------------------------------------------------
// Home guard and isolation proof

/** Throws when `home` is the real home or contains it (`/`, `/Users`). */
export function assertNotRealHome(home, realHome = REAL_HOME) {
  const h = resolve(home);
  const real = resolve(realHome);
  const rel = relative(h, real);
  if (h === real || rel === "" || (!rel.startsWith("..") && !rel.startsWith(sep) && !/^[A-Za-z]:/.test(rel))) {
    throw new Error(`qa env: refusing ${h}: it is the real home or contains it`);
  }
}

function realLaunchctl(args) {
  const out = spawnSync("/bin/launchctl", args, { encoding: "utf8", timeout: 10_000 });
  return { status: out.error ? null : out.status, stdout: out.stdout ?? "" };
}

/**
 * The stable part of a `launchctl print` answer: loaded or not, plus the
 * path, program and arguments lines. Volatile fields (state, pid, runs, last
 * exit code) change on every tick and are left out.
 */
export function launchdFingerprint(status, stdout) {
  if (status !== 0) return `absent:${status}`;
  const keep = [];
  let inArgs = false;
  for (const raw of stdout.split("\n")) {
    const line = raw.trim();
    if (inArgs) {
      if (line === "}") inArgs = false;
      else keep.push(`arg ${line}`);
      continue;
    }
    if (/^arguments = \{$/.test(line)) inArgs = true;
    else if (/^(path|program|type|run interval) = /.test(line)) keep.push(line);
  }
  return `loaded:${createHash("sha256").update(keep.join("\n")).digest("hex").slice(0, 16)}`;
}

/** One snapshot of the real state. `launchctl` and `home` are injectable for tests. */
export function snapshotRealState({ home = REAL_HOME, uid = process.getuid?.() ?? 0, launchctl = realLaunchctl } = {}) {
  const items = {};
  for (const rel of PROOF_FILES) {
    try {
      const st = statSync(join(home, rel));
      items[`~/${rel}`] = `${st.mtimeMs}:${st.size}`;
    } catch {
      items[`~/${rel}`] = "absent";
    }
  }
  for (const label of PROOF_LABELS) {
    let fp = "unsupported";
    if (process.platform === "darwin" || launchctl !== realLaunchctl) {
      const out = launchctl(["print", `gui/${uid}/${label}`]);
      fp = launchdFingerprint(out.status, out.stdout);
    }
    items[`launchd ${label}`] = fp;
  }
  return items;
}

/** `[{ item, status: "unchanged" | "changed" }]` for every item of either snapshot. */
export function compareProof(before, after) {
  const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])];
  return keys.map((item) => ({ item, status: before[item] === after[item] ? "unchanged" : "changed" }));
}

// ---------------------------------------------------------------------------
// The QA environment

const SECRET_ENV = /API_KEY|TOKEN|SECRET|PASSWORD|WATTTIME|ELECTRICITY|EIA_|OLLAMA|^EBB_|^TIDEGAP_|^CLAUDE|ANTHROPIC|OPENAI|GEMINI|^GOOGLE_|^NODE_ENV$|^VITEST/i;

const SHIM = `#!/bin/sh
# QA shim: never reaches launchd, pmset, systemd or the Keychain.
printf '%s %s\\n' "$(basename "$0")" "$*" >> "$QA_SHIM_LOG"
case "$(basename "$0") $1" in
  "launchctl print") echo "Could not find service" >&2; exit 113 ;;
  "pmset -g") echo "Now drawing from 'AC Power'"; exit 0 ;;
  "security "*) exit 44 ;;
esac
exit 0
`;

export function parseArgs(argv = process.argv.slice(2), defaults = {}) {
  const opt = (name, fallback) => {
    const i = argv.indexOf(name);
    return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : fallback;
  };
  return {
    stream: opt("--stream", defaults.stream ?? "qa"),
    portBase: Number(opt("--port-base", defaults.portBase ?? 47901)),
    logDir: resolve(opt("--log-dir", process.env.QA_LOG_DIR ?? join(tmpdir(), "tidegap-qa", "logs"))),
    keep: argv.includes("--keep"),
    headed: argv.includes("--headed"),
  };
}

/**
 * Builds the temp home, env and shims of one stream. Ports: UI `portBase`,
 * fake Telegram `portBase + 50` (47901 → 47951), as in plan section 2.
 */
export function createQaEnv({ stream, portBase, baseDir = join(tmpdir(), "tidegap-qa"), realHome = REAL_HOME }) {
  if (portBase === 47821) throw new Error("qa env: port 47821 is the real default; pick another --port-base");
  const home = join(baseDir, `${stream}-${randomBytes(4).toString("hex")}`);
  assertNotRealHome(home, realHome);
  const shimDir = join(home, ".qa-shims");
  mkdirSync(shimDir, { recursive: true });
  const shimLog = join(home, ".qa-shims.log");
  writeFileSync(shimLog, "");
  for (const name of ["launchctl", "pmset", "systemctl", "osascript", "security", "terminal-notifier"]) {
    writeFileSync(join(shimDir, name), SHIM);
    chmodSync(join(shimDir, name), 0o755);
  }
  const ports = { ui: portBase, tg: portBase + 50 };
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !SECRET_ENV.test(k)));
  Object.assign(env, {
    HOME: home,
    USERPROFILE: home,
    XDG_CONFIG_HOME: join(home, ".config"),
    XDG_DATA_HOME: join(home, ".local", "share"),
    XDG_STATE_HOME: join(home, ".local", "state"),
    XDG_CACHE_HOME: join(home, ".cache"),
    npm_config_cache: join(home, ".npm"),
    PATH: `${shimDir}:${process.env.PATH ?? ""}`,
    QA_SHIM_LOG: shimLog,
    TIDEGAP_USAGE: "off",
    TIDEGAP_NO_NOTIFY: "1",
    TIDEGAP_TELEGRAM_API_BASE: `http://127.0.0.1:${ports.tg}`,
    TIDEGAP_CLAUDE_BIN: FAKE_CLAUDE,
  });
  return {
    home,
    env,
    ports,
    db: join(home, ".tidegap", "queue.db"),
    shimCalls: () => readFileSync(shimLog, "utf8").split("\n").filter(Boolean),
    dispose: () => rmSync(home, { recursive: true, force: true }),
  };
}

// ---------------------------------------------------------------------------
// Stream runner: cases, log, proof, one-line result

/**
 * Starts a stream: QA env, log file, proof before. Returns helpers for the
 * area script; `finish()` prints `PASS` or `FAIL <ids> log: <path>` and exits.
 */
export function startStream(area, defaults = {}, argv = process.argv.slice(2)) {
  const args = parseArgs(argv, { stream: area, ...defaults });
  if (!existsSync(CLI)) {
    console.log(`FAIL setup: ${CLI} is missing; run pnpm build`);
    process.exit(2);
  }
  mkdirSync(args.logDir, { recursive: true });
  const logPath = join(args.logDir, `${args.stream}.log`);
  writeFileSync(logPath, `# qa ${area} stream=${args.stream} port-base=${args.portBase} ${new Date().toISOString()}\n`);
  // Client and page tokens of the throwaway servers are redacted all the same.
  const log = (line) => appendFileSync(logPath, `${String(line).replace(/(tgc_|tgp_|#token=)[\w-]+/g, "$1…")}\n`);
  const before = snapshotRealState();
  const qa = createQaEnv({ stream: args.stream, portBase: args.portBase });
  log(`home ${qa.home}`);
  const failed = [];
  const children = new Set();

  const clip = (s, n = 1500) => (s.length > n ? `${s.slice(0, n)}… (${s.length} chars)` : s);

  /** Runs the built CLI in the QA env. Never throws on a non-zero exit. */
  const cli = (args2, opts = {}) => {
    const res = spawnSync(process.execPath, [CLI, ...args2], {
      env: { ...qa.env, ...opts.env },
      input: opts.input,
      encoding: "utf8",
      timeout: opts.timeout ?? 60_000,
      cwd: opts.cwd ?? qa.home,
    });
    const out = { code: res.status, stdout: res.stdout ?? "", stderr: res.stderr ?? "" };
    log(`$ tidegap ${args2.join(" ")} → exit ${out.code}`);
    if (out.stdout.trim()) log(clip(out.stdout.trim()).replace(/^/gm, "  | "));
    if (out.stderr.trim()) log(clip(out.stderr.trim()).replace(/^/gm, "  ! "));
    return out;
  };

  /** Spawns a long-running child in the QA env; killed by `finish()`. */
  const spawnChild = (cmd, args2, opts = {}) => {
    const child = spawn(cmd, args2, { env: { ...qa.env, ...opts.env }, cwd: opts.cwd ?? qa.home, stdio: ["ignore", "pipe", "pipe"], detached: false });
    children.add(child);
    child.once("exit", () => children.delete(child));
    child.output = "";
    child.stdout.on("data", (d) => (child.output += d));
    child.stderr.on("data", (d) => (child.output += d));
    return child;
  };

  const mutatingCalls = () =>
    qa.shimCalls().filter((l) => {
      const [bin, verb] = l.split(" ");
      return bin === "launchctl" && MUTATING_LAUNCHCTL.test(verb ?? "");
    });

  /**
   * Runs one case; logs ok or FAIL with the first line of the error. A case
   * that made the product try a mutating launchctl call fails too (the shim
   * blocked it; a real run would have changed the owner's launchd jobs),
   * unless `{ allowLaunchctl: true }` says the flow loads a unit by design.
   * Resolves true when it passed.
   */
  const step = async (id, title, ...rest) => {
    const fn = rest.pop();
    const { allowLaunchctl = false } = rest[0] ?? {};
    const seen = mutatingCalls().length;
    try {
      await fn();
      const tried = mutatingCalls().slice(seen);
      if (tried.length && allowLaunchctl) log(`NOTE ${id} the QA shim stood in for ${tried.length} expected launchctl call(s)`);
      else if (tried.length) throw new Error(`tried ${tried.join("; ")} (blocked by the QA shim)`);
      log(`ok   ${id} ${title}`);
      return true;
    } catch (err) {
      failed.push(id);
      log(`FAIL ${id} ${title}: ${String(err?.message ?? err).split("\n")[0]}`);
      return false;
    }
  };

  const finish = async () => {
    for (const c of children) c.kill("SIGTERM");
    await new Promise((r) => setTimeout(r, children.size ? 300 : 0));
    for (const c of children) c.kill("SIGKILL");
    for (const l of qa.shimCalls()) log(`shim ${l}`);
    const proof = compareProof(before, snapshotRealState());
    for (const p of proof) log(`PROOF ${p.item} ${p.status}`);
    const breach = proof.some((p) => p.status === "changed");
    if (!args.keep) qa.dispose();
    if (breach) {
      console.log(`FAIL ${["ISOLATION", ...new Set(failed)].join(" ")} log: ${logPath}`);
      process.exit(2);
    }
    if (failed.length) {
      console.log(`FAIL ${[...new Set(failed)].join(" ")} log: ${logPath}`);
      process.exit(1);
    }
    console.log("PASS");
    process.exit(0);
  };

  // A script error outside a case still ends with the one-line result.
  const crash = (err) => {
    failed.push("setup");
    log(`FAIL setup: ${String(err?.stack ?? err).split("\n").slice(0, 3).join(" | ")}`);
    void finish();
  };
  process.once("uncaughtException", crash);
  process.once("unhandledRejection", crash);

  return {
    args,
    qa,
    env: qa.env,
    home: qa.home,
    logPath,
    log,
    cli,
    spawnChild,
    step,
    skip: (id, reason) => log(`SKIP ${id} ${reason}`),
    note: (line) => log(`NOTE ${line}`),
    finish,
  };
}

/** Throws `message` unless `cond`. */
export function expect(cond, message) {
  if (!cond) throw new Error(message);
}

/** Polls `fn` until it returns truthy or `ms` passes. */
export async function waitFor(fn, ms = 10_000, every = 100) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) return v;
    await new Promise((r) => setTimeout(r, every));
  }
}

/** Starts the fake Telegram fixture as a script on `port`; resolves with `{ base, child }`. */
export function startFakeTelegram(stream, port, token = FAKE_TG_TOKEN) {
  const child = stream.spawnChild(process.execPath, [FAKE_TELEGRAM, String(port), token]);
  return new Promise((ok, fail) => {
    const timer = setTimeout(() => fail(new Error("fake Telegram did not start in 10 s")), 10_000);
    child.stdout.on("data", () => {
      const line = child.output.split("\n").find((l) => l.startsWith("http://"));
      if (line) {
        clearTimeout(timer);
        const base = line.trim();
        const post = async (what, body) =>
          (await fetch(`${base}/_control/${what}`, { method: "POST", body: JSON.stringify(body) })).json();
        ok({
          base,
          child,
          message: (chatId, text) => post("message", { chat_id: chatId, text }),
          calls: async () => (await fetch(`${base}/_control/calls`)).json(),
          sent: async (chatId) =>
            (await (await fetch(`${base}/_control/calls`)).json())
              .filter((c) => c.method === "sendMessage" && (chatId === undefined || Number(c.body.chat_id) === chatId))
              .map((c) => String(c.body.text)),
        });
      }
    });
    child.once("exit", (code) => fail(new Error(`fake Telegram exited with ${code}`)));
  });
}

/** Writes the QA home env file with `lines` (mode 0600). */
export function writeEnvFile(home, lines) {
  const path = join(home, ".config", "tidegap", "env");
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${lines.join("\n")}\n`, { mode: 0o600 });
  return path;
}

export const scriptName = (url) => basename(fileURLToPath(url), ".mjs");

/**
 * Connects an MCP client over stdio in the QA env, on ledger `dbPath`; the
 * server is the built one unless `server` names another command. The SDK resolves from packages/mcp-server (pnpm keeps it
 * out of the root node_modules).
 */
export async function connectMcp(stream, dbPath, extraEnv = {}, server = { command: process.execPath, args: [MCP_SERVER] }) {
  const { createRequire } = await import("node:module");
  const req = createRequire(join(ROOT, "packages/mcp-server/package.json"));
  const { Client } = await import(req.resolve("@modelcontextprotocol/sdk/client/index.js"));
  const { StdioClientTransport } = await import(req.resolve("@modelcontextprotocol/sdk/client/stdio.js"));
  const transport = new StdioClientTransport({
    ...server,
    env: { ...stream.env, TIDEGAP_DB_PATH: dbPath, ...extraEnv },
    cwd: stream.home,
    stderr: "ignore",
  });
  const client = new Client({ name: "tidegap-qa", version: "0.0.0" });
  await client.connect(transport);
  /** Calls a tool; returns `{ text, isError, json }` and logs the call. */
  const call = async (name, args = {}) => {
    const res = await client.callTool({ name, arguments: args });
    const text = (res.content ?? []).map((c) => c.text ?? "").join("\n");
    let json;
    try {
      json = JSON.parse(text);
    } catch {
      json = res.structuredContent;
    }
    stream.log(`mcp ${name} ${JSON.stringify(args)} → ${res.isError ? "error" : "ok"}`);
    stream.log(`  | ${text.slice(0, 1200).replace(/\n/g, "\n  | ")}`);
    return { text, isError: res.isError === true, json };
  };
  return { client, call, close: () => client.close() };
}

/**
 * Every leaf command of the built CLI and its long options, from `--help`:
 * `Map<"queue later", ["--db", "--until", …]>`. Throws when a `--help` fails.
 */
export function discoverCommands(cli) {
  const section = (text, title) =>
    (text.split(new RegExp(`^${title}:\\s*$`, "m"))[1] ?? "").split(/^\S.*:\s*$/m)[0].split("\n");
  const names = (text) => section(text, "Commands").map((l) => /^\s{2}(\S+)/.exec(l)?.[1]).filter((c) => c && c !== "help");
  const options = (text) => section(text, "Options").map((l) => /^\s{2}(?:-\w, )?(--[a-z][a-z-]*)/.exec(l)?.[1]).filter(Boolean);
  const help = (path) => {
    const r = cli([...path, "--help"]);
    if (r.code !== 0) throw new Error(`${path.join(" ") || "tidegap"} --help exit ${r.code}`);
    return r.stdout;
  };
  const out = new Map();
  const walk = (path) => {
    const text = help(path);
    const subs = names(text);
    const opts = options(text);
    // A group with options of its own (`usage --json`, `usage hook`) is a command too.
    if (path.length > 0 && (subs.length === 0 || opts.some((o) => o !== "--help"))) out.set(path.join(" "), opts);
    for (const sub of subs) walk([...path, sub]);
  };
  walk([]);
  return out;
}

/** Leaf commands (`"queue later"`) that the site CLI table (03-cli.md) never names. */
export function missingFromSiteTable(leaves) {
  const site = readFileSync(join(ROOT, "apps/web/content/docs/03-cli.md"), "utf8");
  return leaves.filter((l) => {
    const [group, sub] = l.split(" ");
    return !site.includes(`tidegap ${l}`) && !(sub && new RegExp(`tidegap ${group} [^|]*\\b${sub}\\b`).test(site));
  });
}
