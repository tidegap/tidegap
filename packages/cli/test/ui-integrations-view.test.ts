/** The Settings → Integrations card (integrations plan U6): view-model, text-only rendering, link fragment. */

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { parseFragment } from "../ui/api.js";
import { cardNodes, telegramCard, timeLeft } from "../ui/integrations.js";

/** Just enough DOM for `h()`: elements, text nodes, attributes, listeners. */
class FakeNode {}
class FakeText extends FakeNode {
  constructor(readonly textContent: string) {
    super();
  }
}
class FakeElement extends FakeNode {
  readonly children: FakeNode[] = [];
  readonly attrs: Record<string, string> = {};
  readonly dataset: Record<string, string> = {};
  constructor(readonly tagName: string) {
    super();
  }
  setAttribute(k: string, v: string) {
    this.attrs[k] = v;
  }
  addEventListener() {}
  append(...nodes: FakeNode[]) {
    this.children.push(...nodes);
  }
}

const saved: Record<string, unknown> = {};
beforeAll(() => {
  saved.document = (globalThis as Record<string, unknown>).document;
  saved.Node = (globalThis as Record<string, unknown>).Node;
  Object.assign(globalThis, {
    Node: FakeNode,
    document: {
      createElement: (t: string) => new FakeElement(t),
      createElementNS: (_ns: string, t: string) => new FakeElement(t),
      createTextNode: (t: string) => new FakeText(t),
    },
  });
});
afterAll(() => Object.assign(globalThis, saved));

function walk(n: FakeNode, out: { tags: string[]; text: string[] } = { tags: [], text: [] }) {
  if (n instanceof FakeText) out.text.push(n.textContent);
  if (n instanceof FakeElement) {
    out.tags.push(n.tagName);
    for (const c of n.children) walk(c, out);
  }
  return out;
}

const NOW = Date.parse("2026-10-19T10:00:00Z");

describe("telegramCard", () => {
  it("not configured: the token form and the BotFather steps, no buttons", () => {
    expect(telegramCard({ state: "not_configured" }, NOW)).toMatchObject({ line: "Not connected", steps: true, tokenForm: true, actions: [] });
  });

  it("token saved: Connect and the last 4 characters", () => {
    const c = telegramCard({ state: "token_saved", token_hint: "wXyZ", bot_username: "tg_test_bot" }, NOW);
    expect(c).toMatchObject({ line: "Token set, ends in wXyZ", bot: "@tg_test_bot", tokenForm: false, actions: ["connect", "change-token", "remove-token"] });
  });

  it("pairing: code, link and a countdown of 9:59 one second in", () => {
    const c = telegramCard(
      { state: "pairing", pairing: { code: "123456", bot_username: "tg_test_bot", link: "https://t.me/tg_test_bot?start=123456", expires_at: new Date(NOW + 600_000).toISOString() } },
      NOW + 1000,
    );
    expect(c.pairing).toEqual({ code: "123456", command: "/pair 123456", link: "https://t.me/tg_test_bot?start=123456", left: "9:59 left" });
    expect(c.actions).toEqual(["cancel"]);
    expect(timeLeft(new Date(NOW + 600_000).toISOString(), NOW)).toBe("10:00 left");
    expect(timeLeft(new Date(NOW - 5_000).toISOString(), NOW)).toBe("0:00 left");
  });

  it("pairing: the card carries the bot as @name", () => {
    const c = telegramCard({ state: "pairing", bot_username: "tg_test_bot", pairing: { code: "123456", bot_username: "tg_test_bot", link: "l", expires_at: new Date(NOW + 1000).toISOString() } }, NOW);
    expect(c.bot).toBe("@tg_test_bot");
  });

  it("paired: running offers Send test and Disconnect; not running adds Start listener; manual shows the command", () => {
    const paired = (listener: Record<string, string>) => telegramCard({ state: "paired", chat: { channel_id: "telegram-7", label: "@vit" }, listener }, NOW);
    expect(paired({ state: "running" })).toMatchObject({ line: "Paired with @vit", error: "", actions: ["test", "change-token", "disconnect"] });
    expect(paired({ state: "not_running", message: "The listener is not running. Press Start listener." })).toMatchObject({
      error: "The listener is not running. Press Start listener.",
      actions: ["test", "start-listener", "change-token", "disconnect"],
    });
    const manual = paired({ state: "manual", message: "x" });
    expect(manual).toMatchObject({ manual: "tidegap channels serve", error: "", actions: ["test", "change-token", "disconnect"] });
  });

  it("error: the sentence and Connect again", () => {
    const c = telegramCard({ state: "error", token_hint: "wXyZ", error: "No code arrived within 10 minutes. Press Connect to get a new code." }, NOW);
    expect(c).toMatchObject({ error: "No code arrived within 10 minutes. Press Connect to get a new code.", actions: ["connect-again", "change-token", "remove-token"] });
  });

  it("a chat label with markup renders as text: no element is created from it", () => {
    const vm = telegramCard({ state: "paired", chat: { channel_id: "telegram-7", label: "<img src=x onerror=alert(1)>" }, listener: { state: "running" } }, NOW);
    const out = { tags: [] as string[], text: [] as string[] };
    for (const n of cardNodes({ editing: false }, vm) as FakeNode[]) walk(n, out);
    expect(out.tags).not.toContain("img");
    expect(out.text).toContain("Paired with <img src=x onerror=alert(1)>");
  });

  it("the token field is a password input with autocomplete off and a visible label", () => {
    const out = cardNodes({ editing: false }, telegramCard({ state: "not_configured" }, NOW)) as FakeNode[];
    const inputs: FakeElement[] = [];
    const find = (n: FakeNode) => {
      if (n instanceof FakeElement) {
        if (n.tagName === "input") inputs.push(n);
        n.children.forEach(find);
      }
    };
    out.forEach(find);
    expect(inputs).toHaveLength(1);
    expect(inputs[0]!.attrs).toMatchObject({ type: "password", autocomplete: "off", id: "telegram-token", "aria-describedby": "telegram-steps" });
  });
});

describe("parseFragment", () => {
  it("takes the token and an allow-listed view; anything else opens the Agenda", () => {
    expect(parseFragment("#token=abc")).toEqual({ token: "abc", view: "agenda" });
    expect(parseFragment("#token=abc&view=settings")).toEqual({ token: "abc", view: "settings" });
    expect(parseFragment("#token=abc&view=../x")).toEqual({ token: "abc", view: "agenda" });
    expect(parseFragment("#token=abc&view=task")).toEqual({ token: "abc", view: "agenda" });
    expect(parseFragment("#/agenda")).toBeNull();
  });
});

describe("copyText", () => {
  it("uses the clipboard API and reports failure without a DOM fallback", async () => {
    const { copyText } = await import("../ui/copy.js");
    const written: string[] = [];
    const g = globalThis as Record<string, unknown>;
    const prev = Object.getOwnPropertyDescriptor(g, "navigator");
    Object.defineProperty(g, "navigator", { configurable: true, value: { clipboard: { writeText: async (t: string) => void written.push(t) } } });
    expect(await copyText("@tg_test_bot")).toBe(true);
    expect(written).toEqual(["@tg_test_bot"]);
    Object.defineProperty(g, "navigator", { configurable: true, value: { clipboard: { writeText: async () => Promise.reject(new Error("denied")) } } });
    expect(await copyText("x")).toBe(false);
    if (prev) Object.defineProperty(g, "navigator", prev);
    else delete g.navigator;
  });
});
