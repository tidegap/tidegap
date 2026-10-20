/** Pushover driver (integrations plan U10) against the fake sink as the API (TIDEGAP_PUSHOVER_API_BASE). */

import { describe, expect, it } from "vitest";

import { pushover } from "../src/channels/drivers/pushover.js";
import { DeliveryError } from "../src/channels/http.js";
import { readSecrets } from "../src/channels/secrets.js";
import { kindEnv, refused } from "./channel-kinds-helpers.js";

const USER = "uQiRzpo4DXghDmr9QzzfQu27cmVRsG";
const TOKEN = "azGDORePK8gMaC0QOYAMyEEuzJnyUi";
const PATH = "/1/messages.json";
const childEnv = { PATH: "/usr/bin:/bin" };

describe("pushover", () => {
  const env = kindEnv((_dir, sink) => ({ driver: { env: { pushoverApiBase: sink.baseUrl, pushoverApiBaseRejected: false, shortcutsBin: "/nonexistent", childEnv } } }));

  it("connect posts the form to /1/messages.json; answers hold hints only", async () => {
    const { sink, setup, secretsFile } = env();
    const channel = await setup.connect("pushover", { user_key: USER, app_token: TOKEN });
    expect(channel).toMatchObject({ state: "connected", target: `user …${USER.slice(-4)}` });
    expect(JSON.stringify(channel)).not.toContain(USER.slice(0, 20));
    const [req] = sink.requests(PATH);
    const form = new URLSearchParams(req!.body);
    expect([form.get("token"), form.get("user"), form.get("message")]).toEqual([TOKEN, USER, "Test message from Tidegap. Notifications work."]);
    expect(req!.headers["content-type"]).toBe("application/x-www-form-urlencoded");
    expect(readSecrets("pushover", secretsFile)).toEqual({ user_key: USER, app_token: TOKEN });
  });

  it("400 {user: invalid} → the user key field; {token: invalid} → the API token field; nothing saved", async () => {
    const { sink, setup, store } = env();
    sink.script(PATH, [{ status: 400, body: JSON.stringify({ status: 0, user: "invalid", errors: ["user identifier is invalid"] }) }]);
    const user = await refused(setup.connect("pushover", { user_key: USER, app_token: TOKEN }));
    expect([user.code, user.field, user.delivery]).toEqual(["test_failed", "user_key", "pushover_user"]);
    sink.script(PATH, [{ status: 400, body: JSON.stringify({ status: 0, token: "invalid", errors: ["application token is invalid"] }) }]);
    const token = await refused(setup.connect("pushover", { user_key: USER, app_token: TOKEN }));
    expect([token.field, token.message]).toEqual(["app_token", "Pushover refused the API token. Copy it again from the application page, or create a new one."]);
    expect(store.listChannels()).toEqual([]);
  });

  it("a key that is not 30 letters and digits is invalid before any send", async () => {
    const { sink, setup } = env();
    const err = await refused(setup.connect("pushover", { user_key: "short", app_token: TOKEN }));
    expect([err.code, err.field]).toEqual(["invalid", "user_key"]);
    expect(sink.requests()).toEqual([]);
  });

  it("a non-loopback override is ignored with one log line: the public API host is used", async () => {
    const seen: string[] = [];
    const lines: string[] = [];
    const lookup = ((host: string, _o: unknown, cb: (e: Error) => void) => {
      seen.push(host);
      cb(Object.assign(new Error("offline"), { code: "ENOTFOUND" }));
    }) as never;
    const spec = pushover.send.bind(pushover);
    const ctx = { http: { uiPorts: [1], attempts: 1, lookup }, env: { pushoverApiBaseRejected: true, shortcutsBin: "", childEnv }, log: (l: string) => lines.push(l) };
    const http = { type: "http" as const, method: "POST" as const, url: "https://api.pushover.net/1/messages.json", headers: {}, body: "x=1" };
    for (let i = 0; i < 2; i++) await expect(spec(http, ctx)).rejects.toBeInstanceOf(DeliveryError);
    expect(seen).toEqual(["api.pushover.net", "api.pushover.net"]);
    expect(lines).toEqual(["tidegap: TIDEGAP_PUSHOVER_API_BASE is not a loopback http URL; using the public Pushover API"]);
  });
});
