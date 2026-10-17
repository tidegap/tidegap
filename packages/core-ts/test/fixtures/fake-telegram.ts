/**
 * A fake Telegram Bot API server for tests and the S4 QA script (KTD13).
 * Loopback only. Implements `getMe`, `getWebhookInfo`, `getUpdates` (long
 * poll with `offset` and `timeout`), `sendMessage`, `answerCallbackQuery`
 * and `editMessageReplyMarkup`, and records every call.
 *
 * In tests: `const tg = await startFakeTelegram({ token })`, then
 * `tg.message(chatId, "/queue")`, `tg.callback(chatId, "c:<id>")`,
 * `tg.calls("sendMessage")`, `tg.close()`.
 *
 * As a script (QA): `node packages/core-ts/test/fixtures/fake-telegram.ts [port] [token]`
 * prints the base URL; then
 *   curl -XPOST <base>/_control/message -d '{"chat_id":1,"text":"/pair 123456"}'
 *   curl <base>/_control/calls
 */

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

export interface FakeCall {
  method: string;
  body: Record<string, unknown>;
}

export interface FakeTelegramOptions {
  token?: string;
  port?: number;
  /** Cap on one `getUpdates` wait, so a test never waits Telegram's full timeout. Default 2000 ms. */
  maxWaitMs?: number;
  /** The bot `getMe` returns. */
  botUsername?: string;
}

interface Failure {
  method: string;
  status: number;
  times: number;
  description?: string;
}

export interface FakeTelegram {
  baseUrl: string;
  token: string;
  /** Queue a text message from a chat; returns its update id. */
  message(chatId: number, text: string, opts?: { chatType?: "private" | "group" | "supergroup"; username?: string }): number;
  /** Queue a button press on message `messageId` (default 1); returns its update id. */
  callback(chatId: number, data: string, opts?: { messageId?: number }): number;
  /** Recorded calls, optionally of one method. */
  calls(method?: string): FakeCall[];
  /** Texts of recorded `sendMessage` calls, optionally to one chat. */
  sent(chatId?: number): string[];
  /** Answer the next `times` calls of `method` with HTTP `status`. */
  fail(method: string, status: number, times?: number, description?: string): void;
  /** Make `getWebhookInfo` report a webhook. */
  setWebhook(url: string): void;
  /** The highest update id a `getUpdates` offset confirmed so far. */
  confirmedOffset(): number;
  clearCalls(): void;
  close(): Promise<void>;
}

