/** Shared setup of the job tests: a temp ledger, a scheduler, fake adapters, fake Date. */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { vi } from "vitest";

import { createJob, mockGridFeed, Scheduler } from "../src/index.js";
import type { GridFeed, JobInput, ProviderAdapter, TaskStore } from "../src/index.js";

export const MIN = 60_000;
export const H = 60 * MIN;
export const DAY = 24 * H;
/** A Tuesday noon, far from any DST change. */
export const T0 = Date.parse("2026-10-20T12:00:00.000Z");

export function at(ms: number): void {
  vi.setSystemTime(new Date(ms));
}

export interface Harness {
  s: Scheduler;
  store: TaskStore;
  done(): void;
}

export function harness(feed: GridFeed = mockGridFeed()): Harness {
  vi.useFakeTimers({ toFake: ["Date"] });
  at(T0);
  const dir = mkdtempSync(join(tmpdir(), "tidegap-jobs-"));
  const s = new Scheduler({ dbPath: join(dir, "queue.db"), feed, signing: false, rng: () => 0, defaultRegion: "DE" });
  return {
    s,
    store: s.ledger()!,
    done() {
      vi.useRealTimers();
      s.shutdown();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

/** A fake LLM adapter: completes, or fails with `fail` (multi-line allowed), or waits on `gate`. */
export function llm(opts: { fail?: string; gate?: Promise<void>; defer?: Date } = {}): ProviderAdapter {
  return {
    provider: "anthropic",
    ready: true,
    async dispatch(model) {
      if (opts.gate) await opts.gate;
      if (opts.defer) {
        const { ProviderDeferError } = await import("../src/index.js");
        throw new ProviderDeferError("usage limit", opts.defer);
      }
      if (opts.fail) throw Object.assign(new Error(opts.fail), { status: 400 });
      return { text: "done", model, provider: "anthropic", raw: null };
    },
  };
}

export const PROMPT_JOB: JobInput = {
  title: "Mail digest",
  cadence: { kind: "daily" },
  timeZone: "UTC",
  template: { runner: "prompt", prompt: "check my mail and tell me what matters", provider: "anthropic", tools: "none" },
};

export function job(s: Scheduler, extra: Partial<JobInput> = {}) {
  return createJob(s, { ...PROMPT_JOB, ...extra }, { actor: "cli" });
}

/** Live (queued, scheduled, running, submitted) occurrences of a job. */
export function live(store: TaskStore, jobId: string) {
  return store.list({ jobId }).filter((t) => ["queued", "scheduled", "running", "submitted"].includes(t.status));
}
