/**
 * Vitest setup: point the home directory at a fresh temp dir, so no test
 * reads or creates the developer's real ~/.tidegap or ~/.config/tidegap.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const home = mkdtempSync(join(tmpdir(), "tidegap-test-home-"));
process.env.HOME = home;
process.env.USERPROFILE = home;

// Tests may run inside a Claude Code session (or a tick it started): its
// session markers must not reach the origin capture or the adapter.
for (const name of [
  "CLAUDECODE",
  "CLAUDE_CODE_SESSION_ID",
  "CLAUDE_PROJECT_DIR",
  "CLAUDE_PID",
  "CLAUDE_CONFIG_DIR",
  "TIDEGAP_RESUME",
  "TIDEGAP_RESUME_MAX_TOKENS",
  // A region exported in the developer's shell would override every test's setting.
  "TIDEGAP_DEFAULT_REGION",
]) {
  delete process.env[name];
}

// No test reaches the network: only loopback (the `tidegap ui` server under
// test) passes; anything else (the Anthropic usage API) throws. A test that
// needs a remote answer injects a fake fetch.
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const href = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  const host = new URL(href).hostname;
  if (host === "127.0.0.1" || host === "localhost" || host === "[::1]") return realFetch(input, init);
  throw new Error(`network is off in tests (${host})`);
}) as typeof fetch;
