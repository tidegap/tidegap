/** The SMTP client (integrations plan U11, KTD5) against the fake SMTP server. */

import { afterEach, describe, expect, it, vi } from "vitest";

import { DeliveryError } from "../src/channels/http.js";
import { buildMessage, dotStuff, encodeHeader, ReplyReader, sendSmtp, type SmtpOptions, type SmtpSpec } from "../src/channels/smtp.js";
import { startFakeSmtp, testTls, type FakeSmtp, type FakeSmtpOptions } from "./fixtures/fake-smtp.js";

const PASSWORD = "app-pass-sEcReT-11";
let smtp: FakeSmtp | undefined;
afterEach(async () => {
  await smtp?.close();
  smtp = undefined;
});

const start = async (o: FakeSmtpOptions) => (smtp = await startFakeSmtp({ users: { "me@example.com": PASSWORD }, ...o }));
const spec = (port: number, over: Partial<SmtpSpec> = {}): SmtpSpec => ({
  type: "smtp", host: "localhost", port, security: "tls", user: "me@example.com", password: PASSWORD,
  from: "me@example.com", to: "me@example.com", subject: "Tidegap: Done: café ☕", text: "Done: build\n.hidden line\nÜnïcode", ...over,
});
const opts = { uiPorts: [1], ca: testTls().cert };
const code = (p: Promise<unknown>) => p.then(() => "ok", (e: unknown) => (e instanceof DeliveryError ? e.code : `not a DeliveryError: ${String(e)}`));

describe("sendSmtp", () => {
  it("implicit TLS: EHLO, AUTH PLAIN, MAIL, RCPT, DATA, QUIT in order; subject and UTF-8 body arrive", async () => {
    const s = await start({ mode: "tls" });
    await sendSmtp(spec(s.port), opts);
    await vi.waitFor(() => expect(s.commands().at(-1)?.line).toBe("QUIT"));
    expect(s.commands().map((c) => c.line.split(" ")[0])).toEqual(["EHLO", "AUTH", "MAIL", "RCPT", "DATA", "QUIT"]);
    expect(s.commands()[1]!.line).toBe("AUTH PLAIN");
    const [mail] = s.messages();
    expect(mail).toMatchObject({ from: "me@example.com", to: ["me@example.com"], user: "me@example.com", subject: "Tidegap: Done: café ☕", text: "Done: build\r\n.hidden line\r\nÜnïcode" });
    expect(mail!.data).toMatch(/^Message-ID: <[0-9a-f-]+@example\.com>$/m);
    expect(mail!.data).toMatch(/^Content-Transfer-Encoding: base64$/m);
  });

  it("STARTTLS: AUTH is sent only after the upgrade (the server offers it only then)", async () => {
    const s = await start({ mode: "starttls" });
    await sendSmtp(spec(s.port, { security: "starttls" }), opts);
    const cmds = s.commands();
    expect(cmds.map((c) => c.line.split(" ")[0]).slice(0, 7)).toEqual(["EHLO", "STARTTLS", "EHLO", "AUTH", "MAIL", "RCPT", "DATA"]);
    expect(cmds.map((c) => c.tls).slice(0, 3)).toEqual([false, false, true]);
    expect(cmds.find((c) => c.line.startsWith("AUTH"))?.tls).toBe(true);
    expect(s.messages()).toHaveLength(1);
  });

  it("a server that offers only AUTH LOGIN gets LOGIN; a multi-line EHLO is parsed", async () => {
    const s = await start({ mode: "tls", auth: ["LOGIN"] });
    await sendSmtp(spec(s.port), opts);
    expect(s.commands().find((c) => c.line.startsWith("AUTH"))?.line).toBe("AUTH LOGIN");
    expect(s.messages()[0]?.user).toBe("me@example.com");
  });

  it("security none: allowed to 127.0.0.1 with a login; refused to any other host before connecting", async () => {
    const s = await start({ mode: "plain" });
    await sendSmtp(spec(s.port, { host: "127.0.0.1", security: "none" }), opts);
    expect(s.messages()).toHaveLength(1);
    expect(await code(sendSmtp(spec(s.port, { host: "smtp.example.com", security: "none" }), opts))).toBe("cleartext");
  });

  it("535 → auth; no offered mechanism → auth_unsupported; no STARTTLS offered → starttls_unsupported", async () => {
    const s = await start({ mode: "tls" });
    expect(await code(sendSmtp(spec(s.port, { password: "wrong" }), opts))).toBe("auth");
    await s.close();
    const none = await start({ mode: "tls", auth: [] });
    expect(await code(sendSmtp(spec(none.port), opts))).toBe("auth_unsupported");
    await none.close();
    const plain = await start({ mode: "plain" });
    expect(await code(sendSmtp(spec(plain.port, { host: "127.0.0.1", security: "starttls" }), opts))).toBe("starttls_unsupported");
    expect(plain.messages()).toEqual([]);
  });

  it("refused sender, recipient and policy replies map to their codes", async () => {
    for (const [replies, expected] of [
      [{ MAIL: "550 5.1.0 sender rejected" }, "smtp_sender"],
      [{ RCPT: "550 5.1.1 no such user" }, "smtp_recipient"],
      [{ END: "554 5.7.1 message refused" }, "smtp_policy"],
      [{ MAIL: "530 5.7.0 Authentication required" }, "auth_required"],
      [{ RCPT: "451 4.3.0 try later" }, "smtp_451"],
    ] as const) {
      const s = await start({ mode: "tls", replies });
      expect(await code(sendSmtp(spec(s.port), opts))).toBe(expected);
      await s.close();
      smtp = undefined;
    }
  });

  it("STARTTLS refused with 454: fails smtp_454, and no login, no mail and no further command is sent in the clear", async () => {
    const s = await start({ mode: "starttls", replies: { STARTTLS: "454 4.7.0 TLS not available due to temporary reason" } });
    expect(await code(sendSmtp(spec(s.port, { security: "starttls", host: "127.0.0.1" }), opts))).toBe("smtp_454");
    expect(s.commands().map((c) => c.line)).toEqual(["EHLO localhost", "STARTTLS"]);
    expect(s.commands().some((c) => c.tls)).toBe(false);
    expect(s.messages()).toEqual([]);
  });

  it("bytes sent right after the STARTTLS 220 are dropped, not read as the EHLO reply: the real EHLO and AUTH go over TLS", async () => {
    const s = await start({ mode: "starttls", afterStarttls: ["250-injected.example", "250 AUTH PLAIN"] });
    await sendSmtp(spec(s.port, { security: "starttls" }), opts);
    const cmds = s.commands();
    expect(cmds.map((c) => c.line.split(" ")[0]).slice(0, 5)).toEqual(["EHLO", "STARTTLS", "EHLO", "AUTH", "MAIL"]);
    expect(cmds.map((c) => c.tls).slice(0, 4)).toEqual([false, false, true, true]);
    expect(s.messages()).toHaveLength(1);
  });

  it("an untrusted certificate → tls; a server that never greets → timeout", async () => {
    const s = await start({ mode: "tls" });
    expect(await code(sendSmtp(spec(s.port), { uiPorts: [1] }))).toBe("tls");
    await s.close();
    const silent = await start({ mode: "plain", silent: true });
    const t0 = Date.now();
    expect(await code(sendSmtp(spec(silent.port, { host: "127.0.0.1", security: "none" }), { ...opts, totalMs: 200 }))).toBe("timeout");
    expect(Date.now() - t0).toBeLessThan(2000);
  });

  it("the URL policy refuses link-local hosts; a closed port is network", async () => {
    expect(await code(sendSmtp(spec(25, { host: "169.254.169.254" }), opts))).toBe("blocked_address");
    const s = await start({ mode: "plain" });
    const port = s.port;
    await s.close();
    smtp = undefined;
    expect(await code(sendSmtp(spec(port, { host: "127.0.0.1", security: "none" }), opts))).toBe("network");
  });

  it("a host name goes through the URL policy on every address it resolves to, before any socket opens (tls, starttls)", async () => {
    const asked: string[] = [];
    const lookup = ((host: string, _o: unknown, cb: (e: null, a: { address: string; family: number }[]) => void) => {
      asked.push(host);
      cb(null, [{ address: "203.0.113.7", family: 4 }, { address: "169.254.169.254", family: 4 }]);
    }) as unknown as NonNullable<SmtpOptions["lookup"]>;
    for (const security of ["tls", "starttls"] as const) {
      expect(await code(sendSmtp(spec(587, { host: "mail.example.com", security }), { ...opts, lookup }))).toBe("blocked_address");
    }
    expect(asked).toEqual(["mail.example.com", "mail.example.com"]);
  });

  it("errors never carry the password or a server reply", async () => {
    const s = await start({ mode: "tls" });
    const err = await sendSmtp(spec(s.port, { password: "wrong-sEcReT" }), opts).catch((e: Error) => e);
    expect(String(err) + JSON.stringify(err)).not.toMatch(/sEcReT|credentials/);
  });
});

