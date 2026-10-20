/** `tidegap channels` for the registry kinds (integrations plan U13): add, connect, test, disconnect, set, remove, list, kinds. */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { TaskStore } from "@tidegap/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  EXIT,
  runChannelsAction,
  runChannelsAddKind,
  runChannelsKinds,
  runChannelsList,
  runChannelsRemove,
  type ChannelsIo,
  type ChannelsOptions,
} from "../src/commands/channels.js";
import { readSecrets } from "../src/channels/secrets.js";
import { buildProgram } from "../src/index.js";
import { startFakeSink, type FakeSink } from "./fixtures/fake-sink.js";

const HOOK = "/hook/cli-sEcReT-5521";

describe("tidegap channels (registry kinds)", () => {
  let dir: string;
  let sink: FakeSink;
  let opts: ChannelsOptions;
  let out: string[];
  let err: string[];
  const io = (extra: Partial<ChannelsIo> = {}): ChannelsIo => ({ out: (l) => out.push(l), err: (l) => err.push(l), isTTY: false, ...extra });
  const stdin = (obj: unknown) => io({ readStdin: async () => JSON.stringify(obj) });
  const url = () => `${sink.baseUrl}${HOOK}`;
  const secretsFile = () => join(dir, "channel-secrets.json");
  const rows = () => {
    const s = new TaskStore({ dbPath: opts.db! });
    try {
      return s.listChannels();
    } finally {
      s.close();
    }
  };

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "tidegap-channels-cli-"));
    sink = await startFakeSink();
    out = [];
    err = [];
    opts = { db: join(dir, "q.db"), setup: { secretsFile: join(dir, "channel-secrets.json"), uiPorts: () => [1], platform: "linux", http: { waitsMs: [0, 0] } } };
  });
  afterEach(async () => {
    await sink.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("add webhook --format text --secrets-stdin {url} → exit 0, the plan's line, the secret in the file only", async () => {
    const code = await runChannelsAddKind("webhook", { flags: { format: "text", secretsStdin: true } }, opts, stdin({ url: url() }));
    expect([code, out[0]]).toEqual([EXIT.ok, "Connected webhook. Test message sent."]);
    expect(JSON.parse(sink.requests(HOOK)[0]!.body)).toEqual({ text: "Test message from Tidegap. Notifications work." });
    expect(readSecrets("webhook", secretsFile())).toEqual({ url: url() });
    expect(rows()[0]).toMatchObject({ id: "webhook", enabled: true, config: { format: "text", quiet: "off" } });
    expect(out.join("\n")).not.toContain(HOOK);
  });

  it("an unknown flag such as --url is a usage error (exit 2) that never echoes its value", async () => {
    const parsed = await runChannelsAddKind("slack", { flags: {}, unknown: ["--url=https://hooks.slack.com/services/T/B/sEcReT"] }, opts, io());
    expect(parsed).toBe(EXIT.usage);
    expect(err[0]).toMatch(/unknown option --url\. Secrets never go in flags/);
    expect(err.join()).not.toContain("sEcReT");
    const program = buildProgram();
    const errors: string[] = [];
    program.configureOutput({ writeErr: (s) => errors.push(s), writeOut: () => {} });
    const add = program.commands.find((c) => c.name() === "channels")!.commands.find((c) => c.name() === "add")!;
    let unknown: string[] = [];
    add.action((_kind: string, _o: unknown, cmd: { args: string[] }) => void (unknown = cmd.args.slice(1)));
    await program.parseAsync(["node", "tidegap", "channels", "add", "slack", "--url", "sEcReT-value"]);
    expect([unknown, errors]).toEqual([["--url", "sEcReT-value"], []]);
  });

  it("a flag of another kind, an unknown kind or a bad preset is a usage error", async () => {
    expect(await runChannelsAddKind("slack", { flags: { server: "https://x.example" } }, opts, io())).toBe(EXIT.usage);
    expect(err[0]).toMatch(/--server is not a setting of slack/);
    expect(await runChannelsAddKind("fax", { flags: {} }, opts, io())).toBe(EXIT.usage);
    expect(await runChannelsAddKind("email", { flags: { preset: "aol", secretsStdin: true } }, opts, stdin({}))).toBe(EXIT.usage);
  });

  it("add email with no terminal and no --secrets-stdin → exit 2 with the stdin hint; nothing is sent", async () => {
    expect(await runChannelsAddKind("email", { flags: { user: "me@example.com", preset: "gmail" } }, opts, io())).toBe(EXIT.usage);
    expect(err[0]).toMatch(/Pipe them as JSON into --secrets-stdin/);
    expect(rows()).toEqual([]);
  });

  it("on a terminal the secrets are prompted for, hidden; an empty answer skips an optional one", async () => {
    const asked: string[] = [];
    const answers = [url(), "", ""];
    const code = await runChannelsAddKind("webhook", { flags: {} }, opts, io({ isTTY: true, prompt: async (q) => (asked.push(q), answers.shift() ?? "") }));
    expect(code).toBe(EXIT.ok);
    expect(asked).toEqual([
      "Webhook URL (hidden; Enter keeps the stored value): ",
      "Signing secret (hidden, optional; Enter keeps the stored value): ",
      "Extra headers (hidden, optional; Enter keeps the stored value): ",
    ]);
  });

  it("a refused test is exit 1 with the card's sentence and the field; nothing saved", async () => {
    sink.script(HOOK, [{ status: 404 }]);
    expect(await runChannelsAddKind("webhook", { flags: { secretsStdin: true } }, opts, stdin({ url: url() }))).toBe(EXIT.failed);
    expect(err[0]).toBe('tidegap channels add webhook: The receiver does not know this address. Copy the URL again. (secret "url")');
    expect(rows()).toEqual([]);
  });

  it("list --json holds hints only; set stores events and quiet; disconnect then connect sends a test and enables", async () => {
    await runChannelsAddKind("webhook", { flags: { secretsStdin: true, events: "task_done" } }, opts, stdin({ url: url(), secret: "signing-sEcReT-1" }));
    const json = runChannelsList({ json: true }, opts);
    expect(json).not.toContain("sEcReT");
    expect(JSON.parse(json).channels[0]).toMatchObject({ id: "webhook", kind: "webhook", state: "connected", enabled: true, events: ["task_done"], last: { ok: true } });
    expect(runChannelsList({}, opts)).toMatch(/^ID\s+KIND\s+STATE\s+EVENTS\s+LAST\s+TARGET\nwebhook\s+webhook\s+connected\s+task_done\s+\S+ \S+ ok\s+127\.0\.0\.1:\d+ …5521$/);
    expect(await runChannelsAction("set", "webhook", { events: "task_failed", quiet: "night" }, opts, io())).toBe(EXIT.ok);
    expect(rows()[0]).toMatchObject({ events: ["task_failed"], config: { quiet: "night" } });
    expect(await runChannelsAction("disconnect", "webhook", {}, opts, io())).toBe(EXIT.ok);
    expect(rows()[0]!.enabled).toBe(false);
    expect(await runChannelsAction("test", "webhook", {}, opts, io())).toBe(EXIT.failed);
    expect(err.at(-1)).toMatch(/disconnected/);
    expect(await runChannelsAction("connect", "webhook", {}, opts, io())).toBe(EXIT.ok);
    expect(rows()[0]!.enabled).toBe(true);
    expect(sink.requests(HOOK)).toHaveLength(2);
    expect(sink.requests(HOOK)[1]!.headers["x-tidegap-signature"]).toMatch(/^sha256=/);
  });

  it("--clear removes an optional secret; remove deletes the row and its secrets", async () => {
    await runChannelsAddKind("webhook", { flags: { secretsStdin: true } }, opts, stdin({ url: url(), secret: "signing-sEcReT-1" }));
    expect(await runChannelsAddKind("webhook", { flags: { secretsStdin: true, clear: "secret" } }, opts, stdin({}))).toBe(EXIT.ok);
    expect(readSecrets("webhook", secretsFile())).toEqual({ url: url() });
    expect(await runChannelsRemove("webhook", opts)).toBe("Removed channel webhook and its secrets.");
    expect([rows(), readSecrets("webhook", secretsFile())]).toEqual([[], undefined]);
    await expect(runChannelsRemove("webhook", opts)).rejects.toThrow(/no channel with id webhook/);
  });

  it("set needs --events or --quiet; an unknown id is exit 1", async () => {
    expect(await runChannelsAction("set", "webhook", {}, opts, io())).toBe(EXIT.usage);
    expect(await runChannelsAction("test", "nope", {}, opts, io())).toBe(EXIT.failed);
    expect(err.at(-1)).toBe("tidegap channels test nope: This channel is not set up.");
  });

  it("kinds lists each kind's flags, secrets and presets for this platform", () => {
    const linux = runChannelsKinds({}, "linux");
    expect(linux).toMatch(/^email\s+--user --host --port --security --from --to; secrets: password\?; presets: gmail, icloud, fastmail, m365$/m);
    expect(linux).toMatch(/^webhook\s+--format; secrets: url, secret\?, headers\?$/m);
    expect(linux).not.toMatch(/^shortcuts/m);
    expect(runChannelsKinds({}, "darwin")).toMatch(/^shortcuts\s+--name$/m);
    expect(JSON.parse(runChannelsKinds({ json: true }, "linux")).kinds[0].kind).toBe("telegram");
  });
});
