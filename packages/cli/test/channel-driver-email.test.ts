/** Email driver (integrations plan U11) through ChannelSetup against the fake SMTP server. */

import { afterEach, describe, expect, it } from "vitest";

import { readSecrets } from "../src/channels/secrets.js";
import { kindEnv, refused } from "./channel-kinds-helpers.js";
import { startFakeSmtp, TEST_CERT, type FakeSmtp } from "./fixtures/fake-smtp.js";

const PASSWORD = "app-pass-sEcReT-42";

describe("email", () => {
  const env = kindEnv(() => ({ driver: { smtp: { ca: TEST_CERT } } }));
  let smtp: FakeSmtp;
  afterEach(async () => smtp?.close());
  const fields = (over: Record<string, unknown> = {}) => ({ user: "me@example.com", password: PASSWORD, host: "localhost", port: smtp.port, security: "tls", ...over });

  it("connect sends one test mail over TLS; the card shows the address, the password is a hint", async () => {
    smtp = await startFakeSmtp({ mode: "tls", users: { "me@example.com": PASSWORD } });
    const { setup, secretsFile } = env();
    const channel = await setup.connect("email", fields({ to: "ops@example.com" }));
    expect(channel).toMatchObject({ state: "connected", target: "ops@example.com", fields: { user: "me@example.com", host: "localhost", security: "tls", to: "ops@example.com" } });
    expect(channel.secrets.password).toBe("…T-42");
    expect(JSON.stringify(channel)).not.toContain(PASSWORD);
    const [mail] = smtp.messages();
    expect(mail).toMatchObject({ from: "me@example.com", to: ["ops@example.com"], user: "me@example.com", subject: "Tidegap: Tidegap test message" });
    expect(mail!.text).toBe("Test message from Tidegap. Notifications work.");
    expect(readSecrets("email", secretsFile)).toEqual({ password: PASSWORD });
  });

  it("535 → the password field with the app-password sentence; nothing saved", async () => {
    smtp = await startFakeSmtp({ mode: "tls", users: { "me@example.com": "other" } });
    const { setup, store } = env();
    const err = await refused(setup.connect("email", fields()));
    expect([err.code, err.field, err.message]).toEqual(["test_failed", "password", "The mail server refused the user name or password. Gmail, iCloud and Fastmail need an app password."]);
    expect(store.listChannels()).toEqual([]);
  });

  it("an untrusted certificate is a tls error on the host field", async () => {
    smtp = await startFakeSmtp({ mode: "tls" });
    const { store, secretsFile } = env();
    const { ChannelSetup } = await import("../src/channels/channel-setup.js");
    const plain = new ChannelSetup({ store, secretsFile, uiPorts: () => [1], platform: "linux" });
    const err = await refused(plain.connect("email", fields()));
    expect([err.field, err.delivery, err.message]).toEqual(["host", "tls", "The mail server's certificate is not trusted. Check the server name and the security setting."]);
  });

  it("security none is refused for a host off this computer before any connection", async () => {
    smtp = await startFakeSmtp({ mode: "plain" });
    const { setup } = env();
    const err = await refused(setup.connect("email", fields({ host: "smtp.example.com", security: "none" })));
    expect([err.code, err.field]).toEqual(["invalid", "security"]);
    expect(smtp.commands()).toEqual([]);
  });

  it("a new host drops the stored password (keepWith): it must be typed again; clear removes it on the same host", async () => {
    smtp = await startFakeSmtp({ mode: "plain" });
    const { setup, secretsFile } = env();
    await setup.connect("email", fields({ host: "127.0.0.1", security: "none" }));
    expect(smtp.messages()[0]?.user).toBe("me@example.com");
    const same = await setup.connect("email", { port: smtp.port });
    expect([smtp.messages()[1]?.user, same.secrets.password]).toEqual(["me@example.com", "…T-42"]);
    const moved = await setup.connect("email", { host: "localhost" });
    expect([smtp.messages()[2]?.user, moved.secrets.password]).toEqual([undefined, undefined]);
    expect(readSecrets("email", secretsFile)).toBeUndefined();
    await setup.connect("email", { host: "127.0.0.1", password: PASSWORD });
    const cleared = await setup.connect("email", {}, { clear: ["password"] });
    expect(cleared.secrets.password).toBeUndefined();
    expect(smtp.messages().at(-1)?.user).toBeUndefined();
  });
});
