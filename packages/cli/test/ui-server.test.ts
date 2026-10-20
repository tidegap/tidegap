import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { mockGridFeed, TaskStore, type TaskRecord } from "@tidegap/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { daemonStatus } from "../src/platform/index.js";
import { FORECAST_CACHE_MS, handleApi, type ApiContext } from "../src/ui/api.js";
import { ClientRegistry } from "../src/ui/clients.js";
import { TaskEvents } from "../src/ui/events.js";
import {
  classifyOrigin,
  isLoopbackHost,
  startUiServer,
  STATIC_FILES,
  UI_MODULES,
  type UiServer,
} from "../src/ui/server.js";

const TOKEN = "test-token-0123456789";

function seed(dbPath: string): void {
  const store = new TaskStore({ dbPath });
  const now = Date.now();
  const base = (id: string, extra: Partial<TaskRecord<unknown>>): TaskRecord<unknown> => ({
    taskId: id,
    status: "scheduled",
    enqueuedAt: new Date(now - 60_000).toISOString(),
    scheduledFor: new Date(now + 3_600_000).toISOString(),
    region: "FR",
    title: `title ${id}`,
    bodyJson: JSON.stringify({ type: "provider_call", provider: "anthropic", model: "m", prompt: `prompt of ${id}` }),
    ...extra,
  });
  store.upsert(base("sched-abs", { deadline: new Date(now + 7_200_000).toISOString() }));
  store.upsert(
    base("sched-quota", {
      deadline: new Date(now + 86_400_000).toISOString(),
      deadlineKind: "quota_reset",
      quotaProvider: "claude",
    }),
  );
  store.upsert(
    base("done-1", {
      status: "completed",
      completedAt: new Date(now - 1_000).toISOString(),
      result: { text: "the answer", raw: { id: "msg_1" } },
      receipt: { taskId: "done-1", actualCarbonGCo2: 1.2 } as never,
    }),
  );
  store.close();
}

