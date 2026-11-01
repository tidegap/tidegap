// Dispatcher pill model: the pill's state, its long text (wide windows), the
// short text a narrow window shows, and its title. Pure, so the server tests
// check every state; app.js writes it to the pill.

import { agoAwake, parse } from "./dom.js";

/**
 * The pill for the server's `dispatcher` (null before the first status) and
 * its `readiness` (null on a server without it). The title is the readiness
 * line while tasks cannot run, else the long text, so a short text always
 * has its long text on hover.
 */
export function dispatcherPill(d, readiness, now = Date.now()) {
  if (!d) return { state: "unknown", text: "Dispatcher", short: "Dispatcher", title: "Dispatcher" };
  const last = parse(d.last_tick_at);
  const child = d.ui_child?.alive ? d.ui_child : null;
  const blocked = Boolean(readiness && !readiness.ready);
  const age = agoAwake(last, readiness?.ticker, now);
  let pill;
  if (d.state === "running") {
    // Never green while tasks cannot run: a running dispatcher with a
    // readiness problem (no runner, for example) shows amber.
    if (blocked) pill = { state: "blocked", text: "Running · nothing can run", short: "Blocked" };
    else if (child && !(Number.isFinite(last) && now - last <= 2 * d.interval_s * 1000)) {
      pill = { state: "running", text: `Dispatcher running · PID ${child.pid}`, short: "Running" };
    } else pill = { state: "running", text: `Dispatcher ran ${age}`, short: "Running" };
  } else if (d.state === "stale") {
    pill = { state: "stale", text: `Dispatcher idle · ${age}`, short: `Idle · ${age.replace(/ ago$/, "")}` };
  } else {
    pill = { state: d.state, text: "No dispatcher", short: "No dispatcher" };
  }
  return { ...pill, title: blocked && readiness.line ? readiness.line : pill.text };
}
