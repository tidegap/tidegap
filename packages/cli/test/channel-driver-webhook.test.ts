/** Webhook driver (integrations plan U6): signing, header lines, stored secrets that stay with their URL. */

import { createHmac } from "node:crypto";

import { describe, expect, it } from "vitest";

import { startFakeSink } from "./fixtures/fake-sink.js";

import { readSecrets } from "../src/channels/secrets.js";
import { signatureHeaders, signedSpec } from "../src/channels/drivers/webhook.js";
import { kindEnv, refused } from "./channel-kinds-helpers.js";

describe("webhook signing", () => {
  it("matches HMAC-SHA256 over \"<ts>.<body>\" (known vector)", () => {
    expect(signatureHeaders("s3cret", '{"a":1}', 1700000000)).toEqual({
      "X-Tidegap-Timestamp": "1700000000",
      "X-Tidegap-Signature": "sha256=1698a50bc74d1ff1db85c4e0a5297c2ad9fdba245d5737cdb789e4cc6e098940",
    });
  });

  it("an unsigned spec passes unchanged; a signed one trades sign for the two headers", () => {
    const spec = { type: "http" as const, method: "POST" as const, url: "https://x.test", headers: { A: "b" }, body: "{}" };
    expect(signedSpec(spec)).toEqual(spec);
    expect(signedSpec({ ...spec, sign: { secret: "k" } }, 5)).toEqual({ ...spec, headers: { A: "b", ...signatureHeaders("k", "{}", 5) } });
  });
});

