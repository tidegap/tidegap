/** Settings → Run limits (limits plan U12): the view-model per source, the none warning, the server's sentence on a 400, the live save. */

import { beforeEach, describe, expect, it, vi } from "vitest";

const limits = vi.fn();
const setLimit = vi.fn();

vi.mock("../ui/api.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../ui/api.js")>()),
  api: { limits: (...a: unknown[]) => limits(...a), setLimit: (...a: unknown[]) => setLimit(...a) },
}));

import { ApiError } from "../ui/api.js";
import { limitsModel, limitsNodes, mountLimitsCard, parseCell, saveBody, savedText } from "../ui/limits-card.js";
import { durationText } from "../ui/dom.js";
import { FakeElement, installFakeDom, textOf, walk } from "./fixtures/fake-dom.js";

installFakeDom();

const WARNING = "A run with no time limit holds every other due task while it runs; tidegap queue cancel <id> stops it.";
const r = (runner: string, effective: object, source: string, stored: object | null, dflt: object) => ({ runner, effective, source, stored, default: dflt });
/** AE3's settings: TIDEGAP_LLM_TIMEOUT=20m and TIDEGAP_LLM_TIMEOUT_CLAUDE_CODE=1h. */
const view = (extra: { commandAll?: object | null } = {}) => ({
  settings: [
    {
      setting: "command_timeout", name: "command-timeout", kind: "time_limit", per_runner: false, key: "TIDEGAP_COMMAND_TIMEOUT",
      all: extra.commandAll ?? null,
      runners: [r("command", extra.commandAll ?? { value_s: 1800 }, extra.commandAll ? "setting" : "default", null, { value_s: 1800 })],
    },
    {
      setting: "llm_timeout", name: "llm-timeout", kind: "time_limit", per_runner: true, key: "TIDEGAP_LLM_TIMEOUT", all: { value_s: 1200 },
      runners: [r("claude-code", { value_s: 3600 }, "setting:claude-code", { value_s: 3600 }, { value_s: 1800 }), r("anthropic", { value_s: 1200 }, "setting", null, { value_s: 600 })],
    },
    {
      setting: "retries", name: "retries", kind: "count", per_runner: true, key: "TIDEGAP_RETRIES", all: null,
      runners: [r("command", { value: 1 }, "default", null, { value: 1 }), r("claude-code", { value: 1 }, "default", null, { value: 1 }), r("anthropic", { value: 1 }, "default", null, { value: 1 })],
    },
  ],
  ignored: [{ key: "TIDEGAP_RETRY_DELAY", value: "0", reason: "0 is refused." }],
  no_time_limit_warning: WARNING,
});

type Model = ReturnType<typeof limitsModel>;
const noop = new Proxy({}, { get: () => () => {} });
const cell = (m: Model, id: string) => m.rows!.flatMap((row: { cells: Array<Record<string, unknown>> }) => row.cells).find((c) => c.id === id)!;

