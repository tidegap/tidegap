// Vitest globalSetup shared by the workspace packages: one temp root per run.
// Each test file's hermetic home (test/hermetic-home.ts) lives under it and
// removes itself after the file; this teardown removes the root, so a worker
// that crashed or was killed before its own cleanup leaks nothing either.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export default function setup() {
  const root = mkdtempSync(join(tmpdir(), "tidegap-test-run-"));
  // Workers start after globalSetup and inherit the environment.
  process.env.TIDEGAP_TEST_TMP_ROOT = root;
  const remove = () => rmSync(root, { recursive: true, force: true, maxRetries: 3 });
  // A run stopped before teardown (Ctrl-C, an uncaught error) still removes it.
  process.once("exit", remove);
  return () => {
    process.off("exit", remove);
    remove();
  };
}
