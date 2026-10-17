/**
 * OpenClaw Telegram delivery on the core Telegram client (coherence U13):
 * the request, the message format and the outcome details are unchanged.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { deliverResult, formatReport } from "../src/delivery.js";

const task = {
  taskId: "t-tg",
  status: "completed",
  region: "GB",
  enqueuedAt: "2026-05-21T00:00:00Z",
  completedAt: "2026-05-21T03:00:00Z",
  result: { text: "the deferred answer" },
} as unknown as Parameters<typeof formatReport>[0];

const config = { channels: { telegram: { enabled: true, botToken: "123:abc", allowFrom: ["99"] } } };

describe("OpenClaw Telegram delivery", () => {
  const realFetch = globalThis.fetch;
  let seen: Array<{ url: string; body: Record<string, unknown> }>;
  let status: number;

  beforeEach(() => {
    seen = [];
    status = 200;
    globalThis.fetch = (async (url: string, init: { body: string }) => {
      seen.push({ url, body: JSON.parse(init.body) as Record<string, unknown> });
      return new Response(JSON.stringify(status === 200 ? { ok: true, result: { message_id: 1 } } : { ok: false }), { status });
    }) as unknown as typeof fetch;
  });
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  it("posts the chat message to the Bot API and reports the DM", async () => {
    const [outcome] = await deliverResult(task, { modes: ["telegram"] }, config);
    expect(outcome).toEqual({ mode: "telegram", ok: true, detail: "Telegram DM → 99" });
    expect(seen[0]!.url).toBe("https://api.telegram.org/bot123:abc/sendMessage");
    expect(seen[0]!.body.chat_id).toBe("99");
    expect(seen[0]!.body.disable_web_page_preview).toBe(true);
    expect(seen[0]!.body).not.toHaveProperty("parse_mode");
    expect(String(seen[0]!.body.text)).toContain("the deferred answer");
  });

  it("a Telegram HTTP 500 still yields the same outcome detail", async () => {
    status = 500;
    const [outcome] = await deliverResult(task, { modes: ["chat"] }, config);
    expect(outcome).toEqual({ mode: "chat", ok: false, detail: "Telegram HTTP 500" });
  });
});
