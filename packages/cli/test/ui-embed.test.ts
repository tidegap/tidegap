/**
 * The page inside the Mac app: a lost token goes to the app as the fixed
 * message `expired`, once per page, through the `tidegap` script message
 * handler. A browser has no handler and keeps its own expired screen.
 */

import { describe, expect, it } from "vitest";

import { appChannel } from "../ui/api.js";

/** A window as WKWebView builds it: `webkit.messageHandlers.tidegap.postMessage`. */
function appWindow() {
  const posted: unknown[] = [];
  const win = { webkit: { messageHandlers: { tidegap: { postMessage: (body: unknown) => posted.push(body) } } } };
  return { win, posted };
}

describe("appChannel", () => {
  it("posts expired once, however often the page shows the expired state", () => {
    const { win, posted } = appWindow();
    const app = appChannel(win);
    expect(app.inApp).toBe(true);
    app.expired();
    app.expired();
    expect(posted).toEqual(["expired"]);
  });

  it("posts exactly the string expired, with no data", () => {
    const { win, posted } = appWindow();
    appChannel(win).expired();
    expect(posted).toHaveLength(1);
    expect(posted[0]).toBe("expired");
  });

  it("is a browser when the window has no tidegap handler", () => {
    for (const win of [{}, { webkit: {} }, { webkit: { messageHandlers: {} } }, { webkit: { messageHandlers: { other: { postMessage: () => {} } } } }]) {
      const app = appChannel(win);
      expect(app.inApp).toBe(false);
      expect(() => app.expired()).not.toThrow();
    }
  });
});
