import { describe, expect, it } from "vitest";
import { AnthropicAdapter, MAX_TIMER_MS, NonRetryableError, OpenAIAdapter, ProviderRefusalError } from "../src/index.js";

describe("AnthropicAdapter", () => {
  it("reports not-ready when no key and no client", () => {
    const a = new AnthropicAdapter({ apiKey: undefined });
    delete process.env.ANTHROPIC_API_KEY;
    expect(new AnthropicAdapter().ready).toBe(false);
  });

  it("dispatches via an injected client and shapes the result", async () => {
    let captured: unknown;
    const fakeClient = {
      messages: {
        create: async (req: unknown) => {
          captured = req;
          return {
            content: [
              { type: "text", text: "hello" },
              { type: "text", text: " world" },
            ],
            usage: { input_tokens: 7, output_tokens: 3 },
            model: "claude-sonnet-4-5",
          };
        },
        batches: {
          create: async () => ({ id: "batch_x" }),
        },
      },
    };
    const adapter = new AnthropicAdapter({ apiKey: "test", client: fakeClient });
    const r = await adapter.dispatch("claude-sonnet-4-5", "say hi", {
      maxTokens: 100,
      system: "be brief",
    });
    expect(r.text).toBe("hello world");
    expect(r.usage?.totalTokens).toBe(10);
    expect(r.provider).toBe("anthropic");
    expect((captured as { system: string }).system).toBe("be brief");
  });

  it("submits a batch and returns the handle", async () => {
    const adapter = new AnthropicAdapter({
      apiKey: "test",
      client: {
        messages: {
          create: async () => ({}),
          batches: {
            create: async (req: unknown) => {
              expect(
                (req as { requests: unknown[] }).requests.length,
              ).toBe(3);
              return { id: "msgbatch_01" };
            },
          },
        },
      },
    });
    const handle = await adapter.dispatchBatch(
      "claude-sonnet-4-5",
      ["a", "b", "c"],
    );
    expect(handle.batchId).toBe("msgbatch_01");
    expect(handle.size).toBe(3);
    expect(handle.provider).toBe("anthropic");
  });

  it("rejects empty batch", async () => {
    const adapter = new AnthropicAdapter({ apiKey: "test", client: {} });
    await expect(adapter.dispatchBatch("claude-sonnet-4-5", [])).rejects.toThrow(
      /at least one entry/i,
    );
  });

  it("retrieveBatch reports in_progress while the batch has not ended", async () => {
    const adapter = new AnthropicAdapter({
      apiKey: "test",
      client: {
        messages: {
          create: async () => ({}),
          batches: {
            create: async () => ({ id: "b" }),
            retrieve: async () => ({ processing_status: "in_progress" }),
            results: async () => [],
          },
        },
      },
    });
    const r = await adapter.retrieveBatch("msgbatch_01");
    expect(r.status).toBe("in_progress");
  });

  it("retrieveBatch parses a completed batch result + usage", async () => {
    const adapter = new AnthropicAdapter({
      apiKey: "test",
      client: {
        messages: {
          create: async () => ({}),
          batches: {
            create: async () => ({ id: "b" }),
            retrieve: async () => ({ processing_status: "ended" }),
            // eslint-disable-next-line require-yield
            results: async () =>
              (async function* () {
                yield {
                  result: {
                    type: "succeeded",
                    message: {
                      content: [{ type: "text", text: "batched answer" }],
                      usage: { input_tokens: 11, output_tokens: 4 },
                      model: "claude-sonnet-4-5",
                    },
                  },
                };
              })(),
          },
        },
      },
    });
    const r = await adapter.retrieveBatch("msgbatch_01");
    expect(r.status).toBe("completed");
    expect(r.results?.[0]?.text).toBe("batched answer");
    expect(r.results?.[0]?.usage?.totalTokens).toBe(15);
  });
});

/** Anthropic client stub that records every request it receives. */
function recordingAnthropicClient(response: Record<string, unknown> = {}) {
  const requests: Array<Record<string, unknown>> = [];
  const batchRequests: Array<Record<string, unknown>> = [];
  const client = {
    messages: {
      create: async (req: unknown) => {
        requests.push(req as Record<string, unknown>);
        return {
          content: [{ type: "text", text: "ok" }],
          stop_reason: "end_turn",
          ...response,
        };
      },
      batches: {
        create: async (req: unknown) => {
          batchRequests.push(req as Record<string, unknown>);
          return { id: "msgbatch_t" };
        },
      },
    },
  };
  return { client, requests, batchRequests };
}

