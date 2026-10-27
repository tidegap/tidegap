// Keyboard map. Single keys are ignored while focus is in a text field or a
// dialog is open, and when a modifier is held (browser shortcuts win).
//
//   j / k, ↓ / ↑   next / previous row (opens it when the drawer is open)
//   Enter          open detail          Esc   close drawer
//   c cancel · C stop series · r reschedule · m later · n run now
//   u read/unread · R reply · 1 2 3 4 views · / Journal filters · ? help

import { typing } from "./dom.js";
import { dialogOpen } from "./dialog.js";

function rows() {
  return [...document.querySelectorAll("#view .row[data-task-id]")];
}

function focusedRow() {
  const a = document.activeElement;
  return a instanceof Element ? a.closest("#view .row[data-task-id]") : null;
}

/**
 * handlers: {current() -> task id or null, open(id), close(), drawerOpen(),
 *   act(name, id), view(name), filters(), help()}
 */
export function initKeys(handlers) {
  document.addEventListener("keydown", (e) => {
    if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey) return;
    if (dialogOpen()) return;
    if (e.key === "Escape") {
      if (handlers.drawerOpen()) {
        e.preventDefault();
        handlers.close();
      }
      return;
    }
    if (typing(e.target)) return;

    const list = rows();
    const row = focusedRow();
    const move = (dir) => {
      // Arrows inside the drawer scroll it; only j/k reach the rows from there.
      if (e.key.startsWith("Arrow") && !row && document.getElementById("drawer").contains(document.activeElement)) return;
      e.preventDefault();
      if (list.length === 0) return;
      const currentId = row?.dataset.taskId || handlers.current();
      let i = list.findIndex((r) => r.dataset.taskId === currentId);
      i = i < 0 ? (dir > 0 ? 0 : list.length - 1) : Math.min(list.length - 1, Math.max(0, i + dir));
      const next = list[i];
      next.focus();
      next.scrollIntoView({ block: "nearest" });
      if (handlers.drawerOpen()) handlers.open(next.dataset.taskId, { keepFocus: true });
    };

    switch (e.key) {
      case "j":
      case "ArrowDown":
        return move(1);
      case "k":
      case "ArrowUp":
        return move(-1);
      case "Enter":
        if (row && e.target === row) {
          e.preventDefault();
          handlers.open(row.dataset.taskId);
        }
        return;
      case "1":
        return handlers.view("agenda");
      case "2":
        return handlers.view("timeline");
      case "3":
        return handlers.view("journal");
      case "4":
        return handlers.view("jobs");
      case "/":
        e.preventDefault();
        return handlers.filters();
      case "?":
        e.preventDefault();
        return handlers.help();
    }

    const actions = { c: "cancel", C: "stop-series", r: "reschedule", m: "later", n: "run-now", u: "toggle-read", R: "reply-focus" };
    const name = actions[e.key];
    if (!name) return;
    const id = row?.dataset.taskId || handlers.current();
    if (!id) return;
    e.preventDefault();
    // A held key repeats; an action runs once per press (holding c must not
    // cancel row after row as focus moves).
    if (e.repeat) return;
    handlers.act(name, id);
  });
}
