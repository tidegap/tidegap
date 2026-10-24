import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Every test file runs against a temp home dir, never the real one.
    // One temp root per run, removed at teardown even if a worker crashed.
    globalSetup: ["../../scripts/test/vitest-temp-root.mjs"],
    setupFiles: ["./test/hermetic-home.ts"],
  },
});
