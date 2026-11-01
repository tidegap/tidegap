/**
 * The handoff parameters on the `schedule_task` surface: MCP only, all
 * optional, within the description budget, and the refusal of a shell
 * command runner on both hosts.
 */

import { describe, expect, it } from "vitest";

import {
  commandJobRefusal,
  getToolDefOrThrow,
  jobUnsupportedRefusal,
  paramOptionalForHost,
  paramsForHost,
  QUEUE_ADD_COMMAND_LINE,
} from "../src/index.js";

const NEW_PARAMS = ["runner", "cwd", "permission_profile", "result_path"];

describe("schedule_task handoff parameters", () => {
  const def = getToolDefOrThrow("schedule_task");

  it("MCP exposes runner, cwd, permission_profile and result_path, all optional", () => {
    const mcp = paramsForHost(def, "mcp");
    for (const name of NEW_PARAMS) {
      const p = mcp.find((x) => x.name === name);
      expect(p, name).toBeDefined();
      expect(paramOptionalForHost(p!, "mcp"), name).toBe(true);
    }
    expect(mcp.find((p) => p.name === "runner")!.values).toEqual(["anthropic", "openai", "gemini", "ollama", "claude-code"]);
    expect(mcp.find((p) => p.name === "permission_profile")!.values).toEqual(["read", "web", "none"]);
    expect(mcp.find((p) => p.name === "cwd")!.kind).toBe("string");
    expect(mcp.find((p) => p.name === "result_path")!.kind).toBe("string");
  });

  it("the OpenClaw schedule_task surface has none of the new parameters", () => {
    const names = paramsForHost(def, "openclaw").map((p) => p.name);
    for (const name of NEW_PARAMS) expect(names, name).not.toContain(name);
  });

  it("the schedule_task description fits its 900-character budget", () => {
    expect(def.description.length).toBeLessThanOrEqual(900);
    for (const name of NEW_PARAMS) expect(def.description, name).not.toContain(name);
  });

  it("the output_path and result_path descriptions name the allowed folders", () => {
    const mcp = paramsForHost(def, "mcp");
    for (const name of ["output_path", "result_path"]) {
      expect(mcp.find((p) => p.name === name)!.description, name).toMatch(/inside cwd, this session's project folder or the temp folder/);
    }
  });
});

describe("commandJobRefusal", () => {
  it("refuses runner or provider command and names the CLI line", () => {
    for (const args of [{ runner: "command" }, { provider: "command" }]) {
      const msg = commandJobRefusal({ prompt: "x", ...args });
      expect(msg).toContain(QUEUE_ADD_COMMAND_LINE);
      expect(msg).toMatch(/cannot queue a shell command/);
    }
    expect(QUEUE_ADD_COMMAND_LINE).toBe("tidegap queue add --runner command --cwd <dir> --by <when> '<cmd>'");
  });

  it("leaves the LLM runners alone and keeps the command job refusal", () => {
    expect(commandJobRefusal({ prompt: "x", runner: "claude-code" })).toBeUndefined();
    expect(commandJobRefusal({ prompt: "x", provider: "anthropic" })).toBeUndefined();
    expect(commandJobRefusal({ prompt: "x", command: "ls" })).toMatch(/tidegap jobs add --command/);
  });

  it("a job repeat refuses the handoff parameters by name", () => {
    expect(jobUnsupportedRefusal({ cwd: "/w", result_path: "/tmp/x" })).toBe("cwd, result_path cannot be used with a job repeat; omit them");
    expect(jobUnsupportedRefusal({ permission_profile: "read" })).toBe("permission_profile cannot be used with a job repeat; omit it");
  });
});
