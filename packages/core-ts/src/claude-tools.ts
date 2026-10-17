/**
 * The Claude Code tools a `claude-code` task may use (v1).
 *
 * Read-only on purpose: a task can read web pages, and web content is
 * untrusted (prompt injection). So no tool that runs commands or writes
 * files is ever allowed: `Bash`, `Write` and `Edit` are not on the list.
 * A file tool and a web tool are never allowed together: a fetched page
 * could tell the run to read a local file and send it out in a request.
 */

/** Tools that read local files. Never combined with {@link CLAUDE_CODE_WEB_TOOLS}. */
const CLAUDE_CODE_FILE_TOOLS: readonly string[] = ["Read", "Grep", "Glob"];

/** Tools that reach the network. Never combined with the file tools. */
const CLAUDE_CODE_WEB_TOOLS: readonly string[] = ["WebSearch", "WebFetch"];

/** Every tool name a task, `TIDEGAP_CLAUDE_TOOLS` or the adapter accepts. */
export const CLAUDE_CODE_TOOL_ALLOWLIST: readonly string[] = [...CLAUDE_CODE_WEB_TOOLS, ...CLAUDE_CODE_FILE_TOOLS];

/** The tool set of a `claude-code` run when neither the task nor the env names one. */
export const DEFAULT_CLAUDE_CODE_TOOLS: readonly string[] = ["WebSearch", "WebFetch"];

/**
 * Check a `tools` value: an array of allowlisted names (`[]` = none).
 * Returns the error message, or `undefined` when the value is valid.
 */
export function claudeCodeToolsError(value: unknown): string | undefined {
  const allowed = `allowed: ${CLAUDE_CODE_TOOL_ALLOWLIST.join(", ")} (or [] for none)`;
  if (!Array.isArray(value)) return `tools must be an array of tool names; ${allowed}`;
  const bad = value.filter((t) => typeof t !== "string" || !CLAUDE_CODE_TOOL_ALLOWLIST.includes(t));
  if (bad.length > 0) return `tools ${bad.map((t) => JSON.stringify(t)).join(", ")} not allowed; ${allowed}`;
  const mixesFileAndWeb =
    value.some((t) => CLAUDE_CODE_FILE_TOOLS.includes(t)) && value.some((t) => CLAUDE_CODE_WEB_TOOLS.includes(t));
  if (mixesFileAndWeb) {
    return "tools cannot combine a file tool (Read, Grep, Glob) with a web tool (WebSearch, WebFetch): a fetched page could make the run send a local file out";
  }
  return undefined;
}
