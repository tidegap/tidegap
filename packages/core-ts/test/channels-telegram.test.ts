import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { isLoopbackApiBase, TelegramClient, TelegramError } from "../src/index.js";
import { startFakeTelegram, type FakeTelegram } from "./fixtures/fake-telegram.js";

const TOKEN = "777:secret-token-value";

describe("TelegramClient against the fake server", () => {
  let tg: FakeTelegram;
  let client: TelegramClient;

  beforeEach(async () => {
    tg = await startFakeTelegram({ token: TOKEN, maxWaitMs: 200 });
    client = new TelegramClient({ token: TOKEN, baseUrl: tg.baseUrl });
  });
  afterEach(async () => {
    await tg.close();
  });

  it("sendMessage posts plain text without parse_mode, with buttons as an inline keyboard", async () => {
    await client.sendMessage(5, "<b>hi</b>", { buttons: [[{ text: "Result", data: "r:t-1" }]] });
    const [call] = tg.calls("sendMessage");
    expect(call!.body.text).toBe("<b>hi</b>");
    expect(call!.body).not.toHaveProperty("parse_mode");
    expect(call!.body.reply_markup).toEqual({ inline_keyboard: [[{ text: "Result", callback_data: "r:t-1" }]] });
  });

  it("getUpdates passes offset and timeout", async () => {
    tg.message(5, "/queue");
    const updates = await client.getUpdates({ offset: 1, timeoutS: 1 });
    expect(updates.map((u) => u.message?.text)).toEqual(["/queue"]);
    const [call] = tg.calls("getUpdates");
    expect(call!.body.offset).toBe(1);
    expect(call!.body.timeout).toBe(1);
  });

  it("HTTP 401 is a typed unauthorized error", async () => {
    const bad = new TelegramClient({ token: "wrong", baseUrl: tg.baseUrl });
    const err = await bad.getMe().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TelegramError);
    expect((err as TelegramError).kind).toBe("unauthorized");
    expect((err as TelegramError).status).toBe(401);
  });

  it("HTTP 409 is a typed conflict error", async () => {
    tg.fail("getUpdates", 409);
    const err = (await client.getUpdates().catch((e: unknown) => e)) as TelegramError;
    expect(err.kind).toBe("conflict");
    expect(err.message).toBe("Telegram getUpdates: HTTP 409: fake 409");
  });

  it("a network error is typed and its message has neither the token nor the URL", async () => {
    const port = Number(new URL(tg.baseUrl).port);
    await tg.close();
    const dead = new TelegramClient({ token: TOKEN, baseUrl: `http://127.0.0.1:${port}` });
    const err = (await dead.sendMessage(5, "x").catch((e: unknown) => e)) as TelegramError;
    expect(err.kind).toBe("network");
    expect(err.message).not.toContain(TOKEN);
    expect(err.message).not.toContain("127.0.0.1");
    expect(String(err.stack)).not.toContain(TOKEN);
    tg = await startFakeTelegram({ token: TOKEN });
  });

  it("an API error description never echoes the token", async () => {
    tg.fail("sendMessage", 400, 1, `Bad Request: token ${TOKEN} rejected`);
    const err = (await client.sendMessage(5, "x").catch((e: unknown) => e)) as TelegramError;
    expect(err.kind).toBe("http");
    expect(err.message).not.toContain(TOKEN);
  });
});

describe("isLoopbackApiBase", () => {
  it("allows only http loopback", () => {
    expect(isLoopbackApiBase("http://127.0.0.1:8081")).toBe(true);
    expect(isLoopbackApiBase("http://localhost:9")).toBe(true);
    expect(isLoopbackApiBase("https://127.0.0.1")).toBe(false);
    expect(isLoopbackApiBase("http://evil.example")).toBe(false);
    expect(isLoopbackApiBase("http://127.0.0.1.evil.example")).toBe(false);
    expect(isLoopbackApiBase("not a url")).toBe(false);
  });
});
