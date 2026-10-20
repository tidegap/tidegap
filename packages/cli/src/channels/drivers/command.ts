/**
 * Command driver: the user's program with its argv items (no shell), the
 * Tidegap JSON on stdin, the home folder as working directory, the minimal
 * environment and the 20 s limit of {@link runChild}. The program passes
 * {@link checkProgram} before every run, connect included. Exit code 0 is a
 * delivery.
 */

import { homedir } from "node:os";

import { readChannelDriverEnv } from "../../env.js";
import { DeliveryError } from "../http.js";
import { runChild } from "./child.js";
import { checkProgram } from "./program.js";
import { expectSpec, type ChannelDriver } from "./types.js";

/** Most argv items (the kind's `args` field takes the same number of lines). */
const MAX_ARGS = 10;

export const command: ChannelDriver = {
  async send(spec, ctx) {
    const { path, args, input } = expectSpec(spec, "command");
    if (args.length > MAX_ARGS || args.some((a) => a.includes("\0"))) throw new DeliveryError("invalid_config");
    const program = checkProgram(path);
    if (!program.ok) throw new DeliveryError(program.code);
    const env = ctx.env ?? readChannelDriverEnv();
    const res = await runChild(program.path, args, { cwd: homedir(), env: env.childEnv, input, timeoutMs: ctx.execTimeoutMs });
    if (res.ok) return;
    throw new DeliveryError(res.reason === "exit" ? "command_failed" : res.reason);
  },
};
