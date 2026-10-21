/**
 * `/api/integrations*` (integrations plan KTD2, KTD10; all-channels plan
 * KTD7): the page's and the Mac app's Settings → Integrations cards. The
 * server admits these routes only for the page token and a `macos` client
 * token without an extension origin (KTD1); this module only routes and
 * rate-limits. Telegram actions go through `TelegramSetup`, every other
 * channel through `ChannelSetup` (contract:
 * `docs/plans/2026-10-19-channels-api-contract.md`).
 *
 * Answers carry the status (token as its last 4 characters only) or one fixed
 * sentence; never a token, a path or exception text (R7, R10).
 */

import { ChannelSetup, ChannelSetupError, type ChannelSetupCode, type ChannelSetupOptions } from "../channels/channel-setup.js";
import { TelegramSetup, TelegramSetupError, type SetupErrorCode, type TelegramSetupOptions } from "../channels/telegram-setup.js";

/** Options for the integrations routes; the server adds the ledger. */
export type IntegrationsConfig = Omit<TelegramSetupOptions, "store"> & Pick<ChannelSetupOptions, "secretsFile" | "uiPorts" | "http" | "drivers">;

interface Response {
  status: number;
  body: unknown;
}

/** Per-route limits (KTD10): at most `max` calls in `windowMs`. */
const LIMITS: Readonly<Record<string, { max: number; windowMs: number }>> = {
  token: { max: 5, windowMs: 60_000 },
  pair: { max: 3, windowMs: 10 * 60_000 },
  test: { max: 1, windowMs: 10_000 },
  "listener/start": { max: 3, windowMs: 60_000 },
  "channels/connect": { max: 10, windowMs: 60_000 },
  "channels/test": { max: 1, windowMs: 10_000 },
  "channels/settings": { max: 30, windowMs: 60_000 },
  digest: { max: 30, windowMs: 60_000 },
};

const STATUS_OF: Record<SetupErrorCode, number> = {
  format: 400,
  refused: 409,
  webhook: 409,
  no_token: 409,
  not_paired: 409,
  manual: 409,
  network: 502,
  telegram: 502,
};

const CHANNEL_STATUS_OF: Record<ChannelSetupCode, number> = {
  invalid: 400,
  unknown_kind: 404,
  not_found: 404,
  not_connected: 409,
  telegram: 409,
  test_failed: 409,
  unreachable: 502,
};

/** Actions under `/api/integrations/channels/<id>/` and their body kind. */
const CHANNEL_ACTIONS: Readonly<Record<string, "json" | "none">> = { test: "none", disconnect: "none", remove: "none", settings: "json" };

/** A channel id in a path: a kind, or `telegram-<chat id>`. */
const CHANNEL_ID = /^[A-Za-z0-9_-]{1,80}$/;

