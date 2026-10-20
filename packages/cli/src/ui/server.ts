/**
 * `tidegap ui` HTTP server (KTD8, KTD9). Loopback only. Writes by POST, never
 * dispatches: actions go through a Scheduler with no adapters, and the
 * dispatcher (`tidegap tick` or the OpenClaw loop) runs the task.
 *
 * Security model:
 *   - binds 127.0.0.1 only; there is no host option;
 *   - every `/api/*` request (JSON and SSE) needs `Authorization: Bearer
 *     <token>`, compared in constant time. Two scopes (native clients KTD3):
 *     `page`, the random per-run token in the page link, and `client`, a
 *     long-lived `tgc_` token from the registry (`ui-clients.json`, SHA-256
 *     only; `tidegap clients`). A client token never reaches `/api/clients*`
 *     and never creates a task (`POST /api/tasks`: 403);
 *   - `POST /api/tasks/<id>/reply` and `/api/integrations*` (the Telegram bot
 *     token's screen) answer the page token and a `macos` client token only,
 *     and never an extension origin, whatever the token (403). A caller that
 *     cannot reply gets `actions.reply: false`;
 *   - a `Host` header whose name is not 127.0.0.1, localhost or [::1] (with
 *     no port or this server's port) gets 403, which blocks DNS-rebinding
 *     pages;
 *   - an `Origin` header, when sent, must name the same loopback host, or be
 *     a browser extension origin (`chrome-extension://`, `moz-extension://`,
 *     `safari-web-extension://` plus an id). Any other origin, `null`
 *     included, gets 403. An extension origin reaches `/api/*` only, and only
 *     with a client token: the page token from an extension gets 403, and so
 *     does a static file. The origin only keeps web pages out; the token is
 *     the authentication;
 *   - no CORS headers, so other origins cannot read responses;
 *   - static files come from a fixed map; no request path touches the disk;
 *   - every write is a POST with the bearer header; routes that read a body
 *     (create, cancel, reschedule, postpone, reply, clients) need `Content-Type:
 *     application/json` (415 otherwise: a cross-site form cannot send it
 *     without a preflight, which gets no CORS answer) and at most 64 KiB
 *     (413); body-less routes (read, unread, run-now, dispatcher/start,
 *     revoke) refuse a non-empty body (400); bodies are strict JSON objects.
 *     No cookie is ever set.
 * The static page holds no data; it reads the token from the URL fragment,
 * which browsers never send to the server.
 */

