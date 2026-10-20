/**
 * Shortcuts driver (U12, KTD16): `shortcuts run <name> --input-path <file>`
 * through {@link runChild}. The message goes to a 0600 file in a private
 * temp directory that is removed after the run, whatever its result.
 * `TIDEGAP_SHORTCUTS_BIN` points tests and QA at a fake; the name was
 * validated (no control character, not starting with "-").
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

import { readChannelDriverEnv } from "../../env.js";
import { DeliveryError } from "../http.js";
import { runChild } from "./child.js";
import { expectSpec, type ChannelDriver } from "./types.js";

/** What `shortcuts run` prints when no shortcut has the name. */
const NOT_FOUND = /couldn.?t find|could not find|not found|no shortcut/i;

export const shortcuts: ChannelDriver = {
  async send(spec, ctx) {
    const { name, input } = expectSpec(spec, "shortcut");
    if (!name || name.startsWith("-") || /[\u0000-\u001f\u007f]/.test(name)) throw new DeliveryError("invalid_config");
    const env = ctx.env ?? readChannelDriverEnv();
    const dir = mkdtempSync(join(tmpdir(), "tidegap-shortcut-"));
    try {
      const file = join(dir, "message.txt");
      writeFileSync(file, input, { mode: 0o600 });
      const res = await runChild(env.shortcutsBin, ["run", name, "--input-path", file], { cwd: homedir(), env: env.childEnv, timeoutMs: ctx.execTimeoutMs });
      if (res.ok) return;
      if (res.reason === "timeout") throw new DeliveryError("timeout");
      if (res.reason === "not_found" || res.reason === "not_executable") throw new DeliveryError("no_shortcuts");
      throw new DeliveryError(NOT_FOUND.test(res.stderr) ? "not_found" : "shortcut_failed");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  },
};
