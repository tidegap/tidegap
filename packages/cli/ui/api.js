// API client. The token lives in this module's memory only: it is read once
// from the URL fragment (never sent to the server by the browser) and every
// request carries it in the Authorization header. No cookie, no storage.

let token = null;

export class SessionExpired extends Error {
  constructor() {
    super("This link expired. Run tidegap ui again.");
  }
}

/** A non-2xx answer. `message` is the server's one-line error. */
export class ApiError extends Error {
  constructor(status, message) {
    super(message || `HTTP ${status}`);
    this.status = status;
  }
}

export function setToken(t) {
  token = t;
}

export function hasToken() {
  return !!token;
}

function headers(json) {
  const out = { authorization: `Bearer ${token}` };
  if (json) out["content-type"] = "application/json";
  return out;
}

/** Raw fetch with the bearer header; 401 becomes SessionExpired. */
export async function request(path, init = {}) {
  if (!token) throw new SessionExpired();
  const res = await fetch(path, { ...init, headers: { ...headers(init.json), ...(init.headers || {}) } });
  if (res.status === 401) throw new SessionExpired();
  return res;
}

async function errorOf(res) {
  let msg = "";
  try {
    const body = await res.json();
    if (body && typeof body.error === "string") msg = body.error;
  } catch {
    // no JSON body
  }
  return new ApiError(res.status, msg);
}

export async function get(path) {
  const res = await request(path);
  if (!res.ok) throw await errorOf(res);
  return res.json();
}

/**
 * POST a write. `body` undefined sends no body and no content type (the
 * body-less routes refuse one); an object is sent as JSON.
 */
async function post(path, body) {
  const init = { method: "POST" };
  if (body !== undefined) {
    init.json = true;
    init.body = JSON.stringify(body);
  }
  const res = await request(path, init);
  if (!res.ok) throw await errorOf(res);
  if (res.status === 204) return null;
  return res.json();
}

/**
 * Fire-and-forget POST that survives page unload (pending cancels on
 * pagehide). keepalive keeps the request alive after the page is gone.
 */
export function postKeepalive(path, body) {
  if (!token) return;
  try {
    fetch(path, {
      method: "POST",
      keepalive: true,
      headers: headers(body !== undefined),
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    // the page is going away; nothing to report to
  }
}

const enc = encodeURIComponent;

export const tasksPath = (id, action) => `/api/tasks/${enc(id)}${action ? `/${action}` : ""}`;

export const api = {
  list: (query) => get(`/api/tasks${query ? `?${query}` : ""}`),
  task: (id) => get(tasksPath(id)),
  series: (id) => get(`/api/series/${enc(id)}`),
  status: () => get("/api/status"),
  forecast: (region, hours) => get(`/api/forecast?region=${enc(region)}&hours=${hours}`),
  usage: (spend = false) => get(spend ? "/api/usage?spend=1" : "/api/usage"),
  cancel: (id, series = false) => post(tasksPath(id, "cancel"), series ? { series: true } : {}),
  reschedule: (id, target) => post(tasksPath(id, "reschedule"), target),
  postpone: (id, target) => post(tasksPath(id, "postpone"), target),
  runNow: (id) => post(tasksPath(id, "run-now")),
  reply: (id, text) => post(tasksPath(id, "reply"), { text }),
  read: (id) => post(tasksPath(id, "read")),
  unread: (id) => post(tasksPath(id, "unread")),
  startDispatcher: () => post("/api/dispatcher/start"),
  clients: () => get("/api/clients"),
  addClient: (client) => post("/api/clients", client),
  revokeClient: (id) => post(`/api/clients/${enc(id)}/revoke`),
  integrations: () => get("/api/integrations"),
  saveTelegramToken: (token) => post("/api/integrations/telegram/token", { token }),
  /** `pair`, `pair/cancel`, `test`, `listener/start` or `disconnect` (with a body). */
  telegram: (route, body) => post(`/api/integrations/telegram/${route}`, body),
};

/** Views a link may open (the Mac app's `&view=`); anything else opens the Agenda. */
export const LINK_VIEWS = ["agenda", "timeline", "journal", "settings"];

/**
 * The page link's fragment: `#token=<t>` with an optional `&view=<v>`.
 * Returns null when it carries no token; a view outside LINK_VIEWS is
 * `agenda`.
 */
export function parseFragment(hash) {
  const m = /^#token=([A-Za-z0-9_-]+)(?:&view=([^&]*))?$/.exec(hash);
  if (!m) return null;
  return { token: m[1], view: LINK_VIEWS.includes(m[2]) ? m[2] : "agenda" };
}
