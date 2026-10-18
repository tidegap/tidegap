/**
 * Task events on the CLI surfaces: `tidegap queue show`, `GET /api/tasks/<id>`
 * (events[] capped at 50), the actor of page and client-token writes, the
 * CLI actor, and the page's event line.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { mockGridFeed, TaskStore, type TaskRecord } from "@tidegap/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { runQueueRunNow, runQueueShow } from "../src/commands/queue.js";
import { ClientRegistry } from "../src/ui/clients.js";
import { startUiServer, type UiServer } from "../src/ui/server.js";
// @ts-expect-error plain ES module of the page, no types
import { eventLine } from "../ui/dom.js";

const TOKEN = "test-token-events-0123456789";
const H = 3_600_000;

function seed(dbPath: string, id: string, extra: Partial<TaskRecord<unknown>> = {}): void {
  const store = new TaskStore({ dbPath });
  const now = Date.now();
  store.upsert(
    {
      taskId: id,
      status: "scheduled",
      enqueuedAt: new Date(now - 60_000).toISOString(),
      scheduledFor: new Date(now + H).toISOString(),
      deadline: new Date(now + 6 * H).toISOString(),
      region: "FR",
      bodyJson: JSON.stringify({ type: "provider_call", provider: "anthropic", model: "claude-sonnet-4-6", prompt: "p" }),
      ...extra,
    },
    { kind: "created", actor: "cli" },
  );
  store.close();
}

describe("task events surfaces", () => {
  let dir: string;
  let dbPath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "tidegap-events-cli-"));
    dbPath = join(dir, "queue.db");
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("queue run-now records actor cli; queue show prints Events newest last and --json adds events", async () => {
    const notBefore = new Date(Date.now() + 3 * H).toISOString();
    seed(dbPath, "t1", { notBefore });
    await runQueueRunNow("t1", { db: dbPath, feed: mockGridFeed() });
    const { rendered } = await runQueueShow("t1", { db: dbPath, config: join(dir, "none") });
    const lines = rendered.split("\n");
    const at = lines.indexOf("Events:");
    expect(at).toBeGreaterThan(-1);
    expect(lines[at + 1]).toMatch(/ created by cli/);
    expect(lines[at + 2]).toMatch(new RegExp(` expedited by cli - not_before was ${notBefore.replace(/\./g, "\\.")}`));
    const json = JSON.parse((await runQueueShow("t1", { db: dbPath, json: true, config: join(dir, "none") })).rendered);
    expect(json.events.map((e: { kind: string }) => e.kind)).toEqual(["created", "expedited"]);
    expect(json.events[1]).toMatchObject({ actor: "cli", details: { from: { not_before: notBefore } } });
  });

  describe("ui API", () => {
    let ui: UiServer;
    let clientToken: string;

    beforeEach(async () => {
      const assetDir = join(dir, "ui");
      mkdirSync(assetDir);
      writeFileSync(join(assetDir, "index.html"), "<!doctype html><title>tidegap</title>");
      seed(dbPath, "a");
      seed(dbPath, "b");
      clientToken = new ClientRegistry(dir).add({ name: "Mac menu", kind: "macos" }).token;
      ui = await startUiServer({
        token: TOKEN,
        dbPath,
        assetDir,
        stateDir: dir,
        feed: mockGridFeed(),
        defaultRegion: "FR",
        quota: () => ({}),
        daemonStatus: () => "not_installed",
        pollMs: 50,
        launcher: ["/usr/bin/node", "/opt/tidegap/dist/index.js"],
        logDir: join(dir, "logs"),
        spawn: () => 1,
        isAlive: () => false,
      });
    });
    afterEach(async () => {
      await ui.close();
    });

    const call = (path: string, token: string, method = "GET") =>
      fetch(`${ui.url.replace(/\/$/, "")}${path}`, { method, headers: { authorization: `Bearer ${token}` } });

    it("records page and client:<name> as the actor and returns events[] in the detail", async () => {
      expect((await call("/api/tasks/a/run-now", TOKEN, "POST")).status).toBe(200);
      expect((await call("/api/tasks/b/run-now", clientToken, "POST")).status).toBe(200);
      const a = await (await call("/api/tasks/a", TOKEN)).json();
      const b = await (await call("/api/tasks/b", TOKEN)).json();
      expect(a.events.map((e: { kind: string; actor: string }) => [e.kind, e.actor])).toEqual([
        ["created", "cli"],
        ["expedited", "page"],
      ]);
      expect(b.events.at(-1)).toMatchObject({ kind: "expedited", actor: "client:Mac menu" });
      expect(Object.keys(a.events[1]).sort()).toEqual(["actor", "at", "details", "kind"]);
    });

    it("caps events[] at the newest 50, oldest first", async () => {
      const store = new TaskStore({ dbPath });
      for (let i = 0; i < 60; i++) store.recordEvent("a", { kind: "replied", actor: "page", details: { child_task_id: `c${i}` } });
      store.close();
      const a = await (await call("/api/tasks/a", TOKEN)).json();
      expect(a.events).toHaveLength(50);
      expect(a.events[0].details.child_task_id).toBe("c10");
      expect(a.events.at(-1).details.child_task_id).toBe("c59");
    });
  });

  it("the page renders an event as one text line", () => {
    const line = eventLine(
      {
        at: "2026-10-17T10:00:00.000Z",
        kind: "expedited",
        actor: "page",
        details: { from: { not_before: "2026-10-18T09:00:00.000Z", scheduled_for: null }, to: { not_before: null } },
      },
      (iso: string) => `[${iso.slice(11, 16)}]`,
    );
    expect(line).toBe("[10:00] expedited by page - not before was [09:00]");
    expect(eventLine({ at: "x", kind: "failed", actor: "tick", details: { error: "boom" } })).toBe("x failed by tick - boom");
    expect(eventLine({ at: "x", kind: "dispatched", actor: "tick", details: { provider: "anthropic", model: "claude-sonnet-4-6" } })).toBe(
      "x dispatched by tick - anthropic · sonnet-4-6",
    );
  });
});
