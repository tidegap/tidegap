#!/usr/bin/env node
// QA area "ui": the S2 `pw` cases, S3.8, S3.9 and S14 (grid region card) against `tidegap ui` on a
// seeded ledger, driven by playwright-core (as apps/extension/scripts/smoke-chrome.mjs).
// A browser suite: never run it in parallel with another stream.
// Prints `PASS` or the failed case ids + log path; screenshots go next to the log.
//
//   node scripts/qa/ui-flows.mjs [--stream ui] [--port-base 47901] [--log-dir <dir>] [--keep] [--headed]
//
// Needs `pnpm build` and Chromium for playwright-core
// (`node node_modules/playwright-core/cli.js install chromium`).

import { existsSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { CLI, connectMcp, CORE, expect, FAKE_TG_TOKEN, startFakeSink, startFakeTelegram, startStream, waitFor, writeEnvFile } from "./env.mjs";

const s = startStream("ui-flows", { portBase: 47901 });
const { cli, step, home, args } = s;
const shot = (name) => join(args.logDir, `${args.stream}-${name}.png`);
const seed = join(home, "seed.db");
const empty = join(home, "empty.db");
const port = args.portBase;
const CHAT = 2002;

cli(["install", "--no-load"]);
writeEnvFile(s.home, []);
s.seedLedger(seed);
s.seedLedger(empty, ["--empty"]);
// The seed has few free scheduled tasks; the cases that move or end one get their own.
const xssTitle = `<img src=x onerror="window.__qaXss=1">qa markup`;
{
  const m = await connectMcp(s, seed);
  const deadline = new Date(Date.now() + 72 * 3_600_000).toISOString();
  for (const title of [xssTitle, ...Array.from({ length: 8 }, (_, i) => `qa ui ${i + 1}`)]) {
    await m.call("schedule_task", { prompt: title, title, region: "FR", provider: "claude-code", deadline });
  }
  await m.close();
}
const tg = await startFakeTelegram(s, s.qa.ports.tg);

const tasks = () => JSON.parse(cli(["queue", "list", "--json", "--db", seed]).stdout).tasks;
const show = (id) => s.show(id, seed);

/** `region: null` starts without --region, so the stored setting or the time zone decides. */
function startUi(db, { region = "FR", env } = {}) {
  const flag = region ? ["--region", region] : [];
  const child = s.spawnChild(process.execPath, [CLI, "ui", "--no-open", "--db", db, "--port", String(port), ...flag], { env });
  return waitFor(() => /(http:\/\/127\.0\.0\.1:\d+\/\S*#token=\S+)/.exec(child.output)?.[1], 20_000).then((link) => {
    if (!link) throw new Error(`tidegap ui did not start: ${child.output.trim().split("\n")[0] ?? ""}`);
    return { child, link: link.trim(), token: /#token=([\w-]+)/.exec(link)[1] };
  });
}
const stopUi = async ({ child }) => {
  const done = new Promise((ok) => child.once("exit", ok));
  child.kill("SIGINT");
  await done;
};
const apiAs = (token) => async (method, path, body) => {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, ...(body ? { "content-type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
};

let server = await startUi(seed);
let api = apiAs(server.token);
const mac = JSON.parse(cli(["clients", "add", "--name", "qa mac", "--kind", "macos", "--json"]).stdout);

const { chromium } = await import("playwright-core");
const browser = await chromium.launch({ channel: "chromium", headless: !args.headed });
const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
const pageErrors = [];
const newPage = async (link) => {
  const p = await context.newPage();
  p.on("pageerror", (e) => pageErrors.push(String(e.message).split("\n")[0]));
  // Console lines for refused requests (a 400 or 403 the case provokes) are not uncaught errors.
  p.on("console", (m) => m.type() === "error" && s.log(`console ${m.text().split("\n")[0]}`));
  if (link) await p.goto(link);
  return p;
};
const toasts = (p) => p.$$eval("#toasts .toast-msg", (els) => els.map((e) => e.textContent));
const waitToast = (p, re) => waitFor(async () => (await toasts(p)).find((t) => re.test(t)), 10_000, 200);
const row = (p, id) => p.locator(`#view .row[data-task-id="${id}"]`);
const rowAction = async (p, id, action) => {
  await row(p, id).hover();
  await row(p, id).locator(`[data-action="${action}"]`).click();
};
const pickTask = (pred, label) => {
  const t = tasks().find(pred);
  expect(t, `no seeded task: ${label}`);
  return t;
};
/** Back to the agenda with no dialog or drawer open. */
const home_ = async (p = page, view = "agenda") => {
  await p.evaluate(() => document.getElementById("dialog")?.open && document.getElementById("dialog").close());
  await p.goto(`http://127.0.0.1:${port}/#/${view}`).catch(() => {});
  await p.waitForSelector("#view .row, #view .empty", { timeout: 15_000 });
};
const used = new Set();
const pickActive = (label) => {
  const now = Date.now();
  const t = tasks().find((x) => x.status === "scheduled" && (x.title ?? "").startsWith("qa ui ") && !used.has(x.task_id) && Date.parse(x.scheduled_for) > now);
  expect(t, `no free scheduled task: ${label}`);
  used.add(t.task_id);
  return t;
};

let page;
try {
  await step("S2.3", "open the link; the token leaves the address bar; reload shows the expired state", async () => {
    page = await newPage(server.link);
    await page.waitForSelector("#view .row, #view .empty", { timeout: 15_000 });
    expect(!page.url().includes("token="), "the token is still in the address bar");
    const fresh = await newPage(server.link);
    await fresh.waitForSelector("#view .row, #view .empty", { timeout: 15_000 });
    await fresh.reload();
    await fresh.waitForSelector("text=This link expired.", { timeout: 10_000 });
    await fresh.close();
  });

  await step("S2.5", "agenda with no daemon: amber banner with the fix line; overdue and today groups", async () => {
    await page.goto(`http://127.0.0.1:${port}/#/agenda`).catch(() => {});
    await page.waitForSelector("#banner:not([hidden])", { timeout: 10_000 });
    const tone = await page.getAttribute("#banner", "data-tone");
    const text = await page.textContent("#banner");
    expect(tone === "warn", `banner tone ${tone}`);
    expect(/will not run/i.test(text) && /tidegap install/.test(text), `banner: ${text.trim()}`);
    expect((await page.$$("#view .group-attention")).length > 0, "no overdue (attention) group");
    await page.screenshot({ path: shot("agenda") });
  });

  // Before any tick: the button shows only while no recent tick is recorded.
  await step("S2.18", "Start dispatcher: starts a child; a second start gets 409; teardown kills it", async () => {
    await page.goto(`http://127.0.0.1:${port}/#/agenda`).catch(() => {});
    await page.waitForSelector('[data-action="start-dispatcher"]', { timeout: 10_000 });
    await page.locator('[data-action="start-dispatcher"]').first().click();
    expect(await waitToast(page, /Dispatcher started/), `toast: ${(await toasts(page)).join(" | ")}`);
    const again = await api("POST", "/api/dispatcher/start");
    expect(again.status === 409, `second start: ${again.status}`);
    const { TaskStore } = await import(pathToFileURL(CORE).href);
    const store = new TaskStore({ dbPath: seed });
    let pid;
    try {
      pid = JSON.parse(store.getMeta("ui_dispatcher") ?? "{}").pid;
    } finally {
      store.close();
    }
    expect(Number.isInteger(pid) && pid > 1, `no usable ui_dispatcher pid in ledger meta: ${pid}`);
    process.kill(pid, "SIGTERM");
  });

  await step("S2.6", "Later: presets with times, disabled ones say why; pick one, the row moves, toast", async () => {
    await home_();
    const t = pickActive("later");
    await rowAction(page, t.task_id, "later");
    await page.waitForSelector("#dialog .menu-later", { timeout: 5_000 });
    const items = await page.$$eval("#dialog .menu-later .menu-item", (els) => els.map((e) => ({ label: e.querySelector(".menu-label")?.textContent, disabled: e.disabled, hint: e.querySelector(".menu-hint")?.textContent ?? "", reason: e.querySelector(".menu-reason")?.textContent ?? "" })));
    const presets = items.filter((i) => i.label !== "Pick a time…");
    expect(presets.length === 4, `${presets.length} presets, want 4`);
    for (const i of presets) expect(i.disabled ? i.reason : /\d{1,2}:\d{2}/.test(i.hint), `${i.label}: ${i.disabled ? "disabled without a reason" : "no time"}`);
    const first = presets.findIndex((i) => !i.disabled);
    expect(first >= 0, "every preset is disabled");
    await page.screenshot({ path: shot("later") });
    await page.locator("#dialog .menu-later .menu-item").nth(first).click();
    expect(await waitToast(page, /^Moved/), "no Moved toast");
    const before = Date.parse(t.scheduled_for);
    expect(await waitFor(() => Date.parse(show(t.task_id).scheduledFor) > before, 15_000, 500), "the task did not move later");
  });

  await step("S2.7", "Later → Pick a time earlier than planned: the 409 line, not a generic error", async () => {
    await home_();
    const t = pickActive("pick earlier");
    await rowAction(page, t.task_id, "later");
    await page.locator("#dialog .menu-item", { hasText: "Pick a time…" }).click();
    await page.waitForSelector("#rs-date", { timeout: 5_000 });
    const target = new Date(Math.ceil((Date.now() + 30 * 60_000) / 300_000) * 300_000);
    const pad = (n) => String(n).padStart(2, "0");
    await page.fill("#rs-date", `${target.getFullYear()}-${pad(target.getMonth() + 1)}-${pad(target.getDate())}`);
    await page.fill("#rs-time", `${pad(target.getHours())}:${pad(target.getMinutes())}`);
    await page.click('#dialog button[type="submit"]');
    await page.waitForTimeout(2_000);
    const all = (await toasts(page)).join(" | ");
    const after = show(t.task_id).scheduledFor;
    expect(/already planned for/i.test(all), `no 409 line; the task moved ${t.scheduled_for} → ${after}; toasts: ${all || "none"}`);
  });

  await step("S2.8", "Run now: toast runs on the next tick; event expedited, actor page", async () => {
    await home_();
    const t = pickActive("run now");
    await rowAction(page, t.task_id, "run-now");
    expect(await waitToast(page, /next tick/i), "no 'next tick' toast");
    const ev = await waitFor(() => (show(t.task_id).events ?? []).find((e) => e.kind === "expedited"), 10_000, 500);
    expect(ev?.actor === "page", `expedited actor ${ev?.actor}`);
  });

  await step("S2.9", "cancel and stop series", async () => {
    await home_();
    const t = pickActive("cancel");
    await rowAction(page, t.task_id, "cancel");
    expect(await waitFor(() => show(t.task_id).status === "cancelled", 20_000, 500), "the task is not cancelled");
    const series = pickTask((x) => x.series_id && ["scheduled", "queued"].includes(x.status), "series");
    await page.goto(`http://127.0.0.1:${port}/#/agenda`).catch(() => {});
    await row(page, series.task_id).locator('[data-action="menu"]').click();
    await page.locator("#dialog .menu-item", { hasText: "Stop series" }).click();
    await page.click('#dialog button[type="submit"]');
    expect(await waitFor(() => show(series.task_id).status === "cancelled", 20_000, 500), "the series occurrence is not cancelled");
    const next = tasks().filter((x) => x.series_id === series.series_id && ["scheduled", "queued"].includes(x.status));
    expect(next.length === 0, `${next.length} live occurrence(s) left in the series`);
  });

  await step("S2.10", "Reschedule dialog: new time saved", async () => {
    await home_();
    const t = pickActive("reschedule");
    await row(page, t.task_id).locator('[data-action="menu"]').click();
    await page.locator("#dialog .menu-item", { hasText: "Reschedule…" }).click();
    await page.waitForSelector("#rs-date", { timeout: 5_000 });
    const target = new Date(Date.parse(t.deadline) - 60 * 60_000);
    target.setMinutes(0, 0, 0);
    const pad = (n) => String(n).padStart(2, "0");
    await page.fill("#rs-date", `${target.getFullYear()}-${pad(target.getMonth() + 1)}-${pad(target.getDate())}`);
    await page.fill("#rs-time", `${pad(target.getHours())}:00`);
    await page.click('#dialog button[type="submit"]');
    expect(await waitFor(() => Date.parse(show(t.task_id).scheduledFor) === target.getTime(), 15_000, 500), `scheduled_for ${show(t.task_id).scheduledFor}, want ${target.toISOString()}`);
  });

  await step("S2.11", "timeline: curve and task blocks render", async () => {
    await page.goto(`http://127.0.0.1:${port}/#/timeline`).catch(() => {});
    await page.waitForSelector("#view svg path", { timeout: 10_000 });
    expect((await page.$$("#view [data-task-id]")).length > 0, "no task blocks");
    await page.screenshot({ path: shot("timeline") });
    s.skip("S2.11", "part: drag to another hour (HTML5 drag between hour slots) needs the manual pass");
  });

  await step("S2.12", "journal filters; opening an unread task drops the count; Mark unread brings it back", async () => {
    await page.goto(`http://127.0.0.1:${port}/#/journal`).catch(() => {});
    await page.waitForSelector("#filter-status", { timeout: 10_000 });
    const all = tasks();
    for (const [value, pred] of [
      ["completed", (t) => t.status === "completed"],
      ["failed", (t) => t.status === "failed"],
      ["unread", (t) => ["completed", "failed"].includes(t.status) && !t.read_at],
    ]) {
      await page.selectOption("#filter-status", value);
      await page.waitForTimeout(400);
      const shown = await page.$$eval("#view .row[data-task-id]", (els) => els.map((e) => e.dataset.taskId));
      const want = all.filter(pred).map((t) => t.task_id);
      expect(shown.length === want.length && shown.every((id) => want.includes(id)), `filter ${value}: ${shown.length} rows, want ${want.length}`);
    }
    const unread = all.find((t) => ["completed", "failed"].includes(t.status) && !t.read_at);
    expect(unread, "no unread task in the seed");
    const count = async () => Number((await page.textContent("#unread-count")) || 0);
    const before = await count();
    await page.goto(`http://127.0.0.1:${port}/#/task/${encodeURIComponent(unread.task_id)}`).catch(() => {});
    expect(await waitFor(async () => (await count()) === before - 1, 10_000, 200), `unread count stayed ${await count()}`);
    await page.keyboard.press("u");
    expect(await waitFor(async () => (await count()) === before, 10_000, 200), `unread count ${await count()}, want ${before}`);
  });

  // A task run through the tick (fake claude) has a result, a receipt and events.
  const done = pickActive("detail");
  cli(["queue", "run-now", done.task_id, "--db", seed]);
  cli(["tick", "--once", "--no-notify", "--db", seed]);
  await step("S2.13", "task detail: prompt, result, receipt, events, resume command for a session task", async () => {
    await page.goto(`http://127.0.0.1:${port}/#/task/${encodeURIComponent(done.task_id)}`).catch(() => {});
    await page.waitForSelector("#drawer:not([hidden]) .drawer-title", { timeout: 10_000 });
    const text = await page.textContent("#drawer");
    expect(/receipt/i.test(text), "no receipt section");
    expect((await page.$$("#drawer .pre.result")).length > 0, "no result");
    expect((await page.$$("#drawer ol.events li")).length > 0, "no events timeline");
    const session = tasks().find((t) => show(t.task_id).originSessionId || show(t.task_id).origin?.session_id);
    if (session) {
      await page.goto(`http://127.0.0.1:${port}/#/task/${encodeURIComponent(session.task_id)}`).catch(() => {});
      await page.waitForSelector("#resume-cmd", { timeout: 10_000 });
    } else s.note("S2.13 no session task found in the seed; resume command not checked");
    await page.screenshot({ path: shot("detail") });
  });

  await step("S2.14", "Conversation → Reply with the page token: child task queued, toast, Reply-to link", async () => {
    await page.goto(`http://127.0.0.1:${port}/#/task/${encodeURIComponent(done.task_id)}`).catch(() => {});
    await page.waitForSelector("#reply-input", { timeout: 10_000 });
    const before = new Set(tasks().map((t) => t.task_id));
    await page.fill("#reply-input", "qa follow-up");
    await page.click('[data-action="reply-send"]');
    expect(await waitToast(page, /Reply queued/), `toast: ${(await toasts(page)).join(" | ")}`);
    const child = await waitFor(() => tasks().find((t) => !before.has(t.task_id)), 10_000, 500);
    expect(child, "no child task");
    expect((show(child.task_id).history ?? []).length >= 2, "the child task carries no history");
    await page.goto(`http://127.0.0.1:${port}/#/task/${encodeURIComponent(child.task_id)}`).catch(() => {});
    expect(await waitFor(() => page.evaluate(() => /Reply to/.test(document.getElementById("drawer").textContent)), 10_000, 200), "no 'Reply to' link on the child");
  });

  await step("S2.16", "keyboard: R focuses the reply only when allowed; Esc closes a dialog", async () => {
    await page.goto(`http://127.0.0.1:${port}/#/task/${encodeURIComponent(done.task_id)}`).catch(() => {});
    await page.waitForSelector("#reply-input", { timeout: 10_000 });
    await page.locator("#drawer .drawer-title").click();
    await page.keyboard.press("Shift+R");
    expect(await waitFor(() => page.evaluate(() => document.activeElement?.id === "reply-input"), 3_000, 100), "R did not focus the reply box");
    await page.goto(`http://127.0.0.1:${port}/#/agenda`).catch(() => {});
    await page.click("#help-btn");
    await page.waitForSelector("#dialog[open]", { timeout: 5_000 });
    await page.keyboard.press("Escape");
    expect(await waitFor(() => page.evaluate(() => !document.getElementById("dialog").open), 3_000, 100), "Esc did not close the dialog");
  });

  await step("S2.17", "a tick in another process updates the open page without a reload", async () => {
    await home_();
    const t = pickActive("tick");
    await page.goto(`http://127.0.0.1:${port}/#/agenda`).catch(() => {});
    await row(page, t.task_id).waitFor({ timeout: 10_000 });
    cli(["queue", "run-now", t.task_id, "--db", seed]);
    cli(["tick", "--once", "--no-notify", "--db", seed]);
    expect(show(t.task_id).status === "completed", `setup: status ${show(t.task_id).status}`);
    expect(await waitFor(async () => (await row(page, t.task_id).count()) === 0, 15_000, 300), "the finished task is still on the agenda");
  });

  await step("S2.19", "usage panel hidden with TIDEGAP_USAGE=off", async () => {
    expect(await page.isHidden("#usage-pill"), "the usage pill is shown");
  });

  await step("S2.20", "Connected apps: connect, token once, list, revoke; copy says apps cannot create tasks (K2)", async () => {
    await home_();
    await page.click("#apps-btn");
    await page.waitForSelector("#dialog[open]", { timeout: 5_000 });
    const copy = await page.textContent("#dialog");
    await page.fill("#app-name", "qa browser");
    await page.locator("#dialog button", { hasText: "Connect an app" }).click();
    const token = await waitFor(() => page.evaluate(() => document.querySelector("#dialog .token-field")?.value || document.querySelector("#dialog .token-box")?.textContent || ""), 5_000, 200);
    expect(/tgc_/.test(token ?? ""), "no tgc_ token shown");
    const client = (await api("GET", "/api/clients")).body.clients?.find((c) => c.name === "qa browser");
    expect(client, "the new app is not listed");
    const tokenValue = /tgc_[\w-]+/.exec(token)[0];
    expect((await apiAs(tokenValue)("GET", "/api/summary")).status === 200, "the new token is refused");
    await api("POST", `/api/clients/${client.id ?? client.client_id}/revoke`);
    expect((await apiAs(tokenValue)("GET", "/api/summary")).status === 401, "the revoked token still works");
    await page.keyboard.press("Escape");
    expect(!/can (see and )?queue tasks|create tasks/i.test(copy) || /cannot (create|queue)/i.test(copy), `copy: "${(/[^.]*queue tasks[^.]*\./i.exec(copy) ?? [copy.slice(0, 80)])[0].trim()}"`);
  });

  await step("S2.21", "Settings → Integrations with fake Telegram: token, Connect, pair, Send test, Disconnect, Remove token", { allowLaunchctl: true }, async () => {
    await page.goto(`http://127.0.0.1:${port}/#/settings`).catch(() => {});
    await page.waitForSelector('[data-action="connect-token"]', { timeout: 10_000 });
    await page.fill(".token-field, input[placeholder^='123456789']", "not-a-token");
    await page.click('[data-action="connect-token"]');
    const formatError = await waitFor(() => page.evaluate(() => document.querySelector(".integration-alert")?.textContent || document.querySelector("#telegram-field-error")?.textContent || ""), 5_000, 200);
    expect(formatError, "a bad token format shows no error sentence (S2.22)");
    await page.fill(".token-field, input[placeholder^='123456789']", FAKE_TG_TOKEN);
    await page.press(".token-field", "Enter");
    // One step: Enter saves the token, tests it and starts pairing; the code shows with no second click.
    await page.waitForSelector(".pairing-code", { timeout: 10_000 });
    const botChip = await page.evaluate(() => document.querySelector('.copy-chip[data-copy="bot username"] .copy-value')?.textContent || "");
    expect(/^@\w+$/.test(botChip), `the card shows a copy chip for the bot username after the token is saved ("${botChip}")`);
    const code = await waitFor(() => page.evaluate(() => document.querySelector(".pairing-code .copy-value")?.textContent || ""), 10_000, 200);
    expect(/^\d{6}$/.test(code ?? ""), `pairing code "${code}"`);
    const chips = await page.evaluate(() => [...document.querySelectorAll(".pairing .copy-chip")].map((c) => c.querySelector(".copy-value")?.textContent));
    expect(chips.includes(`/pair ${code}`) && chips.some((t) => t?.startsWith("https://t.me/") && t.endsWith(`?start=${code}`)), `pairing chips: ${chips.join(" | ")}`);
    await page.screenshot({ path: shot("pairing") });
    await tg.message(CHAT, `/pair ${code}`);
    await page.waitForSelector('[data-action="test"]', { timeout: 20_000 });
    const sentBefore = (await tg.sent(CHAT)).length;
    await page.click('[data-action="test"]');
    expect(await waitFor(async () => (await tg.sent(CHAT)).length > sentBefore, 10_000, 300), "Send test sent nothing");
    await page.click('[data-action="disconnect"]');
    await page.check("#forget-token");
    await page.click('#dialog button[type="submit"]');
    await page.waitForSelector('[data-action="connect-token"]', { timeout: 10_000 });
    const state = (await api("GET", "/api/integrations")).body;
    expect(!JSON.stringify(state).includes(FAKE_TG_TOKEN.slice(-12)), "the token is still reported");
  });

  // Channel cards (integrations plan U4). They need the channels API (U3); against an older server the cases are skipped.
  const offered = ((await api("GET", "/api/integrations")).body?.kinds || []).map((k) => k.kind);
  if (offered.includes("webhook")) {
    const sink = await startFakeSink(s, s.qa.ports.sink);
    const card = (kind) => `section.integration-card[data-kind="${kind}"]`;
    const pill = (kind) => page.evaluate((sel) => document.querySelector(`${sel} .integration-state`)?.dataset.state, card(kind));
    const waitPill = (kind, state) => waitFor(async () => (await pill(kind)) === state, 10_000, 200);
    const openSettings = async () => {
      await page.goto(`http://127.0.0.1:${port}/#/settings`).catch(() => {});
      await page.waitForSelector(card("webhook"), { timeout: 10_000 });
    };

    await step("S2.28", "webhook card against the fake sink: Enter connects in one step; Send test; Disconnect; Connect; Remove", async () => {
      await sink.clear();
      await openSettings();
      await page.click(`${card("webhook")} [data-action="open"]`);
      await page.fill("#ch-webhook-url", `${sink.base}/hook`);
      await page.press("#ch-webhook-url", "Enter");
      expect(await waitPill("webhook", "connected"), `pill after Enter: ${await pill("webhook")}`);
      expect((await sink.requests("/hook")).length === 1, "the sink did not get exactly one test message");
      expect(!(await page.$("#ch-webhook-url")), "the form is still open after Connect");
      await page.screenshot({ path: shot("channel-connected") });
      await page.click(`${card("webhook")} [data-action="test"]`);
      expect(await waitFor(async () => (await sink.requests("/hook")).length === 2, 10_000, 200), "Send test sent nothing");
      // Edit with the secret field left empty keeps the stored URL (R8).
      await page.click(`${card("webhook")} [data-action="edit"]`);
      expect((await page.inputValue("#ch-webhook-url")) === "", "Edit put the stored URL into the page");
      await page.click(`${card("webhook")} [data-action="connect-channel"]`);
      expect(await waitFor(async () => (await sink.requests("/hook")).length === 3, 10_000, 200), "Edit with an empty URL did not reach the stored URL");
      expect(await waitPill("webhook", "connected"), "not connected after Edit");
      await page.click(`${card("webhook")} [data-action="disconnect"]`);
      expect(await waitPill("webhook", "disconnected"), "not grey after Disconnect");
      await page.click(`${card("webhook")} [data-action="connect"]`);
      expect(await waitPill("webhook", "connected"), "not green after Connect with no typing");
      await page.click(`${card("webhook")} [data-action="remove"]`);
      await page.click('#dialog button[type="submit"]');
      expect(await waitPill("webhook", "not_set_up"), "not reset after Remove");
      const state = JSON.stringify((await api("GET", "/api/integrations")).body);
      expect(!state.includes(`${sink.base}/hook`), "the webhook URL is reported by the API");
      expect(!(await api("GET", "/api/integrations")).body.channels?.some((c) => c.kind === "webhook"), "the webhook row is still listed after Remove");
    });

    await step("S2.29", "each ready kind connects through its fixture; a refused value shows the inline error", async () => {
      await sink.clear();
      await sink.script("/gone", [{ status: 404 }]);
      await openSettings();
      await page.click(`${card("webhook")} [data-action="open"]`);
      await page.fill("#ch-webhook-url", `${sink.base}/gone`);
      await page.click(`${card("webhook")} [data-action="connect-channel"]`);
      // A 404 is test_failed with field "url": the sentence goes under the URL field, not under the button.
      const err = await waitFor(() => page.evaluate(() => (document.querySelector('#ch-webhook-url[aria-invalid="true"]') && document.querySelector("#ch-webhook-url-error")?.textContent) || ""), 10_000, 200);
      expect(err, "no error under the URL field for a refused URL");
      expect((await page.inputValue("#ch-webhook-url")).endsWith("/gone"), "the typed value was lost");
      expect((await pill("webhook")) === "not_set_up", "a refused connect changed the card state");
      await page.click(`${card("webhook")} [data-action="cancel"]`);
      // Each channel stream's scripts/qa/channels/<kind>.mjs may export `ui: {fields: (sink) => ({...})}`.
      const dir = join(dirname(fileURLToPath(import.meta.url)), "channels");
      for (const f of existsSync(dir) ? readdirSync(dir).filter((x) => x.endsWith(".mjs")) : []) {
        const mod = await import(pathToFileURL(join(dir, f)).href);
        if (!mod.ui?.fields || !offered.includes(mod.kind)) continue;
        await openSettings();
        await page.click(`${card(mod.kind)} [data-action="open"]`);
        for (const [name, value] of Object.entries(mod.ui.fields(sink))) {
          const sel = `#ch-${mod.kind}-${name}`;
          if ((await page.$eval(sel, (e) => e.tagName)) === "SELECT") await page.selectOption(sel, String(value));
          else await page.fill(sel, String(value));
        }
        await page.click(`${card(mod.kind)} [data-action="connect-channel"]`);
        expect(await waitPill(mod.kind, "connected"), `${mod.kind} did not connect from its fixture`);
      }
    });

    await step("S2.30", "uncheck Task finished, turn quiet on, open the link again: both persist", async () => {
      await openSettings();
      await page.click(`${card("webhook")} [data-action="open"]`);
      await page.fill("#ch-webhook-url", `${sink.base}/hook`);
      await page.press("#ch-webhook-url", "Enter");
      expect(await waitPill("webhook", "connected"), "the webhook did not connect");
      await page.uncheck("#webhook-event-task_done");
      expect(await waitFor(() => page.evaluate(() => document.querySelector('.view-settings [role="status"]')?.textContent === "Saved"), 5_000, 100), "no Saved announcement");
      await page.check("#webhook-quiet");
      const stored = () => api("GET", "/api/integrations").then((r) => (r.body.channels || []).find((c) => c.kind === "webhook"));
      expect(await waitFor(async () => (await stored())?.quiet === "night", 5_000, 100), "quiet was not saved");
      const ch = await stored();
      expect(!ch.events.includes("task_done"), `stored events: ${JSON.stringify(ch.events)}`);
      // A reload drops the in-memory token (S2.3), so a fresh page opens the link again.
      const fresh = await newPage(`${server.link}&view=settings`);
      try {
        await fresh.waitForSelector("#webhook-quiet", { timeout: 10_000 });
        expect(!(await fresh.isChecked("#webhook-event-task_done")), "Task finished is checked again in a new page");
        expect(await fresh.isChecked("#webhook-quiet"), "quiet is off again in a new page");
      } finally {
        await fresh.close();
      }
    });
  } else {
    for (const id of ["S2.28", "S2.29", "S2.30"]) s.skip(id, "needs the channels API (integrations plan U3); this server offers no channel kinds");
  }

  await step("S2.31", "Integrations at 390 px and in dark mode: one column, no horizontal scroll", async () => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.emulateMedia({ colorScheme: "dark" });
    await page.goto(`http://127.0.0.1:${port}/#/settings`).catch(() => {});
    await page.waitForSelector(".integration-grid .integration-card", { timeout: 10_000 });
    await page.waitForTimeout(400);
    const { width, cols } = await page.evaluate(() => ({
      width: document.scrollingElement.scrollWidth,
      cols: getComputedStyle(document.querySelector(".integration-grid")).gridTemplateColumns.split(" ").length,
    }));
    await page.screenshot({ path: shot("settings-390-dark"), fullPage: true });
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.emulateMedia({ colorScheme: "light" });
    expect(width <= 390, `horizontal scroll: ${width}px`);
    expect(cols === 1, `${cols} columns at 390 px`);
  });

  await step("S2.26", "a title with markup renders as text everywhere", async () => {
    const t = pickTask((x) => x.title === xssTitle, "markup task");
    await page.goto(`http://127.0.0.1:${port}/#/task/${encodeURIComponent(t.task_id)}`).catch(() => {});
    await page.waitForSelector("#drawer .drawer-title", { timeout: 10_000 });
    expect((await page.textContent("#drawer .drawer-title")).includes("<img"), "the title is not shown as text");
    await page.goto(`http://127.0.0.1:${port}/#/agenda`).catch(() => {});
    await page.waitForTimeout(500);
    expect(!(await page.evaluate(() => window.__qaXss)), "the markup ran");
    expect((await page.$$("#view img, #drawer img, #toasts img")).length === 0, "an <img> was rendered from data");
  });

  await step("S2.25", "390 px wide and dark mode: no horizontal scroll", async () => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.emulateMedia({ colorScheme: "dark" });
    const bad = [];
    for (const v of ["agenda", "timeline", "journal", "settings"]) {
      await page.goto(`http://127.0.0.1:${port}/#/${v}`).catch(() => {});
      await page.waitForTimeout(600);
      const w = await page.evaluate(() => document.scrollingElement.scrollWidth);
      if (w > 390) bad.push(`${v} ${w}px`);
      await page.screenshot({ path: shot(`narrow-dark-${v}`) });
    }
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.emulateMedia({ colorScheme: "light" });
    expect(bad.length === 0, `horizontal scroll: ${bad.join(", ")}`);
  });

  await step("S3.8", "the page with the macos token: Apps hidden, Settings visible", async () => {
    const p = await newPage(`http://127.0.0.1:${port}/#token=${mac.token}`);
    await p.waitForSelector("#view .row, #view .empty", { timeout: 15_000 });
    await p.waitForTimeout(800);
    expect(await p.isHidden("#apps-btn"), "the Apps button is shown");
    expect(await p.isVisible("#nav-settings"), "Settings is hidden");
    await p.close();
  });

  await step("S14.1", "Grid region card under --region FR: source Flag, the override named, Save off", async () => {
    await page.goto(`http://127.0.0.1:${port}/#/settings`).catch(() => {});
    await page.waitForSelector(".region-card #region-select", { timeout: 10_000 });
    const text = await page.textContent(".region-card");
    expect(/France/.test(text) && /Flag: tidegap ui --region/.test(text), `card: ${text.slice(0, 160)}`);
    expect(await page.isDisabled('.region-card [data-action="save"]'), "Save is enabled under --region");
    expect(await page.isDisabled("#region-select"), "the select is enabled under --region");
  });

  await step("S14.2", "Grid region card without --region, TZ Europe/Kyiv: PL + UA note; save DE in one step; unknown UA; Auto; 390 px dark", async () => {
    await stopUi(server);
    server = await startUi(empty, { region: null, env: { TZ: "Europe/Kyiv" } });
    api = apiAs(server.token);
    const p = await newPage(server.link);
    try {
      await p.waitForSelector("#view .empty, #view .empty-full, #view .day-clean, #view .row", { timeout: 15_000 });
      await p.goto(`http://127.0.0.1:${port}/#/settings`).catch(() => {});
      await p.waitForSelector(".region-card #region-select:not([disabled])", { timeout: 10_000 });
      const card = () => p.textContent(".region-card");
      let text = await card();
      expect(/Poland/.test(text) && /From time zone Europe\/(Kyiv|Kiev)/.test(text), `card: ${text.slice(0, 160)}`);
      expect(/No Ukrainian grid data yet/.test(await p.textContent('.region-card [role="note"]')), "no UA note");
      expect(await p.isDisabled('.region-card [data-action="save"]'), "Save is enabled with nothing to change");
      // One step: search, Save; the card shows the server's new resolution.
      await p.fill("#region-search", "germ");
      expect((await p.inputValue("#region-select")) === "DE", "the search did not select Germany");
      await p.click('.region-card [data-action="save"]');
      await waitFor(async () => /Set here/.test(await card()), 10_000, 200);
      text = await card();
      expect(/Germany/.test(text) && /Set here/.test(text), `after Save: ${text.slice(0, 160)}`);
      // The one Settings live region announces the save.
      const live = () => p.evaluate(() => [...document.querySelectorAll('.view-settings [role="status"]')].map((e) => e.textContent));
      expect(await waitFor(async () => (await live()).join("|") === "Region set to Germany (DE).", 5_000, 100), `live regions: ${JSON.stringify(await live())}`);
      const sum = await api("GET", "/api/summary");
      expect(sum.body.region === "DE" && sum.body.region_source === "setting", `summary ${sum.body.region}/${sum.body.region_source}`);
      // The page's own region text follows without a reload.
      await p.evaluate(() => (location.hash = "#/timeline"));
      const sub = () => p.evaluate(() => document.querySelector("#view .view-sub")?.textContent ?? "");
      expect(await waitFor(async () => /^DE /.test(await sub()), 8_000, 200), `timeline: ${await sub()}`);
      await p.evaluate(() => (location.hash = "#/settings"));
      await p.waitForSelector(".region-card #region-select:not([disabled])", { timeout: 10_000 });
      // An unknown zone: the server's sentence with its closest zones.
      await p.fill("#region-search", "UA");
      await p.press("#region-search", "Enter");
      const alert = await waitFor(async () => (await p.$(".region-card #region-error")) && p.textContent(".region-card #region-error"), 10_000, 200);
      expect(/Unknown zone UA\. Closest: PL/.test(alert ?? ""), `error: ${alert}`);
      const focused = await p.evaluate(() => document.activeElement?.id ?? "");
      expect(focused === "region-search", `focus after the error: ${focused || "body"}`);
      // Auto: back to the time-zone guess; a new search clears the error.
      await p.fill("#region-search", "");
      expect(!(await p.$(".region-card #region-error")), "the error stays after a new search");
      await p.selectOption("#region-select", "auto");
      await p.click('.region-card [data-action="save"]');
      await waitFor(async () => /From time zone/.test(await card()), 10_000, 200);
      expect(/Poland/.test(await card()), "Auto did not return to PL");
      // 390 px, dark: no horizontal scroll, controls at least 28 px high.
      await p.setViewportSize({ width: 390, height: 844 });
      await p.emulateMedia({ colorScheme: "dark" });
      await p.waitForTimeout(400);
      const { width, small } = await p.evaluate(() => ({
        width: document.scrollingElement.scrollWidth,
        small: [...document.querySelectorAll(".region-card input, .region-card select, .region-card button")].filter((e) => e.getBoundingClientRect().height < 28).length,
      }));
      await p.screenshot({ path: shot("region-390-dark"), fullPage: true });
      expect(width <= 390, `horizontal scroll: ${width}px`);
      expect(small === 0, `${small} control(s) under 28 px`);
    } finally {
      await p.close();
      await stopUi(server);
      server = await startUi(seed);
      api = apiAs(server.token);
    }
  });

  for (const [id, title] of [
    ["S2.15", "Reply with a client token (K1): form hidden, or Send works; never 'Reply failed: forbidden'"],
    ["S3.9", "Mac window: Journal → task → Conversation → Send (K1)"],
  ]) {
    await step(id, title, async () => {
      const p = await newPage(`http://127.0.0.1:${port}/#token=${mac.token}`);
      await p.waitForSelector("#view .row, #view .empty", { timeout: 15_000 });
      await p.goto(`http://127.0.0.1:${port}/#/task/${encodeURIComponent(done.task_id)}`).catch(() => {});
      await p.waitForSelector("#drawer .drawer-title", { timeout: 10_000 });
      await p.waitForTimeout(500);
      if ((await p.$$("#reply-input")).length === 0) return void (await p.close());
      await p.fill("#reply-input", `qa ${id}`);
      await p.click('[data-action="reply-send"]');
      const msg = await waitFor(async () => (await toasts(p)).find((t) => /Reply (queued|failed)/.test(t)), 10_000, 200);
      await p.screenshot({ path: shot(`${id}-reply`) });
      await p.close();
      expect(msg && !/forbidden/i.test(msg) && /queued/.test(msg), `toast: ${msg ?? "none"}`);
    });
  }

  await step("S2.4", "restart the server; the old tab shows one session-expired state, no toast loop", async () => {
    await stopUi(server);
    server = await startUi(seed);
    api = apiAs(server.token);
    await page.goto(`http://127.0.0.1:${port}/#/journal`).catch(() => {});
    await page.evaluate(() => window.dispatchEvent(new HashChangeEvent("hashchange")));
    const expired = await waitFor(() => page.evaluate(() => /This link expired/.test(document.body.textContent)), 15_000, 300);
    await page.waitForTimeout(3_000);
    const n = (await toasts(page)).length;
    expect(expired, "no expired state in the old tab");
    expect(n <= 1, `${n} toasts in the old tab`);
  });

  await step("S2.24", "empty ledger: every view shows its empty message", async () => {
    await stopUi(server);
    server = await startUi(empty);
    const p = await newPage(server.link);
    const bad = [];
    for (const v of ["agenda", "timeline", "journal"]) {
      await p.goto(`http://127.0.0.1:${port}/#/${v}`).catch(() => {});
      const ok = await waitFor(() => p.evaluate(() => !!document.querySelector("#view .empty, #view .empty-full, #view .day-clean")), 8_000, 200);
      if (!ok) bad.push(v);
    }
    await p.close();
    expect(bad.length === 0, `no empty message: ${bad.join(", ")}`);
  });

  await step("S2.27", "no uncaught errors across the views and dialogs", () => {
    expect(pageErrors.length === 0, `${pageErrors.length} error(s): ${[...new Set(pageErrors)].slice(0, 3).join(" | ")}`);
  });
} catch (err) {
  await step("setup", "the browser run", () => {
    throw err;
  });
} finally {
  await browser.close().catch(() => {});
}

s.skip("S2.22", "part: refused, webhook, network and rate-limit errors are covered by auto:ui-integrations.test.ts; the bad-format error runs in S2.21");
await s.finish();