describe("webhook through ChannelSetup and the fake sink", () => {
  const env = kindEnv();
  const HOOK = "/hook/webhook-kind-0123456789";

  it("a signed connect: the receiver can verify the signature; custom headers arrive", async () => {
    const { sink, setup } = env();
    await setup.connect("webhook", { url: `${sink.baseUrl}${HOOK}`, secret: "s3cret-signing", headers: "Authorization: Bearer tok-1\nX-Env: qa" });
    const [req] = sink.requests(HOOK);
    const ts = req!.headers["x-tidegap-timestamp"]!;
    expect(Math.abs(Number(ts) - Date.now() / 1000)).toBeLessThan(60);
    expect(req!.headers["x-tidegap-signature"]).toBe(`sha256=${createHmac("sha256", "s3cret-signing").update(`${ts}.${req!.body}`).digest("hex")}`);
    expect([req!.headers.authorization, req!.headers["x-env"]]).toEqual(["Bearer tok-1", "qa"]);
    expect(JSON.parse(req!.body)).toMatchObject({ version: 1, event: "test" });
  });

  it("text and teams formats reach the receiver; bad header lines are refused on the field before any send", async () => {
    const { sink, setup } = env();
    await setup.connect("webhook", { url: `${sink.baseUrl}${HOOK}`, format: "text" });
    expect(Object.keys(JSON.parse(sink.requests(HOOK)[0]!.body))).toEqual(["text"]);
    const err = await refused(setup.connect("webhook", { headers: "Host: evil" }));
    expect([err.code, err.field]).toEqual(["invalid", "headers"]);
    expect(sink.requests(HOOK)).toHaveLength(1);
  });

  it("an empty secret keeps the stored one for the same URL, but not for a new host", async () => {
    const { sink, setup, secretsFile } = env();
    const url = `${sink.baseUrl}${HOOK}`;
    await setup.connect("webhook", { url, secret: "s3cret-signing", headers: "Authorization: Bearer tok-1" });
    await setup.connect("webhook", { url: `${url}?again=1` });
    expect(sink.requests(HOOK)[1]!.headers.authorization).toBe("Bearer tok-1");
    const other = url.replace("127.0.0.1", "localhost");
    await setup.connect("webhook", { url: other });
    const last = sink.requests(HOOK).at(-1)!;
    expect(last.headers.authorization).toBeUndefined();
    expect(last.headers["x-tidegap-signature"]).toBeUndefined();
    expect(readSecrets("webhook", secretsFile)).toEqual({ url: other });
  });

  it("keepWith: clear drops the stored secret on the same URL and keeps the headers", async () => {
    const { sink, setup, secretsFile } = env();
    const url = `${sink.baseUrl}${HOOK}`;
    await setup.connect("webhook", { url, secret: "s3cret-signing", headers: "Authorization: Bearer tok-1" });
    await setup.connect("webhook", {}, { clear: ["secret"] });
    const req = sink.requests(HOOK).at(-1)!;
    expect(req.headers["x-tidegap-signature"]).toBeUndefined();
    expect(req.headers.authorization).toBe("Bearer tok-1");
    expect(readSecrets("webhook", secretsFile)).toEqual({ url, headers: "Authorization: Bearer tok-1" });
  });

  it("keepWith: a new host drops the stored headers but a secret typed with it applies", async () => {
    const { sink, setup, secretsFile } = env();
    const url = `${sink.baseUrl}${HOOK}`;
    await setup.connect("webhook", { url, secret: "s3cret-signing", headers: "Authorization: Bearer tok-1" });
    const other = url.replace("127.0.0.1", "localhost");
    await setup.connect("webhook", { url: other, secret: "typed-again-9" });
    const req = sink.requests(HOOK).at(-1)!;
    expect(req.headers.authorization).toBeUndefined();
    const ts = req.headers["x-tidegap-timestamp"]!;
    expect(req.headers["x-tidegap-signature"]).toBe(`sha256=${createHmac("sha256", "typed-again-9").update(`${ts}.${req.body}`).digest("hex")}`);
    expect(readSecrets("webhook", secretsFile)).toEqual({ url: other, secret: "typed-again-9" });
  });

  it("keepWith: the same host on another port is another origin, so the stored secret and headers drop", async () => {
    const { sink, setup, secretsFile } = env();
    const second = await startFakeSink();
    try {
      await setup.connect("webhook", { url: `${sink.baseUrl}${HOOK}`, secret: "s3cret-signing", headers: "Authorization: Bearer tok-1" });
      const moved = `${second.baseUrl}${HOOK}`;
      await setup.connect("webhook", { url: moved });
      const req = second.requests(HOOK)[0]!;
      expect([req.headers.authorization, req.headers["x-tidegap-signature"]]).toEqual([undefined, undefined]);
      expect(readSecrets("webhook", secretsFile)).toEqual({ url: moved });
    } finally {
      await second.close();
    }
  });

  it("keepWith: a different path or query on the same origin keeps them (a URL edit is not a new receiver)", async () => {
    const { sink, setup } = env();
    await setup.connect("webhook", { url: `${sink.baseUrl}${HOOK}`, secret: "s3cret-signing", headers: "X-Env: qa" });
    await setup.connect("webhook", { url: `${sink.baseUrl}${HOOK}-v2?x=1` });
    const req = sink.requests(`${HOOK}-v2`)[0]!;
    expect([req.headers["x-env"], req.headers["x-tidegap-signature"]]).toEqual(["qa", expect.stringMatching(/^sha256=[0-9a-f]{64}$/)]);
  });

  it("the signature and timestamp are the same on every retry of one job", async () => {
    const { sink, setup, waits } = env();
    sink.script(HOOK, [{ status: 500 }, { status: 502 }, { status: 200 }]);
    await setup.connect("webhook", { url: `${sink.baseUrl}${HOOK}`, secret: "s3cret-signing" });
    const reqs = sink.requests(HOOK);
    expect(reqs).toHaveLength(3);
    expect(waits).toHaveLength(2);
    expect(new Set(reqs.map((r) => r.headers["x-tidegap-signature"])).size).toBe(1);
    expect(new Set(reqs.map((r) => r.headers["x-tidegap-timestamp"])).size).toBe(1);
    expect(new Set(reqs.map((r) => r.body)).size).toBe(1);
    const ts = reqs[2]!.headers["x-tidegap-timestamp"]!;
    expect(reqs[2]!.headers["x-tidegap-signature"]).toBe(`sha256=${createHmac("sha256", "s3cret-signing").update(`${ts}.${reqs[2]!.body}`).digest("hex")}`);
  });
});
