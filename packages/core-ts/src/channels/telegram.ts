/**
 * Telegram Bot API client (KTD10, KTD13). Takes the token, the API base URL
 * and `fetch` as arguments; reads no environment. Messages are plain text
 * (no `parse_mode`), so titles and model output cannot inject markup.
 *
 * The request URL holds the token, so no error message or log line built
 * here contains the URL, the token, or a transport error's own text: only
 * the Bot API method, the HTTP status and Telegram's error description.
 */

/** The public Bot API. */
export const TELEGRAM_API_BASE = "https://api.telegram.org";

/** Telegram's cap on one message's text. */
export const TELEGRAM_MESSAGE_MAX = 4096;

/** Longest wait for one Bot API call beyond its long-poll `timeout`, in ms. */
export const TELEGRAM_CALL_TIMEOUT_MS = 30_000;

/** Telegram's cap on a button's `callback_data`, in bytes. */
export const TELEGRAM_CALLBACK_MAX_BYTES = 64;

export interface TelegramChat {
  id: number;
  type: "private" | "group" | "supergroup" | "channel";
  username?: string;
  first_name?: string;
}

export interface TelegramUser {
  id: number;
  is_bot?: boolean;
  username?: string;
  first_name?: string;
}

export interface TelegramMessage {
  message_id: number;
  chat: TelegramChat;
  from?: TelegramUser;
  date?: number;
  text?: string;
}

export interface TelegramCallbackQuery {
  id: string;
  from: TelegramUser;
  message?: TelegramMessage;
  data?: string;
}

export interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
  callback_query?: TelegramCallbackQuery;
}

/** One inline button: its label and its `callback_data`. */
export interface InlineButton {
  text: string;
  data: string;
}

/** Rows of inline buttons. */
export type InlineKeyboard = InlineButton[][];

/** `unauthorized` = 401 (bad token); `conflict` = 409 (another `getUpdates` consumer or a webhook). */
export type TelegramErrorKind = "unauthorized" | "conflict" | "rate_limited" | "http" | "network" | "api";

export class TelegramError extends Error {
  override name = "TelegramError";
  constructor(
    message: string,
    readonly kind: TelegramErrorKind,
    readonly method: string,
    readonly status?: number,
    /** Seconds Telegram asked to wait (429). */
    readonly retryAfterS?: number,
  ) {
    super(message);
  }
}

export interface TelegramClientOptions {
  token: string;
  /** Default {@link TELEGRAM_API_BASE}. Hosts allow an override only on loopback ({@link isLoopbackApiBase}). */
  baseUrl?: string;
  /** Default: the global `fetch`, looked up at call time. */
  fetch?: typeof fetch;
}

/** True for an `http://127.0.0.1[:port]` or `http://localhost[:port]` base (KTD13: tests and QA only). */
export function isLoopbackApiBase(url: string): boolean {
  try {
    const u = new URL(url);
    return u.protocol === "http:" && (u.hostname === "127.0.0.1" || u.hostname === "localhost") && u.username === "" && u.password === "";
  } catch {
    return false;
  }
}

interface ApiEnvelope<T> {
  ok?: boolean;
  result?: T;
  description?: string;
  error_code?: number;
  parameters?: { retry_after?: number };
}

/** Keep Telegram's description short and free of the token. */
function cleanDescription(text: string | undefined, token: string): string {
  if (!text) return "";
  return text.split(token).join("<token>").slice(0, 200);
}

export class TelegramClient {
  private readonly token: string;
  private readonly base: string;
  private readonly fetchFn: typeof fetch | undefined;

  constructor(opts: TelegramClientOptions) {
    this.token = opts.token;
    let base = opts.baseUrl ?? TELEGRAM_API_BASE;
    while (base.endsWith("/")) base = base.slice(0, -1);
    this.base = base;
    this.fetchFn = opts.fetch;
  }