describe("AnthropicAdapter sampling parameters", () => {
  it.each([
    ["claude-sonnet-5", false],
    ["claude-opus-5", false],
    ["claude-opus-5-5", false],
    ["claude-opus-4-8", false],
    ["claude-opus-4-7", false],
    ["claude-fable-5-1", false],
    ["claude-mythos-5-1", false],
    ["claude-opus-6", false],
    ["claude-sonnet-4-6", true],
    ["claude-opus-4-6", true],
    ["claude-sonnet-4-5", true],
    ["claude-opus-4-1", true],
    ["claude-haiku-4-5", true],
    ["claude-3-5-sonnet-20241022", true],
    ["us.anthropic.claude-sonnet-4-6-v1:0", true],
    ["global.anthropic.claude-sonnet-5", false],
  ])("dispatch to %s sends temperature: %s", async (model, sent) => {
    const { client, requests } = recordingAnthropicClient();
    const adapter = new AnthropicAdapter({ client });
    await adapter.dispatch(model, "hi", { temperature: 0.2 });
    expect("temperature" in requests[0]!).toBe(sent);
    if (sent) expect(requests[0]!.temperature).toBe(0.2);
  });

  it("omits temperature from every batch request for a model that rejects it", async () => {
    const { client, batchRequests } = recordingAnthropicClient();
    const adapter = new AnthropicAdapter({ client });
    await adapter.dispatchBatch("claude-opus-5", ["a", "b"], { temperature: 0.4 });
    const reqs = (batchRequests[0] as { requests: Array<{ params: Record<string, unknown> }> })
      .requests;
    expect(reqs).toHaveLength(2);
    for (const r of reqs) expect("temperature" in r.params).toBe(false);
  });

  it("keeps temperature in batch requests for a model that accepts it", async () => {
    const { client, batchRequests } = recordingAnthropicClient();
    const adapter = new AnthropicAdapter({ client });
    await adapter.dispatchBatch("claude-haiku-4-5", ["a"], { temperature: 0.4 });
    const reqs = (batchRequests[0] as { requests: Array<{ params: Record<string, unknown> }> })
      .requests;
    expect(reqs[0]!.params.temperature).toBe(0.4);
  });

  it("sends no temperature key when the caller sets none", async () => {
    const { client, requests } = recordingAnthropicClient();
    await new AnthropicAdapter({ client }).dispatch("claude-haiku-4-5", "hi");
    expect("temperature" in requests[0]!).toBe(false);
  });
});

describe("AnthropicAdapter max_tokens default", () => {
  it("defaults max_tokens to 16000 on dispatch and dispatchBatch", async () => {
    const { client, requests, batchRequests } = recordingAnthropicClient();
    const adapter = new AnthropicAdapter({ client });
    await adapter.dispatch("claude-sonnet-5", "hi");
    await adapter.dispatchBatch("claude-sonnet-5", ["hi"]);
    expect(requests[0]!.max_tokens).toBe(16000);
    const reqs = (batchRequests[0] as { requests: Array<{ params: Record<string, unknown> }> })
      .requests;
    expect(reqs[0]!.params.max_tokens).toBe(16000);
  });

  it("passes an explicit maxTokens through", async () => {
    const { client, requests } = recordingAnthropicClient();
    await new AnthropicAdapter({ client }).dispatch("claude-sonnet-5", "hi", { maxTokens: 512 });
    expect(requests[0]!.max_tokens).toBe(512);
  });
});

