#!/usr/bin/env node
// Chrome smoke run for the extension (U12; actions and readiness U11). Loads dist/chrome into the
// Playwright Chromium against a seeded, throwaway `tidegap ui`, drives the
// QA steps and prints `PASS` or the failed step names.
//
//   node apps/extension/scripts/smoke-chrome.mjs --out <dir> [--headed]
//
// Needs: `pnpm build` (the CLI), `pnpm --filter @tidegap/extension build`,
// and Chromium for playwright-core (`node node_modules/playwright-core/cli.js
// install chromium`). Branded Google Chrome no longer loads unpacked
// extensions from the command line, so this uses the bundled Chromium.
//
// Everything runs in a temp HOME with provider and grid secrets removed, so
// the forecast is the synthetic mock and nothing reaches a real ledger.

import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const EXT_DIR = resolve(here, "../dist/chrome");
const ROOT = resolve(here, "../../..");
const CLI = join(ROOT, "packages/cli/dist/index.js");
const CORE = join(ROOT, "packages/core-ts/dist/index.js");

const args = process.argv.slice(2);
const outIdx = args.indexOf("--out");
if (outIdx < 0 || !args[outIdx + 1]) {
  console.error("smoke: --out <dir> is required (screenshots go there).");
  process.exit(2);
}
const OUT = resolve(args[outIdx + 1]);
const HEADED = args.includes("--headed");
for (const [path, hint] of [
  [CLI, "pnpm build"],
  [join(EXT_DIR, "manifest.json"), "pnpm --filter @tidegap/extension build"],
]) {
  if (!existsSync(path)) {
    console.error(`smoke: ${path} is missing; run \`${hint}\` first.`);
    process.exit(2);
  }
}
mkdirSync(OUT, { recursive: true });

const { chromium } = await import("playwright-core");
const { TaskStore } = await import(pathToFileURL(CORE).href);

const work = mkdtempSync(join(tmpdir(), "tidegap-ext-smoke-"));
const home = join(work, "home");
const db = join(work, "queue.db");
mkdirSync(home, { recursive: true });
const env = Object.fromEntries(
  Object.entries(process.env).filter(([k]) => !/API_KEY|TOKEN|SECRET|PASSWORD|WATTTIME|ELECTRICITY|EIA_|OLLAMA|EBB_|TIDEGAP_/i.test(k)),
);
env.HOME = home;

const cli = (...argv) => execFileSync(process.execPath, [CLI, ...argv], { env, encoding: "utf8" });

function freePort() {
  return new Promise((ok, fail) => {
    const s = createServer();
    s.once("error", fail);
    s.listen(0, "127.0.0.1", () => {
      const { port } = s.address();
      s.close(() => ok(port));
    });
  });
}

const failed = [];
async function step(name, fn) {
  try {
    await fn();
    console.log(`ok   ${name}`);
  } catch (err) {
    failed.push(name);
    console.log(`FAIL ${name}: ${String(err?.message ?? err).split("\n")[0]}`);
  }
}
function expect(cond, message) {
  if (!cond) throw new Error(message);
}

