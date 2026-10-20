/**
 * `tidegap channels add <kind> | connect | test | disconnect | set | remove
 * <id> | list | digest [--at HH:MM] | serve [--once]` (coherence U14, U15; all-channels plan
 * U13). Telegram pairs through `add telegram` and its listener;
 * `installListener` writes and loads the listener unit
 * (`com.tidegap.channels` / `tidegap-channels.service`) through
 * `loadAgent`, and unloads it when pairing starts or the last telegram
 * channel is removed. Every other kind goes through `ChannelSetup`, the
 * code path of the page's cards: one-step connect (validate, test message,
 * then save). Secrets come from a hidden prompt or `--secrets-stdin`,
 * never from a flag. Exit codes: 0 success, 1 a refused value or a failed
 * test, 2 usage.
 */

import { KIND_DESCRIPTORS, parseDigestAt, TaskStore, TelegramClient, telegramChatId, type Channel, type KindDescriptor, type KindField } from "@tidegap/core";

import { ChannelSetup, ChannelSetupError, type ChannelSetupOptions, type ChannelStatus } from "../channels/channel-setup.js";

import { pairTelegram, printCode, type InstallListenerHook } from "../channels/pair.js";
import { runListener, type RunListenerOptions } from "../channels/listener.js";
import { createInstallListener } from "../channels/telegram-setup.js";
import { envFileTelegramToken, loadEnvFileIntoProcess } from "./env-file.js";
import { defaultDbPath } from "./tick.js";
import { readTelegramEnv } from "../env.js";
import { channelsUnitPath } from "../platform/index.js";
import { PromptCancelled, promptSecret } from "./prompt-secret.js";

export interface ChannelsOptions {
  db?: string;
  /** Tests: `ChannelSetup` overrides (secrets file, platform, drivers, HTTP waits). */
  setup?: Omit<Partial<ChannelSetupOptions>, "store">;
  envFile?: string;
  installListener?: InstallListenerHook;
  out?: (line: string) => void;
  /** Tests: the fetch the Telegram client uses. */
  fetch?: typeof fetch;
  /** Tests: pairing overrides. */
  pairCode?: string;
  pairTimeoutMs?: number;
  pairPollTimeoutS?: number;
}

const ENV_FILE = "~/.config/tidegap/env";

function store(opts: ChannelsOptions): TaskStore {
  return new TaskStore({ dbPath: opts.db ?? defaultDbPath() });
}

/** `tidegap channels add <kind> [--no-load]`; returns the exit code. */
export async function runChannelsAdd(kind: string, input: { noLoad?: boolean } = {}, opts: ChannelsOptions = {}): Promise<number> {
  const out = opts.out ?? ((line: string) => process.stdout.write(`${line}\n`));
  if (kind !== "telegram") {
    out(`tidegap channels add: unknown kind ${JSON.stringify(kind)}; the only kind is telegram (os is built in)`);
    return 1;
  }
  loadEnvFileIntoProcess(opts.envFile);
  const env = readTelegramEnv();
  if (env.apiBaseRejected) out("tidegap channels add telegram: TIDEGAP_TELEGRAM_API_BASE is not a loopback http URL; using the public Bot API");
  if (!env.token) {
    out(`tidegap channels add telegram: no bot token. Create a bot with @BotFather, then add TIDEGAP_TELEGRAM_BOT_TOKEN=<token> to ${ENV_FILE}.`);
    return 1;
  }
  // The listener unit reads the env file only: a token exported in this
  // shell alone would pair a chat that the listener can never answer.
  if (!opts.installListener && !input.noLoad && channelsUnitPath() !== null && envFileTelegramToken(opts.envFile) !== env.token) {
    out(
      `tidegap channels add telegram: put TIDEGAP_TELEGRAM_BOT_TOKEN in ${ENV_FILE}; the listener reads only that file, ` +
        "and the token in this shell is missing there or differs. Or pass --no-load and run `tidegap channels serve` yourself.",
    );
    return 1;
  }
  const s = store(opts);
  try {
    const res = await pairTelegram({
      store: s,
      client: new TelegramClient({ token: env.token, baseUrl: env.apiBase, fetch: opts.fetch }),
      out,
      onCode: printCode(out),
      installListener: opts.installListener ?? createInstallListener({ out, dbPath: opts.db }),
      noLoad: input.noLoad,
      code: opts.pairCode,
      timeoutMs: opts.pairTimeoutMs,
      pollTimeoutS: opts.pairPollTimeoutS,
    });
    return res.exitCode;
  } finally {
    s.close();
  }
}

