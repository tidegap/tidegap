// Tests for scripts/check-agent-files.mjs (node --test).
import { test } from "node:test";
import assert from "node:assert/strict";
import { missingCategories, readHosts } from "./check-agent-files.mjs";

const SRC = `const SHARED = "Other MCP hosts";
export const HOSTS: Host[] = [
  {
    id: "plugin",
    installHeading: "Claude Code",
    group: "agent",
    command: "/plugin marketplace add tidegap/tidegap\\n/plugin install tidegap",
  },
  {
    id: "desktop",
    installHeading: SHARED,
    group: "ide",
    command: \`{
  "mcpServers": { "tidegap": { "command": "npx" } }
}\`,
  },
  {
    id: "quoted",
    installHeading: SHARED,
    group: "ide",
    command: "say \\"hi\\"",
  },
];`;

test("readHosts returns each full command, escapes resolved", () => {
  const hosts = readHosts(SRC);
  assert.deepEqual(
    hosts.map((h) => [h.id, h.installHeading, h.group, h.command]),
    [
      ["plugin", "Claude Code", "agent", "/plugin marketplace add tidegap/tidegap\n/plugin install tidegap"],
      ["desktop", "Other MCP hosts", "ide", '{\n  "mcpServers": { "tidegap": { "command": "npx" } }\n}'],
      ["quoted", "Other MCP hosts", "ide", 'say "hi"'],
    ],
  );
});

test("missingCategories needs the `## <label>` heading line, not the word", () => {
  const body = "# Docs\n\n## Install\n\nOpen the Jobs page.\n\n### Jobs\n\n## Jobs page\n";
  assert.deepEqual(missingCategories(body, ["Install", "Jobs"]), ["Jobs"]);
  assert.deepEqual(missingCategories(`${body}\n## Jobs  \r\n`, ["Install", "Jobs"]), []);
});
