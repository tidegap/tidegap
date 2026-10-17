/** The one site description, shared by the meta, Open Graph and Twitter tags. */
export const SITE_DESCRIPTION =
  "Open-source MCP server that runs your agent's non-urgent AI tasks at the cleanest electricity-grid hour before the deadline. Claude Code, Codex, Cursor, any MCP host.";

/**
 * Markdown alternate for pages an installing agent lands on. Next.js merges
 * `alternates` shallowly, so every page that sets its own canonical must
 * spread this in as `types` too.
 */
export const MARKDOWN_ALTERNATE = { "text/markdown": "/install.md" };
