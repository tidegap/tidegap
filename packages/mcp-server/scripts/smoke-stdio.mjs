#!/usr/bin/env node
/**
 * Stdio smoke test for @tidegap/mcp.
 *
 * Spawns the built server (dist/server.js) as a child process, runs the MCP
 * `initialize` handshake and `tools/list` over stdio, and checks that every
 * MCP tool of the canonical tool surface (`toolsForHost("mcp")`) is advertised. Uses an ephemeral in-memory ledger so it never
 * touches ~/.tidegap. Run after a build with: `pnpm --filter @tidegap/mcp smoke`.
 */

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { toolsForHost } from "@tidegap/core";

const EXPECTED = toolsForHost("mcp").map((t) => t.name).sort();
const serverPath = join(dirname(fileURLToPath(import.meta.url)), "..", "dist", "server.js");

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [serverPath],
  env: { ...process.env, TIDEGAP_DB_PATH: ":memory:" },
  stderr: "ignore",
});
const client = new Client({ name: "tidegap-mcp-smoke", version: "0.0.0" });

try {
  await client.connect(transport);
  const info = client.getServerVersion();
  console.log(`INIT_OK ${info?.name}@${info?.version}`);

  const { tools } = await client.listTools();
  const got = tools.map((t) => t.name).sort();
  if (got.join(",") !== EXPECTED.join(",")) {
    throw new Error(`expected tools ${EXPECTED.join(", ")}, got ${got.join(", ")}`);
  }
  console.log(`TOOLS_OK ${tools.length}: ${tools.map((t) => t.name).join(", ")}`);
  console.log("SMOKE_PASS");
} catch (err) {
  console.error(`SMOKE_FAIL: ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
} finally {
  await client.close();
}
