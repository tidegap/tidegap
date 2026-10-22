/**
 * Tests for the canonical tool surface (audit §2.2) — the single source of
 * truth both the MCP server and the OpenClaw plugin derive their tool
 * registrations from.
 *
 * The per-host snapshot at the bottom is the DIVERGENCE CANARY: any edit to a
 * tool's name, description, parameter set, requiredness, host scope or a facet
 * changes the snapshot, forcing a reviewer to acknowledge the surface change
 * on BOTH hosts at once instead of letting the two registrations drift apart.
 */

import { describe, expect, it } from "vitest";
import {
  ALL_TOOL_HOSTS,
  TOOL_SURFACE,
  descriptionForHost,
  getToolDef,
  getToolDefOrThrow,
  neutralSurfaceForHost,
  paramOptionalForHost,
  paramsForHost,
  toolsForHost,
  type CanonicalToolDef,
  type ToolHost,
  type ToolParam,
} from "../src/index.js";

describe("tool surface — shape and invariants", () => {
  it("exposes the expected tools on each host", () => {
    expect(toolsForHost("mcp").map((t) => t.name).sort()).toEqual(
      [
        "cancel_all",
        "cancel_task",
        "check_queue_status",
        "expedite_task",
        "get_grid_forecast",
        "postpone_task",
        "recommend_window",
        "reply_task",
        "retry_task",
        "schedule_task",
        "tidegap_usage",
        "update_deadline",
      ].sort(),
    );
    expect(toolsForHost("openclaw").map((t) => t.name).sort()).toEqual(
      [
        "cancel_all",
        "cancel_task",
        "check_queue_status",
        "expedite_task",
        "get_grid_forecast",
        "recommend_window",
        "reply_task",
        "retry_task",
        "schedule_task",
        "set_delivery",
        "update_deadline",
      ].sort(),
    );
  });

  it("set_delivery is OpenClaw-only (MCP has no delivery subsystem)", () => {
    expect(getToolDef("set_delivery")?.hosts).toEqual(["openclaw"]);
    expect(toolsForHost("mcp").some((t) => t.name === "set_delivery")).toBe(false);
  });

  it("every tool has a non-trivial name, description and at least the params it needs", () => {
    for (const def of TOOL_SURFACE) {
      expect(def.name).toMatch(/^[a-z_]+$/);
      expect(def.description.length).toBeGreaterThan(20);
      expect(def.hosts.length).toBeGreaterThan(0);
      for (const p of def.params) {
        expect(p.name).toMatch(/^[a-z_]+$/);
        expect(p.description.length).toBeGreaterThan(0);
        if (p.kind === "enum") expect(p.values?.length).toBeGreaterThan(0);
        if (p.kind === "array") expect(p.itemKind).toBeTruthy();
      }
    }
  });

  it("getToolDefOrThrow throws on an unknown name", () => {
    expect(() => getToolDefOrThrow("nope")).toThrow(/unknown Tidegap tool/);
  });

  it("the schedule_task provider enum adds claude-code on MCP only", () => {
    const def = getToolDefOrThrow("schedule_task");
    const on = (host: "mcp" | "openclaw") => paramsForHost(def, host).find((p) => p.name === "provider")!;
    for (const host of ["mcp", "openclaw"] as const) {
      expect(on(host).kind).toBe("enum");
      expect(on(host).optional).toBe(true);
    }
    // Backward-compatible: anthropic/openai retained, gemini/ollama ADDED.
    expect(on("openclaw").values).toEqual(["anthropic", "openai", "gemini", "ollama"]);
    // claude-code runs only in `tidegap tick`, so OpenClaw does not offer it.
    expect(on("mcp").values).toEqual(["anthropic", "openai", "gemini", "ollama", "claude-code"]);
  });

  it("models the intentional per-host divergences explicitly", () => {
    // region: required on MCP, optional on OpenClaw for the read tools.
    for (const name of ["get_grid_forecast", "recommend_window"]) {
      const region = getToolDefOrThrow(name).params.find((p) => p.name === "region")!;
      expect(paramOptionalForHost(region, "mcp")).toBe(false);
      expect(paramOptionalForHost(region, "openclaw")).toBe(true);
    }
    // recommend_window.model is MCP-only.
    const rw = getToolDefOrThrow("recommend_window");
    expect(paramsForHost(rw, "mcp").some((p) => p.name === "model")).toBe(true);
    expect(paramsForHost(rw, "openclaw").some((p) => p.name === "model")).toBe(false);
    // schedule_task extras are host-partitioned.
    const st = getToolDefOrThrow("schedule_task");
    const mcpParams = paramsForHost(st, "mcp").map((p) => p.name);
    const ocParams = paramsForHost(st, "openclaw").map((p) => p.name);
    for (const p of ["dry_run", "dispatch", "output_path", "redact_in_receipt"]) {
      expect(mcpParams).toContain(p);
      expect(ocParams).not.toContain(p);
    }
    for (const p of ["deliver", "webhook_url", "file_path", "file_format"]) {
      expect(ocParams).toContain(p);
      expect(mcpParams).not.toContain(p);
    }
  });

  it("shared params agree on kind across hosts (no accidental retype)", () => {
    // For every tool on BOTH hosts, a parameter present on both must have the
    // same kind — the two renderers cannot silently disagree.
    for (const def of TOOL_SURFACE) {
      if (!def.hosts.includes("mcp") || !def.hosts.includes("openclaw")) continue;
      const mcp = new Map(paramsForHost(def, "mcp").map((p) => [p.name, p.kind]));
      const oc = new Map(paramsForHost(def, "openclaw").map((p) => [p.name, p.kind]));
      for (const [name, kind] of mcp) {
        if (oc.has(name)) {
          expect(oc.get(name), `${def.name}.${name} kind drift`).toBe(kind);
        }
      }
    }
  });
});

