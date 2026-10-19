/**
 * A fake HTTP receiver for the channel kinds (integrations plan U5).
 * Loopback only. Records method, path, headers and body of every request;
 * each path can be scripted with a sequence of answers (status, headers,
 * body, a delay, a `Retry-After`, a redirect). An unscripted request gets
 * `200 ok`; the last step of a script repeats.
 *
 * In tests: `const sink = await startFakeSink()`, then
 * `sink.script("/hook", [{ status: 500 }, { status: 200 }])`,
 * `sink.requests("/hook")`, `sink.close()`.
 *
 * As a script (QA): `node packages/cli/test/fixtures/fake-sink.ts [port]`
 * prints the base URL; then
 *   curl -XPOST <base>/_script -d '{"path":"/hook","steps":[{"status":500}]}'   (no delayMs over HTTP)
 *   curl <base>/_requests
 *   curl -XPOST <base>/_clear
 */

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

export interface SinkRequest {
  method: string;
  /** Path with the query string. */
  path: string;
  headers: Record<string, string>;
  body: string;
  at: number;
}

export interface SinkStep {
  status?: number;
  headers?: Record<string, string>;
  body?: string;
  /** Wait this long before answering. */
  delayMs?: number;
  /** Seconds, sent as the `Retry-After` header. */
  retryAfter?: number;
  /** Sent as `Location` (use with a 3xx status). */
  location?: string;
}

export interface FakeSink {
  baseUrl: string;
  /** Recorded requests, optionally of one path (query string ignored). */
  requests(path?: string): SinkRequest[];
  /** Answer the next requests to `path` with `steps` in order; the last step repeats. */
  script(path: string, steps: SinkStep[]): void;
  /** Forget the requests and the scripts. */
  clear(): void;
  close(): Promise<void>;
}

/** Longest scripted delay: past the transport's 20 s job cap. */
const MAX_DELAY_MS = 30_000;

const CONTROL = new Set(["/_requests", "/_script", "/_clear"]);

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

const bare = (path: string) => path.split("?")[0]!;

export async function startFakeSink(opts: { port?: number } = {}): Promise<FakeSink> {
  const log: SinkRequest[] = [];
  const scripts = new Map<string, SinkStep[]>();

  async function answer(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const path = req.url ?? "/";
    const body = await readBody(req);
    if (CONTROL.has(bare(path))) {
      if (bare(path) === "/_requests") return void res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(log));
      if (bare(path) === "/_clear") {
        log.length = 0;
        scripts.clear();
        return void res.writeHead(200).end("{}");
      }
      // Over HTTP a step takes no delay: only an in-process script() can hold a request open.
      const { path: p, steps } = JSON.parse(body) as { path: string; steps: SinkStep[] };
      scripts.set(p, steps.map(({ status, headers, body: text, retryAfter, location }) => ({ status, headers, body: text, retryAfter, location })));
      return void res.writeHead(200).end("{}");
    }
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(req.headers)) if (v !== undefined) headers[k] = Array.isArray(v) ? v.join(", ") : v;
    log.push({ method: req.method ?? "GET", path, headers, body, at: Date.now() });
    const steps = scripts.get(bare(path));
    const step: SinkStep = (steps && steps.length > 1 ? steps.shift() : steps?.[0]) ?? {};
    if (step.delayMs) await new Promise((r) => setTimeout(r, Math.min(step.delayMs, MAX_DELAY_MS)));
    if (res.destroyed) return;
    const out: Record<string, string> = { "content-type": "text/plain", ...step.headers };
    if (step.retryAfter !== undefined) out["retry-after"] = String(step.retryAfter);
    if (step.location) out.location = step.location;
    res.writeHead(step.status ?? 200, out).end(step.body ?? "ok");
  }

  const server = createServer((req, res) => {
    answer(req, res).catch(() => {
      if (!res.headersSent) res.writeHead(500).end("sink error");
    });
  });
  await new Promise<void>((resolve) => server.listen(opts.port ?? 0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    requests: (p) => (p === undefined ? [...log] : log.filter((r) => bare(r.path) === p)),
    script: (p, steps) => void scripts.set(p, [...steps]),
    clear: () => {
      log.length = 0;
      scripts.clear();
    },
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections?.();
        server.close(() => resolve());
      }),
  };
}

// Script mode for the QA run: `node fake-sink.ts [port]`.
if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  const sink = await startFakeSink({ port: Number(process.argv[2] ?? 0) });
  process.stdout.write(`${sink.baseUrl}\n`);
}