  /**
   * Call one Bot API method with a JSON body; throws {@link TelegramError}.
   * The call gives up after its long-poll `timeout` plus
   * {@link TELEGRAM_CALL_TIMEOUT_MS}, so a stalled connection cannot hold
   * the tick or the listener.
   */
  async call<T>(method: string, body: Record<string, unknown> = {}, signal?: AbortSignal): Promise<T> {
    const f = this.fetchFn ?? globalThis.fetch;
    const pollS = typeof body.timeout === "number" ? body.timeout : 0;
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, pollS * 1000 + TELEGRAM_CALL_TIMEOUT_MS);
    const forward = () => controller.abort();
    if (signal?.aborted) controller.abort();
    else signal?.addEventListener("abort", forward, { once: true });
    let res: Response;
    let env: ApiEnvelope<T> = {};
    try {
      try {
        res = await f(`${this.base}/bot${this.token}/${method}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
          signal: controller.signal,
        });
      } catch (err) {
        const code = (err as { cause?: { code?: unknown } })?.cause?.code;
        const why = typeof code === "string" && /^[A-Z_]+$/.test(code) ? ` (${code})` : "";
        if (timedOut) throw new TelegramError(`Telegram ${method}: timed out`, "network", method);
        if ((err as { name?: string })?.name === "AbortError") {
          throw new TelegramError(`Telegram ${method}: aborted`, "network", method);
        }
        throw new TelegramError(`Telegram ${method}: network error${why}`, "network", method);
      }
      try {
        env = (await res.json()) as ApiEnvelope<T>;
      } catch {
        // A non-JSON body (a proxy error page), or a body cut off by the timeout: the status speaks for it.
      }
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", forward);
    }
    if (!res.ok || env.ok !== true) {
      const status = res.status;
      const desc = cleanDescription(env.description, this.token);
      const msg = `Telegram ${method}: HTTP ${status}${desc ? `: ${desc}` : ""}`;
      if (status === 401) throw new TelegramError(msg, "unauthorized", method, status);
      if (status === 409) throw new TelegramError(msg, "conflict", method, status);
      if (status === 429) throw new TelegramError(msg, "rate_limited", method, status, env.parameters?.retry_after);
      throw new TelegramError(msg, res.ok ? "api" : "http", method, status);
    }
    return env.result as T;
  }

  getMe(): Promise<TelegramUser> {
    return this.call("getMe");
  }

  getWebhookInfo(): Promise<{ url: string }> {
    return this.call("getWebhookInfo");
  }

  /** Long poll; `timeoutS` is Telegram's server-side wait. */
  getUpdates(opts: { offset?: number; timeoutS?: number; signal?: AbortSignal } = {}): Promise<TelegramUpdate[]> {
    const body: Record<string, unknown> = { timeout: opts.timeoutS ?? 0, allowed_updates: ["message", "callback_query"] };
    if (opts.offset !== undefined) body.offset = opts.offset;
    return this.call("getUpdates", body, opts.signal);
  }

  /** Send plain text, optionally with inline buttons. */
  sendMessage(chatId: number | string, text: string, opts: { buttons?: InlineKeyboard } = {}): Promise<TelegramMessage> {
    const body: Record<string, unknown> = { chat_id: chatId, text, disable_web_page_preview: true };
    if (opts.buttons && opts.buttons.length > 0) body.reply_markup = keyboardMarkup(opts.buttons);
    return this.call("sendMessage", body);
  }

  answerCallbackQuery(id: string, opts: { text?: string; showAlert?: boolean } = {}): Promise<boolean> {
    const body: Record<string, unknown> = { callback_query_id: id };
    if (opts.text) body.text = opts.text;
    if (opts.showAlert) body.show_alert = true;
    return this.call("answerCallbackQuery", body);
  }

  /** Replace a message's buttons; an empty or missing keyboard removes them. */
  editMessageReplyMarkup(chatId: number | string, messageId: number, buttons?: InlineKeyboard): Promise<unknown> {
    return this.call("editMessageReplyMarkup", {
      chat_id: chatId,
      message_id: messageId,
      reply_markup: keyboardMarkup(buttons ?? []),
    });
  }
}

function keyboardMarkup(buttons: InlineKeyboard): { inline_keyboard: Array<Array<{ text: string; callback_data: string }>> } {
  return { inline_keyboard: buttons.map((row) => row.map((b) => ({ text: b.text, callback_data: b.data }))) };
}
