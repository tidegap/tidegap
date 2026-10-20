/**
 * Channel setup (integrations plan KTD6, U3): the one module the page's
 * integrations routes and `tidegap channels …` call to read, connect, test,
 * disconnect, remove and change the settings of a registry channel. The
 * API contract is `docs/plans/2026-10-19-channels-api-contract.md`.
 *
 * Rules:
 * - One channel per kind: the channel id is the kind (Q1).
 * - Connect is one step: merge the stored values into every empty field,
 *   validate, check the URL policy, send a test message with the candidate
 *   values, and only then write the secrets, the row and the last delivery.
 *   On any failure nothing is written (R1, R7, R8).
 * - Secrets never leave this module: a status carries hints only, and every
 *   error is a fixed sentence per code (R2, R6, R17).
 * - A connect for an id is claimed before its first await; a second one for
 *   the same id shares its result (one test send).
 */

import { dirname } from "node:path";

import {
  channelQuiet,
  descriptorData,
  EVENT_KINDS,
  KIND_DESCRIPTORS,
  testPayload,
  validateFields,
  type Channel,
  type EventKind,
  type FieldErrorCode,
  type KindDescriptor,
  type KindDescriptorData,
  type KindField,
  type QuietMode,
  type RegistryKind,
} from "@tidegap/core";

import { defaultDbPath } from "../commands/tick.js";
import type { ChannelDriver, DriverKind } from "./drivers/index.js";
import { CHANNEL_LAST_META_PREFIX, deliverPayload, type LastDelivery } from "./emit.js";
import { DeliveryError, type HttpSendOptions } from "./http.js";
import { channelSecretsPath, readSecrets, writeSecrets, type SecretMap } from "./secrets.js";
import { checkUrl, uiPortsFor, type UrlPolicyCode } from "./url-policy.js";

/** The card state of a set-up channel (KTD7). */
export type ChannelState = "connected" | "disconnected" | "error";

/** One set-up channel as the page and `channels list --json` see it: no secret value. */
export interface ChannelStatus {
  id: string;
  kind: RegistryKind;
  state: ChannelState;
  /** One line, no secret. */
  target: string;
  /** Non-secret field values. */
  fields: Record<string, string | number>;
  /** Secret field name → hint. */
  secrets: Record<string, string>;
  events: EventKind[];
  quiet: QuietMode;
  last?: LastDelivery;
  /** State `error`: the sentence of the last delivery's code. */
  error?: string;
  /** A URL field is plain http to a host outside the user's network. */
  warning?: "cleartext";
}

export interface ChannelsOverview {
  kinds: KindDescriptorData[];
  channels: ChannelStatus[];
}

/** Why an action was refused; the API maps it to an HTTP status (contract "Error codes"). */
export type ChannelSetupCode = "invalid" | "unknown_kind" | "not_found" | "not_connected" | "telegram" | "test_failed" | "unreachable";

/** A refused action: one sentence with the fix, the field at fault, the mapped delivery code. */
export class ChannelSetupError extends Error {
  override name = "ChannelSetupError";
  constructor(
    readonly code: ChannelSetupCode,
    message: string,
    readonly field?: string,
    readonly delivery?: string,
  ) {
    super(message);
  }
}

/** Fixed sentences that name no field. */
export const CHANNEL_TEXT = {
  unknown_kind: "This channel kind is not available here.",
  not_found: "This channel is not set up.",
  not_connected: "This channel is disconnected. Press Connect first.",
  telegram: "Use the Telegram card's own actions for Telegram.",
  events: "Pick events from the list: task_done, task_failed, clean_window, not_ready, digest.",
  quiet: "Quiet must be \"night\" or \"off\".",
} as const;

const FIELD_TEXT: Record<FieldErrorCode, (label: string) => string> = {
  required: (label) => `Fill in ${label}.`,
  invalid: (label) => `${label} is not valid. Check it and try again.`,
  too_long: (label) => `${label} is too long. Check that you pasted only the value.`,
};

const POLICY_TEXT: Record<UrlPolicyCode, string> = {
  invalid_url: "This is not a valid address. Paste the full URL, starting with https://.",
  scheme: "Use an address that starts with https:// or http://.",
  userinfo: "Remove the user name and password from the address. Put a token in the headers instead.",
  blocked_address: "Tidegap does not send to this address (link-local or cloud metadata). Use the receiver's own URL.",
  ui_port: "This address is the Tidegap page itself. Paste the receiver's URL.",
};

