/** Shared setup of the per-kind driver tests: a ledger, a fake sink and a `ChannelSetup` with instant waits. */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { TaskStore } from "@tidegap/core";
import { afterEach, beforeEach, expect } from "vitest";

import { ChannelSetup, ChannelSetupError, type ChannelSetupOptions } from "../src/channels/channel-setup.js";
import { channelSender, type ChannelSender } from "../src/channels/emit.js";
import { startFakeSink, type FakeSink } from "./fixtures/fake-sink.js";

export interface KindEnv {
  /** A fresh temp directory, removed after the test. */
  dir: string;
  store: TaskStore;
  sink: FakeSink;
  setup: ChannelSetup;
  secretsFile: string;
  /** Waits the transport asked for, in ms. */
  waits: number[];
}

/** Fresh env per test; read it through the returned getter. `extra` may set the platform and driver settings (built per test from its dir and sink). */
export function kindEnv(extra: (dir: string, sink: FakeSink) => Partial<Pick<ChannelSetupOptions, "platform" | "driver">> = () => ({})): () => KindEnv {
  let env: KindEnv;
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
      ...extra(dir, sink),
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

/** The HTTP channel kinds, each pointed at a fake sink: its secrets and the path it posts to. */
export const HTTP_KINDS = [
  { kind: "webhook", path: "/hook/tidegap", fields: (base: string) => ({ url: `${base}/hook/tidegap` }) },
  { kind: "slack", path: "/services/T0001/B0001/hook", fields: (base: string) => ({ url: `${base}/services/T0001/B0001/hook` }) },
  { kind: "discord", path: "/api/webhooks/1/hook", fields: (base: string) => ({ url: `${base}/api/webhooks/1/hook` }) },
  { kind: "ntfy", path: "/tidegap-qa0123456789", fields: (base: string) => ({ server: base, topic: "tidegap-qa0123456789" }) },
  { kind: "pushover", path: "/1/messages.json", fields: () => ({ user_key: "uQiRzpo4DXghDmr9QzzfQu27cmVRsG", app_token: "azGDORePK8gMaC0QOYAMyEEuzJnyUi" }) },
] as const;

export type HttpKind = (typeof HTTP_KINDS)[number];

/**
 * A sender of `kind` to `sink` whose first request the sink takes and never
 * answers, so the send ends at the `totalMs` time limit after the request
 * went out; later requests get 200. `release()` ends the held request.
 */
export function heldFirstSend(sink: FakeSink, kind: HttpKind, totalMs = 200): { send: ChannelSender; release: () => void } {
  let release!: () => void;
  const until = new Promise<void>((r) => (release = r));
  sink.script(kind.path, [{ until }, { status: 200 }]);
  const fields = kind.fields(sink.baseUrl);
  const send = channelSender({
    secrets: () => fields,
    driver: { http: { uiPorts: [1], totalMs, sleep: async () => {} }, env: { pushoverApiBase: sink.baseUrl, pushoverApiBaseRejected: false, shortcutsBin: "/nonexistent", childEnv: {} } },
  });
  return { send, release };
}