describe("AnthropicAdapter stop reasons", () => {
  it("throws ProviderRefusalError with the stop_details category on a refusal", async () => {
    const { client } = recordingAnthropicClient({
      content: [{ type: "text", text: "partial" }],
      stop_reason: "refusal",
      stop_details: { type: "refusal", category: "cyber", explanation: "declined" },
    });
    const adapter = new AnthropicAdapter({ client });
    const err = await adapter.dispatch("claude-opus-5", "hi").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ProviderRefusalError);
    expect((err as ProviderRefusalError).category).toBe("cyber");
    expect((err as ProviderRefusalError).provider).toBe("anthropic");
    expect((err as ProviderRefusalError).model).toBe("claude-opus-5");
  });

  it("throws ProviderRefusalError with a null category when stop_details is absent", async () => {
    const { client } = recordingAnthropicClient({ stop_reason: "refusal" });
    const err = await new AnthropicAdapter({ client })
      .dispatch("claude-opus-5", "hi")
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ProviderRefusalError);
    expect((err as ProviderRefusalError).category).toBeNull();
  });

  it("reports a max_tokens stop on the result with the text", async () => {
    const { client } = recordingAnthropicClient({
      content: [{ type: "text", text: "cut off" }],
      stop_reason: "max_tokens",
    });
    const r = await new AnthropicAdapter({ client }).dispatch("claude-sonnet-5", "hi");
    expect(r.stopReason).toBe("max_tokens");
    expect(r.text).toBe("cut off");
  });

  it("reports end_turn on a normal completion", async () => {
    const { client } = recordingAnthropicClient();
    const r = await new AnthropicAdapter({ client }).dispatch("claude-sonnet-5", "hi");
    expect(r.stopReason).toBe("end_turn");
  });

  function endedBatchClient(message: Record<string, unknown>) {
    return {
      messages: {
        create: async () => ({}),
        batches: {
          create: async () => ({ id: "b" }),
          retrieve: async () => ({ processing_status: "ended" }),
          results: async () =>
            (async function* () {
              yield { result: { type: "succeeded", message } };
            })(),
        },
      },
    };
  }

  it("retrieveBatch fails a refused batch result instead of completing it", async () => {
    const adapter = new AnthropicAdapter({
      client: endedBatchClient({
        content: [],
        stop_reason: "refusal",
        stop_details: { type: "refusal", category: "bio" },
        model: "claude-opus-5",
      }),
    });
    const r = await adapter.retrieveBatch("msgbatch_01");
    expect(r.status).toBe("failed");
    expect(r.results).toBeUndefined();
    expect(r.error).toMatch(/refus/i);
    expect(r.error).toContain("bio");
  });

  it("retrieveBatch reports a max_tokens stop on the batch result", async () => {
    const adapter = new AnthropicAdapter({
      client: endedBatchClient({
        content: [{ type: "text", text: "cut" }],
        stop_reason: "max_tokens",
        model: "claude-sonnet-5",
      }),
    });
    const r = await adapter.retrieveBatch("msgbatch_01");
    expect(r.status).toBe("completed");
    expect(r.results?.[0]?.stopReason).toBe("max_tokens");
    expect(r.results?.[0]?.text).toBe("cut");
  });
});

