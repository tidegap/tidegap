process.env.TZ = "UTC";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { after, before, describe, it } from "node:test";
import { NO_TOKEN_MESSAGE, OFFLINE_MESSAGE, UNPAIRED_MESSAGE, api } from "../src/lib/api.js";
import { CONFIRM, EMPTY_TEXT, doneLine, headerLine, limitsLine, readinessLine, rowButtons, rowsFrom, statusFor } from "../src/popup/model.js";
import { laterOptions, startFakeServer, task } from "./fake-server.js";

const NOW = Date.parse("2026-10-17T09:00:00.000Z");
const html = readFileSync(new URL("../src/popup/popup.html", import.meta.url), "utf8");
const NOT_READY = { ready: false, line: "Tasks will not run: no tick daemon. Run `tidegap install`.", problems: [{ code: "no_daemon" }] };

describe("popup model", () => {
  it("maps a list answer to rows in scheduled_for order, titles as text", () => {
    const body = {
      tasks: [
        { task_id: "c", display_title: "Later", status: "scheduled", scheduled_for: "2026-10-18T14:00:00.000Z" },
        { task_id: "a", display_title: "<i>Soon</i>", status: "queued", scheduled_for: "2026-10-17T11:00:00.000Z" },
        { task_id: "b", display_title: "Busy", status: "running", scheduled_for: null },
      ],
    };
    assert.deepEqual(
      rowsFrom(body, NOW).map(({ id, title, status, when }) => ({ id, title, status, when })),
      [
        { id: "a", title: "<i>Soon</i>", status: "queued", when: "11:00" },
        { id: "c", title: "Later", status: "scheduled", when: "Sun 14:00" },
        { id: "b", title: "Busy", status: "running", when: "running" },
      ],
    );
  });

  it("a row with actions.runNow false renders Run now disabled", () => {
    const [row] = rowsFrom({ tasks: [task("t", { actions: { cancel: true, runNow: false, later: true } })] }, NOW);
    assert.deepEqual(rowButtons(row), [
      { action: "later", label: "Later", disabled: false },
      { action: "cancel", label: "Cancel", disabled: false },
      { action: "runNow", label: "Run now", disabled: true },
    ]);
  });

  it("Later lists the presets with their local times; an unavailable one carries its reason", () => {
    const [row] = rowsFrom({ tasks: [task("t")] }, NOW);
    assert.deepEqual(row.later, [
      { preset: "1h", label: "One hour later", when: "15:00", available: true, reason: "" },
      { preset: "tonight", label: "Tonight", when: "22:00", available: true, reason: "" },
      { preset: "tomorrow_morning", label: "Tomorrow morning", when: "Sun 09:00", available: true, reason: "" },
      { preset: "after_limit_reset", label: "After limit reset", when: "", available: false, reason: "needs the reset time" },
    ]);
  });

  it("a 0.19.0 item without later_options gets no Later button", () => {
    const [row] = rowsFrom({ tasks: [{ ...task("t"), later_options: undefined }] }, NOW);
    assert.equal(row.later, null);
    assert.deepEqual(rowButtons(row).map((b) => b.action), ["cancel", "runNow"]);
  });

  it("Cancel and Run now ask for confirmation", () => {
    assert.equal(CONFIRM.cancel.question, "Cancel this task?");
    assert.equal(CONFIRM.runNow.question, "Run this task on the next tick?");
    assert.equal(CONFIRM.later, undefined);
  });

  it("each action reports one line", () => {
    assert.equal(doneLine("later", { scheduled_for: "2026-10-17T22:00:00.000Z" }, NOW), "Moved to 22:00.");
    assert.equal(doneLine("cancel", {}, NOW), "Cancelled.");
    assert.equal(doneLine("runNow", {}, NOW), "Runs on the next tick.");
  });

  it("readiness not ready gives the line; ready or absent gives nothing", () => {
    assert.equal(readinessLine({ readiness: NOT_READY }), NOT_READY.line);
    assert.equal(readinessLine({ readiness: { ready: true, line: null, problems: [] } }), null);
    assert.equal(readinessLine({}), null);
  });

  it("the popup has no quick add, a readiness line and the empty text", () => {
    assert.doesNotMatch(html, /<form|<textarea|id="(add|prompt|preset|add-btn|add-msg)"|Queue a task/);
    assert.match(html, /id="readiness"[^>]*hidden/);
    assert.match(html, /id="limits"[^>]*hidden/);
    assert.ok(html.includes(`<p id="empty" class="muted" hidden>${EMPTY_TEXT}</p>`));
    assert.equal(EMPTY_TEXT, "No tasks queued. Ask your agent to schedule one.");
    assert.equal(typeof api.addTask, "undefined");
  });

  it("a 400 shows the server's message", () => {
    assert.deepEqual(statusFor({ state: "error", status: 400, message: "deadline must be in the future" }), { kind: "error", text: "deadline must be in the future", options: false });
  });

  it("each status maps to its message", () => {
    assert.deepEqual(statusFor({ state: "unpaired", message: UNPAIRED_MESSAGE }), { kind: "unpaired", text: UNPAIRED_MESSAGE, options: true });
    assert.match(statusFor({ state: "unpaired", message: NO_TOKEN_MESSAGE }).text, /not paired/i);
    assert.match(statusFor({ state: "unpaired", message: UNPAIRED_MESSAGE }).text, /not paired.*revoked, or tidegap is older than 0\.19/i);
    assert.deepEqual(statusFor({ state: "offline", message: OFFLINE_MESSAGE }), { kind: "offline", text: OFFLINE_MESSAGE, options: false });
    assert.match(OFFLINE_MESSAGE, /run `tidegap ui`/i);
  });

  it("the header line shows the clean window", () => {
    assert.equal(headerLine({ region: "FR", clean_window: { start: "2026-10-17T14:00:00.000Z", end: "2026-10-17T17:00:00.000Z", now: false, fallback: false } }), "clean 14:00-17:00 FR");
    assert.equal(headerLine({ clean_window: null, forecast_ok: false }), "Forecast unavailable");
  });
});

