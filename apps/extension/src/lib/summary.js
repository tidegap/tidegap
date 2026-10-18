// Badge text, color and tooltip from one poll (KTD6). Pure: no extension API.
//
// Priority: no token "?"; server unreachable "off"; active > 0 the count
// ("99+" cap); clean window now "now"; a window later the time to its start
// ("45m", "5h"); no forecast: empty. When readiness says tasks will not run,
// the text gets a "!" in front ("!3", "!" alone when empty), the color turns
// amber and the tooltip starts with the readiness line.

const COLORS = {
  unpaired: "#b45309",
  offline: "#6b7280",
  error: "#b91c1c",
  count: "#1d4ed8",
  now: "#15803d",
  later: "#0f766e",
  notReady: "#d97706",
};

const pad2 = (n) => String(n).padStart(2, "0");

/** "14:00" in local time. */
export function clock(iso) {
  const d = new Date(iso);
  return Number.isFinite(d.getTime()) ? `${pad2(d.getHours())}:${pad2(d.getMinutes())}` : "";
}

/** "45m" under an hour, else whole hours ("5h"). */
export function untilText(ms) {
  const mins = Math.max(1, Math.ceil(ms / 60_000));
  return mins < 60 ? `${mins}m` : `${Math.floor(mins / 60)}h`;
}

/** "clean 14:00-17:00 FR", or "cleanest hour 03:00 FR" for a fallback window. */
export function windowText(cw, region) {
  if (!cw) return "";
  const where = region ? ` ${region}` : "";
  if (cw.fallback) return `cleanest hour ${clock(cw.start)}${where}`;
  return `${cw.now ? "clean now until" : "clean"} ${cw.now ? clock(cw.end) : `${clock(cw.start)}-${clock(cw.end)}`}${where}`;
}

/**
 * The server's limit line ("Claude 5h: 72%, resets 16:30"), or null. A
 * server without `limits` (0.19), `limits: null` and the empty line of
 * disabled limit reads all give null.
 */
export function limitsLine(body) {
  const line = body?.limits?.line;
  return typeof line === "string" && line ? line : null;
}

/** The tooltip line, e.g. "3 queued · clean 14:00-17:00 FR · Claude 5h: 72%, resets 16:30". */
export function summaryLine(body) {
  const parts = [body.active > 0 ? `${body.active} queued` : "Queue empty"];
  if (body.clean_window) parts.push(windowText(body.clean_window, body.region));
  else if (body.forecast_ok === false) parts.push("forecast unavailable");
  const limits = limitsLine(body);
  if (limits) parts.push(limits);
  return parts.join(" · ");
}

/**
 * The readiness sentence when the server says tasks will not run, else null.
 * A server without `readiness` (0.19.0) gives null.
 */
export function readinessLine(body) {
  const r = body?.readiness;
  if (!r || r.ready !== false) return null;
  return typeof r.line === "string" && r.line ? r.line : "Tasks will not run.";
}

/** { text, color, title } for one api result. `now` is epoch ms. */
export function badgeFor(result, now = Date.now()) {
  const badge = baseBadge(result, now);
  const line = result.state === "ok" ? readinessLine(result.body) : null;
  if (!line) return badge;
  return { text: `!${badge.text}`, color: COLORS.notReady, title: `Tidegap: ${line} · ${summaryLine(result.body)}` };
}

function baseBadge(result, now) {
  if (result.state === "unpaired") return { text: "?", color: COLORS.unpaired, title: `Tidegap: ${result.message}` };
  if (result.state === "offline") return { text: "off", color: COLORS.offline, title: `Tidegap: ${result.message}` };
  if (result.state !== "ok") return { text: "!", color: COLORS.error, title: `Tidegap: ${result.message}` };
  const body = result.body;
  const title = `Tidegap: ${summaryLine(body)}`;
  if (body.active > 0) return { text: body.active > 99 ? "99+" : String(body.active), color: COLORS.count, title };
  const cw = body.clean_window;
  if (cw && cw.now) return { text: "now", color: COLORS.now, title };
  const start = cw ? Date.parse(cw.start) : NaN;
  if (Number.isFinite(start) && start > now) return { text: untilText(start - now), color: COLORS.later, title };
  return { text: "", color: COLORS.later, title };
}
