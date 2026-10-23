import type { ProviderName } from "../types.js";

/**
 * The model a task dispatches to when the caller names a provider but no
 * model. One map shared by every host (MCP server, OpenClaw plugin) so a task
 * never carries another vendor's model id and every default is a model the
 * vendor still serves. Values are the ids each vendor's API accepts, so
 * Gemini keeps its dotted form (`normalizeModelName` maps it to the
 * canonical `gemini-3-8-flash` table key).
 */
export const DEFAULT_MODEL_BY_PROVIDER: Readonly<Record<ProviderName, string>> =
  Object.freeze({
    anthropic: "claude-sonnet-5",
    openai: "gpt-6-sol",
    gemini: "gemini-3.8-flash",
    ollama: "llama3.1",
    // Claude Code picks its own default model; the adapter omits --model.
    "claude-code": "default",
    // A command job's shell step has no model.
    command: "none",
  });