import { createHash, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { TaskStore } from "@tidegap/core";

import { resolveLauncher } from "../commands/install.js";
import { actionScheduler } from "../commands/queue.js";
import { handleApi, postBodyKind, type ApiContext } from "./api.js";
import { ClientRegistry } from "./clients.js";
import { DispatcherControl, type Spawner } from "./dispatcher.js";
import { TaskEvents } from "./events.js";
import { Integrations, type IntegrationsConfig } from "./integrations.js";

/** Largest POST body read, in bytes. */
export const MAX_BODY_BYTES = 64 * 1024;

export const LOOPBACK = "127.0.0.1";

const SECURITY_HEADERS: Record<string, string> = {
  "content-security-policy":
    "default-src 'self'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "cache-control": "no-store",
};

const JS = "text/javascript; charset=utf-8";
const CSS = "text/css; charset=utf-8";

/** ES modules of the page (ui v2). Each is listed: no path touches the disk. */
export const UI_MODULES = [
  "app.js",
  "api.js",
  "state.js",
  "toast.js",
  "dom.js",
  "views.js",
  "row.js",
  "agenda.js",
  "detail.js",
  "journal.js",
  "timeline.js",
  "dnd.js",
  "keys.js",
  "dialog.js",
  "clients.js",
  "usage.js",
  "integrations.js",
  "channel-card.js",
  "copy.js",
  "qr.js",
] as const;

export const STATIC_FILES: Readonly<Record<string, { file: string; type: string }>> = {
  "/": { file: "index.html", type: "text/html; charset=utf-8" },
  "/tokens.css": { file: "tokens.css", type: CSS },
  "/app.css": { file: "app.css", type: CSS },
  "/tidegap-avatar.png": { file: "tidegap-avatar.png", type: "image/png" },
  ...Object.fromEntries(UI_MODULES.map((f) => [`/${f}`, { file: f, type: JS }])),
};

/** `packages/cli/ui`, from both `src/ui` (tests) and `dist/ui` (published). */
export function defaultAssetDir(): string {
  return join(dirname(fileURLToPath(import.meta.url)), "..", "..", "ui");
}

export interface UiServerOptions
  extends Omit<ApiContext, "store" | "dispatcher" | "integrations"> {
  token: string;
  /** Settings → Integrations; absent = no `/api/integrations` routes. */
  integrations?: IntegrationsConfig;
  /** `tidegap` launcher for Start dispatcher; default: the install step's. */
  launcher?: string[];
  /** Inject the dispatcher spawner, liveness probe and log dir (tests). */
  spawn?: Spawner;
  isAlive?: (pid: number) => boolean;
  logDir?: string;
  /** 0 (default) picks a free port. */
  port?: number;
  /** Directory of the client registry (`ui-clients.json`); default: the Tidegap home. */
  stateDir?: string;
  assetDir?: string;
  /** data_version poll interval for the change stream. */
  pollMs?: number;
}

export interface UiServer {
  port: number;
  address: string;
  url: string;
  server: Server;
  events: TaskEvents;
  close(): Promise<void>;
}

function digest(s: string): Buffer {
  return createHash("sha256").update(s).digest();
}

const LOOPBACK_NAMES = new Set([LOOPBACK, "localhost", "[::1]"]);

/**
 * True when `host` (a Host header, or the host part of an Origin) names a
 * loopback address with no port or with `port`. Anything else, including a
 * DNS name that resolves to 127.0.0.1, is refused.
 */
export function isLoopbackHost(host: string, port: number): boolean {
  const m = /^(\[::1\]|[^:]+)(?::(\d+))?$/.exec(host.trim().toLowerCase());
  if (!m || !LOOPBACK_NAMES.has(m[1]!)) return false;
  return m[2] === undefined || Number(m[2]) === port;
}

/** A browser extension origin: scheme plus an id, nothing else (KTD3). */
const EXTENSION_ORIGIN = /^(?:chrome-extension|moz-extension|safari-web-extension):\/\/[a-z0-9-]+$/i;

export type OriginClass = "none" | "loopback" | "extension" | "foreign";

/** Classify an `Origin` header for a server on `port`. */
export function classifyOrigin(origin: string | undefined, port: number): OriginClass {
  if (origin === undefined) return "none";
  const m = /^http:\/\/([^/]+)$/i.exec(origin);
  if (m && isLoopbackHost(m[1]!, port)) return "loopback";
  return EXTENSION_ORIGIN.test(origin) ? "extension" : "foreign";
}

/**
 * `/api/clients` and everything under it: page token only. Splits the path
 * the way the router does (empty segments dropped), so `/api//clients`
 * cannot route to the clients handlers past this check.
 */
function isClientsRoute(pathname: string): boolean {
  return isApiRoute(pathname, "clients");
}

/** `/api/<name>` and everything under it, split the way the router splits. */
function isApiRoute(pathname: string, name: string): boolean {
  const segs = pathname.split("/").filter(Boolean);
  return segs[0] === "api" && segs[1] === name;
}

/**
 * `/api/integrations` and everything under it (integrations plan KTD1): the
 * page token, or a `macos` client token, and never from an extension origin.
 * Same segment split as the router.
 */
function isIntegrationsRoute(pathname: string): boolean {
  return isApiRoute(pathname, "integrations");
}

/**
 * `POST /api/tasks`, the route that creates a task from nothing (coherence
 * R21, KTD8). Page token only; only agents create tasks, so a client token
 * gets 403. Same segment split as the router.
 */
function isTaskCreateRoute(method: string, pathname: string): boolean {
  if (method !== "POST") return false;
  const segs = pathname.split("/").filter(Boolean);
  return segs.length === 2 && segs[0] === "api" && segs[1] === "tasks";
}

/**
 * `POST /api/tasks/<id>/reply`: a follow-up to a finished task. The page
 * token and a `macos` client token (owner decision D1), never an extension.
 * Same segment split as the router.
 */
function isTaskReplyRoute(method: string, pathname: string): boolean {
  if (method !== "POST") return false;
  const segs = pathname.split("/").filter(Boolean);
  return segs.length === 4 && segs[0] === "api" && segs[1] === "tasks" && segs[3] === "reply";
}

function send(res: ServerResponse, status: number, body?: unknown, type = "application/json; charset=utf-8"): void {
  res.writeHead(status, { ...SECURITY_HEADERS, ...(body === undefined ? {} : { "content-type": type }) });
  if (body === undefined) res.end();
  else res.end(typeof body === "string" || Buffer.isBuffer(body) ? body : JSON.stringify(body));
}

/** Read a request body, keeping at most `max + 1` bytes; `null` when over `max`. */
function readBody(req: IncomingMessage, max: number): Promise<Buffer | null> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      // Keep draining past the cap so the client can read the 413.
      if (size <= max) chunks.push(chunk);
    });
    req.on("end", () => resolve(size > max ? null : Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

type BodyCheck = { ok: true; body: Record<string, unknown> } | { ok: false; status: number; error: string };

/** KTD9 body rules for one POST route. */
async function checkBody(req: IncomingMessage, kind: "json" | "none"): Promise<BodyCheck> {
  if (kind === "json") {
    const type = (req.headers["content-type"] ?? "").split(";")[0]!.trim().toLowerCase();
    if (type !== "application/json") {
      return { ok: false, status: 415, error: "content-type must be application/json" };
    }
  }
  const raw = await readBody(req, MAX_BODY_BYTES);
  if (raw === null) return { ok: false, status: 413, error: "body too large" };
  if (kind === "none") {
    return raw.length === 0 ? { ok: true, body: {} } : { ok: false, status: 400, error: "this route takes no body" };
  }
  if (raw.length === 0) return { ok: true, body: {} };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.toString("utf8"));
  } catch {
    return { ok: false, status: 400, error: "body is not JSON" };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { ok: false, status: 400, error: "body must be a JSON object" };
  }
  return { ok: true, body: parsed as Record<string, unknown> };
}