describe("OpenAIAdapter", () => {
  it("dispatches via an injected client and shapes the result", async () => {
    const fakeClient = {
      chat: {
        completions: {
          create: async (req: unknown) => {
            expect(
              ((req as { messages: { role: string }[] }).messages[0]?.role),
            ).toBe("system");
            return {
              choices: [{ message: { content: "answer" } }],
              usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 },
              model: "gpt-4.1-mini",
            };
          },
        },
      },
      files: { create: async () => ({ id: "f" }) },
      batches: { create: async () => ({ id: "b" }) },
    };
    const adapter = new OpenAIAdapter({ apiKey: "test", client: fakeClient });
    const r = await adapter.dispatch("gpt-4.1-mini", "hi", { system: "be brief" });
    expect(r.text).toBe("answer");
    expect(r.usage?.totalTokens).toBe(7);
    expect(r.provider).toBe("openai");
  });

  it("sends max_completion_tokens and omits temperature for o-series models", async () => {
    let captured: Record<string, unknown> | undefined;
    const adapter = new OpenAIAdapter({
      apiKey: "test",
      client: {
        chat: {
          completions: {
            create: async (req: unknown) => {
              captured = req as Record<string, unknown>;
              return { choices: [{ message: { content: "x" } }] };
            },
          },
        },
        files: { create: async () => ({ id: "f" }) },
        batches: { create: async () => ({ id: "b" }) },
      },
    });
    await adapter.dispatch("o3-mini", "hi", { maxTokens: 100, temperature: 0.5 });
    expect(captured?.max_completion_tokens).toBe(100);
    expect("max_tokens" in captured!).toBe(false);
    // o-series rejects temperature entirely — the key must not be sent.
    expect("temperature" in captured!).toBe(false);
  });

  it("sends max_completion_tokens but keeps temperature for gpt-5-family models", async () => {
    let captured: Record<string, unknown> | undefined;
    const adapter = new OpenAIAdapter({
      apiKey: "test",
      client: {
        chat: {
          completions: {
            create: async (req: unknown) => {
              captured = req as Record<string, unknown>;
              return { choices: [{ message: { content: "x" } }] };
            },
          },
        },
        files: { create: async () => ({ id: "f" }) },
        batches: { create: async () => ({ id: "b" }) },
      },
    });
    await adapter.dispatch("gpt-5-mini", "hi", { maxTokens: 64, temperature: 0.7 });
    expect(captured?.max_completion_tokens).toBe(64);
    expect("max_tokens" in captured!).toBe(false);
    expect(captured?.temperature).toBe(0.7);
  });

  it.each(["gpt-6-sol", "gpt-6-astra", "gpt-6-luna", "GPT-6-sol"])(
    "sends max_completion_tokens and no max_tokens for %s",
    async (model) => {
      let captured: Record<string, unknown> | undefined;
      const adapter = new OpenAIAdapter({
        apiKey: "test",
        client: {
          chat: {
            completions: {
              create: async (req: unknown) => {
                captured = req as Record<string, unknown>;
                return { choices: [{ message: { content: "x" } }] };
              },
            },
          },
          files: { create: async () => ({ id: "f" }) },
          batches: { create: async () => ({ id: "b" }) },
        },
      });
      await adapter.dispatch(model, "hi", { maxTokens: 64, temperature: 0.7 });
      expect(captured?.max_completion_tokens).toBe(64);
      expect("max_tokens" in captured!).toBe(false);
      expect(captured?.temperature).toBe(0.7);
    },
  );

  it("keeps classic max_tokens + temperature for other models", async () => {
    let captured: Record<string, unknown> | undefined;
    const adapter = new OpenAIAdapter({
      apiKey: "test",
      client: {
        chat: {
          completions: {
            create: async (req: unknown) => {
              captured = req as Record<string, unknown>;
              return { choices: [{ message: { content: "x" } }] };
            },
          },
        },
        files: { create: async () => ({ id: "f" }) },
        batches: { create: async () => ({ id: "b" }) },
      },
    });
    await adapter.dispatch("gpt-4o", "hi", { maxTokens: 128, temperature: 0.2 });
    expect(captured?.max_tokens).toBe(128);
    expect("max_completion_tokens" in captured!).toBe(false);
    expect(captured?.temperature).toBe(0.2);
  });

  it("applies the same o-series parameter mapping to batch JSONL bodies", async () => {
    let jsonl: string | undefined;
    const adapter = new OpenAIAdapter({
      apiKey: "test",
      client: {
        chat: { completions: { create: async () => ({}) } },
        files: {
          create: async (req: { file: Blob }) => {
            jsonl = await req.file.text();
            return { id: "file_1" };
          },
        },
        batches: { create: async () => ({ id: "batch_1" }) },
      },
    });
    await adapter.dispatchBatch("o1", ["p"], { maxTokens: 32, temperature: 0.9 });
    const body = JSON.parse(jsonl!.split("\n")[0]!).body as Record<string, unknown>;
    expect(body.max_completion_tokens).toBe(32);
    expect("max_tokens" in body).toBe(false);
    expect("temperature" in body).toBe(false);
  });

  it("uploads a JSONL file, then submits a batch", async () => {
    let uploadedPurpose: string | undefined;
    const adapter = new OpenAIAdapter({
      apiKey: "test",
      client: {
        chat: { completions: { create: async () => ({}) } },
        files: {
          create: async (req: { purpose: string }) => {
            uploadedPurpose = req.purpose;
            return { id: "file_123" };
          },
        },
        batches: {
          create: async (req: { input_file_id: string; completion_window: string }) => {
            expect(req.input_file_id).toBe("file_123");
            expect(req.completion_window).toBe("24h");
            return { id: "batch_abc" };
          },
        },
      },
    });
    const handle = await adapter.dispatchBatch("gpt-4.1-mini", [
      "prompt-1",
      "prompt-2",
    ]);
    expect(uploadedPurpose).toBe("batch");
    expect(handle.batchId).toBe("batch_abc");
    expect(handle.size).toBe(2);
  });

  it("retrieveBatch reports in_progress for a running batch", async () => {
    const adapter = new OpenAIAdapter({
      apiKey: "test",
      client: {
        chat: { completions: { create: async () => ({}) } },
        files: { create: async () => ({ id: "f" }), content: async () => "" },
        batches: {
          create: async () => ({ id: "b" }),
          retrieve: async () => ({ status: "in_progress" }),
        },
      },
    });
    const r = await adapter.retrieveBatch("batch_abc");
    expect(r.status).toBe("in_progress");
  });

  it("retrieveBatch parses the completed output JSONL", async () => {
    const outputLine = JSON.stringify({
      custom_id: "tidegap-0",
      response: {
        body: {
          choices: [{ message: { content: "batched reply" } }],
          usage: { prompt_tokens: 8, completion_tokens: 3, total_tokens: 11 },
          model: "gpt-4.1-mini",
        },
      },
    });
    const adapter = new OpenAIAdapter({
      apiKey: "test",
      client: {
        chat: { completions: { create: async () => ({}) } },
        files: {
          create: async () => ({ id: "f" }),
          content: async (fileId: string) => {
            expect(fileId).toBe("out_file_1");
            return { text: async () => `${outputLine}\n` };
          },
        },
        batches: {
          create: async () => ({ id: "b" }),
          retrieve: async () => ({
            status: "completed",
            output_file_id: "out_file_1",
          }),
        },
      },
    });
    const r = await adapter.retrieveBatch("batch_abc");
    expect(r.status).toBe("completed");
    expect(r.results?.[0]?.text).toBe("batched reply");
    expect(r.results?.[0]?.usage?.totalTokens).toBe(11);
  });
});

