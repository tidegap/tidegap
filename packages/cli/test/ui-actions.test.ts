/**
 * `tidegap ui` write API (ui v2, U8): POST hardening, every action against a
 * real ledger, the change stream, the series route and Start dispatcher.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { DEFAULT_MODEL_BY_PROVIDER, mockGridFeed, TaskStore, type GridFeed, type TaskRecord } from "@tidegap/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { startUiServer, type UiServer } from "../src/ui/server.js";

const TOKEN = "test-token-actions-0123456789";
const H = 3_600_000;
const spec = (prompt: string) =>
  JSON.stringify({ type: "provider_call", provider: "anthropic", model: "claude-sonnet-4-6", prompt });

function seed(dbPath: string): void {
  const store = new TaskStore({ dbPath });
  const now = Date.now();
  const base = (id: string, extra: Partial<TaskRecord<unknown>> = {}): TaskRecord<unknown> => ({
    taskId: id,
    status: "scheduled",
    enqueuedAt: new Date(now - 60_000).toISOString(),
    scheduledFor: new Date(now + H).toISOString(),
    deadline: new Date(now + 6 * H).toISOString(),
    region: "FR",
    bodyJson: spec(`Prompt line of ${id}\nsecond`),
    ...extra,
  });
  store.upsert(base("a"));
  store.upsert(base("b"));
  store.upsert(base("w", { seriesId: "w", repeat: "weekly", title: "Weekly limits" }));
  store.upsert(base("run", { status: "running" }));
  store.upsert(
    base("done", {
      status: "completed",
      completedAt: new Date(now - 1_000).toISOString(),
      result: { text: "the answer" },
      originCwd: "/work",
      originSessionId: "sess-12345678",
    }),
  );
  store.upsert(base("bad", { status: "failed", completedAt: new Date(now).toISOString(), error: "x" }));
  store.close();
}

describe("tidegap ui write API", () => {
  let dir: string;
  let dbPath: string;
  let ui: UiServer;
  let spawned: Array<{ argv: string[]; log: string }>;
  let alive: Set<number>;
  let feedCalls: number;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "tidegap-ui-actions-"));
    dbPath = join(dir, "queue.db");
    const assetDir = join(dir, "ui");
    mkdirSync(assetDir);
    writeFileSync(join(assetDir, "index.html"), "<!doctype html><title>tidegap</title>");
    seed(dbPath);
    spawned = [];
    alive = new Set();
    feedCalls = 0;
    const inner = mockGridFeed();
    const feed: GridFeed = {
      source: "mock",
      fetchForecast: (r, h) => {
        feedCalls++;
        return inner.fetchForecast(r, h);
      },
    };
    ui = await startUiServer({
      token: TOKEN,
      dbPath,
      assetDir,
      stateDir: dir,
      feed,
      defaultRegion: "FR",
      quota: () => ({}),
      daemonStatus: () => "not_installed",
      pollMs: 50,
      launcher: ["/usr/bin/node", "/opt/tidegap/dist/index.js"],
      logDir: join(dir, "logs"),
      spawn: (argv, log) => {
        spawned.push({ argv, log });
        const pid = 40_000 + spawned.length;
        alive.add(pid);
        return pid;
      },
      isAlive: (pid) => alive.has(pid),
    });
  });

  afterEach(async () => {
    await ui.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const post = (path: string, body?: unknown, headers: Record<string, string> = {}, token: string | null = TOKEN) =>
    fetch(`${ui.url.replace(/\/$/, "")}${path}`, {
      method: "POST",
      headers: {
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...(body !== undefined ? { "content-type": "application/json" } : {}),
        ...headers,
      },
      ...(body !== undefined ? { body: typeof body === "string" ? body : JSON.stringify(body) } : {}),
    });
  const get = (path: string) =>
    fetch(`${ui.url.replace(/\/$/, "")}${path}`, { headers: { authorization: `Bearer ${TOKEN}` } });
  const row = (id: string) => {
    const store = new TaskStore({ dbPath });
    try {
      return store.get(id);
    } finally {
      store.close();
    }
  };
  const raw = (path: string, headers: Record<string, string>, method = "POST", body = "") =>
    new Promise<number>((resolve, reject) => {
      const req = request({ host: "127.0.0.1", port: ui.port, path, method, headers }, (res) => {
        res.resume();
        resolve(res.statusCode ?? 0);
      });
      req.on("error", reject);
      req.end(body);
    });

  describe("POST hardening (KTD9)", () => {
    const routes = [
      ["/api/tasks/a/cancel", {}],
      ["/api/tasks/a/reschedule", { at: new Date(Date.now() + 9 * H).toISOString() }],
      ["/api/tasks/done/reply", { text: "hi" }],
      ["/api/tasks/a/run-now", undefined],
      ["/api/tasks/done/read", undefined],
      ["/api/dispatcher/start", undefined],
      ["/api/tasks", { prompt: "quick" }],
    ] as const;

    it("every POST without the token is 401", async () => {
      for (const [path, body] of routes) {
        expect((await post(path, body, {}, null)).status, path).toBe(401);
      }
    });

    it("every POST with a wrong Host or Origin is 403", async () => {
      for (const [path] of routes) {
        const auth = { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" };
        expect(await raw(path, { ...auth, host: `evil.example:${ui.port}` }, "POST", "{}"), path).toBe(403);
        expect(
          await raw(path, { ...auth, host: `127.0.0.1:${ui.port}`, origin: "https://evil.example" }, "POST", "{}"),
          path,
        ).toBe(403);
      }
    });

    it("body routes: text/plain 415, 70 KiB 413, unknown field 400, bad JSON 400", async () => {
      for (const path of ["/api/tasks/a/cancel", "/api/tasks/a/reschedule", "/api/tasks/done/reply", "/api/tasks"]) {
        expect((await post(path, "{}", { "content-type": "text/plain" })).status, path).toBe(415);
        expect((await post(path, { text: "x".repeat(70 * 1024) })).status, path).toBe(413);
        expect((await post(path, { nope: 1 })).status, path).toBe(400);
        expect((await post(path, "{not json")).status, path).toBe(400);
        expect((await post(path, "[1]")).status, path).toBe(400);
      }
      expect(row("a")?.status).toBe("scheduled");
    });

    it("body-less routes refuse a body (400); GET on a POST route is 405", async () => {
      expect((await post("/api/tasks/a/run-now", { x: 1 })).status).toBe(400);
      for (const path of ["/api/tasks/a/cancel", "/api/tasks/a/reschedule", "/api/tasks/a/run-now", "/api/tasks/done/reply", "/api/dispatcher/start"]) {
        expect((await get(path)).status, path).toBe(405);
      }
    });

    it("the v1 page's body-less mark-read with only the bearer header still returns 204", async () => {
      expect(await raw("/api/tasks/done/read", { authorization: `Bearer ${TOKEN}`, host: `127.0.0.1:${ui.port}` })).toBe(204);
    });

    it("never sets a cookie", async () => {
      const res = await post("/api/tasks/a/cancel", {});
      expect(res.headers.get("set-cookie")).toBeNull();
      expect(res.headers.get("access-control-allow-origin")).toBeNull();
    });
  });

  describe("actions", () => {
    it("cancel: 200 summary, then 409 on repeat; unknown task 404", async () => {
      const first = await post("/api/tasks/a/cancel", {});
      expect(first.status).toBe(200);
      expect(((await first.json()) as { status: string }).status).toBe("cancelled");
      const again = await post("/api/tasks/a/cancel", {});
      expect(again.status).toBe(409);
      expect(((await again.json()) as { error: string }).error).toMatch(/cancel: task a is cancelled/);
      expect((await post("/api/tasks/nope/cancel", {})).status).toBe(404);
    });

    it("cancel with series ends the series; a plain cancel skips and rolls", async () => {
      expect((await post("/api/tasks/w/cancel", { series: true })).status).toBe(200);
      expect(row("w")?.repeat).toBe("none");
      expect(row("w~2")).toBeUndefined();
    });

    it("run-now: 200, due now and expedited; the row stays scheduled (no dispatch here)", async () => {
      const res = await post("/api/tasks/a/run-now");
      expect(res.status).toBe(200);
      const r = row("a")!;
      expect(r.status).toBe("scheduled");
      expect(r.intensitySource).toBe("expedited");
      expect(Date.parse(r.scheduledFor!)).toBeLessThanOrEqual(Date.now());
      expect((await post("/api/tasks/run/run-now")).status).toBe(409);
    });

    it("reschedule by deadline, exact time and day bounds", async () => {
      const deadline = new Date(Date.now() + 30 * H).toISOString();
      expect((await post("/api/tasks/a/reschedule", { deadline })).status).toBe(200);
      expect(row("a")?.deadline).toBe(deadline);
      const at = new Date(Date.now() + 10 * H).toISOString();
      expect((await post("/api/tasks/b/reschedule", { at })).status).toBe(200);
      expect(row("b")?.scheduledFor).toBe(at);
      const dayStart = new Date(Date.now() + 26 * H);
      const dayEnd = new Date(dayStart.getTime() + 24 * H);
      const res = await post("/api/tasks/a/reschedule", {
        day_start: dayStart.toISOString(),
        day_end: dayEnd.toISOString(),
      });
      expect(res.status).toBe(200);
      const t = Date.parse(row("a")!.scheduledFor!);
      expect(t).toBeGreaterThanOrEqual(dayStart.getTime());
      expect(t).toBeLessThanOrEqual(dayEnd.getTime());
      expect((await post("/api/tasks/a/reschedule", { at, deadline })).status).toBe(400);
      expect((await post("/api/tasks/a/reschedule", { at: "tomorrow" })).status).toBe(400);
      expect(
        (await post("/api/tasks/a/reschedule", { day_start: dayStart.toISOString(), day_end: dayStart.toISOString() })).status,
      ).toBe(400);
      expect((await post("/api/tasks/run/reschedule", { at })).status).toBe(409);
    });

    it("reply: 201 child; the child appears in the parent's children; failed parent 409", async () => {
      const res = await post("/api/tasks/done/reply", { text: "and then?" });
      expect(res.status).toBe(201);
      const child = (await res.json()) as { task_id: string; parent_task_id: string };
      expect(child.parent_task_id).toBe("done");
      const detail = (await (await get("/api/tasks/done")).json()) as {
        children: Array<{ task_id: string }>;
        resume_command: string;
        actions: { reply: boolean };
      };
      expect(detail.children.map((c) => c.task_id)).toEqual([child.task_id]);
      expect(detail.resume_command).toBe("cd /work && claude --resume sess-12345678");
      expect(detail.actions.reply).toBe(true);
      const bad = await post("/api/tasks/bad/reply", { text: "again" });
      expect(bad.status).toBe(409);
      expect((await post("/api/tasks/done/reply", { text: "" })).status).toBe(400);
    });

    it("the server never dispatches: actions call no adapter and touch no receipt", async () => {
      await post("/api/tasks/a/run-now");
      await post("/api/tasks/b/cancel", {});
      const before = feedCalls;
      await new Promise((r) => setTimeout(r, 120));
      expect(feedCalls).toBe(before);
      expect(row("a")?.receipt).toBeUndefined();
      expect(row("a")?.status).toBe("scheduled");
    });

    it("an action pushes its id on the change stream", async () => {
      const res = await get("/api/events");
      const reader = res.body!.getReader();
      const decoder = new TextDecoder();
      let buf = "";
      while (!buf.includes("event: hello")) buf += decoder.decode((await reader.read()).value);
      await post("/api/tasks/a/cancel", {});
      const until = Date.now() + 3_000;
      while (!buf.includes('"a"') && Date.now() < until) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += decoder.decode(value);
      }
      await reader.cancel();
      expect(buf).toMatch(/event: tasks\ndata: \{"ids":\[[^\]]*"a"/);
    });
  });

  describe("quick add: POST /api/tasks (native clients KTD7)", () => {
    type Created = { task_id: string; status: string; deadline: string; provider: string; model: string };
    const add = async (body: unknown) => {
      const res = await post("/api/tasks", body);
      return { status: res.status, body: (await res.json()) as Created & { error?: string } };
    };

    it("{prompt}: 201, queued or scheduled, deadline 24 h ahead, anthropic and the default model", async () => {
      const before = Date.now();
      const { status, body } = await add({ prompt: "summarize X" });
      const after = Date.now();
      expect(status).toBe(201);
      expect(["queued", "scheduled"]).toContain(body.status);
      const deadline = Date.parse(body.deadline);
      expect(deadline).toBeGreaterThanOrEqual(before + 24 * H - 1_000);
      expect(deadline).toBeLessThanOrEqual(after + 24 * H + 1_000);
      expect(body.provider).toBe("anthropic");
      expect(body.model).toBe(DEFAULT_MODEL_BY_PROVIDER.anthropic);
      const stored = row(body.task_id)!;
      expect(JSON.parse(stored.bodyJson!)).toMatchObject({ type: "provider_call", prompt: "summarize X" });
    });

    it("a given deadline, title, provider and model are stored", async () => {
      const deadline = new Date(Date.now() + 6 * H).toISOString();
      const { status, body } = await add({ prompt: "p", deadline, title: "Six hours", provider: "openai", model: "gpt-x" });
      expect(status).toBe(201);
      expect(body.deadline).toBe(deadline);
      expect(row(body.task_id)).toMatchObject({ title: "Six hours", deadline });
      expect(body).toMatchObject({ provider: "openai", model: "gpt-x" });
    });

    it("provider claude-code with no model stores the claude-code default", async () => {
      const { status, body } = await add({ prompt: "p", provider: "claude-code" });
      expect(status).toBe(201);
      expect(body).toMatchObject({ provider: "claude-code", model: "default" });
      expect(JSON.parse(row(body.task_id)!.bodyJson!)).toMatchObject({ provider: "claude-code", model: "default" });
    });

    it("stores a tools list from the allowlist and refuses anything else with 400", async () => {
      const ok = await add({ prompt: "p", provider: "claude-code", tools: ["WebSearch", "WebFetch"] });
      expect(ok.status).toBe(201);
      expect(JSON.parse(row(ok.body.task_id)!.bodyJson!)).toMatchObject({ tools: ["WebSearch", "WebFetch"] });
      const none = await add({ prompt: "p", provider: "claude-code", tools: [] });
      expect(JSON.parse(row(none.body.task_id)!.bodyJson!)).toMatchObject({ tools: [] });
      for (const tools of [["Bash"], ["Write"], "WebSearch", [1]]) {
        const { status, body } = await add({ prompt: "p", provider: "claude-code", tools });
        expect(status).toBe(400);
        expect(body.error).toContain("WebSearch, WebFetch, Read, Grep, Glob");
      }
      const mixed = await add({ prompt: "p", provider: "claude-code", tools: ["WebFetch", "Read"] });
      expect(mixed.status).toBe(400);
      expect(mixed.body.error).toContain("cannot combine a file tool");
    });

    it("an unknown provider is refused with the list that includes claude-code", async () => {
      const { status, body } = await add({ prompt: "p", provider: "bogus" });
      expect(status).toBe(400);
      expect(body.error).toContain("claude-code");
    });

    it("refuses bad input with 400 and a one-line error", async () => {
      for (const bad of [
        {},
        { prompt: "" },
        { prompt: "   " },
        { prompt: "x".repeat(32_001) },
        { prompt: "p", deadline: new Date(Date.now() - H).toISOString() },
        { prompt: "p", deadline: "soon" },
        { prompt: "p", nope: 1 },
        { prompt: "p", provider: "acme" },
        { prompt: "p", title: "t".repeat(201) },
        { prompt: "p", model: "" },
      ]) {
        const { status, body } = await add(bad);
        expect([bad, status]).toEqual([bad, 400]);
        expect(body.error).toMatch(/^[^\n]+$/);
      }
    });

    it("the new task id shows up on the change stream", async () => {
      const res = await get("/api/events");
      const reader = res.body!.getReader();
      const decoder = new TextDecoder();
      let buf = "";
      while (!buf.includes("event: hello")) buf += decoder.decode((await reader.read()).value);
      const { body } = await add({ prompt: "streamed" });
      const until = Date.now() + 3_000;
      while (!buf.includes(body.task_id) && Date.now() < until) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += decoder.decode(value);
      }
      await reader.cancel();
      expect(buf).toContain(`"${body.task_id}"`);
    });

    it("never dispatches: the task stays pending with no receipt", async () => {
      const { body } = await add({ prompt: "wait for the tick" });
      await new Promise((r) => setTimeout(r, 120));
      const stored = row(body.task_id)!;
      expect(["queued", "scheduled"]).toContain(stored.status);
      expect(stored.receipt).toBeUndefined();
      expect(spawned).toEqual([]);
    });

    it("GET /api/tasks still lists, and the new task is in it", async () => {
      const { body } = await add({ prompt: "listed" });
      const list = (await (await get("/api/tasks")).json()) as { tasks: Array<{ task_id: string }> };
      expect(list.tasks.map((t) => t.task_id)).toContain(body.task_id);
    });
  });

  describe("connected apps: /api/clients (page token only)", () => {
    const asClient = (path: string, token: string, init: RequestInit = {}) =>
      fetch(`${ui.url.replace(/\/$/, "")}${path}`, { ...init, headers: { authorization: `Bearer ${token}`, ...(init.headers ?? {}) } });

    it("POST mints a token (201); GET lists the client without hash or token", async () => {
      const res = await post("/api/clients", { name: "Chrome", kind: "extension" });
      expect(res.status).toBe(201);
      const out = (await res.json()) as { client: { id: string; name: string; kind: string }; token: string };
      expect(out.token).toMatch(/^tgc_/);
      expect(out.client).toMatchObject({ name: "Chrome", kind: "extension" });
      const text = await (await get("/api/clients")).text();
      expect(text).toContain(out.client.id);
      expect(text).not.toContain(out.token);
      expect(text).not.toContain("token_sha256");
      expect((await asClient("/api/tasks", out.token)).status).toBe(200);
    });

    it("the page's form sends only a name: kind defaults to extension; bad input is 400", async () => {
      const res = await post("/api/clients", { name: "Firefox" });
      expect(res.status).toBe(201);
      expect(((await res.json()) as { client: { kind: string } }).client.kind).toBe("extension");
      expect((await post("/api/clients", { name: "" })).status).toBe(400);
      expect((await post("/api/clients", { name: "x", kind: "phone" })).status).toBe(400);
      expect((await post("/api/clients", { name: "x", token: "mine" })).status).toBe(400);
    });

    it("the same routes with a client token are 403", async () => {
      const { token, client } = (await (await post("/api/clients", { name: "c" })).json()) as { token: string; client: { id: string } };
      expect((await asClient("/api/clients", token)).status).toBe(403);
      const json = { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "x" }) };
      expect((await asClient("/api/clients", token, json)).status).toBe(403);
      expect((await asClient(`/api/clients/${client.id}/revoke`, token, { method: "POST" })).status).toBe(403);
    });

    it("a broken registry is a fixed 500 with no path; bad input stays 400", async () => {
      writeFileSync(join(dir, "ui-clients.json"), "{ not json");
      const checks: Array<[Response, string]> = [
        [await get("/api/clients"), "client registry unavailable"],
        [await post("/api/clients", { name: "x" }), "could not add the client"],
        [await post("/api/clients/abc/revoke"), "could not revoke the client"],
      ];
      for (const [res, message] of checks) {
        expect(res.status).toBe(500);
        expect(await res.json()).toEqual({ error: message });
      }
      expect((await post("/api/clients", { name: "" })).status).toBe(400);
      expect((await post("/api/clients", { name: "x", kind: "phone" })).status).toBe(400);
    });

    it("revoke: unknown id 404; known id 200, and that client's next request is 401", async () => {
      expect((await post("/api/clients/nope/revoke")).status).toBe(404);
      const { token, client } = (await (await post("/api/clients", { name: "c" })).json()) as { token: string; client: { id: string } };
      expect((await post(`/api/clients/${client.id}/revoke`)).status).toBe(200);
      expect((await asClient("/api/tasks", token)).status).toBe(401);
      expect((await post(`/api/clients/${client.id}/revoke`, { x: 1 })).status).toBe(400);
    });
  });

  describe("reads (ui v2 fields)", () => {
    it("list gives display_title from the prompt, actions, and no prompt field", async () => {
      const text = await (await get("/api/tasks?status=scheduled")).text();
      expect(text).not.toContain('"prompt"');
      const body = JSON.parse(text) as { tasks: Array<Record<string, unknown>> };
      const a = body.tasks.find((t) => t.task_id === "a")!;
      expect(a.display_title).toBe("Prompt line of a");
      expect(a.provider).toBe("anthropic");
      expect(a.model).toBe("claude-sonnet-4-6");
      expect(a.actions).toMatchObject({ cancel: true, reschedule: true, runNow: true, reply: false });
    });

    it("list accepts series= and limit=", async () => {
      await post("/api/tasks/w/cancel", {});
      const s = (await (await get("/api/tasks?series=w")).json()) as { tasks: Array<{ task_id: string }> };
      expect(s.tasks.map((t) => t.task_id)).toEqual(["w", "w~2"]);
      const l = (await (await get("/api/tasks?limit=2")).json()) as { tasks: unknown[] };
      expect(l.tasks).toHaveLength(2);
      expect((await get("/api/tasks?limit=0")).status).toBe(400);
    });

    it("GET /api/series/:id returns the rule, occurrences and next deadlines", async () => {
      const body = (await (await get("/api/series/w")).json()) as {
        repeat: string;
        occurrences: Array<{ task_id: string }>;
        next_deadlines: string[];
      };
      expect(body.repeat).toBe("weekly");
      expect(body.occurrences.map((o) => o.task_id)).toEqual(["w"]);
      expect(body.next_deadlines).toHaveLength(8);
      expect(Date.parse(body.next_deadlines[1]!) - Date.parse(body.next_deadlines[0]!)).toBe(7 * 24 * H);
      expect((await get("/api/series/none")).status).toBe(404);
    });
  });

  describe("Start dispatcher (KTD13)", () => {
    it("never ran: state never; start spawns the same binary detached, 201; second start 409", async () => {
      let status = (await (await get("/api/status")).json()) as { dispatcher: { state: string; ui_child: unknown } };
      expect(status.dispatcher.state).toBe("never");
      expect(status.dispatcher.ui_child).toBeNull();
      const res = await post("/api/dispatcher/start");
      expect(res.status).toBe(201);
      const meta = (await res.json()) as { pid: number; log: string; started_at: string };
      expect(meta.log).toBe(join(dir, "logs", "ui-tick.log"));
      expect(spawned[0]!.argv).toEqual([
        "/usr/bin/node",
        "/opt/tidegap/dist/index.js",
        "tick",
        "--daemon",
        "--interval",
        "60",
        "--db",
        dbPath,
      ]);
      expect((await post("/api/dispatcher/start")).status).toBe(409);
      status = (await (await get("/api/status")).json()) as typeof status;
      expect(status.dispatcher.state).toBe("running");
      expect(status.dispatcher.ui_child).toMatchObject({ pid: meta.pid, alive: true });
      // Once that child is gone, a new start is allowed.
      alive.delete(meta.pid);
      expect((await post("/api/dispatcher/start")).status).toBe(201);
    });

    it("another ticker ticked recently: start is refused (409) and nothing is spawned", async () => {
      const store = new TaskStore({ dbPath });
      store.setMeta("last_tick_at", new Date(Date.now() - 30_000).toISOString());
      store.close();
      const res = await post("/api/dispatcher/start");
      expect(res.status).toBe(409);
      expect(((await res.json()) as { error: string }).error).toMatch(/already ticking/);
      expect(spawned).toHaveLength(0);
    });

    it("a recycled pid (alive, but no recent start or tick) does not block start", async () => {
      const store = new TaskStore({ dbPath });
      store.setMeta(
        "ui_dispatcher",
        JSON.stringify({ pid: 777, log: "/x.log", started_at: new Date(Date.now() - 3 * H).toISOString() }),
      );
      store.setMeta("last_tick_at", new Date(Date.now() - 3 * H).toISOString());
      store.close();
      alive.add(777);
      const status = (await (await get("/api/status")).json()) as {
        dispatcher: { state: string; ui_child: { alive: boolean } };
      };
      expect(status.dispatcher.ui_child.alive).toBe(false);
      expect(status.dispatcher.state).toBe("stale");
      expect((await post("/api/dispatcher/start")).status).toBe(201);
    });

    it("a stale last tick and no child gives stale", async () => {
      const store = new TaskStore({ dbPath });
      store.setMeta("last_tick_at", new Date(Date.now() - 3 * H).toISOString());
      store.close();
      const status = (await (await get("/api/status")).json()) as {
        dispatcher: { state: string; interval_s: number };
      };
      expect(status.dispatcher.state).toBe("stale");
      expect(status.dispatcher.interval_s).toBe(60);
    });
  });
});

describe("tidegap ui quick add default model", () => {
  it("uses TIDEGAP_DEFAULT_MODEL for an Anthropic task", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tidegap-ui-model-"));
    const prior = process.env.TIDEGAP_DEFAULT_MODEL;
    process.env.TIDEGAP_DEFAULT_MODEL = "claude-env-model";
    const { startUi } = await import("../src/commands/ui.js");
    const { server, link } = await startUi({ db: join(dir, "queue.db"), stateDir: dir, port: 0, region: "FR" });
    try {
      const token = link.split("#token=")[1]!;
      const res = await fetch(`${server.url}api/tasks`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({ prompt: "which model?" }),
      });
      expect(res.status).toBe(201);
      expect(((await res.json()) as { model: string }).model).toBe("claude-env-model");
    } finally {
      await server.close();
      if (prior === undefined) delete process.env.TIDEGAP_DEFAULT_MODEL;
      else process.env.TIDEGAP_DEFAULT_MODEL = prior;
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
