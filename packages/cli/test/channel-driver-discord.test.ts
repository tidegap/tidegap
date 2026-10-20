/** Discord driver (integrations plan U8) against the fake sink. */

import { describe, expect, it } from "vitest";

import { kindEnv, refused } from "./channel-kinds-helpers.js";

const HOOK = "/api/webhooks/123/discord-kind-secret";

describe("discord", () => {
  const env = kindEnv();

  it("connect posts with wait=true and no allowed mentions", async () => {
    const { sink, setup } = env();
    await setup.connect("discord", { url: `${sink.baseUrl}${HOOK}` });
    const [req] = sink.requests(HOOK);
    expect(req!.path).toBe(`${HOOK}?wait=true`);
    expect(JSON.parse(req!.body).allowed_mentions).toEqual({ parse: [] });
  });

  it("429 with JSON retry_after 1.5 → one wait of 1.5 s, then success", async () => {
    const { sink, setup, waits } = env();
    sink.script(HOOK, [{ status: 429, body: '{"retry_after": 1.5}' }, { status: 200 }]);
    expect((await setup.connect("discord", { url: `${sink.baseUrl}${HOOK}` })).state).toBe("connected");
    expect(waits).toEqual([1500]);
    expect(sink.requests(HOOK)).toHaveLength(2);
  });

  it("covers AE1: 404 → Discord's sentence on the URL field, nothing saved", async () => {
    const { sink, setup, store } = env();
    sink.script(HOOK, [{ status: 404, body: '{"message": "Unknown Webhook", "code": 10015}' }]);
    const err = await refused(setup.connect("discord", { url: `${sink.baseUrl}${HOOK}` }));
    expect([err.code, err.field, err.message]).toEqual(["test_failed", "url", "Discord does not know this webhook. Copy the URL again from Server Settings → Integrations → Webhooks."]);
    expect(store.listChannels()).toEqual([]);
  });
});
