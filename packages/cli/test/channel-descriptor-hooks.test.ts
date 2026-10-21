/** The descriptor `errors` and `target` hooks as ChannelSetup applies them (all-channels plan U3). */

import { KIND_DESCRIPTORS } from "@tidegap/core";
import { describe, expect, it } from "vitest";

import { deliveryText } from "../src/channels/channel-setup.js";
import { kindEnv, refused } from "./channel-kinds-helpers.js";

const d = KIND_DESCRIPTORS;
const GENERIC_UNKNOWN = "The test message was not sent. Check the settings and try again.";

describe("deliveryText: a kind's errors hook over the generic sentences", () => {
  it("the kind's own sentence and field win over the generic ones", () => {
    expect(deliveryText(d.webhook, "http_400")).toEqual({ text: d.webhook.errors!.http_400!.text, field: "format" });
    expect(deliveryText(d.pushover, "pushover_token")).toEqual({ text: d.pushover.errors!.pushover_token!.text, field: "app_token" });
    expect(deliveryText(d.ntfy, "auth").field).toBe("token");
  });

  it("an own sentence without a field gets no field from a kind with no URL field (Pushover, ntfy 429)", () => {
    expect(deliveryText(d.pushover, "rate_limited")).toEqual({ text: d.pushover.errors!.rate_limited!.text });
    expect(deliveryText(d.ntfy, "rate_limited")).toEqual({ text: d.ntfy.errors!.rate_limited!.text });
  });

  it("an own sentence without a field on an address-blaming code falls back to the kind's URL field", () => {
    expect(deliveryText(d.slack, "http_400")).toEqual({ text: d.slack.errors!.http_400!.text, field: "url" });
  });

  it("a code the kind does not override uses the generic sentence; an address-blaming one goes under the URL field", () => {
    expect(deliveryText(d.webhook, "http_404")).toEqual({ text: "The receiver does not know this address. Copy the URL again.", field: "url" });
    expect(deliveryText(d.slack, "http_418").text).toBe("The receiver refused the test message (HTTP 418). Check the settings and try again.");
    expect(deliveryText(d.slack, "http_418").field).toBe("url");
    expect(deliveryText(d.slack, "http_503")).toEqual({ text: "The receiver had an error (HTTP 503). Try again later." });
    expect(deliveryText(d.email, "network").field).toBe("host");
  });

  it("an unknown code, or a name from Object.prototype, gets the fixed fallback sentence", () => {
    for (const code of ["boom", "constructor", "__proto__", "toString"]) {
      expect(deliveryText(d.slack, code)).toEqual({ text: GENERIC_UNKNOWN });
    }
  });
});

describe("target hook: the card's one line", () => {
  it("email: to, else from, else the user, else the label", () => {
    const t = d.email.target!;
    expect(t({ to: "a@x.test", from: "b@x.test", user: "c" }, {})).toBe("a@x.test");
    expect(t({ from: "b@x.test", user: "c" }, {})).toBe("b@x.test");
    expect(t({ user: "c" }, {})).toBe("c");
    expect(t({}, {})).toBe("Email");
  });

  it("pushover: the user hint, else the label", () => {
    expect(d.pushover.target!({}, { user_key: "…wxyz" })).toBe("user …wxyz");
    expect(d.pushover.target!({}, {})).toBe("Pushover");
  });

  it("ntfy: the host with a topic hint; the host alone; a server that is not a URL stays raw", () => {
    expect(d.ntfy.target!({ server: "https://ntfy.example.test:8443/base" }, {})).toBe("ntfy.example.test:8443");
    expect(d.ntfy.target!({}, { topic: "…wxyz" })).toBe("ntfy.sh topic …wxyz");
    expect(d.ntfy.target!({ server: "not a url" }, {})).toBe("not a url");
  });

  it("shortcuts and command: the name or path, with a fixed fallback for command", () => {
    expect(d.shortcuts.target!({ name: "Tidegap" }, {})).toBe('Shortcut "Tidegap"');
    expect(d.shortcuts.target!({}, {})).toBe('Shortcut ""');
    expect(d.command.target!({}, {})).toBe("Command");
  });
});

describe("hooks through ChannelSetup", () => {
  const env = kindEnv();
  const HOOK = "/services/T0/B0/hook-kind-secret";

  it("a kind with no target hook shows its URL secret's hint, without the path", async () => {
    const { sink, setup } = env();
    const channel = await setup.connect("slack", { url: `${sink.baseUrl}${HOOK}` });
    expect(channel.target).toBe(`http://${new URL(sink.baseUrl).host} …cret`);
    expect(JSON.stringify(channel)).not.toContain("hook-kind");
  });

  it("a failed test on a connected ntfy channel shows the kind's sentence as the card error, and the code in last", async () => {
    const { sink, setup } = env();
    const topic = "tidegap-qa0123456789";
    await setup.connect("ntfy", { server: sink.baseUrl, topic });
    sink.script(`/${topic}`, [{ status: 403 }]);
    const err = await refused(setup.test("ntfy"));
    expect([err.code, err.field]).toEqual(["test_failed", "token"]);
    const card = setup.channel("ntfy");
    expect(card).toMatchObject({ state: "error", error: d.ntfy.errors!.auth!.text, last: { ok: false, code: "auth" } });
  });
});
