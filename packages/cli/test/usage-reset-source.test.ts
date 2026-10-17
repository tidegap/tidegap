/**
 * The usage module plugged into core "Later → after limit reset" (KTD5):
 * a statusline reading in a temp cache drives `postponeTask`.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { mockGridFeed, Scheduler, TaskStore } from "@tidegap/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { usageLimitResetSource, writeUsageCache } from "../src/usage/index.js";

const H = 3_600_000;
let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "tidegap-reset-source-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const usage = () => ({ cachePath: join(dir, "usage.json"), configPath: join(dir, "config"), env: {} });

function seed(reset: Date): void {
  writeUsageCache(
    {
      version: 1,
      claude: {
        statusline: {
          fetched_at: new Date().toISOString(),
          data: { five_hour: { pct: 100, resets_at: reset.toISOString() }, scoped: [] },
        },
      },
    },
    usage().cachePath,
  );
}

async function task(s: Scheduler, provider: "anthropic" | "openai") {
  return s.enqueueProviderCall(
    { type: "provider_call", provider, model: "m", prompt: "p" },
    { deadline: new Date(Date.now() + 2 * H), region: "DE" },
  );
}

describe("usageLimitResetSource", () => {
  it("postpones an anthropic task to the Claude reset plus 5 minutes", async () => {
    const reset = new Date(Math.ceil((Date.now() + 3 * H) / 60_000) * 60_000);
    seed(reset);
    const dbPath = join(dir, "q.db");
    const s = new Scheduler({ dbPath, feed: mockGridFeed(), signing: false, rng: () => 0, limitReset: usageLimitResetSource(usage()) });
    const rec = await task(s, "anthropic");
    await s.postponeTask(rec.taskId, { preset: "after_limit_reset" });
    const store = new TaskStore({ dbPath });
    expect(store.get(rec.taskId)!.notBefore).toBe(new Date(reset.getTime() + 5 * 60_000).toISOString());
    store.close();
    s.shutdown();
  });

  it("knows no reset for other providers or without limit state", async () => {
    const source = usageLimitResetSource(usage());
    const s = new Scheduler({ feed: mockGridFeed(), signing: false, rng: () => 0 });
    expect(await source(await task(s, "openai"), new Date())).toBeNull();
    expect(await source(await task(s, "anthropic"), new Date())).toBeNull();
    seed(new Date(Date.now() + H));
    expect(await source(await task(s, "anthropic"), new Date())).toMatchObject({ source: "usage:five_hour" });
    s.shutdown();
  });
});