describe("tidegap ui server", () => {
  let dir: string;
  let dbPath: string;
  let assetDir: string;
  let ui: UiServer;
  let probe: ReturnType<typeof daemonStatus>;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "tidegap-ui-"));
    dbPath = join(dir, "queue.db");
    assetDir = join(dir, "ui");
    mkdirSync(assetDir);
    writeFileSync(join(assetDir, "index.html"), "<!doctype html><title>tidegap</title>");
    writeFileSync(join(dir, "package.json"), "{}");
    seed(dbPath);
    probe = "not_installed";
    ui = await startUiServer({
      token: TOKEN,
      dbPath,
      assetDir,
      stateDir: dir,
      feed: mockGridFeed(),
      defaultRegion: "FR",
      quota: () => ({}),
      daemonStatus: () => probe,
      pollMs: 50,
    });
  });

  afterEach(async () => {
    await ui.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const api = (path: string, init: RequestInit = {}, token: string | null = TOKEN) =>
    fetch(`${ui.url.replace(/\/$/, "")}${path}`, {
      ...init,
      headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(init.headers ?? {}) },
    });

  it("binds 127.0.0.1 only", () => {
    expect(ui.address).toBe("127.0.0.1");
  });

  it("requires the bearer token on the API (AE6)", async () => {
    expect((await api("/api/tasks", {}, null)).status).toBe(401);
    expect((await api("/api/tasks", {}, "wrong")).status).toBe(401);
    expect((await api("/api/events", {}, null)).status).toBe(401);
    expect((await api("/api/tasks")).status).toBe(200);
  });

  const raw = (path: string, headers: Record<string, string>, method = "GET") =>
    new Promise<number>((resolve, reject) => {
      const req = request({ host: "127.0.0.1", port: ui.port, path, method, headers }, (res) => {
        res.resume();
        resolve(res.statusCode ?? 0);
      });
      req.on("error", reject);
      req.end();
    });

  it("accepts only loopback Host headers and refuses foreign ones (DNS rebinding, AE6)", async () => {
    const auth = { authorization: `Bearer ${TOKEN}` };
    for (const host of [`127.0.0.1:${ui.port}`, `localhost:${ui.port}`, `[::1]:${ui.port}`, "localhost", "127.0.0.1", "[::1]", `LOCALHOST:${ui.port}`]) {
      expect(await raw("/api/tasks", { ...auth, host }), host).toBe(200);
    }
    for (const host of [`evil.example:${ui.port}`, `localhost:${ui.port + 1}`, `127.0.0.1.evil.example:${ui.port}`, `localhost.:${ui.port}`, "127.0.0.2", `[::2]:${ui.port}`]) {
      expect(await raw("/api/tasks", { ...auth, host }), host).toBe(403);
    }
    // The page itself is guarded too, so a rebound page cannot read it.
    expect(await raw("/", { host: `evil.example:${ui.port}` })).toBe(403);
  });

  it("refuses a foreign Origin header", async () => {
    const base = { authorization: `Bearer ${TOKEN}`, host: `127.0.0.1:${ui.port}` };
    expect(await raw("/api/tasks", { ...base, origin: `http://127.0.0.1:${ui.port}` })).toBe(200);
    expect(await raw("/api/tasks", { ...base, origin: `http://localhost:${ui.port}` })).toBe(200);
    expect(await raw("/api/tasks", { ...base, origin: "https://evil.example" })).toBe(403);
    expect(await raw("/api/tasks", { ...base, origin: "null" })).toBe(403);
    expect(await raw("/api/tasks/done-1/read", { ...base, origin: "https://evil.example" }, "POST")).toBe(403);
  });

  it("sends JSON with nosniff and no CORS headers", async () => {
    const res = await api("/api/tasks");
    expect(res.headers.get("content-type")).toMatch(/^application\/json/);
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("access-control-allow-origin")).toBeNull();
  });

  it("never changes read state on GET, and refuses POST on read-only routes", async () => {
    expect((await api("/api/tasks/done-1/read")).status).toBe(405);
    expect((await api("/api/tasks/done-1/unread")).status).toBe(405);
    const unread = (await (await api("/api/tasks?unread=1")).json()) as { tasks: unknown[] };
    expect(unread.tasks).toHaveLength(1);
    for (const path of ["/api/status", "/api/forecast", "/api/events", "/api/summary"]) {
      expect((await api(path, { method: "POST" })).status, path).toBe(405);
    }
    // POST /api/tasks is quick add: a body route, so a body-less POST lists nothing.
    expect((await api("/api/tasks", { method: "POST" })).status).toBe(415);
  });

  it("filters by kind and unread, and the list carries no prompt", async () => {
    const quota = (await (await api("/api/tasks?kind=quota_reset")).json()) as { tasks: Array<{ task_id: string }> };
    expect(quota.tasks.map((t) => t.task_id)).toEqual(["sched-quota"]);
    const unread = (await (await api("/api/tasks?unread=1")).json()) as { tasks: Array<{ task_id: string }> };
    expect(unread.tasks.map((t) => t.task_id)).toEqual(["done-1"]);
    const pending = await api("/api/tasks?status=queued,scheduled,submitted");
    const text = await pending.text();
    expect(text).not.toContain("prompt of");
    expect((JSON.parse(text) as { tasks: unknown[] }).tasks).toHaveLength(2);
    expect((await api("/api/tasks?status=bogus")).status).toBe(400);
  });

  it("returns detail with history, receipt and raw payload", async () => {
    const res = await api("/api/tasks/done-1");
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.prompt).toBe("prompt of done-1");
    expect(body.history).toEqual([
      { role: "user", content: "prompt of done-1" },
      { role: "assistant", content: "the answer" },
    ]);
    expect((body.receipt as { actualCarbonGCo2: number }).actualCarbonGCo2).toBe(1.2);
    expect(body.raw).toEqual({ id: "msg_1" });
    expect((await api("/api/tasks/nope")).status).toBe(404);
  });

  it("marks a finished task read (204) and refuses a scheduled one (409)", async () => {
    expect((await api("/api/tasks/done-1/read", { method: "POST" })).status).toBe(204);
    const store = new TaskStore({ dbPath });
    expect(store.get("done-1")!.readAt).toBeDefined();
    store.close();
    expect((await api("/api/tasks/sched-abs/read", { method: "POST" })).status).toBe(409);
    expect((await api("/api/tasks/done-1/unread", { method: "POST" })).status).toBe(204);
  });

  async function nextTasksEvent(trigger: () => void | Promise<void>): Promise<string> {
    const res = await api("/api/events");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    // Wait for the hello event, so the subscription exists before the change.
    while (!buf.includes("event: hello")) buf += decoder.decode((await reader.read()).value);
    await trigger();
    const deadline = Date.now() + 3_000;
    while (!buf.includes("event: tasks") && Date.now() < deadline) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value);
    }
    await reader.cancel();
    return buf;
  }

  it("streams a tasks event when another connection completes a task", async () => {
    const buf = await nextTasksEvent(() => {
      const other = new TaskStore({ dbPath });
      const rec = other.get("sched-abs")!;
      other.upsert({ ...rec, status: "completed", completedAt: new Date().toISOString(), result: { text: "x" } });
      other.close();
    });
    expect(buf).toMatch(/event: tasks\ndata: \{"ids":\["sched-abs"\]\}/);
  });

  it("streams a tasks event after its own mark-read", async () => {
    const buf = await nextTasksEvent(async () => {
      await api("/api/tasks/done-1/read", { method: "POST" });
    });
    expect(buf).toContain('"ids":["done-1"]');
  });

  it("reports daemon status, last tick and quota labels (AE7)", async () => {
    const body = (await (await api("/api/status")).json()) as Record<string, unknown>;
    expect(body.daemon).toBe("not_installed");
    expect(body).toHaveProperty("last_tick_at", null);
    expect(daemonStatus({ platform: "win32" })).toBe("unknown");
    expect(daemonStatus({ platform: "darwin", home: dir, exists: () => false })).toBe("not_installed");
    expect(daemonStatus({ platform: "linux", home: dir, exists: () => true })).toBe("installed");
  });

  it("serves a capped forecast", async () => {
    const body = (await (await api("/api/forecast?region=FR&hours=500")).json()) as { points: unknown[] };
    expect(body.points.length).toBeLessThanOrEqual(72);
    expect(body.points.length).toBeGreaterThan(0);
    expect((await api("/api/forecast?region=../x")).status).toBe(400);
  });

  it("serves only the fixed static map, with the CSP header", async () => {
    const page = await fetch(ui.url);
    expect(page.status).toBe(200);
    expect(page.headers.get("content-security-policy")).toContain("default-src 'self'");
    expect(page.headers.get("x-content-type-options")).toBe("nosniff");
    expect(page.headers.get("access-control-allow-origin")).toBeNull();
    for (const path of ["/..%2f..%2fpackage.json", "/%2e%2e/%2e%2e/package.json", "/package.json", "/src/index.ts"]) {
      const r = await new Promise<number>((resolve, reject) => {
        const req = request({ host: "127.0.0.1", port: ui.port, path }, (res) => {
          res.resume();
          resolve(res.statusCode ?? 0);
        });
        req.on("error", reject);
        req.end();
      });
      expect([path, r]).toEqual([path, 404]);
    }
  });
});

