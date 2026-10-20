/** URL policy of the HTTP channel kinds (integrations plan U2, KTD8). */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { checkAddress, checkUrl, uiPortsFor } from "../src/channels/url-policy.js";
import { DEFAULT_UI_PORT, writeDiscovery } from "../src/ui/discovery.js";

const UI = 47833;
const policy = { uiPorts: [UI, DEFAULT_UI_PORT] };
const code = (url: string) => {
  const r = checkUrl(url, policy);
  return r.ok ? (r.warning ?? "ok") : r.code;
};

describe("checkUrl", () => {
  it("blocks the link-local metadata address in every spelling", () => {
    for (const u of [
      "http://169.254.169.254/latest/meta-data/",
      "http://169.254.1.1:8080/",
      "http://2852039166/",
      "http://0xa9fea9fe/",
      "http://[::ffff:169.254.169.254]/",
      "http://[fe80::1]/",
      "http://[fd00:ec2::254]/",
      "http://[fd20:ce::254]/",
      "http://[64:ff9b::a9fe:a9fe]/",
      "http://[2002:a9fe:a9fe::]/",
      "http://[::a9fe:a9fe]/",
      "http://100.100.100.200/",
      "http://0.0.0.0:9999/",
      "http://[::]/",
    ]) {
      expect([u, code(u)]).toEqual([u, "blocked_address"]);
    }
  });

  it("blocks the tidegap ui port on loopback, allows other loopback ports", () => {
    expect(code(`http://127.0.0.1:${UI}/`)).toBe("ui_port");
    expect(code(`http://localhost:${DEFAULT_UI_PORT}/api`)).toBe("ui_port");
    expect(code(`http://[::1]:${UI}/`)).toBe("ui_port");
    expect(code(`http://127.0.0.2:${UI}/`)).toBe("ui_port");
    expect(code("http://127.0.0.1:9999/")).toBe("ok");
    expect(code(`http://192.168.1.20:${UI}/`)).toBe("ok");
  });

  it("refuses other schemes, userinfo and garbage", () => {
    expect(code("ftp://x")).toBe("scheme");
    expect(code("file:///etc/passwd")).toBe("scheme");
    expect(code("https://u:p@host.example/")).toBe("userinfo");
    expect(code("https://u@host.example/")).toBe("userinfo");
    expect(code("not a url")).toBe("invalid_url");
  });

  it("allows LAN and https hosts; plain http to a public host warns cleartext", () => {
    expect(code("http://example.com")).toBe("cleartext");
    expect(code("http://203.0.113.9/hook")).toBe("cleartext");
    expect(code("https://example.com/hook")).toBe("ok");
    for (const u of ["http://192.168.1.10:8123/api/webhook/x", "http://10.0.0.5/", "http://homeassistant.local:8123/", "http://nas/", "http://100.101.102.103/", "http://[fd12::1]/"]) {
      expect([u, code(u)]).toEqual([u, "ok"]);
    }
  });
});

describe("checkAddress (send time)", () => {
  it("refuses a resolved metadata address and the ui port on loopback", () => {
    expect(checkAddress("169.254.169.254", 80, policy)).toEqual({ ok: false, code: "blocked_address" });
    expect(checkAddress("::ffff:a9fe:a9fe", 443, policy)).toEqual({ ok: false, code: "blocked_address" });
    expect(checkAddress("127.0.0.1", UI, policy)).toEqual({ ok: false, code: "ui_port" });
    expect(checkAddress("93.184.216.34", 443, policy)).toEqual({ ok: true });
  });
});

describe("uiPortsFor", () => {
  it("the running server's port from the discovery file plus the default; the default alone without one", () => {
    const dir = mkdtempSync(join(tmpdir(), "tidegap-policy-"));
    try {
      expect(uiPortsFor(dir)).toEqual([DEFAULT_UI_PORT]);
      writeDiscovery(dir, { pid: 1, port: UI, url: `http://127.0.0.1:${UI}`, started_at: new Date().toISOString(), cli_version: "0" });
      expect(uiPortsFor(dir)).toEqual([UI, DEFAULT_UI_PORT]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
