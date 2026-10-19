/**
 * `/api/integrations*` (integrations plan KTD2, KTD10): the page's and the
 * Mac app's Settings → Integrations card. The server admits these routes only
 * for the page token and a `macos` client token without an extension origin
 * (KTD1); this module only routes and rate-limits. Every Telegram action goes
 * through the shared setup module.
 *
 * Answers carry the status (token as its last 4 characters only) or one fixed
 * sentence; never a token, a path or exception text (R7, R10).
 */

import { TelegramSetup, TelegramSetupError, type SetupErrorCode, type TelegramSetupOptions } from "../channels/telegram-setup.js";

/** Options for the integrations routes; the server adds the ledger. */
export type IntegrationsConfig = Omit<TelegramSetupOptions, "store">;

interface Response {
  status: number;
  body: unknown;
}

/** Per-route limits (KTD10): at most `max` calls in `windowMs`. */
const LIMITS = {
  token: { max: 5, windowMs: 60_000 },
  pair: { max: 3, windowMs: 10 * 60_000 },
  test: { max: 1, windowMs: 10_000 },
  listener: { max: 3, windowMs: 60_000 },
} as const;

type LimitedRoute = keyof typeof LIMITS;

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
  private readonly calls = new Map<LimitedRoute, number[]>();
  private readonly now: () => number;

  constructor(opts: TelegramSetupOptions) {
    this.telegram = new TelegramSetup(opts);
    this.now = opts.now ?? Date.now;
  }

  /** Seconds to wait when `route` is over its limit, else undefined (and the call is counted). */
  private limited(route: LimitedRoute): number | undefined {
    const { max, windowMs } = LIMITS[route];
    const now = this.now();
    const recent = (this.calls.get(route) ?? []).filter((t) => now - t < windowMs);
    if (recent.length >= max) return Math.max(1, Math.ceil((recent[0]! + windowMs - now) / 1000));
    recent.push(now);
    this.calls.set(route, recent);
    return undefined;
  }

  private async state(status = 200): Promise<Response> {
    return { status, body: { telegram: await this.telegram.status() } };
  }

  /** Route one integrations request; `route` is the path after `/api/integrations`. */
  async handle(method: string, route: string[], body: Record<string, unknown>): Promise<Response> {
    if (route.length === 0) return method === "GET" ? this.state() : notAllowed();
    if (route[0] !== "telegram") return notFound();
    const action = route.slice(1).join("/");
    if (!Object.hasOwn(TELEGRAM_POST_ROUTES, action)) return notFound();
    if (method !== "POST") return notAllowed();
    const limit: LimitedRoute | undefined =
      action === "token" ? "token" : action === "pair" ? "pair" : action === "test" ? "test" : action === "listener/start" ? "listener" : undefined;
    const wait = limit && this.limited(limit);
    if (wait) return { status: 429, body: { error: `Wait ${wait} seconds and try again.`, retry_after_s: wait } };
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
        default: {
          const bad = Object.keys(body).find((k) => k !== "forget_token");
          if (bad !== undefined || (body.forget_token !== undefined && typeof body.forget_token !== "boolean")) {
            return { status: 400, body: { error: "the body must be {\"forget_token\"?: boolean}" } };
          }
          await this.telegram.disconnect({ forgetToken: body.forget_token === true });
          return this.state();
        }
      }
    } catch (err) {
      if (err instanceof TelegramSetupError) return { status: STATUS_OF[err.code], body: { error: err.message, code: err.code } };
      // A file or ledger failure: a fixed sentence, never the exception text.
      return { status: 500, body: { error: "Tidegap could not save the change. Try again." } };
    }
  }

  /** Abort a running pairing (server close, KTD5). */
  close(): Promise<void> {
    return this.telegram.close();
  }
}

function notFound(): Response {
  return { status: 404, body: { error: "not found" } };
}

function notAllowed(): Response {
  return { status: 405, body: { error: "method not allowed" } };
}