export async function startUiServer(opts: UiServerOptions): Promise<UiServer> {
  const store = new TaskStore({ dbPath: opts.dbPath });
  const events = new TaskEvents(store, opts.pollMs);
  // Writes go through a Scheduler built WITHOUT adapters (KTD8): it can
  // cancel, move, mark run-now and enqueue a reply, never dispatch.
  const ownScheduler = opts.scheduler === undefined;
  const scheduler =
    opts.scheduler ??
    actionScheduler({ dbPath: opts.dbPath, feed: opts.feed, region: opts.defaultRegion });
  const dispatcher = new DispatcherControl(store, {
    launcher: opts.launcher ?? resolveLauncher(undefined, []),
    dbPath: opts.dbPath,
    daemonStatus: opts.daemonStatus,
    ...(opts.spawn ? { spawn: opts.spawn } : {}),
    ...(opts.isAlive ? { isAlive: opts.isAlive } : {}),
    ...(opts.logDir ? { logDir: opts.logDir } : {}),
    ...(opts.now ? { now: opts.now } : {}),
  });
  const clients = opts.clients ?? new ClientRegistry(opts.stateDir);
  const integrations = opts.integrations ? new Integrations({ dbPath: opts.dbPath, ...opts.integrations, store }) : undefined;
  const ctx: ApiContext = { ...opts, store, scheduler, dispatcher, clients, integrations };
  const assetDir = opts.assetDir ?? defaultAssetDir();
  const tokenDigest = digest(opts.token);
  let port = 0;

  /** The bearer's scope: the per-run page token, a registry client token, or none. */
  const scope = (bearer: string | undefined): "page" | "client" | undefined => {
    if (bearer === undefined) return undefined;
    if (timingSafeEqual(digest(bearer), tokenDigest)) return "page";
    return clients.verify(bearer) ? "client" : undefined;
  };

  /**
   * The change stream. For a client token (`clientBearer`), the bearer is
   * checked again before each event and on each keep-alive: once it is
   * revoked the stream ends, and a reconnect gets 401.
   */
  const openStream = (req: IncomingMessage, res: ServerResponse, clientBearer?: string): void => {
    res.writeHead(200, {
      ...SECURITY_HEADERS,
      "content-type": "text/event-stream; charset=utf-8",
      connection: "keep-alive",
    });
    res.write(`event: hello\ndata: {}\n\n`);
    const valid = () => clientBearer === undefined || clients.verify(clientBearer) !== undefined;
    let open = true;
    const end = () => {
      if (!open) return;
      open = false;
      clearInterval(keepAlive);
      unsubscribe();
      res.end();
    };
    const unsubscribe = events.subscribe((ids) => {
      if (!valid()) return end();
      res.write(`event: tasks\ndata: ${JSON.stringify({ ids })}\n\n`);
    });
    const keepAlive = setInterval(() => (valid() ? res.write(`: keep-alive\n\n`) : end()), 15_000);
    keepAlive.unref();
    req.on("close", end);
  };

  const server = createServer((req, res) => {
    void (async () => {
      if (!isLoopbackHost(req.headers.host ?? "", port)) return send(res, 403, { error: "forbidden host" });
      const origin = classifyOrigin(req.headers.origin, port);
      if (origin === "foreign") return send(res, 403, { error: "forbidden origin" });
      const url = new URL(req.url ?? "/", `http://${LOOPBACK}`);
      const method = req.method ?? "GET";
      if (url.pathname === "/api" || url.pathname.startsWith("/api/")) {
        const bearer = /^Bearer (.+)$/.exec(req.headers.authorization ?? "")?.[1];
        const who = scope(bearer);
        if (!who) return send(res, 401, { error: "unauthorized" });
        // An extension uses a client token; the page token stays in the page.
        if (origin === "extension" && who === "page") return send(res, 403, { error: "forbidden origin" });
        if (who === "client" && (isClientsRoute(url.pathname) || isTaskCreateRoute(method, url.pathname))) {
          return send(res, 403, { error: "forbidden" });
        }
        // The page and the Mac app only, never an extension: the bot token's
        // screen (KTD1) and a reply to a task (D1).
        const client = who === "client" ? clients.verify(bearer!) : undefined;
        const pageOrMac = who === "page" || (origin !== "extension" && client?.kind === "macos");
        if ((isIntegrationsRoute(url.pathname) || isTaskReplyRoute(method, url.pathname)) && !pageOrMac) {
          return send(res, 403, { error: "forbidden" });
        }
        if (url.pathname === "/api/events") {
          return method === "GET"
            ? openStream(req, res, who === "client" ? bearer : undefined)
            : send(res, 405, { error: "method not allowed" });
        }
        let body: Record<string, unknown> = {};
        const kind = method === "POST" ? postBodyKind(url.pathname) : undefined;
        if (kind) {
          const checked = await checkBody(req, kind);
          if (!checked.ok) return send(res, checked.status, { error: checked.error });
          body = checked.body;
        }
        const out = await handleApi(
          // The task-events actor: `page` or `client:<name>`.
          { ...ctx, actor: who === "page" ? "page" : `client:${client?.name ?? "unknown"}`, canReply: pageOrMac },
          method,
          url.pathname,
          url.searchParams,
          body,
        );
        if (out.changedIds) events.emit(out.changedIds);
        return send(res, out.status, out.body);
      }
      if (origin === "extension") return send(res, 403, { error: "forbidden origin" });
      const asset = Object.hasOwn(STATIC_FILES, url.pathname) ? STATIC_FILES[url.pathname] : undefined;
      if (!asset) return send(res, 404, "not found", "text/plain; charset=utf-8");
      if (method !== "GET" && method !== "HEAD") return send(res, 405, "method not allowed", "text/plain; charset=utf-8");
      try {
        return send(res, 200, readFileSync(join(assetDir, asset.file)), asset.type);
      } catch {
        return send(res, 404, "not found", "text/plain; charset=utf-8");
      }
    })().catch(() => {
      // No error text in the response: it can carry paths or provider detail.
      if (!res.headersSent) send(res, 500, { error: "internal error" });
      else res.end();
    });
  });

  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(opts.port ?? 0, LOOPBACK, () => resolve());
    });
  } catch (err) {
    // Port taken (the CLI retries on a free port): release what was opened.
    if (ownScheduler) scheduler.shutdown();
    store.close();
    throw err;
  }
  const addr = server.address() as AddressInfo;
  port = addr.port;
  events.start();

  return {
    port,
    address: addr.address,
    url: `http://${LOOPBACK}:${port}/`,
    server,
    events,
    close: async () => {
      await integrations?.close();
      events.stop();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      if (ownScheduler) scheduler.shutdown();
      store.close();
    },
  };
}
