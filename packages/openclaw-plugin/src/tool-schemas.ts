/**
 * OpenClaw-side renderer for the canonical Tidegap tool surface.
 *
 * The names, descriptions, parameter sets and requiredness live in
 * @tidegap/core's tool-surface module — the single source of truth shared
 * with the @tidegap/mcp server (audit §2.2). This file converts those
 * schema-library-neutral descriptors into the TypeBox `TSchema` objects the
 * OpenClaw plugin runtime consumes for each tool's `parameters`.
 *
 * The OpenClaw renderer is deliberately the LOOSER of the two hosts: it
 * advertises exactly the shapes the plugin always has (plain strings /
 * numbers, `format: date-time` on timestamps, unions of literals for enums),
 * and it does NOT re-impose the MCP server's strict facets (integer bounds,
 * string min-length, positivity). The handlers validate their own inputs and
 * the core enforces the real invariants, so this preserves the plugin's
 * existing wire contract while sourcing the surface from one place.
 */

import { Type, type TSchema } from "typebox";
import {
  descriptionForHost,
  getToolDefOrThrow,
  paramOptionalForHost,
  paramsForHost,
  type ToolParam,
} from "@tidegap/core";

const HOST = "openclaw" as const;

function literalUnion(values: readonly string[]): TSchema {
  // TypeBox requires a non-empty tuple; the surface never declares an empty
  // enum, but guard defensively so a bad descriptor fails loudly.
  const members = values.map((v) => Type.Literal(v));
  if (members.length === 0) throw new Error("enum parameter has no values");
  return Type.Union(members);
}

/** Render one neutral parameter descriptor into its OpenClaw TypeBox schema. */
function buildTypeBoxField(param: ToolParam): TSchema {
  const opts: Record<string, unknown> = { description: param.description };
  let base: TSchema;
  switch (param.kind) {
    case "string":
      if (param.format === "date-time") opts.format = "date-time";
      base = Type.String(opts);
      break;
    case "number":
      base = Type.Number(opts);
      break;
    case "boolean":
      base = Type.Boolean(opts);
      break;
    case "enum":
      base = Type.Union(
        (param.values ?? []).map((v) => Type.Literal(v)),
        opts,
      );
      break;
    case "array": {
      const items =
        param.itemKind === "enum"
          ? literalUnion(param.values ?? [])
          : Type.String();
      base = Type.Array(items, opts);
      break;
    }
    case "object": {
      const props: Record<string, TSchema> = {};
      for (const sub of param.properties ?? []) {
        props[sub.name] = buildTypeBoxField(sub);
      }
      base = Type.Object(props, opts);
      break;
    }
  }
  return paramOptionalForHost(param, HOST) ? Type.Optional(base) : base;
}

/** The TypeBox `parameters` schema for a tool, by name. */
export function openclawToolParameters(name: string): TSchema {
  const def = getToolDefOrThrow(name);
  const props: Record<string, TSchema> = {};
  for (const param of paramsForHost(def, HOST)) {
    props[param.name] = buildTypeBoxField(param);
  }
  return Type.Object(props);
}

/**
 * The canonical `{ name, label, description, parameters }` header for one
 * OpenClaw tool. The plugin adds a host-specific `execute` handler to this.
 * `label` is OpenClaw UI text with no MCP analogue, so it is supplied here.
 */
export function openclawTool(
  name: string,
  label: string,
): { name: string; label: string; description: string; parameters: TSchema } {
  const def = getToolDefOrThrow(name);
  return {
    name: def.name,
    label,
    description: descriptionForHost(def, HOST),
    parameters: openclawToolParameters(name),
  };
}