// ── Description template (TDQS) ─────────────────────────────────────────────
// Every host-resolved description of every tool except the OpenClaw-only
// set_delivery follows: purpose sentence, "Use when:", "Do not use ...",
// "Behavior:", "Returns:" — and never names what its host lacks.

const TEMPLATED = TOOL_SURFACE.filter((d) => d.name !== "set_delivery");
const hostTexts = (def: CanonicalToolDef): Array<[ToolHost, string]> =>
  def.hosts.map((h) => [h, descriptionForHost(def, h)]);
const behaviorClause = (text: string): string =>
  text.slice(text.indexOf("Behavior:"), text.indexOf("Returns:"));
const mentions = (text: string, word: string): boolean =>
  new RegExp(`(^|[^a-z_])${word}([^a-z_]|$)`).test(text);

/** Param names (identifier-like, with an underscore) of every param, recursively. */
function paramNames(params: readonly ToolParam[]): string[] {
  return params.flatMap((p) => [p.name, ...paramNames(p.properties ?? [])]);
}

describe("tool surface — description template", () => {
  it("each description fits its length budget (schedule_task 900, others 600)", () => {
    for (const def of TEMPLATED) {
      for (const [host, text] of hostTexts(def)) {
        const max = def.name === "schedule_task" ? 900 : 600;
        expect(text.length, `${def.name}@${host} is ${text.length} chars`).toBeLessThanOrEqual(max);
      }
    }
  });

  it("each description has Use when / Do not use / Behavior / Returns, in that order", () => {
    for (const def of TEMPLATED) {
      for (const [host, text] of hostTexts(def)) {
        const at = ["Use when:", "Do not use", "Behavior:", "Returns:"].map((m) => text.indexOf(m));
        expect(at.every((i) => i > 0), `${def.name}@${host} misses a clause`).toBe(true);
        expect([...at].sort((a, b) => a - b), `${def.name}@${host} clause order`).toEqual(at);
      }
    }
  });

  it("each description names a sibling its host registers, and nothing its host lacks", () => {
    const allTools = TOOL_SURFACE.map((d) => d.name);
    const allParams = new Set(TOOL_SURFACE.flatMap((d) => paramNames(d.params)).filter((n) => n.includes("_")));
    for (const host of ["mcp", "openclaw"] as const) {
      const tools = toolsForHost(host);
      const hostTools = new Set(tools.map((d) => d.name));
      const hostParams = new Set(tools.flatMap((d) => paramNames(paramsForHost(d, host))));
      for (const def of tools.filter((d) => d.name !== "set_delivery")) {
        const text = def.description;
        const siblings = [...hostTools].filter((n) => n !== def.name && mentions(text, n));
        expect(siblings.length, `${def.name}@${host} names no sibling`).toBeGreaterThan(0);
        for (const name of allTools) {
          if (!hostTools.has(name)) expect(mentions(text, name), `${def.name}@${host} names ${name}`).toBe(false);
        }
        for (const name of allParams) {
          if (!hostParams.has(name)) expect(mentions(text, name), `${def.name}@${host} names ${name}`).toBe(false);
        }
      }
    }
    expect(mentions(descriptionForHost(getToolDefOrThrow("update_deadline"), "openclaw"), "postpone_task")).toBe(false);
    expect(mentions(descriptionForHost(getToolDefOrThrow("schedule_task"), "openclaw"), "dry_run")).toBe(false);
  });

  it("cancel_task and cancel_all name each other", () => {
    for (const [, text] of hostTexts(getToolDefOrThrow("cancel_task"))) expect(mentions(text, "cancel_all")).toBe(true);
    for (const [, text] of hostTexts(getToolDefOrThrow("cancel_all"))) expect(mentions(text, "cancel_task")).toBe(true);
  });

  it("every MCP tool declares a title and all four hints", () => {
    for (const def of toolsForHost("mcp")) {
      const a = def.annotations;
      expect(a, `${def.name} has no annotations`).toBeTruthy();
      expect(a!.title.length, `${def.name} title`).toBeGreaterThan(0);
      for (const hint of ["readOnlyHint", "destructiveHint", "idempotentHint", "openWorldHint"] as const) {
        expect(typeof a![hint], `${def.name}.${hint}`).toBe("boolean");
      }
    }
  });

  it("no Behavior clause contradicts the read-only or destructive hint", () => {
    for (const def of TEMPLATED) {
      for (const [host, text] of hostTexts(def)) {
        const behavior = behaviorClause(text);
        if (def.annotations?.readOnlyHint) {
          expect(behavior, `${def.name}@${host} read-only`).toContain("writes nothing");
          expect(behavior.replace("writes nothing", ""), `${def.name}@${host} read-only`).not.toMatch(
            /\b(writes|marks|creates|deletes|refreshes|updates)\b/i,
          );
        }
        if (def.annotations && !def.annotations.destructiveHint) {
          expect(behavior, `${def.name}@${host} not destructive`).not.toMatch(/\b(overwrites|replaces|deletes|removes)\b/i);
        }
      }
    }
  });

  it("Behavior says \"no network\" exactly when openWorldHint is false", () => {
    for (const def of TEMPLATED) {
      if (!def.annotations) continue;
      for (const [host, text] of hostTexts(def)) {
        expect(behaviorClause(text).includes("no network"), `${def.name}@${host} openWorld`).toBe(!def.annotations.openWorldHint);
      }
    }
  });
});

