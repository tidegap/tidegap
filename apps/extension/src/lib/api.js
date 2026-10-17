// Client for the local `tidegap ui` API (docs/spec/ui-client-api.md). Every
// call returns a result, never throws:
//   { state: "ok", status, body }
//   { state: "offline", message }         nothing answered on the port
//   { state: "unpaired", message }        no token, or 401
//   { state: "error", status, message }   any other non-2xx
// Server text is shown only for the one-line 400/409 errors; anything else
// gets a fixed message (dependency-free-task-ui-patterns.md).

export const NO_TOKEN_MESSAGE = "Not paired. Paste a client token in the extension options.";
export const UNPAIRED_MESSAGE = "Not paired: token not accepted (revoked, or tidegap is older than 0.19).";
export const OFFLINE_MESSAGE = "tidegap ui is not running. Run `tidegap ui` in a terminal.";
const FORBIDDEN_MESSAGE = "tidegap ui refused the request (403). Use a client token from `tidegap clients add`, not the page link.";

/** A server that accepts the connection and never answers counts as offline. */
const TIMEOUT_MS = 10_000;

export function baseUrl(port) {
  return `http://127.0.0.1:${port}`;
}

/** The full page, signed in with the client token (it lands in the URL fragment, never sent to the server). */
export function pageUrl({ port, token }) {
  return `${baseUrl(port)}/#token=${encodeURIComponent(token)}`;
}

async function serverMessage(res) {
  try {
    const body = await res.json();
    if (body && typeof body.error === "string") return body.error.split("\n")[0];
  } catch {
    // no JSON body
  }
  return "";
}

/**
 * One request. `settings` carries `port` and `token`; `body` (an object) is
 * sent as JSON. `fetchImpl` is for tests.
 */
export async function request(settings, path, { method = "GET", body, fetchImpl = globalThis.fetch } = {}) {
  if (!settings.token) return { state: "unpaired", message: NO_TOKEN_MESSAGE };
  const headers = { authorization: `Bearer ${settings.token}` };
  const init = { method, headers, cache: "no-store", credentials: "omit", signal: AbortSignal.timeout(TIMEOUT_MS) };
  if (body !== undefined) {
    headers["content-type"] = "application/json";
    init.body = JSON.stringify(body);
  }
  let res;
  try {
    res = await fetchImpl(`${baseUrl(settings.port)}${path}`, init);
  } catch {
    return { state: "offline", message: OFFLINE_MESSAGE };
  }
  if (res.status === 401) return { state: "unpaired", message: UNPAIRED_MESSAGE };
  if (res.ok) {
    try {
      return { state: "ok", status: res.status, body: await res.json() };
    } catch {
      return { state: "error", status: res.status, message: "tidegap ui sent an answer this extension cannot read." };
    }
  }
  if (res.status === 400 || res.status === 409) {
    const msg = await serverMessage(res);
    return { state: "error", status: res.status, message: msg || `tidegap ui refused the request (${res.status}).` };
  }
  if (res.status === 403) return { state: "error", status: 403, message: FORBIDDEN_MESSAGE };
  return { state: "error", status: res.status, message: `tidegap ui answered ${res.status}.` };
}

const ACTIVE = "queued,scheduled,running,submitted";

export const api = {
  summary: (s, since, opts) => request(s, `/api/summary${since ? `?since=${encodeURIComponent(since)}` : ""}`, opts),
  activeTasks: (s, opts) => request(s, `/api/tasks?status=${ACTIVE}&limit=20`, opts),
  /** "Later": `choice` is `{preset}`, `{until}` or `{delay_minutes}` (spec, postpone). */
  postpone: (s, id, choice, opts) => request(s, taskPath(id, "postpone"), { ...opts, method: "POST", body: choice }),
  cancel: (s, id, opts) => request(s, taskPath(id, "cancel"), { ...opts, method: "POST", body: {} }),
  runNow: (s, id, opts) => request(s, taskPath(id, "run-now"), { ...opts, method: "POST" }),
};

function taskPath(id, action) {
  return `/api/tasks/${encodeURIComponent(id)}/${action}`;
}
