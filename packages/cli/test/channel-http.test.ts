/** HTTP transport of the channel drivers (integrations plan U2, KTD8, KTD12) against the fake sink. */

import type { lookup as dnsLookup } from "node:dns";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { DeliveryError, MAX_BODY_BYTES, sendHttp, type HttpSendOptions } from "../src/channels/http.js";
import { startFakeSink, type FakeSink } from "./fixtures/fake-sink.js";

const UI = 47834;

/** A DNS answer for `host` only; anything else fails like an unknown name. */
function fakeDns(host: string, address: string): typeof dnsLookup {
  return ((name: string, _opts: unknown, cb: (err: Error | null, addrs?: { address: string; family: number }[]) => void) => {
    if (name === host) cb(null, [{ address, family: address.includes(":") ? 6 : 4 }]);
    else cb(Object.assign(new Error(`getaddrinfo ENOTFOUND ${name}`), { code: "ENOTFOUND" }));
  }) as unknown as typeof dnsLookup;
}

describe("sendHttp", () => {
  let sink: FakeSink;
  let waits: number[];
  beforeEach(async () => {
    sink = await startFakeSink();
    waits = [];
  });
  afterEach(() => sink.close());

  const opts = (over: Partial<HttpSendOptions> = {}): HttpSendOptions => ({ uiPorts: [UI], sleep: async (ms) => void waits.push(ms), ...over });
  const spec = (path = "/hook", url = `${sink.baseUrl}${path}`) => ({ type: "http" as const, method: "POST" as const, url, headers: { "Content-Type": "application/json" }, body: '{"version":1}' });
  const failure = async (p: Promise<unknown>) => {
    const err = await p.then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(DeliveryError);
    expect((err as Error).message).not.toContain(sink.baseUrl.replace("http://", ""));
    expect((err as Error).message).not.toContain("/hook");
    return err as DeliveryError;
  };

  it("500, 500, 200: three attempts with the same X-Tidegap-Delivery, waits 1 s and 3 s, result ok", async () => {
    sink.script("/hook", [{ status: 500 }, { status: 500 }, { status: 200 }]);
    const res = await sendHttp(spec(), opts());
    expect(res.attempts).toBe(3);
    const reqs = sink.requests("/hook");
    expect(reqs).toHaveLength(3);
    const ids = new Set(reqs.map((r) => r.headers["x-tidegap-delivery"]));
    expect(ids.size).toBe(1);
    expect([...ids][0]).toMatch(/^[0-9a-f-]{36}$/);
    expect(reqs[0]!.body).toBe('{"version":1}');
    expect(reqs[0]!.headers["content-type"]).toBe("application/json");
    expect(waits).toEqual([1000, 3000]);
  });

  it("429 with Retry-After: 2 waits about 2 s", async () => {
    sink.script("/hook", [{ status: 429, retryAfter: 2 }, { status: 200 }]);
    await sendHttp(spec(), opts());
    expect(waits).toEqual([2000]);
  });

  it("Discord-style 429: retry_after in the JSON body", async () => {
    sink.script("/hook", [{ status: 429, body: '{"retry_after": 1.5}' }, { status: 204 }]);
    await sendHttp(spec(), opts());
    expect(waits).toEqual([1500]);
  });

  it("Retry-After: 60 is beyond the cap: no wait, fails rate_limited", async () => {
    sink.script("/hook", [{ status: 429, retryAfter: 60 }]);
    const err = await failure(sendHttp(spec(), opts()));
    expect([err.code, err.status]).toEqual(["rate_limited", 429]);
    expect(waits).toEqual([]);
    expect(sink.requests("/hook")).toHaveLength(1);
  });

  it("404: one attempt, code http_404; 401 is auth", async () => {
    sink.script("/hook", [{ status: 404 }]);
    expect((await failure(sendHttp(spec(), opts()))).code).toBe("http_404");
    expect(sink.requests("/hook")).toHaveLength(1);
    sink.script("/auth", [{ status: 401 }]);
    expect((await failure(sendHttp(spec("/auth"), opts()))).code).toBe("auth");
  });

  it("302: code redirect, the Location is not followed", async () => {
    sink.script("/hook", [{ status: 302, location: `${sink.baseUrl}/elsewhere` }]);
    expect((await failure(sendHttp(spec(), opts()))).code).toBe("redirect");
    expect(sink.requests("/elsewhere")).toHaveLength(0);
  });

  it("a receiver slower than the job cap fails timeout within the cap", async () => {
    sink.script("/hook", [{ status: 200, delayMs: 2_000 }]);
    const t0 = Date.now();
    expect((await failure(sendHttp(spec(), opts({ totalMs: 300 })))).code).toBe("timeout");
    expect(Date.now() - t0).toBeLessThan(1_000);
  });

  it("the default cap is 20 s: a 25 s receiver times out in about 20 s", { timeout: 30_000 }, async () => {
    sink.script("/hook", [{ status: 200, delayMs: 25_000 }]);
    const t0 = Date.now();
    expect((await failure(sendHttp(spec(), opts()))).code).toBe("timeout");
    expect(Date.now() - t0).toBeGreaterThanOrEqual(19_900);
    expect(Date.now() - t0).toBeLessThan(21_500);
  });

  it("a refused connection is network, retried three times", async () => {
    const port = Number(new URL(sink.baseUrl).port);
    await sink.close();
    const err = await failure(sendHttp(spec("/hook", `http://127.0.0.1:${port}/hook`), opts()));
    expect(err.code).toBe("network");
    expect(waits).toEqual([1000, 3000]);
  });

  it("a host that resolves to 169.254.169.254 at send time is blocked_address; nothing is sent", async () => {
    const port = new URL(sink.baseUrl).port;
    const err = await failure(sendHttp(spec("/hook", `http://rebind.test:${port}/hook`), opts({ lookup: fakeDns("rebind.test", "169.254.169.254") })));
    expect(err.code).toBe("blocked_address");
    expect(waits).toEqual([]);
  });

  it("a host that resolves to loopback on the ui port is ui_port; on another port it is sent", async () => {
    const err = await failure(sendHttp(spec("/hook", `http://ui.test:${UI}/hook`), opts({ lookup: fakeDns("ui.test", "127.0.0.1") })));
    expect(err.code).toBe("ui_port");
    const port = new URL(sink.baseUrl).port;
    await sendHttp(spec("/hook", `http://lan.test:${port}/hook`), opts({ lookup: fakeDns("lan.test", "127.0.0.1") }));
    expect(sink.requests("/hook")).toHaveLength(1);
  });

  it("a TLS failure is tls, failed at once with no retry", async () => {
    // The sink speaks plain HTTP, so the TLS handshake of an https:// URL fails.
    const port = new URL(sink.baseUrl).port;
    const err = await failure(sendHttp(spec("/hook", `https://127.0.0.1:${port}/hook`), opts()));
    expect(err.code).toBe("tls");
    expect(waits).toEqual([]);
  });

  it("a literal metadata URL is refused before any connection", async () => {
    expect((await failure(sendHttp(spec("/hook", "http://169.254.169.254/latest"), opts()))).code).toBe("blocked_address");
  });

  it("reads at most 4 KiB of the answer", async () => {
    sink.script("/hook", [{ status: 200, body: "x".repeat(50_000) }]);
    const res = await sendHttp(spec(), opts());
    expect(res.body.length).toBeLessThanOrEqual(MAX_BODY_BYTES);
  });
});
