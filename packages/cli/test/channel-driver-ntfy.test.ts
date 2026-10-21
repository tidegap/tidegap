/** ntfy driver (integrations plan U9) against the fake sink as the server. */

import { describe, expect, it } from "vitest";

import { readSecrets } from "../src/channels/secrets.js";
import { kindEnv, refused } from "./channel-kinds-helpers.js";

const TOPIC = "tidegap-qa0123456789";

describe("ntfy", () => {
  const env = kindEnv();

  it("connect publishes to <server>/<topic> with the headers; the token is a Bearer header", async () => {
    const { sink, setup } = env();
    const channel = await setup.connect("ntfy", { server: sink.baseUrl, topic: TOPIC, token: "tk_secret_token_1" });
    expect(channel.target).toMatch(/^127\.0\.0\.1:\d+ topic …6789$/);
    expect(JSON.stringify(channel)).not.toContain("tk_secret_token_1");
    const [req] = sink.requests(`/${TOPIC}`);
    expect(req!.body).toBe("Test message from Tidegap. Notifications work.");
    expect([req!.headers.title, req!.headers.priority, req!.headers.tags, req!.headers.authorization]).toEqual(["Tidegap test message", "3", "information_source", "Bearer tk_secret_token_1"]);
  });

  it("covers AE5: Edit with the token empty keeps it for the same server; the hint is unchanged", async () => {
    const { sink, setup } = env();
    const first = await setup.connect("ntfy", { server: sink.baseUrl, topic: TOPIC, token: "tk_secret_token_1" });
    const again = await setup.connect("ntfy", { priority: "5" });
    const req = sink.requests(`/${TOPIC}`)[1]!;
    expect([req.headers.authorization, req.headers.priority]).toEqual(["Bearer tk_secret_token_1", "5"]);
    expect(again.secrets.token).toBe(first.secrets.token);
  });

  it("a new server host does not get the stored token: the empty field drops it", async () => {
    const { sink, setup, secretsFile } = env();
    await setup.connect("ntfy", { server: sink.baseUrl, topic: TOPIC, token: "tk_secret_token_1" });
    const moved = await setup.connect("ntfy", { server: sink.baseUrl.replace("127.0.0.1", "localhost") });
    expect(sink.requests(`/${TOPIC}`)[1]!.headers.authorization).toBeUndefined();
    expect(moved.secrets.token).toBeUndefined();
    expect(readSecrets("ntfy", secretsFile)).toEqual({ topic: TOPIC });
  });

  it("403 → the token sentence on the token field; a topic with a space is invalid before any send", async () => {
    const { sink, setup } = env();
    sink.script(`/${TOPIC}`, [{ status: 403 }]);
    const err = await refused(setup.connect("ntfy", { server: sink.baseUrl, topic: TOPIC, token: "tk_bad" }));
    expect([err.code, err.field, err.message]).toEqual(["test_failed", "token", "ntfy refused the access token. Create a new one in your ntfy account."]);
    const bad = await refused(setup.connect("ntfy", { server: sink.baseUrl, topic: "my topic" }));
    expect([bad.code, bad.field]).toEqual(["invalid", "topic"]);
    expect(sink.requests(`/${TOPIC}`)).toHaveLength(1);
  });

  it("the server goes through the URL policy: a metadata address or the UI port is invalid on the server field before any send", async () => {
    const { sink, setup, store } = env();
    for (const server of ["http://169.254.169.254", "http://127.0.0.1:1"]) {
      const err = await refused(setup.connect("ntfy", { server, topic: TOPIC }));
      expect([err.code, err.field]).toEqual(["invalid", "server"]);
    }
    expect(sink.requests()).toEqual([]);
    expect(store.listChannels()).toEqual([]);
  });

  it("429 with a short Retry-After is waited out; with a long one the ntfy sentence shows, on no field, and nothing is saved", async () => {
    const { sink, setup, store, waits } = env();
    sink.script(`/${TOPIC}`, [{ status: 429, retryAfter: 1 }, { status: 200 }]);
    expect((await setup.connect("ntfy", { server: sink.baseUrl, topic: TOPIC })).state).toBe("connected");
    expect(waits).toEqual([1000]);
    await setup.remove("ntfy");
    sink.script(`/${TOPIC}`, [{ status: 429, retryAfter: 60 }]);
    const err = await refused(setup.connect("ntfy", { server: sink.baseUrl, topic: TOPIC }));
    expect([err.code, err.field, err.delivery, err.message]).toEqual([
      "unreachable",
      undefined,
      "rate_limited",
      "The ntfy server limits messages. Wait a few minutes, or use an account token or your own server.",
    ]);
    expect(store.listChannels()).toEqual([]);
  });
});
