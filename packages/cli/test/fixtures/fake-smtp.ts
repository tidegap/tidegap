/**
 * A fake SMTP server for the email channel (integrations plan U11).
 * Loopback only. Modes: `plain` (no TLS), `tls` (implicit TLS) and
 * `starttls` (AUTH is offered only after the upgrade). The certificate is
 * self-signed for `localhost` and 127.0.0.1 and made by `openssl` in a
 * temp folder on first use ({@link testTls}), so no key sits in git.
 *
 * In tests: `const smtp = await startFakeSmtp({ mode: "starttls" })`, then
 * `smtp.messages()`, `smtp.commands()`, `smtp.close()`.
 *
 * As a script (QA): `node packages/cli/test/fixtures/fake-smtp.ts <smtp port>`
 * runs a `plain` server on that port that takes any login, and prints the
 * base URL of a control server:
 *   curl <base>/_messages     curl -XPOST <base>/_clear
 */

import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer as createHttpServer } from "node:http";
import { createServer, type AddressInfo, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TLSSocket, createServer as createTlsServer } from "node:tls";

/** `openssl req` settings: a self-signed CA certificate for localhost and 127.0.0.1. */
const OPENSSL_CONFIG = [
  "[req]",
  "distinguished_name = dn",
  "x509_extensions = ext",
  "prompt = no",
  "[dn]",
  "CN = localhost",
  "[ext]",
  "basicConstraints = critical, CA:true",
  "subjectAltName = DNS:localhost, IP:127.0.0.1",
  "",
].join("\n");

let tls: { key: string; cert: string } | undefined;

