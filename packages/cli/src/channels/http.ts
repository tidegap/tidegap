/**
 * The HTTP transport of the channel drivers (integrations plan KTD8, KTD12).
 *
 * - One job has a 20 s cap over every attempt. Up to 3 attempts on a network
 *   error, a 5xx or a 429; waits of 1 s and 3 s, or the receiver's
 *   `Retry-After` (Discord: `retry_after` in the JSON body) when it is at
 *   most 10 s. A longer `Retry-After` fails at once (`rate_limited`). Any
 *   other 4xx, a redirect and a TLS error fail at once.
 * - Every attempt of a job carries the same `X-Tidegap-Delivery: <uuid>`, so
 *   a receiver can drop duplicates.
 * - Redirects are never followed (`redirect`: "Paste the final URL").
 * - The URL policy runs on the literal host before the first attempt and, in
 *   the socket's DNS lookup, on every address the name resolves to: the
 *   address that is checked is the one the socket connects to, so a name
 *   that rebinds to a blocked address between checks is still refused.
 * - The response body is read only to map an error, at most 4 KiB.
 * - A {@link DeliveryError} carries a code and the HTTP status only: never
 *   the URL (a webhook URL is a secret), a header or the body.
 */

import { randomUUID } from "node:crypto";
import { lookup as dnsLookup, type LookupAddress, type LookupOptions } from "node:dns";
import { request as httpRequest, type IncomingHttpHeaders } from "node:http";
import { request as httpsRequest } from "node:https";
import type { LookupFunction } from "node:net";

import type { DeliverySpec } from "@tidegap/core";

import { checkAddress, checkUrl, urlPort } from "./url-policy.js";

/** A failed delivery: a mapped code (`http_404`, `auth`, `timeout`, `tls`, `rate_limited`…) and the status. */
export class DeliveryError extends Error {
  constructor(
    readonly code: string,
    readonly status?: number,
    /** Another attempt may help (a network error). */
    readonly retry = false,
  ) {
    super(`delivery failed: ${code}`);
    this.name = "DeliveryError";
  }
}

export type HttpSpec = Extract<DeliverySpec, { type: "http" }>;

export interface HttpAnswer {
  status: number;
  headers: IncomingHttpHeaders;
  /** At most {@link MAX_BODY_BYTES}, decoded as UTF-8. */
  body: string;
  attempts: number;
}

export interface HttpSendOptions {
  /** Loopback ports of the `tidegap ui` server (URL policy). */
  uiPorts: readonly number[];
  /** Cap over every attempt of the job. Default 20 s. */
  totalMs?: number;
  /** Default 3. */
  attempts?: number;
  /** Waits before attempt 2, 3… when the receiver names none. Default 1 s, 3 s. */
  waitsMs?: readonly number[];
  /** A longer `Retry-After` fails the job. Default 10 s. */
  maxRetryAfterMs?: number;
  /** Tests: instant sleep, a DNS answer. */
  sleep?: (ms: number) => Promise<void>;
  lookup?: typeof dnsLookup;
  /**
   * A kind's code for a refused answer, read from its status and body
   * (Pushover names the bad field in JSON); undefined keeps the status code.
   * The body never leaves this function.
   */
  mapError?: (status: number, body: string) => string | undefined;
}

export const MAX_BODY_BYTES = 4096;
const TOTAL_MS = 20_000;
const WAITS_MS = [1_000, 3_000];
const MAX_RETRY_AFTER_MS = 10_000;

/** The code of a non-2xx status. */
export function statusCode(status: number): string {
  if (status === 401 || status === 403) return "auth";
  if (status === 429) return "rate_limited";
  if (status >= 300 && status < 400) return "redirect";
  return `http_${status}`;
}

/** Certificate and handshake failures; `EPROTO` is a failed handshake (a receiver that does not speak TLS, an old protocol). */
const TLS_ERROR = /^(EPROTO$|CERT_|ERR_TLS_|ERR_SSL_|UNABLE_TO_|DEPTH_ZERO_|SELF_SIGNED_|HOSTNAME_MISMATCH)/;

/** The receiver's wait in ms: `Retry-After` seconds or date, else Discord's JSON `retry_after` (seconds). */
export function retryAfterMs(headers: IncomingHttpHeaders, body: string, now: number = Date.now()): number | undefined {
  const h = headers["retry-after"];
  if (typeof h === "string" && h.trim()) {
    if (/^\d+(\.\d+)?$/.test(h.trim())) return Math.ceil(Number(h) * 1000);
    const at = Date.parse(h);
    if (Number.isFinite(at)) return Math.max(0, at - now);
  }
  try {
    const v = (JSON.parse(body) as { retry_after?: unknown }).retry_after;
    if (typeof v === "number" && Number.isFinite(v) && v >= 0) return Math.ceil(v * 1000);
  } catch {
    // not JSON
  }
  return undefined;
}

