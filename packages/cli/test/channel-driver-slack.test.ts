/** Slack driver (integrations plan U7) against the fake sink. */

import { describe, expect, it } from "vitest";

import { kindEnv, refused } from "./channel-kinds-helpers.js";

const HOOK = "/services/T0/B0/slack-kind-secret";

describe("slack", () => {
  const env = kindEnv();

  it("connect posts text plus the block; the block text carries the payload text", async () => {
    const { sink, setup } = env();
    const channel = await setup.connect("slack", { url: `${sink.baseUrl}${HOOK}` });
    expect(channel.state).toBe("connected");
    expect(JSON.stringify(channel)).not.toContain("slack-kind-secret");
    const body = JSON.parse(sink.requests(HOOK)[0]!.body);
    expect(body.blocks[0].text.text).toBe(`*Tidegap test message*\n${body.text}`);
  });

  it("404 no_service → Slack's sentence on the URL field; 410 → the archived sentence; nothing saved", async () => {
    const { sink, setup, store } = env();
    sink.script(HOOK, [{ status: 404, body: "no_service" }]);
    const gone = await refused(setup.connect("slack", { url: `${sink.baseUrl}${HOOK}` }));
    expect([gone.code, gone.field, gone.message]).toEqual(["test_failed", "url", "Slack removed this webhook. Add a new one in your Slack app and paste it here."]);
    sink.script(HOOK, [{ status: 410, body: "channel_is_archived" }]);
    expect((await refused(setup.connect("slack", { url: `${sink.baseUrl}${HOOK}` }))).message).toMatch(/archived/);
    expect(store.listChannels()).toEqual([]);
  });

  it("Slack's error word picks the sentence before the status; an unknown word falls back to the status", async () => {
    const { sink, setup, store } = env();
    const cases: [number, string, string, string | undefined, RegExp][] = [
      [400, "invalid_payload", "slack_payload", undefined, /message format/],
      [404, "channel_not_found", "slack_channel_not_found", "url", /no longer exists/],
      [403, "action_prohibited", "slack_action_prohibited", "url", /admin restricted/],
      [403, "invalid_token", "slack_webhook_gone", "url", /removed this webhook/],
      [400, "channel_is_archived", "slack_channel_archived", "url", /archived/],
      [403, "something_new", "auth", "url", /did not accept this URL/],
    ];
    for (const [status, body, delivery, field, text] of cases) {
      sink.script(HOOK, [{ status, body }]);
      const err = await refused(setup.connect("slack", { url: `${sink.baseUrl}${HOOK}` }));
      expect([err.code, err.delivery, err.field]).toEqual(["test_failed", delivery, field]);
      expect(err.message).toMatch(text);
    }
    expect(store.listChannels()).toEqual([]);
  });

  it("a look-alike host is invalid on the URL field before any send", async () => {
    const { sink, setup } = env();
    const err = await refused(setup.connect("slack", { url: "https://hooks.slack.com.evil.com/services/x" }));
    expect([err.code, err.field, err.message]).toEqual(["invalid", "url", "Paste the Incoming Webhook URL. It starts with https://hooks.slack.com/services/."]);
    expect(sink.requests()).toEqual([]);
  });

  it("a loopback URL on the Tidegap UI port passes the host rule but not the URL policy", async () => {
    const { sink, setup } = env();
    const err = await refused(setup.connect("slack", { url: `http://127.0.0.1:1${HOOK}` }));
    expect([err.code, err.field, err.delivery]).toEqual(["invalid", "url", "ui_port"]);
    expect(sink.requests()).toEqual([]);
  });

  it("429 with a short Retry-After is waited out and the connect succeeds", async () => {
    const { sink, setup, waits } = env();
    sink.script(HOOK, [{ status: 429, retryAfter: 2 }, { status: 200 }]);
    expect((await setup.connect("slack", { url: `${sink.baseUrl}${HOOK}` })).state).toBe("connected");
    expect(waits).toEqual([2000]);
    expect(sink.requests(HOOK)).toHaveLength(2);
  });

  it("429 with a long Retry-After is unreachable with the generic slow-down sentence on no field; nothing saved", async () => {
    const { sink, setup, store, waits } = env();
    sink.script(HOOK, [{ status: 429, retryAfter: 60 }]);
    const err = await refused(setup.connect("slack", { url: `${sink.baseUrl}${HOOK}` }));
    expect([err.code, err.field, err.delivery, err.message]).toEqual(["unreachable", undefined, "rate_limited", "The receiver asks Tidegap to slow down. Wait a minute and try again."]);
    expect(waits).toEqual([]);
    expect(store.listChannels()).toEqual([]);
  });
});