describe("tidegap ui token scopes and origins (native clients KTD3)", () => {
  let dir: string;
  let ui: UiServer;
  let registry: ClientRegistry;
  let clientToken: string;
  let clientId: string;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "tidegap-ui-scope-"));
    const assetDir = join(dir, "ui");
    mkdirSync(assetDir);
    writeFileSync(join(assetDir, "index.html"), "<!doctype html><title>tidegap</title>");
    writeFileSync(join(assetDir, "app.js"), "export {};");
    seed(join(dir, "queue.db"));
    registry = new ClientRegistry(dir);
    ({ token: clientToken, client: { id: clientId } } = registry.add({ name: "Chrome", kind: "extension" }));
    ui = await startUiServer({
      token: TOKEN,
      dbPath: join(dir, "queue.db"),
      assetDir,
      stateDir: dir,
      feed: mockGridFeed(),
      defaultRegion: "FR",
      quota: () => ({}),
      daemonStatus: () => "unknown",
      pollMs: 50,
      // No token saved, so no route below reaches Telegram.
      integrations: { envFile: join(dir, "env"), apiBase: "http://127.0.0.1:9", installListener: () => {}, secretsFile: join(dir, "channel-secrets.json") },
    });
  });

  afterEach(async () => {
    await ui.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const call = (path: string, token: string | null, origin?: string, method = "GET", extra: Record<string, string> = {}, body = "") =>
    new Promise<{ status: number; headers: Record<string, unknown> }>((resolve, reject) => {
      const headers: Record<string, string> = { host: `127.0.0.1:${ui.port}`, ...extra };
      if (token) headers.authorization = `Bearer ${token}`;
      if (origin !== undefined) headers.origin = origin;
      const req = request({ host: "127.0.0.1", port: ui.port, path, method, headers }, (res) => {
        res.resume();
        resolve({ status: res.statusCode ?? 0, headers: res.headers });
      });
      req.on("error", reject);
      req.end(body);
    });
  const status = async (...args: Parameters<typeof call>) => (await call(...args)).status;

  const EXT = ["chrome-extension://abcdefghijklmnop", "moz-extension://0f2c1e7a-3b4d-4c5e-8f9a-0b1c2d3e4f50", "safari-web-extension://E0B1C2D3-1111-2222-3333-444455556666"];

  it("matrix row: no Origin. page token all routes; client token all but /api/clients; none 401", async () => {
    expect(await status("/api/tasks", TOKEN)).toBe(200);
    expect(await status("/api/clients", TOKEN)).toBe(200);
    expect(await status("/api/tasks", clientToken)).toBe(200);
    expect(await status("/api/clients", clientToken)).toBe(403);
    expect(await status(`/api/clients/${clientId}/revoke`, clientToken, undefined, "POST")).toBe(403);
    expect(await status("/api/tasks", null)).toBe(401);
    expect(await status("/api/tasks", "tgc_bogus")).toBe(401);
  });

  it("matrix row: loopback Origin. same as no Origin", async () => {
    const o = `http://127.0.0.1:${ui.port}`;
    expect(await status("/api/tasks", TOKEN, o)).toBe(200);
    expect(await status("/api/clients", TOKEN, o)).toBe(200);
    expect(await status("/api/tasks", clientToken, o)).toBe(200);
    expect(await status("/api/clients", clientToken, o)).toBe(403);
    expect(await status("/api/tasks", null, o)).toBe(401);
  });

  it("matrix row: extension Origin. client token on /api/* (AE1); page token 403; none 401", async () => {
    for (const o of EXT) {
      expect([o, await status("/api/tasks", clientToken, o)]).toEqual([o, 200]);
      expect([o, await status("/api/tasks", TOKEN, o)]).toEqual([o, 403]);
      expect([o, await status("/api/clients", clientToken, o)]).toEqual([o, 403]);
      expect([o, await status("/api/tasks", null, o)]).toEqual([o, 401]);
    }
  });

  it("matrix row: foreign Origin (and null). 403 whatever the token (AE1)", async () => {
    for (const o of ["https://evil.example", "null", "http://evil.example", `http://localhost:${ui.port + 1}`]) {
      for (const t of [TOKEN, clientToken, null]) {
        expect([o, t, await status("/api/tasks", t, o)]).toEqual([o, t, 403]);
      }
    }
  });

  it("refuses a malformed extension origin", async () => {
    for (const o of ["chrome-extension://", "chrome-extension://abc/path", "chrome-extension://abc:1", "chrome-extensionx://abc", "file://abc"]) {
      expect([o, await status("/api/tasks", clientToken, o)]).toEqual([o, 403]);
    }
  });

  it("an extension Origin gets 403 on static files", async () => {
    for (const path of ["/", "/app.js"]) {
      expect([path, await status(path, null, EXT[0])]).toEqual([path, 403]);
      expect([path, await status(path, clientToken, EXT[0])]).toEqual([path, 403]);
    }
    expect(await status("/", null)).toBe(200);
  });

  it("a client token never creates a task: 403 on POST /api/tasks; the page token creates (R21)", async () => {
    const json = { "content-type": "application/json" };
    const add = JSON.stringify({ prompt: "from a client" });
    const { token: macToken } = registry.add({ name: "Mac", kind: "macos" });
    for (const token of [clientToken, macToken]) {
      for (const o of [undefined, EXT[0]]) {
        expect([o, await status("/api/tasks", token, o, "POST", json, add)]).toEqual([o, 403]);
        // Empty segments cannot slip past the check.
        expect([o, await status("/api//tasks", token, o, "POST", json, add)]).toEqual([o, 403]);
      }
    }
    const store = new TaskStore({ dbPath: join(dir, "queue.db") });
    const before = store.list().length;
    store.close();
    expect(await status("/api/tasks", TOKEN, undefined, "POST", json, add)).toBe(201);
    const after = new TaskStore({ dbPath: join(dir, "queue.db") });
    expect(after.list().length).toBe(before + 1);
    after.close();
  });

  it("reply: the page and a macos client token reply; an extension token or origin gets 403 (D1)", async () => {
    const json = { "content-type": "application/json" };
    const reply = JSON.stringify({ text: "and then?" });
    const { token: macToken } = registry.add({ name: "Mac", kind: "macos" });
    const loopback = `http://127.0.0.1:${ui.port}`;
    const paths = [
      "/api/tasks/done-1/reply",
      "/api/tasks/done-1//reply",
      "/api//tasks/done-1/reply",
      "/api/tasks/done-1/reply/",
      "/api/tasks/done-1/reply?x=1",
    ];
    for (const path of paths) {
      // An extension client token, from anywhere; a macos token or the page token from an extension origin.
      for (const o of [undefined, loopback, ...EXT]) {
        expect([path, o, await status(path, clientToken, o, "POST", json, reply)]).toEqual([path, o, 403]);
      }
      for (const o of EXT) {
        expect([path, o, await status(path, macToken, o, "POST", json, reply)]).toEqual([path, o, 403]);
        expect([path, o, await status(path, TOKEN, o, "POST", json, reply)]).toEqual([path, o, 403]);
      }
    }
    const store = new TaskStore({ dbPath: join(dir, "queue.db") });
    const before = store.list().length;
    store.close();
    // No Origin (a native fetch) and the loopback Origin (the Mac app's web view, the page).
    for (const o of [undefined, loopback]) {
      expect([o, await status("/api/tasks/done-1/reply", macToken, o, "POST", json, reply)]).toEqual([o, 201]);
      expect([o, await status("/api/tasks/done-1/reply", TOKEN, o, "POST", json, reply)]).toEqual([o, 201]);
    }
    const after = new TaskStore({ dbPath: join(dir, "queue.db") });
    expect(after.list().length).toBe(before + 4);
    after.close();
  });

  it("actions.reply follows the caller: true for the page and a macos token, false for an extension token (D1)", async () => {
    const { token: macToken } = registry.add({ name: "Mac", kind: "macos" });
    type Listed = { actions?: { reply: boolean }; tasks?: Array<{ task_id: string; actions: { reply: boolean } }> };
    const replyFlag = (path: string, token: string, origin?: string) =>
      new Promise<boolean>((resolve, reject) => {
        const headers: Record<string, string> = { host: `127.0.0.1:${ui.port}`, authorization: `Bearer ${token}` };
        if (origin !== undefined) headers.origin = origin;
        request({ host: "127.0.0.1", port: ui.port, path, headers }, (res) => {
          let text = "";
          res.setEncoding("utf8");
          res.on("data", (c: string) => (text += c));
          res.on("end", () => {
            const body = JSON.parse(text) as Listed;
            resolve(body.actions?.reply ?? body.tasks!.find((t) => t.task_id === "done-1")!.actions.reply);
          });
        })
          .on("error", reject)
          .end();
      });
    for (const path of ["/api/tasks/done-1", "/api/tasks"]) {
      expect([path, await replyFlag(path, TOKEN)]).toEqual([path, true]);
      expect([path, await replyFlag(path, macToken)]).toEqual([path, true]);
      expect([path, await replyFlag(path, clientToken, EXT[0])]).toEqual([path, false]);
      expect([path, await replyFlag(path, clientToken)]).toEqual([path, false]);
      // A macos token used from an extension origin cannot reply, so it sees false too.
      expect([path, await replyFlag(path, macToken, EXT[0])]).toEqual([path, false]);
    }
  });

  it("a client token reaches GET /api/tasks, /postpone, /cancel and /run-now (R22)", async () => {
    const json = { "content-type": "application/json" };
    expect(await status("/api/tasks?status=scheduled", clientToken, EXT[0])).toBe(200);
    expect(await status("/api/tasks/sched-abs/postpone", clientToken, EXT[0], "POST", json, '{"delay_minutes":30}')).toBe(200);
    expect(await status("/api/tasks/sched-abs/run-now", clientToken, EXT[0], "POST")).toBe(200);
    expect(await status("/api/tasks/sched-abs/cancel", clientToken, EXT[0], "POST", json, "{}")).toBe(200);
  });

  it("a client token revoked while the server runs gets 401 on the next request (AE2)", async () => {
    expect(await status("/api/tasks", clientToken, EXT[0])).toBe(200);
    new ClientRegistry(dir).revoke(clientId);
    expect(await status("/api/tasks", clientToken, EXT[0])).toBe(401);
  });

  it("an extension POST keeps the content-type rule (415) and no response has CORS headers", async () => {
    const res = await call("/api/tasks/done-1/cancel", clientToken, EXT[0], "POST", { "content-type": "text/plain" }, "{}");
    expect(res.status).toBe(415);
    for (const r of [res, await call("/api/tasks", clientToken, EXT[0]), await call("/api/tasks", TOKEN, EXT[0])]) {
      expect(Object.keys(r.headers).filter((h) => h.startsWith("access-control-"))).toEqual([]);
    }
  });

  it("the client token also opens the event stream", async () => {
    const res = await fetch(`${ui.url}api/events`, { headers: { authorization: `Bearer ${clientToken}` } });
    expect(res.status).toBe(200);
    await res.body!.cancel();
  });

  it("a client token gets 403 on /api/clients spelled with empty segments", async () => {
    const json = { "content-type": "application/json" };
    for (const o of [undefined, EXT[0]]) {
      for (const path of ["/api//clients", "/api/clients//", "/api//clients/", "/api///clients"]) {
        expect([path, o, await status(path, clientToken, o)]).toEqual([path, o, 403]);
        expect([path, o, await status(path, clientToken, o, "POST", json, '{"name":"evil"}')]).toEqual([path, o, 403]);
      }
      for (const path of [`/api//clients/${clientId}/revoke`, `/api/clients//${clientId}/revoke`, `/api/clients/${clientId}//revoke`]) {
        expect([path, o, await status(path, clientToken, o, "POST")]).toEqual([path, o, 403]);
      }
    }
    expect(new ClientRegistry(dir).list().map((c) => c.id)).toEqual([clientId]);
    expect(await status("/api//clients", TOKEN)).toBe(200);
  });

  it("covers AE4: /api/integrations answers the page and a macos client token, never an extension (KTD1)", async () => {
    const { token: macToken } = registry.add({ name: "Mac", kind: "macos" });
    const loopback = `http://127.0.0.1:${ui.port}`;
    expect(await status("/api/integrations", macToken)).toBe(200);
    expect(await status("/api/integrations", TOKEN)).toBe(200);
    expect(await status("/api/integrations", TOKEN, loopback)).toBe(200);
    expect(await status("/api/integrations", clientToken)).toBe(403);
    expect(await status("/api/integrations/telegram/pair", clientToken, undefined, "POST")).toBe(403);
    for (const path of ["/api/integrations/channels/connect", "/api/integrations/channels/webhook/test", "/api/integrations/channels/webhook/settings"]) {
      expect([path, await status(path, clientToken, undefined, "POST")]).toEqual([path, 403]);
      expect([path, await status(path, macToken, EXT[0], "POST")]).toEqual([path, 403]);
      expect([path, (await status(path, macToken, undefined, "POST")) !== 403]).toEqual([path, true]);
    }
    for (const o of EXT) {
      expect([o, await status("/api/integrations", clientToken, o)]).toEqual([o, 403]);
      expect([o, await status("/api/integrations", macToken, o)]).toEqual([o, 403]);
      expect([o, await status("/api/integrations", TOKEN, o)]).toEqual([o, 403]);
    }
    expect(await status("/api/integrations", TOKEN, "https://evil.example")).toBe(403);
    expect(await status("/api/integrations", null)).toBe(401);
    for (const path of ["/api//integrations", "/api/integrations//telegram/pair", "/api///integrations", "/api/integrations//channels/connect"]) {
      expect([path, await status(path, clientToken, undefined, "POST")]).toEqual([path, 403]);
      expect([path, await status(path, clientToken)]).toEqual([path, 403]);
    }
  });

  it("a revoked client token's open event stream ends", async () => {
    const res = await fetch(`${ui.url}api/events`, { headers: { authorization: `Bearer ${clientToken}` } });
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    while (!buf.includes("event: hello")) buf += decoder.decode((await reader.read()).value);
    ui.events.emit(["before"]);
    while (!buf.includes('"before"')) buf += decoder.decode((await reader.read()).value);
    new ClientRegistry(dir).revoke(clientId);
    ui.events.emit(["after"]);
    let done = false;
    const until = Date.now() + 3_000;
    while (!done && Date.now() < until) {
      const next = await reader.read();
      done = next.done;
      if (next.value) buf += decoder.decode(next.value);
    }
    expect(done).toBe(true);
    expect(buf).not.toContain('"after"');
    expect(await status("/api/events", clientToken)).toBe(401);
  });
});