/** Generic sentences per delivery code; a kind's `errors` overrides them. */
const DELIVERY_TEXT: Readonly<Record<string, string>> = {
  ...POLICY_TEXT,
  auth: "The receiver refused the message (not authorized). Check the URL or the token and try again.",
  http_404: "The receiver does not know this address. Copy the URL again.",
  http_410: "The receiver says this address is gone. Create a new one and paste it.",
  http_413: "The receiver refused the message as too large.",
  redirect: "The address redirects. Paste the final URL.",
  rate_limited: "The receiver asks Tidegap to slow down. Wait a minute and try again.",
  timeout: "The receiver did not answer in 20 seconds. Check the address and try again.",
  network: "Tidegap could not reach the receiver. Check the address and the network connection.",
  tls: "The receiver's TLS certificate was not accepted. Check the address.",
  not_ready: "This channel kind is not available yet.",
};

const HTTP_4XX = /^http_4\d\d$/;
const HTTP_5XX = /^http_5\d\d$/;

/** Codes where the receiver was not reached or failed itself: 502 `unreachable`. */
function isUnreachable(code: string): boolean {
  return code === "network" || code === "timeout" || code === "rate_limited" || HTTP_5XX.test(code);
}

/** Codes that blame the address: the error goes under the kind's URL field. */
function blamesAddress(code: string): boolean {
  return Object.hasOwn(POLICY_TEXT, code) || ["auth", "redirect", "tls"].includes(code) || HTTP_4XX.test(code);
}

function genericDeliveryText(code: string): string {
  if (Object.hasOwn(DELIVERY_TEXT, code)) return DELIVERY_TEXT[code]!;
  if (HTTP_4XX.test(code)) return `The receiver refused the test message (HTTP ${code.slice(5)}). Check the settings and try again.`;
  if (HTTP_5XX.test(code)) return `The receiver had an error (HTTP ${code.slice(5)}). Try again later.`;
  return "The test message was not sent. Check the settings and try again.";
}

/** The sentence and field of a delivery code for a kind. */
export function deliveryText(descriptor: KindDescriptor, code: string): { text: string; field?: string } {
  const own = descriptor.errors && Object.hasOwn(descriptor.errors, code) ? descriptor.errors[code] : undefined;
  const urlField = descriptor.fields.find((f) => f.input === "url")?.name;
  const field = own?.field ?? (blamesAddress(code) ? urlField : undefined);
  return { text: own?.text ?? genericDeliveryText(code), ...(field ? { field } : {}) };
}

function deliveryFailure(descriptor: KindDescriptor, code: string): ChannelSetupError {
  const { text, field } = deliveryText(descriptor, code);
  return new ChannelSetupError(isUnreachable(code) ? "unreachable" : "test_failed", text, field, code);
}

/** Secrets shorter than this show as "stored": four characters of a short value say too much. */
const MIN_HINT_LENGTH = 12;

/** A secret's hint (R6): the last 4 characters; a URL also shows its host. */
export function secretHint(field: KindField, value: string): string {
  if (value.length < MIN_HINT_LENGTH) return "stored";
  const tail = `…${value.slice(-4)}`;
  if (field.input !== "url") return tail;
  try {
    return `${new URL(value).host} ${tail}`;
  } catch {
    return tail;
  }
}

const isEmpty = (v: unknown) => v === undefined || v === null || (typeof v === "string" && v.trim() === "");

/** Events from a request: known kinds only, duplicates dropped, in `EVENT_KINDS` order. */
export function parseEvents(raw: unknown): EventKind[] {
  if (!Array.isArray(raw) || raw.some((e) => typeof e !== "string" || !(EVENT_KINDS as readonly string[]).includes(e))) {
    throw new ChannelSetupError("invalid", CHANNEL_TEXT.events, "events");
  }
  return EVENT_KINDS.filter((k) => raw.includes(k));
}

export function parseQuiet(raw: unknown): QuietMode {
  if (raw !== "night" && raw !== "off") throw new ChannelSetupError("invalid", CHANNEL_TEXT.quiet, "quiet");
  return raw;
}