describe("limitsModel", () => {
  it("renders AE3's settings with the right sources", () => {
    const m = limitsModel(view());
    expect(m.rows!.map((row: { label: string }) => row.label)).toEqual(["All runners", "command", "claude-code", "anthropic"]);
    expect(cell(m, "all:llm_timeout")).toMatchObject({ text: "20m", source: "set here", editable: true, stored: true });
    expect(cell(m, "claude-code:llm_timeout")).toMatchObject({ text: "1h", source: "this runner", editable: true });
    expect(cell(m, "anthropic:llm_timeout")).toMatchObject({ text: "20m", source: "all runners" });
    expect(cell(m, "command:llm_timeout")).toMatchObject({ applies: false });
    // One key for the one runner: edited in the all-runners row only.
    expect(cell(m, "all:command_timeout")).toMatchObject({ text: "30m", source: "default", stored: false });
    expect(cell(m, "command:command_timeout")).toMatchObject({ text: "30m", source: "default", editable: false });
    expect(cell(m, "all:retries")).toMatchObject({ text: "not set", source: "" });
    expect(m.ignored).toEqual(["TIDEGAP_RETRY_DELAY=0 is ignored: 0 is refused."]);
  });

  it("a cell set to none shows the warning line under it", () => {
    const m = limitsModel(view({ commandAll: { value_s: "none" } }));
    expect(cell(m, "all:command_timeout")).toMatchObject({ text: "none", none: true, warning: WARNING });
    const el = new FakeElement("div");
    el.replaceChildren(...(limitsNodes(m, noop).flat() as never[]));
    expect(textOf(el)).toContain(WARNING);
    // An editor with No limit ticked shows it before the save too.
    expect(cell(limitsModel(view(), { editing: "all:command_timeout", none: true }), "all:command_timeout")).toMatchObject({ editing: true, warning: WARNING });
  });

  it("a 400 shows the server's sentence next to the cell", () => {
    const m = limitsModel(view(), { editing: "all:command_timeout", errors: { "all:command_timeout": "0 is not a time limit; use none for no time limit." } });
    const nodes = walk(limitsNodes(m, noop) as never[]);
    const td = nodes.els.find((e) => e.dataset.cell === "all:command_timeout")!;
    expect(textOf(td)).toContain("0 is not a time limit; use none for no time limit.");
    expect(walk([td]).els.find((e) => e.attrs.role === "alert")).toBeDefined();
  });
});

describe("parse and save bodies", () => {
  it("parses the duration grammar to seconds and a count for retries", () => {
    expect(parseCell("time_limit", "30m")).toEqual({ value_s: 1800 });
    expect(parseCell("time_limit", "1.5h")).toEqual({ value_s: 5400 });
    expect(parseCell("delay", "90")).toEqual({ value_s: 90 });
    expect(parseCell("time_limit", "soon")).toHaveProperty("error");
    expect(parseCell("count", "3")).toEqual({ value: 3 });
    expect(parseCell("count", "-1")).toHaveProperty("error");
    expect(durationText(604_800)).toBe("7d");
    expect(durationText(90)).toBe("90s");
  });

  it("builds the POST body per kind; null clears", () => {
    const c = { setting: "llm_timeout", runner: "claude-code", kind: "time_limit" };
    expect(saveBody(c, { value_s: "none" })).toEqual({ setting: "llm_timeout", runner: "claude-code", value_s: "none" });
    expect(saveBody({ setting: "retries", runner: null, kind: "count" }, { value: 0 })).toEqual({ setting: "retries", runner: null, value: 0 });
    expect(saveBody(c, null)).toEqual({ setting: "llm_timeout", runner: "claude-code", value_s: null });
    expect(savedText(c, { value_s: "none" })).toBe("LLM time limit for claude-code set to none.");
  });
});

describe("the live card", () => {
  beforeEach(() => {
    limits.mockReset();
    setLimit.mockReset();
  });
  const settle = () => new Promise((res) => setTimeout(res, 0));

  it("saving none sends value_s none, announces it and shows the warning; a 400 shows the sentence", async () => {
    limits.mockResolvedValue(view());
    setLimit.mockResolvedValueOnce(view({ commandAll: { value_s: "none" } }));
    const el = new FakeElement("section");
    const status = { textContent: "" };
    const card = mountLimitsCard(el as never, { status });
    await settle();
    card.on.edit("all:command_timeout");
    card.on.none(true);
    card.on.save(cell(limitsModel(card.view, card.ui), "all:command_timeout"), "");
    await settle();
    expect(setLimit).toHaveBeenCalledWith({ setting: "command_timeout", runner: null, value_s: "none" });
    expect(status.textContent).toBe("Command time limit for all runners set to none.");
    expect(textOf(el)).toContain(WARNING);

    setLimit.mockRejectedValueOnce(new ApiError(400, "0 is not a time limit; use none for no time limit.", { code: "invalid" }));
    card.on.edit("all:command_timeout");
    card.on.none(false);
    card.on.save(cell(limitsModel(card.view, card.ui), "all:command_timeout"), "0");
    await settle();
    expect(setLimit).toHaveBeenLastCalledWith({ setting: "command_timeout", runner: null, value_s: 0 });
    expect(textOf(el)).toContain("0 is not a time limit; use none for no time limit.");
  });
});
