/**
 * Audit §2.2 — the OpenClaw plugin's registered tools are DERIVED from the
 * shared canonical surface in @tidegap/core, not hand-authored alongside it.
 *
 * Pins names, per-tool parameter sets, requiredness and descriptions to the
 * single source of truth for the "openclaw" host, so the plugin registration
 * can never silently diverge from the MCP server's.
 */

import { describe, expect, it } from "vitest";
import {
  descriptionForHost,
  getToolDefOrThrow,
  paramOptionalForHost,
  paramsForHost,
  toolsForHost,
} from "@tidegap/core";
import tidegapPlugin from "../src/index.js";
import type { StubResolvedTool } from "./stub-tool-plugin.js";

/** Extract the { properties, required } shape from a TypeBox object schema. */
function shapeOf(parameters: unknown): {
  props: string[];
  required: string[];
} {
  const schema = parameters as {
    properties?: Record<string, unknown>;
    required?: string[];
  };
  return {
    props: Object.keys(schema.properties ?? {}).sort(),
    required: (schema.required ?? []).slice().sort(),
  };
}

describe("OpenClaw tools are derived from the shared surface (§2.2)", () => {
  it("registers exactly the shared surface's openclaw tools", () => {
    expect(tidegapPlugin.tools.map((t: StubResolvedTool) => t.name).sort()).toEqual(
      toolsForHost("openclaw").map((d) => d.name).sort(),
    );
  });

  it("every registered tool matches its shared descriptor (desc/params/required)", () => {
    for (const def of toolsForHost("openclaw")) {
      const tool = tidegapPlugin.tools.find((t: StubResolvedTool) => t.name === def.name);
      expect(tool, `tool ${def.name} not registered`).toBeTruthy();

      // description is the openclaw-resolved text of the shared surface.
      expect(tool!.description).toBe(descriptionForHost(getToolDefOrThrow(def.name), "openclaw"));

      const { props, required } = shapeOf(tool!.parameters);
      const expectedProps = paramsForHost(def, "openclaw").map((p) => p.name).sort();
      expect(props, `properties drift on ${def.name}`).toEqual(expectedProps);

      const expectedRequired = paramsForHost(def, "openclaw")
        .filter((p) => !paramOptionalForHost(p, "openclaw"))
        .map((p) => p.name)
        .sort();
      expect(required, `required drift on ${def.name}`).toEqual(expectedRequired);
    }
  });
});
