/** Shared setup of the per-kind driver tests: a ledger, a fake sink and a `ChannelSetup` with instant waits. */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { TaskStore } from "@tidegap/core";
import { afterEach, beforeEach, expect } from "vitest";

import { ChannelSetup, ChannelSetupError } from "../src/channels/channel-setup.js";
import { startFakeSink, type FakeSink } from "./fixtures/fake-sink.js";

export interface KindEnv {
  store: TaskStore;
  sink: FakeSink;
  setup: ChannelSetup;
  secretsFile: string;
  /** Waits the transport asked for, in ms. */
  waits: number[];
}

/** Fresh env per test; read it through the returned getter. */
export function kindEnv(): () => KindEnv {
  let env: KindEnv & { dir: string };
  beforeEach(async () => {
    const dir = mkdtempSync(join(tmpdir(), "tidegap-channel-kind-"));
    const store = new TaskStore({ dbPath: join(dir, "q.db") });
    const sink = await startFakeSink();
    const secretsFile = join(dir, "channel-secrets.json");
    const waits: number[] = [];
    const setup = new ChannelSetup({
      store,
      secretsFile,
      uiPorts: () => [1],
      platform: "linux",
      http: { waitsMs: [0, 0], sleep: async (ms) => void waits.push(ms) },
    });
    env = { dir, store, sink, setup, secretsFile, waits };
  });
  afterEach(async () => {
    env.store.close();
    await env.sink.close();
    rmSync(env.dir, { recursive: true, force: true });
  });
  return () => env;
}

/** The `ChannelSetupError` a promise rejects with. */
export async function refused(p: Promise<unknown>): Promise<ChannelSetupError> {
  const err = await p.then(() => undefined, (e: unknown) => e);
  expect(err).toBeInstanceOf(ChannelSetupError);
  return err as ChannelSetupError;
}
