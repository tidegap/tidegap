/**
 * Audit §2.2 — the MCP server's registered tool list is DERIVED from the
 * shared canonical surface in @tidegap/core, not hand-authored alongside it.
 *
 * This pins the derivation so the MCP registration can never drift from the
 * single source of truth: names, per-tool parameter sets, requiredness and
 * descriptions must all match `@tidegap/core`'s tool-surface for the "mcp"
 * host.
 */

import { describe, expect, it } from "vitest";
import {
  paramOptionalForHost,
  paramsForHost,
  toolsForHost,
} from "@tidegap/core";
import { buildToolList, TOOL_DEFINITIONS } from "../src/server.js";

describe("MCP tool list is derived from the shared surface (§2.2)", () => {
  it("advertises exactly the shared surface's mcp tools, in order", () => {
    expect(TOOL_DEFINITIONS.map((d) => d.name)).toEqual(
      toolsForHost("mcp").map((d) => d.name),
    );
  });

  it("every advertised tool matches its shared descriptor (name/desc/params/required)", () => {
    const advertised = buildToolList();
    for (const def of toolsForHost("mcp")) {
      const tool = advertised.find((t) => t.name === def.name);
      expect(tool, `tool ${def.name} missing from the advertised list`).toBeTruthy();

      // description and annotations come verbatim from the shared surface.
      expect(tool!.description).toBe(def.description);
      expect(tool!.annotations, `annotations drift on ${def.name}`).toEqual(def.annotations);

      // properties are exactly the shared params for the mcp host.
      const props = Object.keys(
        (tool!.inputSchema as { properties?: Record<string, unknown> }).properties ?? {},
      ).sort();
      const expectedProps = paramsForHost(def, "mcp").map((p) => p.name).sort();
      expect(props, `properties drift on ${def.name}`).toEqual(expectedProps);

      // required is exactly the non-optional shared params for the mcp host.
      const required = (
        (tool!.inputSchema as { required?: string[] }).required ?? []
      ).sort();
      const expectedRequired = paramsForHost(def, "mcp")
        .filter((p) => !paramOptionalForHost(p, "mcp"))
        .map((p) => p.name)
        .sort();
      expect(required, `required drift on ${def.name}`).toEqual(expectedRequired);
    }
  });

  it("advertises the five-value provider enum on schedule_task", () => {
    const schedule = buildToolList().find((t) => t.name === "schedule_task")!;
    const provider = (
      schedule.inputSchema as {
        properties?: { provider?: { enum?: string[] } };
      }
    ).properties?.provider;
    expect(provider?.enum).toEqual(["anthropic", "openai", "gemini", "ollama", "claude-code"]);
  });
  it("advertises date-times by format alone, on closed objects (zod 4 JSON schema)", () => {
    const schedule = buildToolList().find((t) => t.name === "schedule_task")!;
    const schema = schedule.inputSchema as {
      additionalProperties?: unknown;
      properties: Record<string, Record<string, unknown>>;
    };
    expect(schema.additionalProperties).toBe(false);
    expect(Object.keys(schema.properties.deadline).sort()).toEqual(["description", "format", "type"]);
    expect(schema.properties.deadline.format).toBe("date-time");
  });

  it("parses RFC 3339 date-times only (seconds and a +HH:MM or Z offset)", () => {
    const schedule = TOOL_DEFINITIONS.find((d) => d.name === "schedule_task")!.schema;
    const deadline = schedule.shape.deadline;
    expect(deadline.safeParse("2026-11-01T10:00:00Z").success).toBe(true);
    expect(deadline.safeParse("2026-11-01T10:00:00.123+02:00").success).toBe(true);
    expect(deadline.safeParse("2026-11-01T10:00:00+0200").success).toBe(false);
    expect(deadline.safeParse("2026-11-01T10:00Z").success).toBe(false);
    expect(deadline.safeParse("2026-11-01T10:00:00").success).toBe(false);
  });
});
