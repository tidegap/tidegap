// Tests for the QA harness environment: the real-home refusal and the
// isolation proof. Run: node --test scripts/qa/env.test.mjs

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import { assertNotRealHome, compareProof, createQaEnv, launchdFingerprint, ledgerFingerprint, REAL_HOME, snapshotRealState } from "./env.mjs";

test("refuses the real home, its parents and the root", () => {
  assert.throws(() => assertNotRealHome(REAL_HOME), /refusing/);
  assert.throws(() => assertNotRealHome(`${REAL_HOME}/`), /refusing/);
  assert.throws(() => assertNotRealHome(dirname(REAL_HOME)), /refusing/);
  assert.throws(() => assertNotRealHome("/"), /refusing/);
  assert.throws(() => assertNotRealHome("/fake/home", "/fake/home"), /refusing/);
});

test("accepts a temp home and a sibling of the real home", () => {
  assert.doesNotThrow(() => assertNotRealHome(join(tmpdir(), "tidegap-qa", "cli-1234")));
  assert.doesNotThrow(() => assertNotRealHome("/fake/home-qa", "/fake/home"));
});

test("a home inside the real home is allowed only when it is not the home itself", () => {
  // The guard is about the resolved home being the real one (or above it);
  // a subdirectory cannot see ~/.tidegap through homedir().
  assert.doesNotThrow(() => assertNotRealHome(join(REAL_HOME, "qa-sub")));
});

test("createQaEnv: temp HOME, no secrets, shimmed launchctl", () => {
  const base = mkdtempSync(join(tmpdir(), "qa-env-test-"));
  const saved = { ...process.env };
  process.env.ANTHROPIC_API_KEY = "sk-should-go";
  process.env.TIDEGAP_TELEGRAM_BOT_TOKEN = "1:should-go";
  process.env.CLAUDECODE = "1";
  try {
    const qa = createQaEnv({ stream: "t", portBase: 47901, baseDir: base });
    assert.equal(qa.env.HOME, qa.home);
    assert.ok(qa.home.startsWith(base));
    assert.notEqual(qa.env.HOME, REAL_HOME);
    assert.equal(qa.env.ANTHROPIC_API_KEY, undefined);
    assert.equal(qa.env.TIDEGAP_TELEGRAM_BOT_TOKEN, undefined);
    assert.equal(qa.env.CLAUDECODE, undefined);
    assert.equal(qa.env.TIDEGAP_USAGE, "off");
    assert.equal(qa.env.TIDEGAP_TELEGRAM_API_BASE, "http://127.0.0.1:47951");
    assert.deepEqual(qa.ports, { ui: 47901, tg: 47951, sink: 47961 });
    const res = spawnSync("launchctl", ["print", "gui/501/com.tidegap.qa-shim-probe"], { env: qa.env, encoding: "utf8" });
    assert.equal(res.status, 113);
    spawnSync("launchctl", ["bootout", "gui/501/com.tidegap.qa-shim-probe"], { env: qa.env });
    assert.deepEqual(qa.shimCalls(), ["launchctl print gui/501/com.tidegap.qa-shim-probe", "launchctl bootout gui/501/com.tidegap.qa-shim-probe"]);
    qa.dispose();
  } finally {
    process.env = saved;
    rmSync(base, { recursive: true, force: true });
  }
});

test("createQaEnv refuses the real default port", () => {
  assert.throws(() => createQaEnv({ stream: "t", portBase: 47821, baseDir: tmpdir() }), /47821/);
});

const PRINT = (args, extra = "") => `gui/501/com.tidegap.tick = {
\tactive count = 0
\tpath = /Users/x/Library/LaunchAgents/com.tidegap.tick.plist
\ttype = LaunchAgent
\tstate = not running
\tprogram = /usr/local/bin/node
\targuments = {
${args.map((a) => `\t\t${a}`).join("\n")}
\t}
\truns = 229
\tpid = 0
${extra}\trun interval = 300 seconds
}`;

test("launchd fingerprint ignores state, runs and pid but sees the program", () => {
  const a = launchdFingerprint(0, PRINT(["node", "tidegap", "tick"]));
  const b = launchdFingerprint(0, PRINT(["node", "tidegap", "tick"]).replace("runs = 229", "runs = 230").replace("not running", "running"));
  const c = launchdFingerprint(0, PRINT(["node", "/tmp/qa/tidegap", "tick"]));
  assert.equal(a, b);
  assert.notEqual(a, c);
  assert.equal(launchdFingerprint(113, ""), "absent:113");
});

function fakeHome() {
  const home = mkdtempSync(join(tmpdir(), "qa-proof-"));
  mkdirSync(join(home, ".tidegap"), { recursive: true });
  mkdirSync(join(home, ".config", "tidegap"), { recursive: true });
  writeFileSync(join(home, ".tidegap", "queue.db"), "db");
  writeFileSync(join(home, ".config", "tidegap", "env"), "A=1\n");
  return home;
}

