/**
 * A small SMTP client for the email channel (all-channels plan KTD5), on
 * `node:net` and `node:tls`, with no dependency.
 *
 * - EHLO, STARTTLS or implicit TLS, AUTH PLAIN or LOGIN, MAIL, RCPT, DATA
 *   with dot-stuffing, QUIT. Plain text, UTF-8, base64 body, RFC 2047
 *   subject.
 * - TLS certificates are always verified. A password is sent only over TLS,
 *   or to a server on this computer (security `none` is loopback only).
 * - The URL policy runs on every address the host resolves to (link-local
 *   and cloud metadata addresses are refused), on the socket that uses it.
 * - Timeouts: 15 s to connect, 30 s in total. No retry: a second mail after
 *   an unclear failure is worse than none (KTD12).
 * - Every failure is a {@link DeliveryError} with a code: never the
 *   password, an address or a server reply.
 */

import { randomUUID } from "node:crypto";
import { lookup as dnsLookup } from "node:dns";
import { connect as netConnect, isIP, type Socket } from "node:net";
import { connect as tlsConnect, type TLSSocket } from "node:tls";

import { isLoopbackSmtpHost, type DeliverySpec } from "@tidegap/core";

import { DeliveryError, policyLookup } from "./http.js";
import { checkAddress } from "./url-policy.js";

export type SmtpSpec = Extract<DeliverySpec, { type: "smtp" }>;

export interface SmtpOptions {
  /** Loopback ports of the `tidegap ui` server (URL policy). */
  uiPorts: readonly number[];
  /** Default 15 s. */
  connectMs?: number;
  /** Default 30 s. */
  totalMs?: number;
  /** Tests only: a CA to trust (a self-signed test server). Never set from config. */
  ca?: string | Buffer;
  /** Tests: a DNS answer. */
  lookup?: typeof dnsLookup;
}

const CONNECT_MS = 15_000;
const TOTAL_MS = 30_000;

/** The name this client gives in EHLO. */
const CLIENT_NAME = "localhost";

const TLS_ERROR = /^(EPROTO$|CERT_|ERR_TLS_|ERR_SSL_|UNABLE_TO_|DEPTH_ZERO_|SELF_SIGNED_|HOSTNAME_MISMATCH)/;

/** One SMTP reply: the code and the text of every line. */
export interface SmtpReply {
  code: number;
  lines: string[];
}

/**
 * Reads replies from a socket: lines `ddd-text` continue a reply, `ddd text`
 * (or a bare `ddd`) ends it. A malformed line fails the read.
 */
export class ReplyReader {
  private buf = "";
  private lines: string[] = [];
  private readonly ready: SmtpReply[] = [];
  private waiter?: { ok: (r: SmtpReply) => void; fail: (e: Error) => void };
  private error?: Error;

  constructor(socket: Socket) {
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => this.push(chunk));
  }

  /** Feed received text; exposed for the parser tests. */
  push(chunk: string): void {
    this.buf += chunk;
    let i: number;
    while ((i = this.buf.indexOf("\n")) >= 0) {
      const line = this.buf.slice(0, i).replace(/\r$/, "");
      this.buf = this.buf.slice(i + 1);
      const m = /^(\d{3})([ -]?)(.*)$/.exec(line);
      if (!m) return this.fail(new DeliveryError("smtp_protocol"));
      this.lines.push(m[3]!);
      if (m[2] === "-") continue;
      this.ready.push({ code: Number(m[1]), lines: this.lines });
      this.lines = [];
    }
    if (this.buf.length > 4096) this.fail(new DeliveryError("smtp_protocol"));
    this.flush();
  }

  fail(err: Error): void {
    this.error ??= err;
    this.flush();
  }

  private flush(): void {
    if (!this.waiter) return;
    const next = this.ready.shift();
    const w = this.waiter;
    if (next) {
      this.waiter = undefined;
      w.ok(next);
    } else if (this.error) {
      this.waiter = undefined;
      w.fail(this.error);
    }
  }

  next(): Promise<SmtpReply> {
    return new Promise((ok, fail) => {
      this.waiter = { ok, fail };
      this.flush();
    });
  }
}

/** `.` doubled at the start of every line (RFC 5321 4.5.2). */
export function dotStuff(text: string): string {
  return text.replace(/(^|\r\n)\./g, "$1..");
}