describe("tool surface — parameter descriptions", () => {
  /** Every [tool, host, param] the hosts expose, sub-parameters included. */
  function exposed(): Array<[string, ToolHost, ToolParam]> {
    const out: Array<[string, ToolHost, ToolParam]> = [];
    const walk = (tool: string, host: ToolHost, params: readonly ToolParam[]) => {
      for (const p of params) {
        out.push([tool, host, p]);
        walk(tool, host, p.properties ?? []);
      }
    };
    for (const def of TOOL_SURFACE) for (const host of def.hosts) walk(def.name, host, paramsForHost(def, host));
    return out;
  }

  it("every parameter description says more than the parameter name", () => {
    for (const [tool, host, p] of exposed()) {
      const text = p.description.trim().toLowerCase();
      expect(text.length, `${tool}.${p.name}@${host}`).toBeGreaterThan(0);
      expect(text, `${tool}.${p.name}@${host}`).not.toBe(p.name.replace(/_/g, " "));
      expect(text, `${tool}.${p.name}@${host}`).not.toBe(p.name);
    }
  });

  it("every optional parameter states its default or what omitting it does", () => {
    for (const [tool, host, p] of exposed()) {
      if (!paramOptionalForHost(p, host)) continue;
      expect(p.description, `${tool}.${p.name}@${host}`).toMatch(/\b(defaults?|omit)\b/i);
    }
  });
});

describe("tool surface — divergence canary", () => {
  it("per-host neutral schema snapshot (review any change on BOTH hosts)", () => {
    const snapshot = Object.fromEntries(
      ALL_TOOL_HOSTS.map((host) => [host, neutralSurfaceForHost(host)]),
    );
    expect(snapshot).toMatchSnapshot();
  });
});