export async function startFakeTelegram(opts: FakeTelegramOptions = {}): Promise<FakeTelegram> {
  const token = opts.token ?? "123:fake-token";
  const maxWaitMs = opts.maxWaitMs ?? 2000;
  const updates: Array<Record<string, unknown> & { update_id: number }> = [];
  const calls: FakeCall[] = [];
  const failures: Failure[] = [];
  const waiters = new Set<() => void>();
  let nextUpdateId = 1;
  let nextMessageId = 1000;
  let confirmed = 0;
  let webhook = "";

  const wake = () => {
    for (const w of [...waiters]) w();
  };

  const push = (u: Record<string, unknown>): number => {
    const id = nextUpdateId++;
    updates.push({ update_id: id, ...u });
    wake();
    return id;
  };

  const message: FakeTelegram["message"] = (chatId, text, o = {}) =>
    push({
      message: {
        message_id: nextMessageId++,
        date: Math.floor(Date.now() / 1000),
        chat: { id: chatId, type: o.chatType ?? "private", username: o.username },
        from: { id: chatId, is_bot: false, username: o.username },
        text,
      },
    });

  const callback: FakeTelegram["callback"] = (chatId, data, o = {}) =>
    push({
      callback_query: {
        id: `cb-${nextUpdateId}`,
        from: { id: chatId, is_bot: false },
        message: { message_id: o.messageId ?? 1, chat: { id: chatId, type: "private" } },
        data,
      },
    });

  const reply = (res: ServerResponse, status: number, body: unknown) => {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  };

  const readBody = (req: IncomingMessage): Promise<Record<string, unknown>> =>
    new Promise((resolve) => {
      let raw = "";
      req.on("data", (c: Buffer) => (raw += c.toString("utf8")));
      req.on("end", () => {
        try {
          resolve(raw ? (JSON.parse(raw) as Record<string, unknown>) : {});
        } catch {
          resolve({});
        }
      });
    });

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const body = await readBody(req);
    if (url.pathname.startsWith("/_control/")) {
      const what = url.pathname.slice("/_control/".length);
      if (what === "message") return reply(res, 200, { update_id: message(Number(body.chat_id), String(body.text ?? ""), { chatType: body.chat_type as "private" | undefined }) });
      if (what === "callback") return reply(res, 200, { update_id: callback(Number(body.chat_id), String(body.data ?? "")) });
      if (what === "calls") return reply(res, 200, calls);
      return reply(res, 404, { ok: false });
    }
    const m = /^\/bot([^/]+)\/(\w+)$/.exec(url.pathname);
    if (!m) return reply(res, 404, { ok: false, error_code: 404, description: "Not Found" });
    const [, gotToken, method] = m as unknown as [string, string, string];
    if (gotToken !== token) return reply(res, 401, { ok: false, error_code: 401, description: "Unauthorized" });
    calls.push({ method, body });
    const failure = failures.find((f) => f.method === method && f.times > 0);
    if (failure) {
      failure.times--;
      return reply(res, failure.status, { ok: false, error_code: failure.status, description: failure.description ?? `fake ${failure.status}` });
    }
    switch (method) {
      case "getMe":
        return reply(res, 200, { ok: true, result: { id: 42, is_bot: true, username: opts.botUsername ?? "tidegap_test_bot" } });
      case "getWebhookInfo":
        return reply(res, 200, { ok: true, result: { url: webhook, pending_update_count: 0 } });
      case "getUpdates": {
        const offset = typeof body.offset === "number" ? body.offset : 0;
        if (offset > 0) {
          confirmed = Math.max(confirmed, offset - 1);
          while (updates.length > 0 && updates[0]!.update_id < offset) updates.shift();
        }
        const ready = () => updates.filter((u) => u.update_id >= offset);
        const timeoutMs = Math.min(Number(body.timeout ?? 0) * 1000, maxWaitMs);
        if (ready().length === 0 && timeoutMs > 0) {
          await new Promise<void>((resolve) => {
            const done = () => {
              clearTimeout(timer);
              waiters.delete(done);
              resolve();
            };
            const timer = setTimeout(done, timeoutMs);
            waiters.add(done);
          });
        }
        return reply(res, 200, { ok: true, result: ready() });
      }
      case "sendMessage":
        return reply(res, 200, {
          ok: true,
          result: { message_id: nextMessageId++, chat: { id: body.chat_id, type: "private" }, text: body.text },
        });
      case "answerCallbackQuery":
      case "editMessageReplyMarkup":
        return reply(res, 200, { ok: true, result: true });
      default:
        return reply(res, 404, { ok: false, error_code: 404, description: "Not Found: method not found" });
    }
  });

  await new Promise<void>((resolve) => server.listen(opts.port ?? 0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;

  return {
    baseUrl: `http://127.0.0.1:${port}`,
    token,
    message,
    callback,
    calls: (method) => (method ? calls.filter((c) => c.method === method) : [...calls]),
    sent: (chatId) =>
      calls
        .filter((c) => c.method === "sendMessage" && (chatId === undefined || Number(c.body.chat_id) === chatId))
        .map((c) => String(c.body.text)),
    fail: (method, status, times = 1, description) => failures.push({ method, status, times, description }),
    setWebhook: (u) => {
      webhook = u;
    },
    confirmedOffset: () => confirmed,
    clearCalls: () => {
      calls.length = 0;
    },
    close: () =>
      new Promise<void>((resolve) => {
        wake();
        server.closeAllConnections?.();
        server.close(() => resolve());
      }),
  };
}

// Script mode for the QA run: `node fake-telegram.ts [port] [token]`.
if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  const port = Number(process.argv[2] ?? 0);
  const fake = await startFakeTelegram({ port, token: process.argv[3] ?? "test:token", maxWaitMs: 50_000 });
  process.stdout.write(`${fake.baseUrl}\n`);
}
