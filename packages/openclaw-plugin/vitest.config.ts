import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// The OpenClaw plugin SDK is provided by the runtime, not installed as a
// dependency. Alias the SDK import to a local stub so the plugin entry can be
// loaded and its tools exercised under vitest.
export default defineConfig({
  test: {
    // The module-load startup dispatcher opens the DEFAULT ~/.tidegap/queue.db.
    // Disable it for the suite so tests stay hermetic on temp DBs. This used
    // to be an EBB_DISABLE_STARTUP_DISPATCH=1 env var; the plugin bundle now
    // reads no environment variables, so the opt-out is a function call in the
    // setup file below.
    // One temp root per run, removed at teardown even if a worker crashed.
    globalSetup: ["../../scripts/test/vitest-temp-root.mjs"],
    setupFiles: ["./test/hermetic-home.ts", "./test/setup.ts"],
    alias: {
      "openclaw/plugin-sdk/tool-plugin": fileURLToPath(
        new URL("./test/stub-tool-plugin.ts", import.meta.url),
      ),
    },
  },
});