/** The body kind of a POST route under `/api/integrations/channels/` (`route` after `channels`), or undefined when there is no such route. */
export function channelPostBodyKind(route: readonly string[]): "json" | "none" | undefined {
  if (route.length === 1 && route[0] === "connect") return "json";
  if (route.length !== 2 || !CHANNEL_ID.test(route[0]!) || !Object.hasOwn(CHANNEL_ACTIONS, route[1]!)) return undefined;
  return CHANNEL_ACTIONS[route[1]!];
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** 400 for a body with keys outside `allowed`, else undefined. */
function extraKeys(body: Record<string, unknown>, allowed: readonly string[], shape: string): Response | undefined {
  return Object.keys(body).some((k) => !allowed.includes(k)) ? invalid(`the body must be ${shape}`) : undefined;
}

function invalid(error: string): Response {
  return { status: 400, body: { error, code: "invalid" } };
}

/** POST routes under `/api/integrations/telegram/` and their body kind. */
export const TELEGRAM_POST_ROUTES: Readonly<Record<string, "json" | "none">> = {
  token: "json",
  pair: "none",
  "pair/cancel": "none",
  test: "none",
  "listener/start": "none",
  disconnect: "json",
};

export class Integrations {
  readonly telegram: TelegramSetup;
  readonly channels: ChannelSetup;
  private readonly calls = new Map<string, number[]>();
  private readonly now: () => number;

  constructor(opts: TelegramSetupOptions & Omit<ChannelSetupOptions, "store">) {
    this.telegram = new TelegramSetup(opts);
    this.channels = new ChannelSetup(opts);
    this.now = opts.now ?? Date.now;
  }

  /** Seconds to wait when `route` (counted per `key`) is over its limit, else undefined (and the call is counted). */
  private limited(route: string, key: string = route): number | undefined {
    if (!Object.hasOwn(LIMITS, route)) return undefined;
    const { max, windowMs } = LIMITS[route]!;
    const now = this.now();
    const recent = (this.calls.get(key) ?? []).filter((t) => now - t < windowMs);
    if (recent.length >= max) return Math.max(1, Math.ceil((recent[0]! + windowMs - now) / 1000));
    recent.push(now);
    this.calls.set(key, recent);
    return undefined;
  }

  private async state(status = 200): Promise<Response> {
    return { status, body: { telegram: await this.telegram.status(), ...this.channels.status() } };
  }

  /** Route one integrations request; `route` is the path after `/api/integrations`. */
  async handle(method: string, route: string[], body: Record<string, unknown>): Promise<Response> {
    if (route.length === 0) return method === "GET" ? this.state() : notAllowed();
    if (route[0] === "channels") return this.handleChannel(method, route.slice(1), body);
    if (route.length === 1 && route[0] === "digest") return this.handleDigest(method, body);
    if (route[0] !== "telegram") return notFound();
    const action = route.slice(1).join("/");
    if (!Object.hasOwn(TELEGRAM_POST_ROUTES, action)) return notFound();
    if (method !== "POST") return notAllowed();
    const wait = this.limited(action);
    if (wait) return tooMany(wait);
    try {
      switch (action) {
        case "token": {
          const bad = Object.keys(body).find((k) => k !== "token");
          if (bad !== undefined || typeof body.token !== "string") return { status: 400, body: { error: "the body must be {\"token\": \"…\"}" } };
          await this.telegram.saveToken(body.token.trim());
          return this.state();
        }
        case "pair":
          return this.state((await this.telegram.startPairing()) ? 202 : 200);
        case "pair/cancel":
          await this.telegram.cancelPairing();
          return this.state();
        case "test":
          await this.telegram.sendTest();
          return { status: 200, body: { sent: true } };
        case "listener/start":
          await this.telegram.startListener();
          return this.state();
        case "disconnect": {
          const bad = Object.keys(body).find((k) => k !== "forget_token");
          if (bad !== undefined || (body.forget_token !== undefined && typeof body.forget_token !== "boolean")) {
            return { status: 400, body: { error: "the body must be {\"forget_token\"?: boolean}" } };
          }
          await this.telegram.disconnect({ forgetToken: body.forget_token === true });
          return this.state();
        }
        default:
          return notFound();
      }
    } catch (err) {
      if (err instanceof TelegramSetupError) return { status: STATUS_OF[err.code], body: { error: err.message, code: err.code } };
      return internalError();
    }
  }

  /** `POST /api/integrations/digest {at: "HH:MM"}`: the daily summary's send time, as `tidegap channels digest --at`. */
  private handleDigest(method: string, body: Record<string, unknown>): Response {
    if (method !== "POST") return notAllowed();
    const wait = this.limited("digest");
    if (wait) return tooMany(wait);
    const bad = extraKeys(body, ["at"], '{"at": "HH:MM"}');
    if (bad) return bad;
    if (typeof body.at !== "string") return { status: 400, body: { error: "Give the time as HH:MM, 00:00 to 23:59.", code: "invalid", field: "at" } };
    try {
      return { status: 200, body: { digest: this.channels.setDigestTime(body.at) } };
    } catch (err) {
      if (err instanceof ChannelSetupError) return channelErrorResponse(err);
      return internalError();
    }
  }

  /** `/api/integrations/channels/…` (all-channels plan KTD7); `route` is the path after `channels`. */
  private async handleChannel(method: string, route: string[], body: Record<string, unknown>): Promise<Response> {
    if (!channelPostBodyKind(route)) return notFound();
    if (method !== "POST") return notAllowed();
    const [id, action] = route.length === 1 ? ["", "connect"] : [route[0]!, route[1]!];
    const wait = this.limited(`channels/${action}`, action === "test" ? `channels/test:${id}` : undefined);
    if (wait) return tooMany(wait);
    try {
      switch (action) {
        case "connect": {
          const bad = extraKeys(body, ["kind", "fields", "events", "quiet", "clear"], '{"kind", "fields"?, "events"?, "quiet"?, "clear"?}');
          if (bad) return bad;
          if (typeof body.kind !== "string") return invalid("the body must name a \"kind\"");
          if (body.fields !== undefined && !isPlainObject(body.fields)) return invalid("\"fields\" must be an object");
          const channel = await this.channels.connect(body.kind, (body.fields as Record<string, unknown> | undefined) ?? {}, {
            events: body.events,
            quiet: body.quiet,
            clear: body.clear,
          });
          return { status: 200, body: { channel } };
        }
        case "test":
          return { status: 200, body: { sent: true, channel: await this.channels.test(id) } };
        case "disconnect":
          return { status: 200, body: { channel: await this.channels.disconnect(id) } };
        case "remove":
          await this.channels.remove(id);
          return { status: 200, body: { removed: true } };
        case "settings": {
          const bad = extraKeys(body, ["events", "quiet"], '{"events"?, "quiet"?}');
          if (bad) return bad;
          if (body.events === undefined && body.quiet === undefined) return invalid("the body must set \"events\" or \"quiet\"");
          return { status: 200, body: { channel: await this.channels.settings(id, { events: body.events, quiet: body.quiet }) } };
        }
        default:
          return notFound();
      }
    } catch (err) {
      if (err instanceof ChannelSetupError) return channelErrorResponse(err);
      return internalError();
    }
  }

  /** Abort a running pairing (server close, KTD5). */
  close(): Promise<void> {
    return this.telegram.close();
  }
}

/** A refused channel action: its status, sentence, code and, when set, the field and delivery code. */
function channelErrorResponse(err: ChannelSetupError): Response {
  return {
    status: CHANNEL_STATUS_OF[err.code],
    body: { error: err.message, code: err.code, ...(err.field ? { field: err.field } : {}), ...(err.delivery ? { delivery: err.delivery } : {}) },
  };
}

/** A file or ledger failure: a fixed sentence, never the exception text. */
function internalError(): Response {
  return { status: 500, body: { error: "Tidegap could not save the change. Try again.", code: "internal" } };
}

function tooMany(wait: number): Response {
  return { status: 429, body: { error: `Wait ${wait} seconds and try again.`, code: "rate_limited", retry_after_s: wait } };
}

function notFound(): Response {
  return { status: 404, body: { error: "not found" } };
}

function notAllowed(): Response {
  return { status: 405, body: { error: "method not allowed" } };
}
