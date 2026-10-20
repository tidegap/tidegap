/**
 * Command driver: the user's program with its argv items (no shell), the
 * Tidegap JSON on stdin, the home folder as working directory, the minimal
 * environment and the 20 s limit of {@link runChild}. Exit code 0 is a
 * delivery.
 */

import { homedir } from "node:os";
import { isAbsolute } from "node:path";

import { readChannelDriverEnv } from "../../env.js";
import { DeliveryError } from "../http.js";
import { runChild } from "./child.js";
import { expectSpec, type ChannelDriver } from "./types.js";

export const command: ChannelDriver = {
  async send(spec, ctx) {
    const { path, args, input } = expectSpec(spec, "command");
    if (!isAbsolute(path)) throw new DeliveryError("invalid_config");
    const env = ctx.env ?? readChannelDriverEnv();
    const res = await runChild(path, args, { cwd: homedir(), env: env.childEnv, input, timeoutMs: ctx.execTimeoutMs });
    if (res.ok) return;
    throw new DeliveryError(res.reason === "exit" ? "command_failed" : res.reason);
  },
};
