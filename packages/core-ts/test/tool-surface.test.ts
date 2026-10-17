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
  getToolDef,
  getToolDefOrThrow,
  neutralSurfaceForHost,
  paramOptionalForHost,
  paramsForHost,
  toolsForHost,
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

describe("tool surface — divergence canary", () => {
  it("per-host neutral schema snapshot (review any change on BOTH hosts)", () => {
    const snapshot = Object.fromEntries(
      ALL_TOOL_HOSTS.map((host) => [host, neutralSurfaceForHost(host)]),
    );
    expect(snapshot).toMatchSnapshot();
  });
});