describe("popup model against a fake tidegap ui", () => {
  let fake;
  before(async () => {
    fake = await startFakeServer({ tasks: [task("t1"), task("t2", { later_options: laterOptions(false) })], readiness: NOT_READY });
  });
  after(() => fake.close());

  it("a summary without limits gives no limit line", async () => {
    const r = await api.summary(fake.settings);
    assert.equal(r.body.limits, undefined);
    assert.equal(limitsLine(r.body), null);
  });

  it("the summary's readiness becomes the popup line", async () => {
    const r = await api.summary(fake.settings);
    assert.equal(readinessLine(r.body), NOT_READY.line);
  });

  it("Later on an available preset moves the row; the list shows the new time", async () => {
    const r = await api.postpone(fake.settings, "t1", { preset: "1h" });
    assert.equal(doneLine("later", r.body, NOW), "Moved to 15:00.");
    const rows = rowsFrom((await api.activeTasks(fake.settings)).body, NOW);
    assert.equal(rows.find((x) => x.id === "t1").when, "15:00");
  });

  it("an empty task list renders the empty text (no rows)", async () => {
    const empty = await startFakeServer({ tasks: [] });
    try {
      assert.deepEqual(rowsFrom((await api.activeTasks(empty.settings)).body, NOW), []);
    } finally {
      await empty.close();
    }
  });
});

describe("popup against a server with limit state", () => {
  const LIMITS = { line: "Claude 5h: 72%, resets 16:30", status: "ok", window: "five_hour", pct: 72, resets_at: "2026-10-17T16:30:00.000Z" };
  const resetOptions = () =>
    laterOptions().map((o) =>
      o.preset === "after_limit_reset" ? { preset: o.preset, label: o.label, not_before: "2026-10-17T16:35:00.000Z", available: true } : o,
    );
  let fake;
  before(async () => {
    fake = await startFakeServer({ tasks: [task("t1", { later_options: resetOptions() })], limits: LIMITS });
  });
  after(() => fake.close());

  it("the summary's limit line becomes the popup line", async () => {
    const r = await api.summary(fake.settings);
    assert.equal(limitsLine(r.body), "Claude 5h: 72%, resets 16:30");
  });

  it("After limit reset is enabled with its time when the server marks it available, and moves the row", async () => {
    const list = await api.activeTasks(fake.settings);
    const reset = rowsFrom(list.body, NOW)[0].later.find((o) => o.preset === "after_limit_reset");
    assert.deepEqual(reset, { preset: "after_limit_reset", label: "After limit reset", when: "16:35", available: true, reason: "" });
    const r = await api.postpone(fake.settings, "t1", { preset: "after_limit_reset" });
    assert.equal(r.state, "ok");
  });
});
