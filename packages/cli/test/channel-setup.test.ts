/** `ChannelSetup` (integrations plan U3, KTD6) against the fake sink: one-step connect, stored values, disconnect, remove, settings. */

import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { TaskStore } from "@tidegap/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ChannelSetup, ChannelSetupError, secretHint, type ChannelSetupStore } from "../src/channels/channel-setup.js";
import { CHANNEL_LAST_META_PREFIX, channelSender, emitEvents, registryDeps } from "../src/channels/emit.js";
import { readSecrets } from "../src/channels/secrets.js";
import { startFakeSink, type FakeSink } from "./fixtures/fake-sink.js";

const SECRET_PATH = "/hook/s3cr3t-path-0123456789abcdef";

describe("ChannelSetup", () => {
  let dir: string;
  let store: TaskStore;
  let sink: FakeSink;
  let secretsFile: string;
  let setup: ChannelSetup;
  let url: string;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "tidegap-channel-setup-"));
    store = new TaskStore({ dbPath: join(dir, "q.db") });
    sink = await startFakeSink();
    secretsFile = join(dir, "channel-secrets.json");
    url = `${sink.baseUrl}${SECRET_PATH}`;
    setup = new ChannelSetup({ store, secretsFile, uiPorts: () => [1], platform: "linux", http: { waitsMs: [0, 0] } });
  });
  afterEach(async () => {
    store.close();
    await sink.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const refused = async (p: Promise<unknown>) => {
    const err = await p.then(() => undefined, (e: unknown) => e);
    expect(err).toBeInstanceOf(ChannelSetupError);
    return err as ChannelSetupError;
  };

  it("covers AE1: a 404 from the receiver saves nothing and blames the URL field", async () => {
    sink.script(SECRET_PATH, [{ status: 404 }]);
    const err = await refused(setup.connect("webhook", { url }));
    expect([err.code, err.field, err.delivery]).toEqual(["test_failed", "url", "http_404"]);
    expect(err.message).not.toContain(SECRET_PATH);
    expect(store.listChannels()).toEqual([]);
    expect(existsSync(secretsFile)).toBe(false);
    expect(store.getMeta(`${CHANNEL_LAST_META_PREFIX}webhook`)).toBeUndefined();
  });

  it("a 2xx connects: row enabled with default events, secret in the file only, last delivery ok, a test payload sent", async () => {
    const channel = await setup.connect("webhook", { url });
    expect(channel).toMatchObject({ id: "webhook", kind: "webhook", state: "connected", events: ["task_done", "task_failed", "clean_window", "not_ready"], quiet: "off", last: { ok: true } });
    expect(channel.secrets.url).toMatch(/^127\.0\.0\.1:\d+ …cdef$/);
    expect(channel.target).toBe(channel.secrets.url);
    expect(JSON.stringify(channel)).not.toContain(SECRET_PATH);
    expect(readSecrets("webhook", secretsFile)).toEqual({ url });
    expect(JSON.stringify(store.listChannels())).not.toContain(SECRET_PATH);
    const [req] = sink.requests(SECRET_PATH);
    expect(JSON.parse(req!.body)).toMatchObject({ version: 1, event: "test", level: "info" });
  });

  it("a 5xx after retries is unreachable; a refused URL policy is invalid on the field before any send", async () => {
    sink.script(SECRET_PATH, [{ status: 503 }]);
    const down = await refused(setup.connect("webhook", { url }));
    expect([down.code, down.delivery]).toEqual(["unreachable", "http_503"]);
    expect(sink.requests(SECRET_PATH)).toHaveLength(3);
    for (const bad of ["http://169.254.169.254/latest", "ftp://example.com/x", "http://127.0.0.1:1/hook"]) {
      const err = await refused(setup.connect("webhook", { url: bad }));
      expect([err.code, err.field]).toEqual(["invalid", "url"]);
    }
    const empty = await refused(setup.connect("webhook", {}));
    expect([empty.code, empty.field, empty.message]).toEqual(["invalid", "url", "Fill in Webhook URL."]);
    expect(store.listChannels()).toEqual([]);
  });

  it("covers AE5: an empty secret field reuses the stored secret and keeps its hint", async () => {
    const first = await setup.connect("webhook", { url });
    const again = await setup.connect("webhook", { url: "" }, { quiet: "night" });
    expect(sink.requests(SECRET_PATH)).toHaveLength(2);
    expect(again.secrets).toEqual(first.secrets);
    expect(again.quiet).toBe("night");
  });

  it("a failed Edit keeps the stored channel and its secret", async () => {
    await setup.connect("webhook", { url });
    sink.script("/other", [{ status: 410 }]);
    const err = await refused(setup.connect("webhook", { url: `${sink.baseUrl}/other` }));
    expect(err.code).toBe("test_failed");
    expect(readSecrets("webhook", secretsFile)).toEqual({ url });
    expect(setup.channel("webhook").state).toBe("connected");
  });

  /** The ledger with switches that make one write throw. */
  const failing = () => {
    const fail = { insert: false, meta: false };
    const wrapped: ChannelSetupStore = {
      listChannels: () => store.listChannels(),
      insertChannel: (c) => {
        if (fail.insert) throw new Error("disk full");
        store.insertChannel(c);
      },
      removeChannel: (id) => store.removeChannel(id),
      getMeta: (k) => store.getMeta(k),
      setMeta: (k, v) => {
        if (fail.meta) throw new Error("disk full");
        store.setMeta(k, v);
      },
      deleteMeta: (k) => store.deleteMeta(k),
    };
    return { fail, setup: new ChannelSetup({ store: wrapped, secretsFile, uiPorts: () => [1], platform: "linux", http: { waitsMs: [0, 0] } }) };
  };

  it("a failed row write puts the secrets back: first connect leaves none, an Edit keeps the old ones", async () => {
    const { fail, setup: s } = failing();
    fail.insert = true;
    await expect(s.connect("webhook", { url })).rejects.toThrow("disk full");
    expect(readSecrets("webhook", secretsFile)).toBeUndefined();
    expect(store.listChannels()).toEqual([]);
    fail.insert = false;
    await s.connect("webhook", { url });
    const before = store.listChannels();
    fail.insert = true;
    await expect(s.connect("webhook", { url: `${sink.baseUrl}/other` })).rejects.toThrow("disk full");
    expect(readSecrets("webhook", secretsFile)).toEqual({ url });
    expect(store.listChannels()).toEqual(before);
  });

  it("a failed last-delivery write still connects: row and secrets saved, no last line", async () => {
    const { fail, setup: s } = failing();
    fail.meta = true;
    const channel = await s.connect("webhook", { url });
    expect(channel.state).toBe("connected");
    expect(channel.last).toBeUndefined();
    expect(readSecrets("webhook", secretsFile)).toEqual({ url });
  });

  it("two connects for the same id at once share one test send", async () => {
    sink.script(SECRET_PATH, [{ status: 200, delayMs: 100 }]);
    const [a, b] = await Promise.all([setup.connect("webhook", { url }), setup.connect("webhook", { url })]);
    expect(a).toEqual(b);
    expect(sink.requests(SECRET_PATH)).toHaveLength(1);
  });

  it("covers AE3: disconnect keeps the settings and stops sending; connect with no fields resumes", async () => {
    await setup.connect("webhook", { url });
    const off = await setup.disconnect("webhook");
    expect(off.state).toBe("disconnected");
    expect(readSecrets("webhook", secretsFile)).toEqual({ url });
    const now = new Date("2026-10-20T12:00:00Z");
    const emit = () =>
      emitEvents({
        store,
        send: channelSender(registryDeps({ dbPath: join(dir, "q.db"), secretsFile })),
        cleanWindow: { start: "2026-10-20T11:00:00Z", end: "2026-10-20T13:00:00Z" },
        now,
      });
    sink.clear();
    expect(await emit()).toEqual({ sent: 0, failed: 0 });
    expect(sink.requests()).toHaveLength(0);
    expect((await refused(setup.test("webhook"))).code).toBe("not_connected");
    expect((await setup.connect("webhook", {})).state).toBe("connected");
    expect(sink.requests(SECRET_PATH)).toHaveLength(1);
  });

  it("test records the last delivery: a failure turns the card to error with its sentence", async () => {
    await setup.connect("webhook", { url });
    sink.script(SECRET_PATH, [{ status: 401 }]);
    const err = await refused(setup.test("webhook"));
    expect([err.code, err.delivery]).toEqual(["test_failed", "auth"]);
    expect(setup.channel("webhook")).toMatchObject({ state: "error", last: { ok: false, code: "auth" }, error: err.message });
    sink.script(SECRET_PATH, [{ status: 200 }]);
    expect((await setup.test("webhook")).state).toBe("connected");
  });

  it("remove deletes the row, the secret and the last delivery", async () => {
    await setup.connect("webhook", { url });
    await setup.remove("webhook");
    expect(setup.status().channels).toEqual([]);
    expect(readSecrets("webhook", secretsFile)).toBeUndefined();
    expect(JSON.parse(readFileSync(secretsFile, "utf8"))).toEqual({});
    expect(store.getMeta(`${CHANNEL_LAST_META_PREFIX}webhook`)).toBeUndefined();
    expect((await refused(setup.remove("webhook"))).code).toBe("not_found");
  });

  it.skipIf(process.getuid?.() === 0)("a failed secrets delete keeps the row, so remove can be retried", async () => {
    const secretsDir = join(dir, "secrets");
    mkdirSync(secretsDir, { mode: 0o700 });
    const file = join(secretsDir, "channel-secrets.json");
    const s = new ChannelSetup({ store, secretsFile: file, uiPorts: () => [1], platform: "linux", http: { waitsMs: [0, 0] } });
    await s.connect("webhook", { url });
    chmodSync(secretsDir, 0o500);
    try {
      await expect(s.remove("webhook")).rejects.toThrow();
      expect(store.listChannels().map((c) => c.id)).toEqual(["webhook"]);
    } finally {
      chmodSync(secretsDir, 0o700);
    }
    await s.remove("webhook");
    expect(store.listChannels()).toEqual([]);
    expect(readSecrets("webhook", file)).toBeUndefined();
  });

  it("settings stores events and quiet, works on a Telegram row, refuses bad values", async () => {
    await setup.connect("webhook", { url });
    const changed = await setup.settings("webhook", { events: ["digest", "task_failed", "digest"], quiet: "night" });
    expect([changed.events, changed.quiet]).toEqual([["task_failed", "digest"], "night"]);
    expect(store.listChannels()[0]!.events).toEqual(["task_failed", "digest"]);
    expect((await refused(setup.settings("webhook", { events: ["bogus"] }))).field).toBe("events");
    expect((await refused(setup.settings("webhook", { quiet: "always" }))).field).toBe("quiet");
    store.insertChannel({ id: "telegram-55", kind: "telegram", enabled: true, events: ["task_done"], config: { chat_id: 55, label: "@me" }, createdAt: new Date().toISOString() });
    const tg = await setup.settings("telegram-55", { quiet: "night" });
    expect(tg).toMatchObject({ kind: "telegram", target: "@me", quiet: "night", events: ["task_done"] });
    expect(store.listChannels().find((c) => c.id === "telegram-55")!.config).toEqual({ chat_id: 55, label: "@me", quiet: "night" });
    expect((await refused(setup.test("telegram-55"))).code).toBe("telegram");
  });

  it("status lists ready kinds only and hides unknown or unready kinds", async () => {
    const { kinds } = setup.status();
    expect(kinds.every((k) => k.ready)).toBe(true);
    expect(kinds.map((k) => k.kind)).toContain("webhook");
    expect((await refused(setup.connect("slack", {}))).code).toBe("unknown_kind");
  });

  it("a plain http URL to a public host carries the cleartext warning", async () => {
    const pub = new ChannelSetup({
      store,
      secretsFile,
      uiPorts: () => [1],
      drivers: { webhook: { send: async () => {} } } as never,
    });
    expect((await pub.connect("webhook", { url: "http://example.com/hooks/abcdefgh1234" })).warning).toBe("cleartext");
  });

  it("secret hints never show more than 4 characters of a value", () => {
    const f = { name: "t", label: "T", input: "password" } as const;
    expect(secretHint(f, "short")).toBe("stored");
    expect(secretHint(f, "0123456789abcdef")).toBe("…cdef");
    expect(secretHint({ ...f, input: "url" }, "https://hooks.example.com/services/T0/B0/xyz9")).toBe("hooks.example.com …xyz9");
  });
});
