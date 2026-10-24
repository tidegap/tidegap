/**
 * Vitest setup: point the home directory at a fresh temp dir, so no test
 * reads or creates the developer's real ~/.tidegap or ~/.config/tidegap.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll } from "vitest";

// The home lives under the run's temp root (scripts/test/vitest-temp-root.mjs,
// removed at teardown) and is removed after this file, or on exit if the
// worker dies first.
const home = mkdtempSync(join(process.env.TIDEGAP_TEST_TMP_ROOT || tmpdir(), "tidegap-test-home-"));
const removeHome = () => rmSync(home, { recursive: true, force: true, maxRetries: 3 });
process.once("exit", removeHome);
afterAll(() => {
  process.off("exit", removeHome);
  removeHome();
});
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