describe("message building", () => {
  it("dot-stuffs every line that starts with a dot", () => {
    expect(dotStuff(".a\r\nb\r\n.c\r\n..d")).toBe("..a\r\nb\r\n..c\r\n...d");
  });

  it("a non-ASCII subject is RFC 2047 words under 76 characters; control characters never split the header", () => {
    const long = encodeHeader("Tidegap: ".concat("ü".repeat(60)));
    for (const line of long.split("\r\n")) expect(line.length).toBeLessThanOrEqual(76);
    expect(encodeHeader("x\r\nBcc: evil@example.com")).toBe("x Bcc: evil@example.com");
    const msg = buildMessage({ from: "a@b.example", to: "c@d.example", subject: "s\r\nBcc: e@f.example", text: "hi" }, new Date("2026-10-20T10:00:00Z"));
    expect(msg).not.toMatch(/^Bcc:/m);
    expect(msg).toMatch(/^Date: Tue, 20 Oct 2026 10:00:00 \+0000$/m);
  });

  it("the reply reader joins 250- continuation lines and stops at 250 space", async () => {
    const r = new ReplyReader({ setEncoding() {}, on() {} } as never);
    r.push("250-smtp.example.com\r\n250-AUTH PLAIN LOGIN\r\n250 8BITMIME\r\n220 next\r\n");
    expect(await r.next()).toEqual({ code: 250, lines: ["smtp.example.com", "AUTH PLAIN LOGIN", "8BITMIME"] });
    expect((await r.next()).code).toBe(220);
  });
});
