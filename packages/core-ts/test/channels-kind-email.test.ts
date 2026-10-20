/** Email kind (integrations plan U11): fields, presets, security rule, Outlook refusal, spec. */

import { describe, expect, it } from "vitest";

import { KIND_DESCRIPTORS, validateFields } from "../src/index.js";
import type { NotificationPayload } from "../src/index.js";
import { headerLine, isLoopbackHost } from "../src/channels/kinds/email.js";

const email = KIND_DESCRIPTORS.email;
const at = "2026-10-20T10:00:00.000Z";
const failed: NotificationPayload = { event: "task_failed", level: "error", title: "Failed: build", text: "Failed: build\nexit 1", at };
const base = { user: "me@example.com", host: "smtp.example.com", port: "465", security: "tls", password: "pw" };
const values = (input: Record<string, string>) => {
  const v = validateFields(email, input);
  if (!v.ok) throw new Error(`invalid ${v.field}`);
  return { ...v.values, ...v.secrets };
};
const spec = (input: Record<string, string>, p: NotificationPayload = failed) => {
  const s = email.format!(p, values(input));
  if (s.type !== "smtp") throw new Error("not smtp");
  return s;
};

describe("email", () => {
  it("from defaults to the address, to defaults to from; the subject is one line", () => {
    expect(spec(base)).toEqual({
      type: "smtp", host: "smtp.example.com", port: 465, security: "tls", user: "me@example.com", password: "pw",
      from: "me@example.com", to: "me@example.com", subject: "Tidegap: Failed: build", text: failed.text,
    });
    expect(spec({ ...base, from: "bot@example.com" }).to).toBe("bot@example.com");
    expect(spec({ ...base, to: "ops@example.com" })).toMatchObject({ from: "me@example.com", to: "ops@example.com" });
  });

  it("a subject with CR, LF and a Bcc line keeps none of the line breaks", () => {
    const s = spec(base, { ...failed, title: "x\r\nBcc: evil@example.com" });
    expect(s.subject).toBe("Tidegap: x Bcc: evil@example.com");
    expect(headerLine("a b\u0000c")).toBe("a b c");
  });

  it("Gmail app passwords lose their spaces; other hosts keep the password as typed; no password means no login", () => {
    expect(spec({ ...base, host: "smtp.gmail.com", password: "abcd efgh ijkl mnop" }).password).toBe("abcdefghijklmnop");
    expect(spec({ ...base, password: "pass word" }).password).toBe("pass word");
    const anon = spec({ ...base, host: "127.0.0.1", security: "none", password: "" });
    expect(["user" in anon, "password" in anon]).toEqual([false, false]);
  });

  it("addresses are plain local@domain: angle brackets, spaces and two addresses are refused", () => {
    for (const user of ["Me <me@example.com>", "me@example.com, you@example.com", "me@exa mple.com", "me", "me@localhost"]) {
      expect(validateFields(email, { ...base, user })).toMatchObject({ ok: false, field: "user" });
    }
    expect(validateFields(email, { ...base, to: "x@y.z\r\nBcc: a@b.c" })).toMatchObject({ ok: false, field: "to" });
  });

  it("security none is allowed only to a loopback host; Outlook.com personal is refused with the reason", () => {
    expect(email.validate!(values({ ...base, host: "127.0.0.1", security: "none" }))).toBeUndefined();
    expect(email.validate!(values({ ...base, host: "localhost", security: "none" }))).toBeUndefined();
    expect(email.validate!(values({ ...base, security: "none" }))?.field).toBe("security");
    expect(email.validate!(values({ ...base, host: "smtp-mail.outlook.com" }))?.field).toBe("host");
    expect(email.validate!(values({ ...base, user: "me@hotmail.com" }))).toMatchObject({ field: "user", text: expect.stringMatching(/Outlook\.com and Hotmail/) });
    expect([isLoopbackHost("127.0.0.2"), isLoopbackHost("[::1]"), isLoopbackHost("10.0.0.1")]).toEqual([true, true, false]);
  });

  it("host is a name only; port is 1 to 65535; the password follows the host (keepWith)", () => {
    expect(validateFields(email, { ...base, host: "https://smtp.example.com" })).toMatchObject({ ok: false, field: "host" });
    expect(validateFields(email, { ...base, port: "70000" })).toMatchObject({ ok: false, field: "port" });
    expect(email.fields.find((f) => f.name === "password")).toMatchObject({ secret: true, keepWith: "host" });
    expect(email.fields.find((f) => f.name === "password")?.required).toBeUndefined();
  });

  it("presets fill host, port and security; Microsoft 365 says Outlook.com is not supported", () => {
    expect(email.presets!.map((p) => [p.id, p.values.host, p.values.port, p.values.security])).toEqual([
      ["gmail", "smtp.gmail.com", 465, "tls"],
      ["icloud", "smtp.mail.me.com", 587, "starttls"],
      ["fastmail", "smtp.fastmail.com", 465, "tls"],
      ["m365", "smtp.office365.com", 587, "starttls"],
    ]);
    expect(email.presets!.find((p) => p.id === "m365")?.note).toMatch(/Outlook\.com and Hotmail personal accounts are not supported/);
    expect(email.steps.at(-1)?.text).toMatch(/Outlook\.com and Hotmail personal accounts are not supported/);
  });
});