describe("tidegap ui assets", () => {
  const dir = join(__dirname, "..", "ui");
  const read = (f: string) => readFileSync(join(dir, f), "utf8");

  it("index.html references only relative asset paths", () => {
    const html = read("index.html");
    const refs = [...html.matchAll(/(?:src|href)="([^"]+)"/g)].map((m) => m[1]!);
    expect(refs.length).toBeGreaterThan(0);
    for (const ref of refs) expect(ref).toMatch(/^(#|data:,$|[a-z]+\.(js|css)$)/);
    expect(html).not.toMatch(/https?:\/\//);
  });

  it("the header carries the generated brand mark as inline, style-free SVG", () => {
    const html = read("index.html");
    const block = /<!-- brand-mark:start -->([\s\S]*?)<!-- brand-mark:end -->/.exec(html)?.[1];
    expect(block).toBeDefined();
    expect(block).toMatch(/^<svg [^>]*aria-hidden="true"/);
    expect(block).not.toMatch(/style=|http/);
  });

  /**
   * `http(s)://` literals left after the allow-list (KTD8): the SVG namespace
   * (an identifier), links the user opens (`t.me`, the docs) and the vendored
   * QR file's licence header. Anything else would be a remote load.
   */
  const remoteLiterals = (js: string): string[] =>
    js
      .replaceAll("http://www.w3.org/2000/svg", "")
      .replace(/https:\/\/t\.me\/[A-Za-z0-9_]*/g, "")
      .replace(/https:\/\/www\.tidegap\.com\/docs(?:#[a-z0-9-]*)?/g, "")
      .replaceAll("https://www.nayuki.io/page/qr-code-generator-library", "")
      .match(/https?:\/\/\S*/g) ?? [];

  it("the remote-literal guard allows only its named prefixes", () => {
    expect(remoteLiterals('const a = "https://t.me/BotFather"; const b = "https://www.tidegap.com/docs#telegram-setup";')).toEqual([]);
    expect(remoteLiterals('fetch("https://evil.example/x")')).toEqual(['https://evil.example/x")']);
    expect(remoteLiterals('import "https://t.me.evil.example/x.js"')).not.toEqual([]);
  });

  it("no module loads anything remote or writes HTML from data", () => {
    for (const file of UI_MODULES) {
      const js = read(file);
      expect([file, remoteLiterals(js)]).toEqual([file, []]);
      expect([file, js]).not.toEqual([
        file,
        expect.stringMatching(/innerHTML|outerHTML|insertAdjacentHTML|document\.write|\beval\(|new Function|setAttribute\(["']style/),
      ]);
      // The token lives in module memory only: no browser storage, no cookie.
      expect([file, js]).not.toEqual([file, expect.stringMatching(/localStorage|sessionStorage|document\.cookie|indexedDB/)]);
    }
  });

  it("the page creates no task: no form posts to /api/tasks and the client has no create call (R20)", () => {
    expect(read("index.html")).not.toMatch(/<form|Queue a task/i);
    for (const file of UI_MODULES) {
      const js = read(file);
      expect([file, js]).not.toEqual([file, expect.stringMatching(/["'`]\/api\/tasks["'`]|Queue a task|quick ?add/i)]);
    }
    expect(read("api.js")).toMatch(/postpone: \(id, target\) => post\(tasksPath\(id, "postpone"\), target\)/);
  });

  it("the Later menu explains how to give a missing reset time (U9)", async () => {
    const { laterReason } = (await import(join(dir, "dialog.js"))) as {
      laterReason: (t: { task_id: string }, o: { preset: string; reason?: string }) => string;
    };
    const task = { task_id: "t-1" };
    expect(laterReason(task, { preset: "after_limit_reset", reason: "needs the reset time" })).toBe(
      "Tell your agent the reset time, or run `tidegap queue later t-1 --until after-limit-reset --reset-at HH:MM`",
    );
    expect(laterReason(task, { preset: "tonight", reason: "less than one hour of tonight is left" })).toBe(
      "less than one hour of tonight is left",
    );
  });

  it("every module import resolves to a served module", () => {
    for (const file of UI_MODULES) {
      for (const m of read(file).matchAll(/^import\s[^;]*?from\s+"([^"]+)";/gms)) {
        expect([file, m[1]]).toEqual([file, expect.stringMatching(/^\.\/[a-z]+\.js$/)]);
        expect(UI_MODULES).toContain(m[1]!.slice(2));
      }
    }
  });

  it("the static map and the ui directory list the same files", () => {
    const onDisk = readdirSync(dir).sort();
    const mapped = Object.values(STATIC_FILES).map((f) => f.file).sort();
    expect(mapped).toEqual(onDisk);
  });

  it("stylesheets load no web font or remote resource", () => {
    for (const file of ["tokens.css", "app.css"]) {
      expect([file, read(file)]).not.toEqual([file, expect.stringMatching(/@import|@font-face|url\(/)]);
    }
  });

  it("every carbon band label pair meets WCAG AA (4.5:1) in light and dark", () => {
    const css = read("tokens.css");
    const dark = css.slice(css.indexOf("@media (prefers-color-scheme: dark)"));
    const light = css.slice(0, css.indexOf("@media (prefers-color-scheme: dark)"));
    const lum = (hex: string) => {
      const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
      const [r, g, b] = c.map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
      return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
    };
    const ratio = (a: string, b: string) => {
      const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
      return (hi! + 0.05) / (lo! + 0.05);
    };
    const token = (block: string, name: string) => {
      const m = new RegExp(`--${name}:\\s*(#[0-9a-fA-F]{6});`).exec(block);
      if (!m) throw new Error(`token --${name} missing`);
      return m[1]!;
    };
    let pairs = 0;
    for (const block of [light, dark]) {
      for (const band of ["very-clean", "clean", "average", "dirty", "very-dirty"]) {
        const r = ratio(token(block, `band-${band}`), token(block, `band-${band}-bg`));
        expect([band, r >= 4.5]).toEqual([band, true]);
        pairs++;
      }
      for (const [fg, bg] of [["fg", "bg"], ["fg-muted", "surface"], ["accent-fg", "accent"], ["danger", "surface"], ["warn", "surface"]]) {
        expect([fg, bg, ratio(token(block, fg!), token(block, bg!)) >= 4.5]).toEqual([fg, bg, true]);
      }
    }
    expect(pairs).toBe(10);
  });

  it("the real asset directory is served", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "tidegap-ui-assets-"));
    const ui = await startUiServer({
      token: TOKEN,
      dbPath: join(tmp, "queue.db"),
      feed: mockGridFeed(),
      defaultRegion: "FR",
      quota: () => ({}),
      daemonStatus: () => "unknown",
    });
    try {
      for (const [path, asset] of Object.entries(STATIC_FILES)) {
        const res = await fetch(`${ui.url.replace(/\/$/, "")}${path}`);
        expect([path, res.status]).toEqual([path, 200]);
        expect(res.headers.get("content-type")).toBe(asset.type);
        expect(res.headers.get("content-security-policy")).toContain("default-src 'self'");
        expect(res.headers.get("x-content-type-options")).toBe("nosniff");
        expect(path === "/" ? "text/html" : path.endsWith(".css") ? "text/css" : path.endsWith(".png") ? "image/png" : "text/javascript").toBe(
          asset.type.split(";")[0],
        );
      }
      expect(STATIC_FILES["/clients.js"]?.type).toMatch(/^text\/javascript/);
      for (const path of ["/nope.js", "/ui/app.js", "/__proto__", "/constructor"]) {
        const res = await fetch(`${ui.url.replace(/\/$/, "")}${path}`);
        expect([path, res.status]).toEqual([path, 404]);
      }
    } finally {
      await ui.close();
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe("tidegap ui internals", () => {
  it("classifyOrigin sorts Origin headers into none, loopback, extension and foreign", () => {
    expect(classifyOrigin(undefined, 4000)).toBe("none");
    expect(classifyOrigin("http://127.0.0.1:4000", 4000)).toBe("loopback");
    expect(classifyOrigin("http://localhost:4001", 4000)).toBe("foreign");
    expect(classifyOrigin("chrome-extension://abc", 4000)).toBe("extension");
    expect(classifyOrigin("https://127.0.0.1:4000", 4000)).toBe("foreign");
    expect(classifyOrigin("null", 4000)).toBe("foreign");
  });

  it("isLoopbackHost accepts loopback names with no port or the server port", () => {
    expect(isLoopbackHost("127.0.0.1:4000", 4000)).toBe(true);
    expect(isLoopbackHost("[::1]", 4000)).toBe(true);
    expect(isLoopbackHost("localhost:4001", 4000)).toBe(false);
    expect(isLoopbackHost("::1", 4000)).toBe(false);
    expect(isLoopbackHost("localhost:4000:1", 4000)).toBe(false);
  });

  it("caches the forecast so change events do not spend provider quota", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tidegap-ui-fc-"));
    const store = new TaskStore({ dbPath: join(dir, "queue.db") });
    const inner = mockGridFeed();
    let calls = 0;
    let now = new Date("2026-10-15T12:00:00Z");
    const ctx: ApiContext = {
      store,
      dbPath: "x",
      feed: { ...inner, fetchForecast: (r, h) => (calls++, inner.fetchForecast(r, h)) },
      defaultRegion: "FR",
      quota: () => ({}),
      daemonStatus: () => "unknown",
      now: () => now,
    };
    try {
      const q = new URLSearchParams("region=FR&hours=24");
      expect((await handleApi(ctx, "GET", "/api/forecast", q)).status).toBe(200);
      expect((await handleApi(ctx, "GET", "/api/forecast", q)).status).toBe(200);
      expect(calls).toBe(1);
      now = new Date(now.getTime() + FORECAST_CACHE_MS);
      await handleApi(ctx, "GET", "/api/forecast", q);
      expect(calls).toBe(2);
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("a ledger read that throws during a poll is skipped, not fatal", () => {
    let version = 1;
    let fail = false;
    const store = {
      dataVersion: () => version,
      list: () => {
        if (fail) throw new Error("SQLITE_BUSY");
        return [];
      },
    } as unknown as TaskStore;
    const events = new TaskEvents(store, 10_000);
    const seen: string[][] = [];
    events.subscribe((ids) => seen.push(ids));
    fail = true;
    version = 2;
    expect(() => events.poll()).not.toThrow();
    fail = false;
    // The version was not consumed, so the retry still looks at the ledger.
    events.poll();
    expect(seen).toEqual([]);
    events.stop();
  });
});
