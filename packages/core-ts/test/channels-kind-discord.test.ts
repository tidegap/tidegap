/** Discord kind (integrations plan U8): embed, escaping, no mentions, wait=true, fixed hosts. */

import { describe, expect, it } from "vitest";

import { KIND_DESCRIPTORS, validateFields } from "../src/index.js";
import type { NotificationPayload } from "../src/index.js";

const discord = KIND_DESCRIPTORS.discord;
const URL_OK = "https://discord.com/api/webhooks/123/abc-DEF_9";
const payload: NotificationPayload = { event: "task_failed", level: "error", title: "[click](https://evil) @everyone", text: "Failed **bold** @everyone", at: "2026-10-20T10:00:00.000Z" };
const spec = (p: NotificationPayload, url = URL_OK) => {
  const s = discord.format!(p, { url });
  if (s.type !== "http") throw new Error("not http");
  return s;
};

describe("discord", () => {
  it("one embed colored by level, no allowed mentions, wait=true", () => {
    const s = spec(payload);
    expect(s.url).toBe(`${URL_OK}?wait=true`);
    const b = JSON.parse(s.body);
    expect(b.username).toBe("Tidegap");
    expect(b.allowed_mentions).toEqual({ parse: [] });
    expect(b.embeds[0]).toMatchObject({ color: 0xc62828, timestamp: payload.at });
    expect(b.embeds[0].title).toBe("\\[click\\]\\(https://evil\\) @everyone");
    expect(b.embeds[0].description).toBe("Failed \\*\\*bold\\*\\* @everyone");
  });

  it("keeps thread_id and cuts the description at 4,096 characters with an ellipsis", () => {
    expect(spec(payload, `${URL_OK}?thread_id=7`).url).toBe(`${URL_OK}?thread_id=7&wait=true`);
    const d = JSON.parse(spec({ ...payload, text: "a".repeat(5000) }).body).embeds[0].description;
    expect(d).toHaveLength(4096);
    expect(d.endsWith("…")).toBe(true);
    const escaped = JSON.parse(spec({ ...payload, text: "*".repeat(5000) }).body).embeds[0].description;
    expect(escaped.length).toBeLessThanOrEqual(4096);
    expect(escaped).toMatch(/(\\\*)+…$/);
  });

  it("only Discord's webhook hosts or a loopback test sink", () => {
    const ok = (url: string) => validateFields(discord, { url }).ok;
    for (const host of ["discord.com", "discordapp.com", "canary.discord.com", "ptb.discord.com"]) expect(ok(`https://${host}/api/webhooks/1/x`)).toBe(true);
    expect(ok("https://discord.com/api/v10/webhooks/1/x")).toBe(true);
    expect(ok("http://127.0.0.1:4100/api/webhooks/1/x")).toBe(true);
    expect(ok("https://discord.com.evil.com/api/webhooks/1/x")).toBe(false);
    expect(ok("https://discord.com/api/channels/1")).toBe(false);
  });

  it("covers AE1: a 404 blames the URL with Discord's sentence", () => {
    expect(discord.errors!.http_404).toEqual({ field: "url", text: "Discord does not know this webhook. Copy the URL again from Server Settings → Integrations → Webhooks." });
  });
});