let server = null;
let context = null;
try {
  // Seed the ledger and start the server on a free port (47821 may be the real one).
  execFileSync(process.execPath, [join(ROOT, "scripts/ui-seed.mjs"), "--db", db], { env, stdio: "ignore" });
  const port = await freePort();
  server = spawn(process.execPath, [CLI, "ui", "--no-open", "--db", db, "--region", "FR", "--port", String(port)], {
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  await new Promise((ok, fail) => {
    const timer = setTimeout(() => fail(new Error("tidegap ui did not start in 20 s")), 20_000);
    server.stdout.on("data", (d) => {
      if (String(d).includes("tidegap ui:")) {
        clearTimeout(timer);
        ok();
      }
    });
    server.once("exit", (code) => fail(new Error(`tidegap ui exited with ${code}`)));
  });
  const { client_id: clientId, token } = JSON.parse(cli("clients", "add", "--name", "smoke", "--kind", "extension", "--json"));
  const apiGet = async (path) => {
    const res = await fetch(`http://127.0.0.1:${port}${path}`, { headers: { authorization: `Bearer ${token}` } });
    return res.json();
  };
  const seeded = await apiGet("/api/summary");
  const activeList = (await apiGet("/api/tasks?status=queued,scheduled,running,submitted&limit=20")).tasks;

  // 3a. The extension loads and its service worker registers.
  const profile = join(work, "profile");
  context = await chromium.launchPersistentContext(profile, {
    channel: "chromium",
    headless: !HEADED,
    args: [`--disable-extensions-except=${EXT_DIR}`, `--load-extension=${EXT_DIR}`],
  });
  let extId = "";
  await step("3a service worker registers", async () => {
    const worker = context.serviceWorkers()[0] ?? (await context.waitForEvent("serviceworker", { timeout: 15_000 }));
    extId = new URL(worker.url()).host;
    expect(/^[a-p]{32}$/.test(extId), `unexpected extension id ${extId}`);
  });
  if (!extId) throw new Error("no extension id; later steps cannot run");
  const extUrl = (path) => `chrome-extension://${extId}/${path}`;

  // Extension pages can message the background and read the badge.
  const page = await context.newPage();
  await page.goto(extUrl("options/options.html"));
  const poll = () => page.evaluate(() => chrome.runtime.sendMessage({ type: "poll" }));
  const badge = () => page.evaluate(() => chrome.action.getBadgeText({}));
  const openPopup = async () => {
    const p = await context.newPage();
    await p.goto(extUrl("popup/popup.html"));
    return p;
  };

  await step("3b options: save and test connection", async () => {
    await page.fill("#port", String(port));
    await page.fill("#token", token);
    await page.click("#save");
    await page.waitForFunction(() => document.getElementById("status").textContent.startsWith("Saved"), null, { timeout: 5_000 });
    await page.click("#test");
    await page.waitForFunction(() => document.getElementById("status").textContent.startsWith("Connected"), null, { timeout: 10_000 });
    await page.screenshot({ path: join(OUT, "options.png") });
  });

  // A temp HOME has no tick daemon, so a coherence-batch server says "not ready".
  const notReady = seeded.readiness?.ready === false;
  await step("3c poll sets the badge to the active count (with ! when not ready)", async () => {
    const res = await poll();
    expect(res?.state === "ok", `poll state ${res?.state}`);
    const text = await badge();
    const want = `${notReady ? "!" : ""}${seeded.active > 99 ? "99+" : String(seeded.active)}`;
    expect(text === want, `badge "${text}", want "${want}"`);
  });

  await step("3d popup lists the active tasks and the clean window", async () => {
    const p = await openPopup();
    await p.waitForSelector("#rows li", { timeout: 10_000 });
    const titles = await p.$$eval("#rows li .row-title", (els) => els.map((e) => e.textContent));
    expect(titles.length === activeList.length, `${titles.length} rows, want ${activeList.length}`);
    for (const t of activeList) expect(titles.includes(t.display_title), `missing row "${t.display_title}"`);
    const line = await p.textContent("#window");
    expect(line.trim().length > 0, "clean-window line is empty");
    await p.screenshot({ path: join(OUT, "popup.png") });
    await p.close();
  });

  await step("3e popup shows the readiness line and no quick add", async () => {
    expect(seeded.readiness && typeof seeded.readiness.ready === "boolean", "summary has no readiness (server without the coherence batch)");
    expect(notReady, "a temp HOME with no daemon should not be ready");
    const p = await openPopup();
    await p.waitForSelector("#rows li", { timeout: 10_000 });
    const line = await p.$eval("#readiness", (el) => (el.hidden ? "" : el.textContent));
    expect(line === seeded.readiness.line, `readiness line "${line}", want "${seeded.readiness.line}"`);
    const quickAdd = await p.$$("form, textarea, #add, #prompt");
    expect(quickAdd.length === 0, "a quick-add element is still in the popup");
    await p.screenshot({ path: join(OUT, "readiness.png") });
    await p.close();
  });

  const used = new Set();
  const pickRow = (pred) => {
    const t = activeList.find((x) => !used.has(x.task_id) && pred(x));
    expect(t, "no seeded task fits this step");
    used.add(t.task_id);
    return t;
  };
  const taskById = async (id) => (await apiGet("/api/tasks")).tasks.find((x) => x.task_id === id);
  const rowSel = (id) => `#rows > li[data-task="${id}"]`;
  const waitMsg = (p, prefix) =>
    p.waitForFunction((want) => document.getElementById("action-msg").textContent.startsWith(want), prefix, { timeout: 10_000 });

  await step("3f Later moves a task to a preset", async () => {
    const t = pickRow((x) => x.actions?.later && x.later_options?.some((o) => o.available));
    const option = t.later_options.find((o) => o.available);
    const p = await openPopup();
    await p.waitForSelector(rowSel(t.task_id), { timeout: 10_000 });
    await p.click(`${rowSel(t.task_id)} [data-action="later"]`);
    const disabled = await p.$$eval(`${rowSel(t.task_id)} .later-options button:disabled`, (els) => els.length);
    const reasons = await p.$$eval(`${rowSel(t.task_id)} .later-options .reason`, (els) => els.length);
    expect(disabled === reasons, `${disabled} disabled presets, ${reasons} reasons shown`);
    await p.screenshot({ path: join(OUT, "later.png") });
    await p.click(`${rowSel(t.task_id)} [data-preset="${option.preset}"]`);
    await waitMsg(p, "Moved");
    await p.close();
    const after = await taskById(t.task_id);
    expect(after.not_before && Date.parse(after.not_before) >= Date.parse(option.not_before), `not_before ${after.not_before}, want ${option.not_before}`);
  });

  await step("3g Run now asks, then marks the task due", async () => {
    const t = pickRow((x) => x.actions?.runNow);
    const p = await openPopup();
    await p.waitForSelector(rowSel(t.task_id), { timeout: 10_000 });
    await p.click(`${rowSel(t.task_id)} [data-action="runNow"]`);
    await p.waitForSelector(`${rowSel(t.task_id)} [data-confirm="runNow"]`, { timeout: 5_000 });
    await p.click(`${rowSel(t.task_id)} [data-confirm="runNow"] .yes`);
    await waitMsg(p, "Runs on the next tick");
    await p.close();
    const after = await taskById(t.task_id);
    expect(Date.parse(after.scheduled_for ?? "") <= Date.now() + 60_000, `scheduled_for ${after.scheduled_for} is not due`);
  });

  await step("3h Cancel asks, then cancels the task", async () => {
    const t = pickRow((x) => x.actions?.cancel && x.status !== "running" && x.status !== "submitted");
    const p = await openPopup();
    await p.waitForSelector(rowSel(t.task_id), { timeout: 10_000 });
    await p.click(`${rowSel(t.task_id)} [data-action="cancel"]`);
    await p.click(`${rowSel(t.task_id)} [data-confirm="cancel"] .no`);
    expect((await p.$$(`${rowSel(t.task_id)} [data-confirm]`)).length === 0, "Keep did not close the confirm");
    expect((await taskById(t.task_id)).status !== "cancelled", "Keep cancelled the task");
    await p.click(`${rowSel(t.task_id)} [data-action="cancel"]`);
    await p.click(`${rowSel(t.task_id)} [data-confirm="cancel"] .yes`);
    await waitMsg(p, "Cancelled");
    await p.waitForFunction((sel) => !document.querySelector(sel), rowSel(t.task_id), { timeout: 5_000 });
    await p.close();
    const after = await taskById(t.task_id);
    expect(after.status === "cancelled", `status ${after.status}`);
  });

  await step("3i a finished task sends one notification", async () => {
    const pick = activeList.find((t) => !used.has(t.task_id) && t.status === "scheduled") ?? activeList.find((t) => !used.has(t.task_id));
    const store = new TaskStore({ dbPath: db });
    try {
      const rec = store.get(pick.task_id);
      store.upsert({ ...rec, status: "completed", completedAt: new Date().toISOString(), result: { text: "smoke result" } });
    } finally {
      store.close();
    }
    const res = await poll();
    expect(res?.state === "ok", `poll state ${res?.state}`);
    const all = await page.evaluate(() => chrome.notifications.getAll());
    const ids = Object.keys(all);
    // getAll returns ids only; the title text is covered by test/notify.test.js.
    expect(ids.length === 1 && ids[0] === `tidegap-task-${pick.task_id}`, `notifications ${JSON.stringify(ids)}`);
  });

  await step("3j a revoked client shows ? and not paired", async () => {
    cli("clients", "revoke", clientId);
    const res = await poll();
    expect(res?.state === "unpaired", `poll state ${res?.state}`);
    const text = await badge();
    expect(text === "?", `badge "${text}"`);
    const p = await openPopup();
    await p.waitForSelector("#status:not([hidden])", { timeout: 10_000 });
    const msg = await p.textContent("#status");
    expect(/not paired/i.test(msg), `popup says "${msg}"`);
    await p.close();
  });

  await step("3k a stopped server shows off and not running", async () => {
    const exited = new Promise((ok) => server.once("exit", ok));
    server.kill("SIGINT");
    await exited;
    server = null;
    const res = await poll();
    expect(res?.state === "offline", `poll state ${res?.state}`);
    const text = await badge();
    expect(text === "off", `badge "${text}"`);
    const p = await openPopup();
    await p.waitForSelector("#status:not([hidden])", { timeout: 15_000 });
    const msg = await p.textContent("#status");
    expect(/not running/i.test(msg), `popup says "${msg}"`);
    await p.screenshot({ path: join(OUT, "offline.png") });
    await p.close();
  });
} catch (err) {
  failed.push(`setup: ${String(err?.message ?? err).split("\n")[0]}`);
} finally {
  await context?.close().catch(() => {});
  server?.kill("SIGINT");
  rmSync(work, { recursive: true, force: true });
}

if (failed.length) {
  console.log(`FAIL ${failed.join("; ")}`);
  process.exit(1);
}
for (const shot of ["options.png", "popup.png", "readiness.png", "later.png", "offline.png"]) {
  if (!existsSync(join(OUT, shot))) {
    console.log(`FAIL missing screenshot ${shot}`);
    process.exit(1);
  }
}
console.log(`PASS (screenshots in ${OUT})`);
