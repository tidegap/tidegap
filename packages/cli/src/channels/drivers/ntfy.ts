/** ntfy driver: a POST of the descriptor's spec through the shared HTTP transport (retries, URL policy, no redirects). */

import { httpDriver, type ChannelDriver } from "./types.js";

export const ntfy: ChannelDriver = httpDriver;
