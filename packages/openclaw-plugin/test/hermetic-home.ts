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
