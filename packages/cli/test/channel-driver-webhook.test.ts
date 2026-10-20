/** Webhook driver (integrations plan U6): signing, header lines, stored secrets that stay with their URL. */

import { createHmac } from "node:crypto";

import { describe, expect, it } from "vitest";

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
});