/** UTF-8 bytes per RFC 2047 word: 45 bytes are 60 base64 characters, so "=?UTF-8?B?…?=" stays within the 75-character limit. */
const MAX_WORD_BYTES = 45;

/** A header value: as is when printable ASCII, else RFC 2047 base64 words of at most 75 characters, folded. */
export function encodeHeader(text: string): string {
  const clean = text.replace(/[\u0000-\u001f\u007f]+/g, " ");
  if (/^[\x20-\x7e]*$/.test(clean)) return clean;
  const words: string[] = [];
  let chunk = "";
  for (const ch of clean) {
    if (Buffer.byteLength(chunk + ch, "utf8") > MAX_WORD_BYTES) {
      words.push(chunk);
      chunk = "";
    }
    chunk += ch;
  }
  if (chunk) words.push(chunk);
  return words.map((w) => `=?UTF-8?B?${Buffer.from(w, "utf8").toString("base64")}?=`).join("\r\n ");
}

/** An RFC 5322 date. */
function mailDate(now: Date): string {
  return now.toUTCString().replace(/GMT$/, "+0000");
}

/** The whole message: headers, a blank line, the base64 body in 76-character lines. */
export function buildMessage(spec: Pick<SmtpSpec, "from" | "to" | "subject" | "text">, now: Date = new Date()): string {
  const domain = spec.from.split("@")[1] ?? "localhost";
  const body = Buffer.from(spec.text.replace(/\r?\n/g, "\r\n"), "utf8").toString("base64").replace(/.{76}/g, "$&\r\n");
  return [
    `Date: ${mailDate(now)}`,
    `From: <${spec.from}>`,
    `To: <${spec.to}>`,
    `Subject: ${encodeHeader(spec.subject)}`,
    `Message-ID: <${randomUUID()}@${domain}>`,
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=utf-8",
    "Content-Transfer-Encoding: base64",
    "Auto-Submitted: auto-generated",
    "X-Mailer: Tidegap",
    "",
    body.replace(/\r\n$/, ""),
  ].join("\r\n");
}

/** The code of an unexpected reply at a step. */
function replyCode(reply: SmtpReply, step: "auth" | "mail" | "rcpt" | "data" | "other"): string {
  const text = reply.lines.join(" ");
  if (reply.code === 535 || (step === "auth" && reply.code >= 500)) return "auth";
  if (reply.code === 530) return "auth_required";
  if (/\b5\.7\.\d+/.test(text)) return "smtp_policy";
  if (reply.code >= 500 && step === "mail") return "smtp_sender";
  if (reply.code >= 500 && step === "rcpt") return "smtp_recipient";
  return `smtp_${reply.code}`;
}

/** A plain address only: the spec was validated, this keeps a header or a command line from splitting. */
const ADDRESS = /^[^\s<>@,;"]+@[^\s<>@,;"]+$/;

/**
 * Send one mail. Resolves once the server accepted the DATA; rejects with a
 * {@link DeliveryError}.
 */