/** The ledger calls setup needs (a `TaskStore` satisfies it). */
export interface ChannelSetupStore {
  listChannels(): Channel[];
  insertChannel(channel: Channel): void;
  removeChannel(id: string): boolean;
  getMeta(key: string): string | undefined;
  setMeta(key: string, value: string): void;
  deleteMeta(key: string): void;
}

export interface ChannelSetupOptions {
  store: ChannelSetupStore;
  /** Default `~/.config/tidegap/channel-secrets.json` under `home`. */
  secretsFile?: string;
  home?: string;
  /** Locates the UI discovery file when `uiPorts` is absent. */
  dbPath?: string;
  /** Loopback ports of the `tidegap ui` server (URL policy). Default: the discovery file and the default port. */
  uiPorts?: () => readonly number[];
  /** Which kinds run here (`platforms`). Default `process.platform`. */
  platform?: NodeJS.Platform;
  /** Tests: HTTP transport overrides (waits, sleep, DNS). */
  http?: Partial<Omit<HttpSendOptions, "uiPorts">>;
  /** Tests: drivers instead of the real ones. */
  drivers?: Readonly<Record<DriverKind, ChannelDriver>>;
  now?: () => number;
}

export interface ConnectOptions {
  events?: unknown;
  quiet?: unknown;
}

export interface SettingsInput {
  events?: unknown;
  quiet?: unknown;
}

export class ChannelSetup {
  private readonly store: ChannelSetupStore;
  private readonly secretsFile: string;
  private readonly uiPorts: () => readonly number[];
  private readonly platform: NodeJS.Platform;
  private readonly now: () => number;
  /** Connects in flight, per channel id. */
  private readonly connecting = new Map<string, Promise<ChannelStatus>>();

  constructor(private readonly opts: ChannelSetupOptions) {
    this.store = opts.store;
    this.secretsFile = opts.secretsFile ?? channelSecretsPath(opts.home);
    this.uiPorts = opts.uiPorts ?? (() => uiPortsFor(dirname(opts.dbPath ?? defaultDbPath())));
    this.platform = opts.platform ?? process.platform;
    this.now = opts.now ?? Date.now;
  }

  /** Ready kinds that run on this platform, in card order. */
  private listedKinds(): KindDescriptor[] {
    return Object.values(KIND_DESCRIPTORS).filter((d) => d.ready && (!d.platforms || d.platforms.includes(this.platform)));
  }

  /** The descriptor of a registry kind (not Telegram) that is listed here, else `unknown_kind`. */
  private descriptor(kind: unknown): KindDescriptor & { kind: DriverKind } {
    const d = this.listedKinds().find((k) => k.kind === kind);
    if (!d) throw new ChannelSetupError("unknown_kind", CHANNEL_TEXT.unknown_kind);
    if (d.kind === "telegram") throw new ChannelSetupError("telegram", CHANNEL_TEXT.telegram);
    return d as KindDescriptor & { kind: DriverKind };
  }

  /** The row of `id`, with its listed kind; Telegram only when `telegram` is allowed. */
  private row(id: string, telegram = false): Channel {
    const row = this.store.listChannels().find((c) => c.id === id);
    if (!row || row.kind === "os" || !this.listedKinds().some((d) => d.kind === row.kind)) {
      throw new ChannelSetupError("not_found", CHANNEL_TEXT.not_found);
    }
    if (row.kind === "telegram" && !telegram) throw new ChannelSetupError("telegram", CHANNEL_TEXT.telegram);
    return row;
  }

  private secrets(id: string): SecretMap {
    return readSecrets(id, this.secretsFile) ?? {};
  }

  private lastOf(id: string): LastDelivery | undefined {
    try {
      const v = JSON.parse(this.store.getMeta(`${CHANNEL_LAST_META_PREFIX}${id}`) ?? "null") as Partial<LastDelivery> | null;
      if (!v || typeof v.at !== "string" || typeof v.ok !== "boolean") return undefined;
      return { at: v.at, ok: v.ok, ...(typeof v.code === "string" ? { code: v.code } : {}) };
    } catch {
      return undefined;
    }
  }

  private recordLast(id: string, result: Omit<LastDelivery, "at">): void {
    this.store.setMeta(`${CHANNEL_LAST_META_PREFIX}${id}`, JSON.stringify({ at: new Date(this.now()).toISOString(), ...result }));
  }

