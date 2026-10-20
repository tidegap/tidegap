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

  it("a look-alike host is invalid on the URL field before any send", async () => {
    const { sink, setup } = env();
    const err = await refused(setup.connect("slack", { url: "https://hooks.slack.com.evil.com/services/x" }));
    expect([err.code, err.field, err.message]).toEqual(["invalid", "url", "Paste the Incoming Webhook URL. It starts with https://hooks.slack.com/services/."]);
    expect(sink.requests()).toEqual([]);
  });
});
