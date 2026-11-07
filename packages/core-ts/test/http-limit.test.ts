/**
 * No hidden ceiling under a run's LLM time limit: Node's fetch (undici) ends
 * a call whose response headers take longer than 300 s, so each call with a
 * limit carries its own dispatcher whose header and body timeouts follow
 * the limit (none for `none`). The tests stand in for the 300 s default with
 * a short global dispatcher and a local server that delays its headers.
 */
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { Agent, getGlobalDispatcher, setGlobalDispatcher, type Dispatcher } from "undici";

import { AnthropicAdapter, GeminiAdapter, limitDispatcher, OpenAIAdapter } from "../src/index.js";

const HEADERS_DELAY_MS = 1_500;

describe("a call under an LLM time limit carries its own dispatcher", () => {
  let server: Server;
  let baseUrl: string;
  let saved: Dispatcher;

  beforeAll(async () => {
    server = createServer((_req, res) => {
      // The answer's headers come only after the delay, as a long model call's do.
      setTimeout(() => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ candidates: [{ content: { parts: [{ text: "late answer" }] } }] }));
      }, HEADERS_DELAY_MS);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    saved = getGlobalDispatcher();
    // The stand-in for Node's 300 s default: headers must come within 300 ms.
    setGlobalDispatcher(new Agent({ headersTimeout: 300, bodyTimeout: 300 }));
  });
  afterAll(async () => {
    setGlobalDispatcher(saved);
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  const gemini = () => new GeminiAdapter({ apiKey: "test-key", baseUrl });

  it("without a limit the default dispatcher ends the call at its header timeout", async () => {
    await expect(gemini().dispatch("gemini-x", "hi")).rejects.toThrow();
  });

  it("with none the call waits past the default header timeout and completes", async () => {
    const result = await gemini().dispatch("gemini-x", "hi", { timeoutMs: "none" });
    expect(result.text).toBe("late answer");
  });

  it("with a limit longer than the delay the call completes; the default timeout does not end it", async () => {
    const result = await gemini().dispatch("gemini-x", "hi", { timeoutMs: 60_000 });
    expect(result.text).toBe("late answer");
  });

  it("with a limit shorter than the delay the call stops at the labelled time limit", async () => {
    const err = await gemini()
      .dispatch("gemini-x", "hi", { timeoutMs: 500 })
      .catch((e: unknown) => e as { message: string; details?: { stopped_by?: string } });
    expect(err.details?.stopped_by).toBe("llm_timeout");
  });

  it("the SDK request of an API adapter carries the dispatcher of its limit", async () => {
    const seen: unknown[] = [];
    const create = async (_req: unknown, options?: unknown) => {
      seen.push(options);
      return { content: [{ type: "text", text: "ok" }], model: "m", usage: { input_tokens: 1, output_tokens: 1 }, stop_reason: "end_turn" };
    };
    const adapter = new AnthropicAdapter({ apiKey: "test", client: { messages: { create } } });
    await adapter.dispatch("claude-x", "hi", { timeoutMs: "none" });
    await adapter.dispatch("claude-x", "hi", { timeoutMs: 120_000 });
    expect((seen[0] as { fetchOptions?: { dispatcher?: unknown } }).fetchOptions?.dispatcher).toBe(limitDispatcher("none"));
    expect((seen[1] as { fetchOptions?: { dispatcher?: unknown } }).fetchOptions?.dispatcher).toBe(limitDispatcher(120_000));
    expect(limitDispatcher(undefined)).toBeUndefined();
  });
});

describe("an SDK file upload goes through the global fetch", () => {
  let server: Server;
  const seen: { url: string; type: string; body: string }[] = [];

  beforeAll(async () => {
    server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        seen.push({ url: req.url ?? "", type: String(req.headers["content-type"] ?? ""), body: Buffer.concat(chunks).toString("utf8") });
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(req.url?.endsWith("/files") ? { id: "file_1", object: "file" } : { id: "batch_1", object: "batch" }));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    vi.stubEnv("OPENAI_BASE_URL", `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`);
  });
  afterAll(async () => {
    vi.unstubAllEnvs();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("the OpenAI Batch submit uploads its input file as multipart and creates the batch", async () => {
    const handle = await new OpenAIAdapter({ apiKey: "test-key" }).dispatchBatch("gpt-4o-mini", ["hi"], {});
    expect(handle.batchId).toBe("batch_1");
    const upload = seen.find((r) => r.url.endsWith("/files"));
    expect(upload?.type).toMatch(/^multipart\/form-data/);
    expect(upload?.body).toContain("tidegap-0");
    expect(upload?.body).not.toContain("[object FormData]");
  });
});