/** The test key and certificate, made once per process; the temp folder is removed at once. */
export function testTls(): { key: string; cert: string } {
  if (tls) return tls;
  const dir = mkdtempSync(join(tmpdir(), "tidegap-smtp-tls-"));
  try {
    const config = join(dir, "openssl.cnf");
    writeFileSync(config, OPENSSL_CONFIG);
    const key = join(dir, "key.pem");
    const cert = join(dir, "cert.pem");
    execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-sha256", "-days", "2", "-keyout", key, "-out", cert, "-config", config], { stdio: "ignore" });
    tls = { key: readFileSync(key, "utf8"), cert: readFileSync(cert, "utf8") };
    return tls;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

export interface FakeMail {
  from: string;
  to: string[];
  /** The raw DATA, dot-stuffing undone. */
  data: string;
  /** The decoded Subject header. */
  subject: string;
  /** The decoded body. */
  text: string;
  /** The user that logged in, if any. */
  user?: string;
}

export interface FakeSmtpOptions {
  port?: number;
  mode?: "plain" | "tls" | "starttls";
  /** Mechanisms offered in EHLO. Default PLAIN and LOGIN; [] offers no AUTH. */
  auth?: string[];
  /** Accepted user → password; absent: any login is accepted. */
  users?: Record<string, string>;
  /** Fixed replies instead of the default for a step. */
  replies?: Partial<Record<"MAIL" | "RCPT" | "END" | "STARTTLS", string>>;
  /** Lines sent in the same write as the STARTTLS 220, before the TLS handshake (a STARTTLS response injection). */
  afterStarttls?: string[];
  /** Never send the greeting (a server that hangs). */
  silent?: boolean;
}

export interface FakeSmtp {
  port: number;
  messages(): FakeMail[];
  /** Each command line as received ("AUTH PLAIN …" shortened to its verb and mechanism) and whether TLS was on. */
  commands(): { line: string; tls: boolean }[];
  clear(): void;
  close(): Promise<void>;
}

function decodeWords(v: string): string {
  return v.replace(/\r\n /g, "").replace(/=\?UTF-8\?B\?([^?]*)\?=/gi, (_, b64: string) => Buffer.from(b64, "base64").toString("utf8"));
}

/** Subject and body of a stored message. */
function parseMail(data: string): { subject: string; text: string } {
  const split = data.indexOf("\r\n\r\n");
  const head = data.slice(0, split);
  const body = data.slice(split + 4);
  const subject = /^Subject: (.*(?:\r\n .*)*)/m.exec(head)?.[1] ?? "";
  const text = /Content-Transfer-Encoding: base64/i.test(head) ? Buffer.from(body.replace(/\r\n/g, ""), "base64").toString("utf8") : body;
  return { subject: decodeWords(subject), text };
}

export async function startFakeSmtp(opts: FakeSmtpOptions = {}): Promise<FakeSmtp> {
  const mode = opts.mode ?? "plain";
  const mechs = opts.auth ?? ["PLAIN", "LOGIN"];
  const mails: FakeMail[] = [];
  const log: { line: string; tls: boolean }[] = [];
  const sockets = new Set<Socket>();

  const session = (raw: Socket, startTls: boolean) => {
    let sock: Socket = raw;
    let tls = startTls;
    let buf = "";
    let data: string[] | null = null;
    let mail: { from: string; to: string[]; user?: string } = { from: "", to: [] };
    let user: string | undefined;
    let login: { step: "user" | "pass"; user?: string } | null = null;
    const say = (line: string) => sock.write(`${line}\r\n`);
    const okLogin = (u: string, p: string) => !opts.users || opts.users[u] === p;
    const ehlo = () => {
      const ext = [];
      if (mode === "starttls" && !tls) ext.push("STARTTLS");
      if (mechs.length && (mode !== "starttls" || tls)) ext.push(`AUTH ${mechs.join(" ")}`);
      ext.push("8BITMIME");
      say("250-fake.localhost");
      ext.forEach((e, i) => say(`250${i === ext.length - 1 ? " " : "-"}${e}`));
    };
    const onLine = (line: string) => {
      if (data) {
        if (line === ".") {
          const raw = data.join("\r\n");
          data = null;
          mails.push({ ...mail, data: raw, ...parseMail(raw), ...(user ? { user } : {}) });
          return say(opts.replies?.END ?? "250 2.0.0 queued");
        }
        data.push(line.startsWith("..") ? line.slice(1) : line);
        return;
      }
      if (login) {
        const value = Buffer.from(line, "base64").toString("utf8");
        if (login.step === "user") {
          login = { step: "pass", user: value };
          return say("334 UGFzc3dvcmQ6");
        }
        const u = login.user ?? "";
        login = null;
        if (!okLogin(u, value)) return say("535 5.7.8 Authentication credentials invalid");
        user = u;
        return say("235 2.7.0 Accepted");
      }
      const [verb = "", ...rest] = line.split(" ");
      const upper = verb.toUpperCase();
      log.push({ line: upper === "AUTH" ? `AUTH ${rest[0] ?? ""}` : line, tls });
      switch (upper) {
        case "EHLO":
        case "HELO":
          return ehlo();
        case "STARTTLS": {
          if (opts.replies?.STARTTLS) return say(opts.replies.STARTTLS);
          if (mode !== "starttls" || tls) return say("503 5.5.1 not now");
          sock.write(["220 2.0.0 go ahead", ...(opts.afterStarttls ?? [])].map((l) => `${l}\r\n`).join(""));
          raw.removeAllListeners("data");
          const secure = new TLSSocket(raw, { isServer: true, ...testTls() });
          sock = secure;
          tls = true;
          buf = "";
          secure.setEncoding("utf8");
          secure.on("data", feed);
          secure.on("error", () => {});
          return;
        }
        case "AUTH": {
          const mech = (rest[0] ?? "").toUpperCase();
          if (!mechs.includes(mech) || (mode === "starttls" && !tls)) return say("504 5.5.4 mechanism not offered");
          if (mech === "PLAIN") {
            const [, u = "", p = ""] = Buffer.from(rest[1] ?? "", "base64").toString("utf8").split("\0");
            if (!okLogin(u, p)) return say("535 5.7.8 Authentication credentials invalid");
            user = u;
            return say("235 2.7.0 Accepted");
          }
          login = { step: "user" };
          return say("334 VXNlcm5hbWU6");
        }
        case "MAIL":
          if (opts.replies?.MAIL) return say(opts.replies.MAIL);
          mail = { from: /<([^>]*)>/.exec(line)?.[1] ?? "", to: [] };
          return say("250 2.1.0 ok");
        case "RCPT":
          if (opts.replies?.RCPT) return say(opts.replies.RCPT);
          mail.to.push(/<([^>]*)>/.exec(line)?.[1] ?? "");
          return say("250 2.1.5 ok");
        case "DATA":
          data = [];
          return say("354 end with .");
        case "QUIT":
          say("221 2.0.0 bye");
          return void sock.end();
        default:
          return say("502 5.5.2 unknown command");
      }
    };
    const feed = (chunk: string) => {
      buf += chunk;
      let i: number;
      while ((i = buf.indexOf("\r\n")) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 2);
        onLine(line);
      }
    };
    raw.setEncoding("utf8");
    raw.on("data", feed);
    raw.on("error", () => {});
    if (!opts.silent) say("220 fake.localhost ESMTP");
  };

  let server: Server;
  if (mode === "tls") {
    server = createTlsServer(testTls(), (s) => {
      sockets.add(s);
      session(s, true);
    });
  } else {
    server = createServer((s) => {
      sockets.add(s);
      session(s, false);
    });
  }
  await new Promise<void>((resolve) => server.listen(opts.port ?? 0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    port,
    messages: () => [...mails],
    commands: () => [...log],
    clear: () => {
      mails.length = 0;
      log.length = 0;
    },
    close: () =>
      new Promise<void>((resolve) => {
        for (const s of sockets) s.destroy();
        server.close(() => resolve());
      }),
  };
}

// Script mode for the QA run: `node fake-smtp.ts <smtp port>`.
if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  const smtp = await startFakeSmtp({ port: Number(process.argv[2] ?? 0) });
  const control = createHttpServer((req, res) => {
    if (req.url === "/_messages") return void res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(smtp.messages()));
    if (req.url === "/_clear" && req.method === "POST") {
      smtp.clear();
      return void res.writeHead(200).end("ok");
    }
    res.writeHead(404).end();
  });
  await new Promise<void>((resolve) => control.listen(0, "127.0.0.1", resolve));
  process.stdout.write(`http://127.0.0.1:${(control.address() as AddressInfo).port}\nsmtp 127.0.0.1:${smtp.port}\n`);
}