test("proof: unchanged when nothing is touched", () => {
  const home = fakeHome();
  const launchctl = () => ({ status: 0, stdout: PRINT(["tick"]) });
  const before = snapshotRealState({ home, uid: 501, launchctl });
  const after = snapshotRealState({ home, uid: 501, launchctl });
  assert.ok(compareProof(before, after).every((p) => p.status === "unchanged"));
  assert.equal(before["~/.claude/settings.json"], "absent");
  rmSync(home, { recursive: true, force: true });
});

test("proof: a touched file, a new file and an unloaded job are changed", () => {
  const home = fakeHome();
  let loaded = true;
  const launchctl = ([, target]) =>
    loaded || target.endsWith(".channels") ? { status: 0, stdout: PRINT(["tick"]) } : { status: 113, stdout: "" };
  const before = snapshotRealState({ home, uid: 501, launchctl });
  const later = new Date(Date.now() + 5_000);
  utimesSync(join(home, ".tidegap", "queue.db"), later, later);
  mkdirSync(join(home, ".claude"));
  writeFileSync(join(home, ".claude", "settings.json"), "{}");
  loaded = false;
  const after = snapshotRealState({ home, uid: 501, launchctl });
  const status = Object.fromEntries(compareProof(before, after).map((p) => [p.item, p.status]));
  assert.deepEqual(status, {
    "~/.tidegap/queue.db": "changed",
    "~/.config/tidegap/env": "unchanged",
    "~/.config/tidegap/channel-secrets.json": "unchanged",
    "~/.claude/settings.json": "changed",
    "~/.tidegap/queue.db harness rows": "unchanged",
    "launchd com.tidegap.tick": "changed",
    "launchd com.tidegap.channels": "unchanged",
  });
  rmSync(home, { recursive: true, force: true });
});

test("proof: a size change with the same mtime is changed", () => {
  const home = fakeHome();
  const launchctl = () => ({ status: 113, stdout: "" });
  const file = join(home, ".config", "tidegap", "env");
  const t = new Date(Date.now() - 60_000);
  utimesSync(file, t, t);
  const before = snapshotRealState({ home, launchctl });
  writeFileSync(file, "A=12\n");
  utimesSync(file, t, t);
  const after = snapshotRealState({ home, launchctl });
  assert.equal(compareProof(before, after).find((p) => p.item === "~/.config/tidegap/env").status, "changed");
  rmSync(home, { recursive: true, force: true });
});

test("ledger fingerprint sees a harness row written to the WAL, ignores other rows", (t) => {
  const sqlite = process.getBuiltinModule?.("node:sqlite");
  if (!sqlite?.DatabaseSync) return t.skip("node:sqlite is unavailable");
  const dir = mkdtempSync(join(tmpdir(), "qa-ledger-test-"));
  const path = join(dir, "queue.db");
  const db = new sqlite.DatabaseSync(path);
  try {
    db.exec("PRAGMA journal_mode = WAL; PRAGMA wal_autocheckpoint = 0;");
    db.exec("CREATE TABLE tasks (task_id TEXT PRIMARY KEY, title TEXT, origin_cwd TEXT); CREATE TABLE channels (id TEXT PRIMARY KEY, config_json TEXT NOT NULL);");
    db.exec("INSERT INTO tasks VALUES ('owner-1', 'owner work', '/work')");
    const before = ledgerFingerprint(path);
    assert.match(before, /^rows:0:0:/);
    db.exec("INSERT INTO tasks VALUES ('owner-2', 'more owner work', '/work')");
    assert.equal(ledgerFingerprint(path), before);
    db.exec("INSERT INTO tasks VALUES ('leak-1', 'qa later', '/tmp/x')");
    db.exec(`INSERT INTO channels VALUES ('ch-1', '{"chat_id":1001}')`);
    const after = ledgerFingerprint(path);
    assert.match(after, /^rows:1:1:/);
    assert.notEqual(after, before);
    assert.equal(ledgerFingerprint(join(dir, "missing.db")), "absent");
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("gate forwards --stream, --port-base and --log-dir to the area script", () => {
  const dir = mkdtempSync(join(tmpdir(), "gate-fwd-"));
  try {
    spawnSync(process.execPath, [join(dirname(fileURLToPath(import.meta.url)), "gate.mjs"), "docs", "--", "--stream", "fwd-probe", "--port-base", "47955", "--log-dir", dir, "--no-measure"], { encoding: "utf8" });
    assert.ok(existsSync(join(dir, "fwd-probe.log")), "log named after the forwarded --stream lands in the forwarded --log-dir");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