function describeChannel(c: Channel): string {
  const chat = telegramChatId(c);
  const who = typeof c.config.label === "string" ? ` ${c.config.label}` : "";
  return chat !== undefined ? `chat ${chat}${who}` : "";
}

/** A `ChannelSetup` on the ledger of `opts` (secrets file under the home folder). */
function setupFor(s: TaskStore, opts: ChannelsOptions): ChannelSetup {
  return new ChannelSetup({ store: s, dbPath: opts.db ?? defaultDbPath(), ...opts.setup });
}

/** One row of `channels list --json`: a registry channel's status (hints only) or a Telegram row, each with its state and last delivery. */
export type ChannelListEntry = (ChannelStatus | Channel) & { enabled: boolean };

/** The rows of `channels list`, with registry kinds as statuses (no secret value). */
function listEntries(s: TaskStore, opts: ChannelsOptions): ChannelListEntry[] {
  const setup = setupFor(s, opts);
  return s.listChannels().map((row) => {
    try {
      const status = setup.channel(row.id);
      return row.kind === "telegram" ? { ...row, state: status.state, ...(status.last ? { last: status.last } : {}) } : { ...status, enabled: row.enabled };
    } catch {
      // A kind this platform does not offer (Shortcuts off macOS): the row as stored; its config holds no secret.
      return row;
    }
  });
}

/** "10:42 ok" / "10:42 http_404" from a last delivery. */
function lastText(e: ChannelListEntry): string {
  const last = (e as { last?: { at: string; ok: boolean; code?: string } }).last;
  return last ? `${last.at.slice(0, 16).replace("T", " ")} ${last.ok ? "ok" : (last.code ?? "failed")}` : "";
}

/** `tidegap channels list [--json]`. */
export function runChannelsList(input: { json?: boolean } = {}, opts: ChannelsOptions = {}): string {
  const s = store(opts);
  let entries: ChannelListEntry[];
  try {
    entries = listEntries(s, opts);
  } finally {
    s.close();
  }
  if (input.json) return JSON.stringify({ channels: entries });
  if (entries.length === 0) return "No channels. Add one with `tidegap channels add <kind>` (kinds: `tidegap channels kinds`). Desktop notifications (os) are built in.";
  const rows = entries.map((e) => {
    const state = "state" in e && typeof e.state === "string" ? e.state : e.enabled ? "on" : "off";
    const target = "target" in e && typeof e.target === "string" ? e.target : describeChannel(e as Channel);
    return [e.id, e.kind, state, e.events.join(","), lastText(e), target];
  });
  const header = ["ID", "KIND", "STATE", "EVENTS", "LAST", "TARGET"];
  const widths = header.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i]!.length)));
  return [header, ...rows].map((r) => r.map((cell, i) => (i < header.length - 1 ? cell.padEnd(widths[i]!) : cell)).join("  ")).join("\n");
}

/**
 * `tidegap channels remove <id>`; throws when no channel has that id.
 * A registry channel loses its secrets and last delivery too (R7);
 * removing the last telegram channel unloads the listener.
 */
export async function runChannelsRemove(id: string, opts: ChannelsOptions = {}): Promise<string> {
  const s = store(opts);
  let lastTelegram = false;
  let registry = false;
  try {
    const row = s.listChannels().find((c) => c.id === id);
    if (!row) throw new Error(`no channel with id ${id}`);
    registry = row.kind !== "telegram";
    if (registry) await setupFor(s, opts).remove(id);
    else {
      s.removeChannel(id);
      lastTelegram = !s.listChannels().some((c) => c.kind === "telegram");
    }
  } finally {
    s.close();
  }
  if (lastTelegram) await (opts.installListener ?? createInstallListener({ dbPath: opts.db }))("unload");
  return registry ? `Removed channel ${id} and its secrets.` : `Removed channel ${id}. The chat loses access on its next message.`;
}

/** Exit codes of the registry commands. */
export const EXIT = { ok: 0, failed: 1, usage: 2 } as const;