export async function sendSmtp(spec: SmtpSpec, opts: SmtpOptions, now: Date = new Date()): Promise<void> {
  if (!ADDRESS.test(spec.from) || !ADDRESS.test(spec.to)) throw new DeliveryError("invalid_config");
  const host = spec.host.replace(/^\[(.*)\]$/, "$1");
  const loopback = isLoopbackSmtpHost(host);
  if (spec.security === "none" && !loopback) throw new DeliveryError("cleartext");
  if (isIP(host)) {
    const res = checkAddress(host, spec.port, opts);
    if (!res.ok) throw new DeliveryError(res.code);
  }
  const lookup = policyLookup(spec.port, opts);
  const tlsOptions = { servername: isIP(host) ? undefined : host, ca: opts.ca, rejectUnauthorized: true, minVersion: "TLSv1.2" as const };

  let socket: Socket;
  const sockets: Socket[] = [];
  let reader!: ReplyReader;
  let total: NodeJS.Timeout | undefined;
  const fail = (err: unknown) => {
    const e = err as NodeJS.ErrnoException;
    if (err instanceof DeliveryError) return err;
    if (TLS_ERROR.test(e?.code ?? "")) return new DeliveryError("tls");
    return new DeliveryError("network");
  };
  /** Rejects when the socket errors, closes or the total time runs out. */
  let abort!: (err: Error) => void;
  const aborted = new Promise<never>((_, reject) => (abort = reject));
  aborted.catch(() => {});
  const watch = (s: Socket) => {
    sockets.push(s);
    s.on("error", (err) => {
      const d = fail(err);
      reader?.fail(d);
      abort(d);
    });
    s.on("close", () => {
      const d = new DeliveryError("network");
      reader?.fail(d);
      abort(d);
    });
  };
  const race = <T>(p: Promise<T>) => Promise.race([p, aborted]);

  try {
    total = setTimeout(() => {
      const d = new DeliveryError("timeout");
      reader?.fail(d);
      abort(d);
    }, opts.totalMs ?? TOTAL_MS);

    socket = await race(
      new Promise<Socket>((ok, reject) => {
        const s =
          spec.security === "tls"
            ? tlsConnect({ host, port: spec.port, lookup, ...tlsOptions })
            : netConnect({ host, port: spec.port, lookup });
        const timer = setTimeout(() => {
          reject(new DeliveryError("timeout"));
          s.destroy();
        }, opts.connectMs ?? CONNECT_MS);
        s.once(spec.security === "tls" ? "secureConnect" : "connect", () => {
          clearTimeout(timer);
          ok(s);
        });
        s.once("error", (err) => {
          clearTimeout(timer);
          reject(fail(err));
        });
        watch(s);
      }),
    );
    reader = new ReplyReader(socket);
    const send = (line: string) => socket.write(`${line}\r\n`);
    const expect = async (codes: number[], step: Parameters<typeof replyCode>[1] = "other") => {
      const reply = await race(reader.next());
      if (!codes.includes(reply.code)) throw new DeliveryError(replyCode(reply, step));
      return reply;
    };
    const ehlo = async () => {
      send(`EHLO ${CLIENT_NAME}`);
      return (await expect([250])).lines.slice(1).map((l) => l.toUpperCase());
    };

    await expect([220]);
    let ext = await ehlo();
    let secure = spec.security === "tls";
    if (spec.security === "starttls") {
      if (!ext.some((e) => e === "STARTTLS")) throw new DeliveryError("starttls_unsupported");
      send("STARTTLS");
      await expect([220]);
      socket.removeAllListeners("data");
      socket = await race(
        new Promise<TLSSocket>((ok, reject) => {
          const s = tlsConnect({ socket, ...tlsOptions });
          s.once("secureConnect", () => ok(s));
          s.once("error", (err) => reject(fail(err)));
          watch(s);
        }),
      );
      reader = new ReplyReader(socket);
      secure = true;
      ext = await ehlo();
    }

    if (spec.password !== undefined && spec.user !== undefined) {
      if (!secure && !loopback) throw new DeliveryError("cleartext");
      const auth = ext.find((e) => /^AUTH[ =]/.test(e))?.slice(5).split(/\s+/) ?? [];
      if (auth.includes("PLAIN")) {
        send(`AUTH PLAIN ${Buffer.from(`\0${spec.user}\0${spec.password}`, "utf8").toString("base64")}`);
        await expect([235], "auth");
      } else if (auth.includes("LOGIN")) {
        send("AUTH LOGIN");
        await expect([334], "auth");
        send(Buffer.from(spec.user, "utf8").toString("base64"));
        await expect([334], "auth");
        send(Buffer.from(spec.password, "utf8").toString("base64"));
        await expect([235], "auth");
      } else {
        throw new DeliveryError("auth_unsupported");
      }
    }

    send(`MAIL FROM:<${spec.from}>`);
    await expect([250], "mail");
    send(`RCPT TO:<${spec.to}>`);
    await expect([250, 251], "rcpt");
    send("DATA");
    await expect([354], "data");
    socket.write(`${dotStuff(buildMessage(spec, now))}\r\n.\r\n`);
    await expect([250], "data");
    send("QUIT");
  } catch (err) {
    throw fail(err);
  } finally {
    clearTimeout(total);
    for (const s of sockets) {
      s.removeAllListeners("close");
      s.on("error", () => {});
      s.end();
      s.destroy();
    }
  }
}