/**
 * A socket `lookup` that applies the URL policy to every address a name
 * resolves to, so the address checked is the one the socket connects to
 * (KTD8). Shared by the HTTP and SMTP transports.
 */
export function policyLookup(port: number, opts: Pick<HttpSendOptions, "uiPorts" | "lookup">): LookupFunction {
  const resolve = opts.lookup ?? dnsLookup;
  return (hostname, options, cb) => {
    resolve(hostname, { ...(options as LookupOptions), all: true }, (err, addresses) => {
      if (err) return cb(err, "", 0);
      const all = addresses as unknown as LookupAddress[];
      for (const a of all) {
        const res = checkAddress(a.address, port, opts);
        if (!res.ok) return cb(new DeliveryError(res.code), "", 0);
      }
      if ((options as LookupOptions).all) return cb(null, all);
      const first = all[0];
      if (!first) return cb(Object.assign(new Error("no address"), { code: "ENOTFOUND" }), "", 0);
      cb(null, first.address, first.family);
    });
  };
}

/** One attempt; rejects with a {@link DeliveryError}. */
function attempt(url: URL, spec: HttpSpec, headers: Record<string, string>, timeoutMs: number, opts: HttpSendOptions): Promise<Omit<HttpAnswer, "attempts">> {
  const lookup = policyLookup(urlPort(url), opts);
  return new Promise((ok, fail) => {
    let settled = false;
    const done = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn();
    };
    const send = url.protocol === "https:" ? httpsRequest : httpRequest;
    const req = send(url, { method: spec.method, headers, lookup, agent: false }, (res) => {
      const chunks: Buffer[] = [];
      let size = 0;
      const finish = () =>
        done(() => ok({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).subarray(0, MAX_BODY_BYTES).toString("utf8") }));
      res.on("data", (c: Buffer) => {
        chunks.push(c);
        size += c.length;
        if (size >= MAX_BODY_BYTES) {
          finish();
          res.destroy();
        }
      });
      res.on("end", finish);
      res.on("error", () => finish());
    });
    const timer = setTimeout(() => {
      done(() => fail(new DeliveryError("timeout")));
      req.destroy();
    }, timeoutMs);
    req.on("error", (err: NodeJS.ErrnoException) =>
      done(() => {
        if (err instanceof DeliveryError) return fail(err);
        if (TLS_ERROR.test(err.code ?? "")) return fail(new DeliveryError("tls"));
        fail(new DeliveryError("network", undefined, true));
      }),
    );
    req.end(spec.body);
  });
}

const sleepMs = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Send one HTTP delivery with retries (KTD12). Resolves with the 2xx answer;
 * rejects with a {@link DeliveryError}.
 */
export async function sendHttp(spec: HttpSpec, opts: HttpSendOptions): Promise<HttpAnswer> {
  const policy = checkUrl(spec.url, opts);
  if (!policy.ok) throw new DeliveryError(policy.code);
  const headers: Record<string, string> = {
    "User-Agent": "Tidegap",
    ...spec.headers,
    "X-Tidegap-Delivery": randomUUID(),
    "Content-Length": String(Buffer.byteLength(spec.body)),
  };
  const deadline = Date.now() + (opts.totalMs ?? TOTAL_MS);
  const attempts = opts.attempts ?? 3;
  const waits = opts.waitsMs ?? WAITS_MS;
  const sleep = opts.sleep ?? sleepMs;
  for (let n = 1; ; n++) {
    const left = deadline - Date.now();
    if (left <= 0) throw new DeliveryError("timeout");
    let failure: DeliveryError;
    let wait = waits[n - 1] ?? waits[waits.length - 1] ?? 0;
    try {
      const answer = await attempt(policy.url, spec, headers, left, opts);
      if (answer.status >= 200 && answer.status < 300) return { ...answer, attempts: n };
      failure = new DeliveryError(opts.mapError?.(answer.status, answer.body) ?? statusCode(answer.status), answer.status);
      if (answer.status !== 429 && answer.status < 500) throw failure;
      const asked = answer.status === 429 || answer.status === 503 ? retryAfterMs(answer.headers, answer.body) : undefined;
      if (asked !== undefined) {
        if (asked > (opts.maxRetryAfterMs ?? MAX_RETRY_AFTER_MS)) throw failure;
        wait = asked;
      }
    } catch (err) {
      if (!(err instanceof DeliveryError) || !err.retry) throw err;
      failure = err;
    }
    if (n >= attempts || Date.now() + wait >= deadline) throw failure;
    await sleep(wait);
  }
}