describe("message history (ui v2 reply, KTD7)", () => {
  const HISTORY = [
    { role: "user" as const, content: "first question" },
    { role: "assistant" as const, content: "first answer" },
  ];

  it("Anthropic sync sends prior turns in order, then the prompt", async () => {
    let captured: { messages?: unknown; system?: string } = {};
    const adapter = new AnthropicAdapter({
      apiKey: "test",
      client: {
        messages: {
          create: async (req: typeof captured) => {
            captured = req;
            return { content: [{ type: "text", text: "ok" }], usage: {} };
          },
        },
      },
    });
    await adapter.dispatch("claude-sonnet-4-5", "follow-up", {
      system: "be brief",
      messages: HISTORY,
    });
    expect(captured.system).toBe("be brief");
    expect(captured.messages).toEqual([...HISTORY, { role: "user", content: "follow-up" }]);
  });

  it("Anthropic batch request params carry the turns", async () => {
    let requests: Array<{ params: { messages: unknown } }> = [];
    const adapter = new AnthropicAdapter({
      apiKey: "test",
      client: {
        messages: {
          create: async () => ({}),
          batches: {
            create: async (req: { requests: typeof requests }) => {
              requests = req.requests;
              return { id: "msgbatch_h" };
            },
          },
        },
      },
    });
    await adapter.dispatchBatch("claude-sonnet-4-5", ["follow-up"], { messages: HISTORY });
    expect(requests[0]?.params.messages).toEqual([
      ...HISTORY,
      { role: "user", content: "follow-up" },
    ]);
  });

  it("Anthropic without messages sends exactly one user turn (regression)", async () => {
    let captured: { messages?: unknown } = {};
    const adapter = new AnthropicAdapter({
      apiKey: "test",
      client: {
        messages: {
          create: async (req: typeof captured) => {
            captured = req;
            return { content: [{ type: "text", text: "ok" }], usage: {} };
          },
        },
      },
    });
    await adapter.dispatch("claude-sonnet-4-5", "solo");
    expect(captured.messages).toEqual([{ role: "user", content: "solo" }]);
  });

  it("OpenAI sync puts system first, then the turns, then the prompt", async () => {
    let captured: { messages?: unknown } = {};
    const adapter = new OpenAIAdapter({
      apiKey: "test",
      client: {
        chat: {
          completions: {
            create: async (req: typeof captured) => {
              captured = req;
              return { choices: [{ message: { content: "ok" } }] };
            },
          },
        },
      },
    });
    await adapter.dispatch("gpt-4.1-mini", "follow-up", { system: "sys", messages: HISTORY });
    expect(captured.messages).toEqual([
      { role: "system", content: "sys" },
      ...HISTORY,
      { role: "user", content: "follow-up" },
    ]);
  });

  it("OpenAI batch JSONL lines carry the turns; none means the old body", async () => {
    const lines: string[] = [];
    const adapter = new OpenAIAdapter({
      apiKey: "test",
      client: {
        chat: { completions: { create: async () => ({}) } },
        files: {
          create: async (req: { file: Blob }) => {
            lines.push(await req.file.text());
            return { id: "file_h" };
          },
        },
        batches: { create: async () => ({ id: "batch_h" }) },
      },
    });
    await adapter.dispatchBatch("gpt-4.1-mini", ["follow-up"], { messages: HISTORY });
    await adapter.dispatchBatch("gpt-4.1-mini", ["solo"]);
    expect(JSON.parse(lines[0]!).body.messages).toEqual([
      ...HISTORY,
      { role: "user", content: "follow-up" },
    ]);
    expect(JSON.parse(lines[1]!).body.messages).toEqual([{ role: "user", content: "solo" }]);
  });
});