  /** The status of one row; reads its secrets only to build hints. */
  private statusOf(row: Channel): ChannelStatus {
    const kind = row.kind as RegistryKind;
    const descriptor = KIND_DESCRIPTORS[kind];
    const last = this.lastOf(row.id);
    const state: ChannelState = !row.enabled ? "disconnected" : last && !last.ok ? "error" : "connected";
    const fields: Record<string, string | number> = {};
    const hints: Record<string, string> = {};
    let target: string;
    let warning: "cleartext" | undefined;
    if (kind === "telegram") {
      const label = row.config.label;
      target = typeof label === "string" && label ? label : `chat ${String(row.config.chat_id ?? "")}`.trim();
    } else {
      const stored = this.secrets(row.id);
      for (const f of descriptor.fields) {
        const v = f.secret ? stored[f.name] : row.config[f.name];
        if (typeof v !== "string" && typeof v !== "number") continue;
        if (f.secret) hints[f.name] = secretHint(f, String(v));
        else fields[f.name] = v;
        if (f.input === "url" && typeof v === "string") {
          const res = checkUrl(v, { uiPorts: [] });
          if (res.ok && res.warning) warning = res.warning;
        }
      }
      const urlHint = descriptor.fields.find((f) => f.input === "url" && hints[f.name] !== undefined);
      const firstValue = Object.values(fields).find((v) => typeof v === "string" && v !== "");
      target = descriptor.target?.(fields, hints) ?? (urlHint ? hints[urlHint.name]! : firstValue !== undefined ? String(firstValue) : descriptor.label);
    }
    return {
      id: row.id,
      kind,
      state,
      target,
      fields,
      secrets: hints,
      events: [...row.events],
      quiet: channelQuiet(row),
      ...(last ? { last } : {}),
      ...(state === "error" && last?.code ? { error: deliveryText(descriptor, last.code).text } : {}),
      ...(warning ? { warning } : {}),
    };
  }

  /** The kinds the page may show and every set-up channel of those kinds, Telegram rows included. */
  status(): ChannelsOverview {
    const kinds = this.listedKinds();
    const listed = new Set<string>(kinds.map((k) => k.kind));
    return {
      kinds: kinds.map(descriptorData),
      channels: this.store.listChannels().filter((c) => listed.has(c.kind)).map((c) => this.statusOf(c)),
    };
  }

  /** The status of one channel. */
  channel(id: string): ChannelStatus {
    return this.statusOf(this.row(id, true));
  }

  private async send(descriptor: KindDescriptor & { kind: DriverKind }, fields: Readonly<Record<string, unknown>>): Promise<void> {
    try {
      await deliverPayload(descriptor.kind, fields, testPayload(new Date(this.now())), { http: { ...this.opts.http, uiPorts: this.uiPorts() } }, this.opts.drivers);
    } catch (err) {
      throw deliveryFailure(descriptor, err instanceof DeliveryError ? err.code : "error");
    }
  }

  /** Wait for a connect in flight on `id`, whatever its result. */
  private async settled(id: string): Promise<void> {
    await this.connecting.get(id)?.catch(() => {});
  }

  /**
   * Connect a channel of `kind` in one step (KTD6). Empty fields take the
   * stored values; nothing is written unless the test message was accepted.
   */
  connect(kind: unknown, fields: Readonly<Record<string, unknown>> = {}, opts: ConnectOptions = {}): Promise<ChannelStatus> {
    let descriptor: KindDescriptor & { kind: DriverKind };
    try {
      descriptor = this.descriptor(kind);
    } catch (err) {
      return Promise.reject(err);
    }
    const id = descriptor.kind;
    const running = this.connecting.get(id);
    if (running) return running;
    const run = this.runConnect(descriptor, fields, opts).finally(() => this.connecting.delete(id));
    this.connecting.set(id, run);
    return run;
  }