/** The kinds `channels add` takes besides Telegram: ready, and offered on `platform`. */
export function cliKinds(platform: NodeJS.Platform = process.platform): KindDescriptor[] {
  return Object.values(KIND_DESCRIPTORS).filter((d) => d.kind !== "telegram" && d.ready && (!d.platforms || d.platforms.includes(platform)));
}

/** `--user-key` for field `user_key`. */
export const fieldFlag = (name: string) => `--${name.replace(/_/g, "-")}`;

/** Commander's key of a flag (`--user-key` → `userKey`). */
const flagKey = (name: string) => name.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());

/** One `channels add` flag per non-secret field name across the CLI kinds; a textarea field repeats (one line each). */
export interface KindFieldOption {
  name: string;
  flag: string;
  repeat: boolean;
  /** The kinds with this field, for the help text. */
  kinds: string[];
  help: string;
}

export function kindFieldOptions(kinds: readonly KindDescriptor[] = Object.values(KIND_DESCRIPTORS).filter((d) => d.kind !== "telegram")): KindFieldOption[] {
  const out = new Map<string, KindFieldOption>();
  for (const d of kinds) {
    for (const f of d.fields) {
      if (f.secret) continue;
      const o = out.get(f.name) ?? { name: f.name, flag: fieldFlag(f.name), repeat: f.input === "textarea", kinds: [], help: f.label };
      o.kinds.push(d.kind);
      out.set(f.name, o);
    }
  }
  return [...out.values()];
}

export interface ChannelsIo {
  out?: (line: string) => void;
  err?: (line: string) => void;
  /** All of stdin, for `--secrets-stdin`. */
  readStdin?: () => Promise<string>;
  /** stdin is a terminal: missing secrets are prompted for, hidden. */
  isTTY?: boolean;
  /** A hidden prompt; default {@link promptSecret}. */
  prompt?: (question: string) => Promise<string>;
}

export interface ChannelsAddInput {
  /** Parsed commander options: field values by camelCase key, plus the generic flags. */
  flags: Record<string, unknown>;
  /** Tokens commander did not know (an unknown flag such as `--url x`). */
  unknown?: readonly string[];
}

/** stdout and stderr line writers, unless the caller passed its own. */
function writers(opts: ChannelsOptions, io: ChannelsIo): { out: (line: string) => void; err: (line: string) => void } {
  return {
    out: io.out ?? opts.out ?? ((line: string) => process.stdout.write(`${line}\n`)),
    err: io.err ?? ((line: string) => process.stderr.write(`${line}\n`)),
  };
}

const readAll = async (): Promise<string> => {
  let text = "";
  for await (const chunk of process.stdin) text += String(chunk);
  return text;
};

/** The flag part of an unknown token: `--url=x` → `--url`; a bare value is not shown at all (it may be a secret). */
function tokenName(token: string): string {
  return token.startsWith("-") ? token.split("=")[0]! : "an extra argument";
}

function setupError(err: unknown, d: KindDescriptor | undefined, prefix: string): string {
  // Not a refusal: the ledger or the secrets file failed. Its text names a path, never a secret.
  if (!(err instanceof ChannelSetupError)) return `${prefix}: ${err instanceof Error ? err.message : String(err)}`;
  const f = d && err.field ? d.fields.find((x) => x.name === err.field) : undefined;
  const where = f ? (f.secret ? ` (secret "${f.name}")` : ` (${fieldFlag(f.name)})`) : "";
  return `${prefix}: ${err.message}${where}`;
}

/** The secret field values a terminal user types, hidden; an empty answer keeps the stored value. */
async function promptSecrets(d: KindDescriptor, io: Required<Pick<ChannelsIo, "prompt">>): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const f of d.fields.filter((x) => x.secret)) {
    const hint = f.required ? "" : ", optional";
    const answer = (await io.prompt(`${f.label} (hidden${hint}; Enter keeps the stored value): `)).trim();
    if (answer) out[f.name] = answer;
  }
  return out;
}

/** `--secrets-stdin`: one JSON object of strings (or numbers) on stdin. */
function parseSecretsJson(text: string): Record<string, string | number> | undefined {
  try {
    const v = JSON.parse(text) as unknown;
    if (!v || typeof v !== "object" || Array.isArray(v)) return undefined;
    if (Object.values(v).some((x) => typeof x !== "string" && typeof x !== "number")) return undefined;
    return v as Record<string, string | number>;
  } catch {
    return undefined;
  }
}