describe("the model time limit (KTD14)", () => {
  /** An SDK `create` that never answers; it records the abort. */
  function hangingCreate() {
    const seen: { aborted?: boolean; timeout?: number } = {};
    const create = (_req: unknown, options?: { signal?: AbortSignal; timeout?: number }) =>
      new Promise<never>(() => {
        seen.timeout = options?.timeout;
        options?.signal?.addEventListener("abort", () => (seen.aborted = true));
      });
    return { create, seen };
  }

  it.each([
    ["anthropic", (create: ReturnType<typeof hangingCreate>["create"]) => new AnthropicAdapter({ apiKey: "test", client: { messages: { create } } })],
    ["openai", (create: ReturnType<typeof hangingCreate>["create"]) => new OpenAIAdapter({ apiKey: "test", client: { chat: { completions: { create } } } })],
  ])("%s: a call that never answers rejects at timeoutMs, stopped_by llm_timeout, and is aborted; the SDK gets the same timeout", async (provider, make) => {
    const { create, seen } = hangingCreate();
    const started = Date.now();
    const err = (await make(create).dispatch("m", "hi", { timeoutMs: 50 }).catch((e: unknown) => e)) as NonRetryableError;
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(err).toBeInstanceOf(NonRetryableError);
    expect(err.message).toBe(`${provider}: timed out after 0.05s`);
    expect(err.details).toEqual({ stopped_by: "llm_timeout" });
    expect(seen.aborted).toBe(true);
    // The SDK's own default (10 minutes) cannot end a longer call first, unlabelled.
    expect(seen.timeout).toBe(50);
  });

  it("a model error whose text says timed out is not labeled llm_timeout", async () => {
    const create = async () => {
      throw Object.assign(new Error("request timed out upstream"), { status: 400 });
    };
    const adapter = new AnthropicAdapter({ apiKey: "test", client: { messages: { create } } });
    const err = (await adapter.dispatch("m", "hi", { timeoutMs: 5_000 }).catch((e: unknown) => e)) as Error & { details?: unknown };
    expect(err.message).toBe("request timed out upstream");
    expect(err.details).toBeUndefined();
  });

  it("a limit above the setTimeout maximum is clamped: the SDK gets MAX_TIMER_MS and a call that answers at once resolves", async () => {
    expect(MAX_TIMER_MS).toBe(2 ** 31 - 1);
    let timeout: number | undefined;
    const create = async (_req: unknown, options?: { timeout?: number }) => {
      timeout = options?.timeout;
      return { content: [{ type: "text", text: "ok" }], usage: { input_tokens: 1, output_tokens: 1 } };
    };
    const r = await new AnthropicAdapter({ apiKey: "test", client: { messages: { create } } }).dispatch("m", "hi", { timeoutMs: 2 ** 31 });
    expect(r.text).toBe("ok");
    expect(timeout).toBe(MAX_TIMER_MS);
  });

  it("without timeoutMs the client gets the request alone, as before", async () => {
    const calls: unknown[][] = [];
    const create = async (...args: unknown[]) => {
      calls.push(args);
      return { content: [{ type: "text", text: "ok" }], usage: { input_tokens: 1, output_tokens: 1 } };
    };
    await new AnthropicAdapter({ apiKey: "test", client: { messages: { create } } }).dispatch("m", "hi");
    expect(calls[0]).toHaveLength(1);
  });
});