  private async runConnect(
    descriptor: KindDescriptor & { kind: DriverKind },
    input: Readonly<Record<string, unknown>>,
    opts: ConnectOptions,
  ): Promise<ChannelStatus> {
    const id = descriptor.kind;
    const row = this.store.listChannels().find((c) => c.id === id && c.kind === id);
    const events = opts.events !== undefined ? parseEvents(opts.events) : row ? [...row.events] : [...descriptor.defaultEvents];
    const quiet = opts.quiet !== undefined ? parseQuiet(opts.quiet) : row ? channelQuiet(row) : "off";
    const storedSecrets = this.secrets(id);
    const merged: Record<string, unknown> = {};
    for (const f of descriptor.fields) {
      const given = Object.hasOwn(input, f.name) ? input[f.name] : undefined;
      merged[f.name] = isEmpty(given) ? (f.secret ? storedSecrets[f.name] : row?.config[f.name]) : given;
    }
    const checked = validateFields(descriptor, merged);
    if (!checked.ok) {
      const label = descriptor.fields.find((f) => f.name === checked.field)?.label ?? checked.field;
      throw new ChannelSetupError("invalid", FIELD_TEXT[checked.code](label), checked.field);
    }
    const values = { ...checked.values, ...checked.secrets };
    for (const f of descriptor.fields) {
      if (f.input !== "url" || values[f.name] === undefined) continue;
      const policy = checkUrl(String(values[f.name]), { uiPorts: this.uiPorts() });
      if (!policy.ok) throw new ChannelSetupError("invalid", POLICY_TEXT[policy.code], f.name, policy.code);
    }
    await this.send(descriptor, values);
    const secrets = Object.keys(checked.secrets).length > 0 ? checked.secrets : undefined;
    writeSecrets(id, secrets, this.secretsFile);
    try {
      this.store.insertChannel({
        id,
        kind: id,
        enabled: true,
        events,
        config: { ...checked.values, quiet },
        createdAt: row?.createdAt ?? new Date(this.now()).toISOString(),
      });
    } catch (err) {
      // Keep the stored channel consistent: its secrets go back to what it had.
      try {
        writeSecrets(id, Object.keys(storedSecrets).length > 0 ? storedSecrets : undefined, this.secretsFile);
      } catch {
        // The ledger error is the one to report.
      }
      throw err;
    }
    try {
      this.recordLast(id, { ok: true });
    } catch {
      // The channel is saved; only its last-delivery line is missing until the next send.
    }
    return this.statusOf(this.row(id));
  }

  /** Send a test message with the stored values to an enabled channel; the result is the last delivery. */
  async test(id: string): Promise<ChannelStatus> {
    await this.settled(id);
    const row = this.row(id);
    if (!row.enabled) throw new ChannelSetupError("not_connected", CHANNEL_TEXT.not_connected);
    const descriptor = this.descriptor(row.kind);
    try {
      await this.send(descriptor, { ...row.config, ...this.secrets(id) });
    } catch (err) {
      this.recordLast(id, { ok: false, code: err instanceof ChannelSetupError && err.delivery ? err.delivery : "error" });
      throw err;
    }
    this.recordLast(id, { ok: true });
    return this.statusOf(this.row(id));
  }

  /** Stop sending; settings and secrets stay (R7). */
  async disconnect(id: string): Promise<ChannelStatus> {
    await this.settled(id);
    const row = this.row(id);
    this.store.insertChannel({ ...row, enabled: false });
    return this.statusOf({ ...row, enabled: false });
  }

  /**
   * Delete the secrets, the last delivery and then the row (R7). The row
   * goes last, so after a failed step it is still there and a retry
   * finishes the job.
   */
  async remove(id: string): Promise<void> {
    await this.settled(id);
    this.row(id);
    if (readSecrets(id, this.secretsFile) !== undefined) writeSecrets(id, undefined, this.secretsFile);
    this.store.deleteMeta(`${CHANNEL_LAST_META_PREFIX}${id}`);
    this.store.removeChannel(id);
  }

  /** Change the events and/or quiet mode (R9, R10); Telegram rows too. No test send. */
  async settings(id: string, input: SettingsInput): Promise<ChannelStatus> {
    await this.settled(id);
    const events = input.events !== undefined ? parseEvents(input.events) : undefined;
    const quiet = input.quiet !== undefined ? parseQuiet(input.quiet) : undefined;
    const row = this.row(id, true);
    const next: Channel = { ...row, events: events ?? row.events, config: quiet ? { ...row.config, quiet } : row.config };
    this.store.insertChannel(next);
    return this.statusOf(next);
  }
}