const csv = (v: unknown) => (typeof v === "string" ? v.split(",").map((x) => x.trim()).filter(Boolean) : undefined);

/**
 * `tidegap channels add <kind>` for every kind but Telegram: flags for the
 * non-secret fields, secrets from `--secrets-stdin` or a hidden prompt,
 * then the one-step connect of the card. Returns the exit code.
 */
export async function runChannelsAddKind(kind: string, input: ChannelsAddInput, opts: ChannelsOptions = {}, io: ChannelsIo = {}): Promise<number> {
  const { out, err } = writers(opts, io);
  const prefix = `tidegap channels add ${kind}`;
  const kinds = cliKinds(opts.setup?.platform ?? process.platform);
  const d = kinds.find((k) => k.kind === kind);
  if (!d) {
    err(`${prefix}: unknown kind. Kinds: telegram, ${kinds.map((k) => k.kind).join(", ")}.`);
    return EXIT.usage;
  }
  const unknown = input.unknown ?? [];
  if (unknown.length > 0) {
    err(`${prefix}: unknown option ${tokenName(unknown[0]!)}. Secrets never go in flags: use --secrets-stdin or the hidden prompt. See \`tidegap channels add --help\`.`);
    return EXIT.usage;
  }
  const own = new Set(d.fields.filter((f) => !f.secret).map((f) => f.name));
  const fields: Record<string, unknown> = {};
  for (const o of kindFieldOptions()) {
    const v = input.flags[flagKey(o.name)];
    if (v === undefined) continue;
    if (!own.has(o.name)) {
      err(`${prefix}: ${o.flag} is not a setting of ${kind}.`);
      return EXIT.usage;
    }
    fields[o.name] = Array.isArray(v) ? v.join("\n") : v;
  }
  const presetId = input.flags.preset;
  if (presetId !== undefined) {
    const preset = d.presets?.find((p) => p.id === presetId);
    if (!preset) {
      err(`${prefix}: unknown --preset. Presets: ${(d.presets ?? []).map((p) => p.id).join(", ") || "none"}.`);
      return EXIT.usage;
    }
    for (const [k, v] of Object.entries(preset.values)) fields[k] ??= v;
  }
  const secretFields = d.fields.filter((f) => f.secret);
  let secrets: Record<string, string | number> = {};
  if (input.flags.secretsStdin === true) {
    const parsed = parseSecretsJson(await (io.readStdin ?? readAll)());
    if (!parsed) {
      err(`${prefix}: --secrets-stdin needs one JSON object of strings on stdin, for example {"${secretFields[0]?.name ?? "password"}": "…"}.`);
      return EXIT.usage;
    }
    secrets = parsed;
  } else if (secretFields.length > 0) {
    if (!(io.isTTY ?? process.stdin.isTTY === true)) {
      err(`${prefix}: this kind has secrets (${secretFields.map((f) => f.name).join(", ")}). Pipe them as JSON into --secrets-stdin, or run it in a terminal to type them hidden.`);
      return EXIT.usage;
    }
    try {
      secrets = await promptSecrets(d, { prompt: io.prompt ?? ((q) => promptSecret(q)) });
    } catch (e) {
      if (!(e instanceof PromptCancelled)) throw e;
      err(`${prefix}: cancelled. Nothing was saved.`);
      return EXIT.failed;
    }
  }
  const s = store(opts);
  try {
    const channel = await setupFor(s, opts).connect(kind, { ...secrets, ...fields }, {
      ...(input.flags.events !== undefined ? { events: csv(input.flags.events) } : {}),
      ...(input.flags.quiet !== undefined ? { quiet: input.flags.quiet } : {}),
      ...(input.flags.clear !== undefined ? { clear: csv(input.flags.clear) } : {}),
    });
    out(`Connected ${kind}. Test message sent.`);
    out(`  ${channel.target}`);
    return EXIT.ok;
  } catch (e) {
    err(setupError(e, d, prefix));
    return EXIT.failed;
  } finally {
    s.close();
  }
}

/** `channels connect | test | disconnect <id>` and `channels set <id>`: one `ChannelSetup` action. */
export async function runChannelsAction(
  action: "connect" | "test" | "disconnect" | "set",
  id: string,
  input: { events?: string; quiet?: string } = {},
  opts: ChannelsOptions = {},
  io: ChannelsIo = {},
): Promise<number> {
  const { out, err } = writers(opts, io);
  const prefix = `tidegap channels ${action} ${id}`;
  if (action === "set" && input.events === undefined && input.quiet === undefined) {
    err(`${prefix}: set --events and/or --quiet.`);
    return EXIT.usage;
  }
  const s = store(opts);
  try {
    const setup = setupFor(s, opts);
    const kind = s.listChannels().find((c) => c.id === id)?.kind;
    const d = kind && kind !== "os" ? KIND_DESCRIPTORS[kind] : undefined;
    if (action === "connect") {
      if (kind === "telegram") throw new ChannelSetupError("telegram", "Telegram pairs with `tidegap channels add telegram`.");
      if (!d) throw new ChannelSetupError("not_found", "This channel is not set up.");
      await setup.connect(d.kind, {});
      out(`Connected ${id}. Test message sent.`);
    } else if (action === "test") {
      await setup.test(id);
      out(`Test message sent to ${id}.`);
    } else if (action === "disconnect") {
      await setup.disconnect(id);
      out(`Disconnected ${id}. Settings kept; \`tidegap channels connect ${id}\` resumes it.`);
    } else {
      const ch = await setup.settings(id, { ...(input.events !== undefined ? { events: csv(input.events) ?? [] } : {}), ...(input.quiet !== undefined ? { quiet: input.quiet } : {}) });
      out(`Saved ${id}: events ${ch.events.join(",") || "none"}, quiet ${ch.quiet}.`);
    }
    return EXIT.ok;
  } catch (e) {
    err(setupError(e, undefined, prefix));
    return EXIT.failed;
  } finally {
    s.close();
  }
}

/**
 * `tidegap channels digest [--at HH:MM]`: show or set the daily summary's
 * local send time. Exit 2 for a time that is not HH:MM.
 */
export function runChannelsDigest(input: { at?: string } = {}, opts: ChannelsOptions = {}, io: ChannelsIo = {}): number {
  const { out, err } = writers(opts, io);
  if (input.at !== undefined && !parseDigestAt(input.at)) {
    err("tidegap channels digest: give --at as HH:MM, 00:00 to 23:59.");
    return EXIT.usage;
  }
  const s = store(opts);
  try {
    const setup = setupFor(s, opts);
    const d = input.at !== undefined ? setup.setDigestTime(input.at) : setup.digest();
    const ids = s.listChannels().filter((c) => c.enabled && c.events.includes("digest")).map((c) => c.id);
    out(`Daily summary at ${d.at} local time. Last sent: ${d.last ?? "never"}.`);
    out(ids.length > 0 ? `Channels: ${ids.join(", ")}.` : "No channel subscribes to it. Add it with `tidegap channels set <id> --events …,digest`.");
    return EXIT.ok;
  } finally {
    s.close();
  }
}

/** `tidegap channels kinds [--json]`: what `channels add` takes, per kind: flags, secrets, presets. */
export function runChannelsKinds(input: { json?: boolean } = {}, platform: NodeJS.Platform = process.platform): string {
  const kinds = cliKinds(platform).map((d) => ({
    kind: d.kind,
    label: d.label,
    flags: d.fields.filter((f: KindField) => !f.secret).map((f) => fieldFlag(f.name)),
    secrets: d.fields.filter((f: KindField) => f.secret).map((f) => (f.required ? f.name : `${f.name}?`)),
    ...(d.presets?.length ? { presets: d.presets.map((p) => p.id) } : {}),
  }));
  if (input.json) return JSON.stringify({ kinds: [{ kind: "telegram", label: "Telegram", flags: [], secrets: [] }, ...kinds] });
  const lines = ["telegram    pair with `tidegap channels add telegram` (bot token in ~/.config/tidegap/env)"];
  for (const k of kinds) {
    const parts = [k.flags.join(" ") || "no flags", k.secrets.length ? `secrets: ${k.secrets.join(", ")}` : "", k.presets ? `presets: ${k.presets.join(", ")}` : ""].filter(Boolean);
    lines.push(`${k.kind.padEnd(10)}  ${parts.join("; ")}`);
  }
  return lines.join("\n");
}

/** `tidegap channels serve [--once]`: the listener process. */
export function runChannelsServe(input: { once?: boolean } = {}, opts: ChannelsOptions & Omit<RunListenerOptions, "db" | "envFile" | "once"> = {}): Promise<number> {
  return runListener({ ...opts, once: input.once });
}
