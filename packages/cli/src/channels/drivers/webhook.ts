/** Generic webhook driver (R11): the reference driver, a POST through the shared HTTP transport. */

import { sendHttp } from "../http.js";
import { expectSpec, type ChannelDriver } from "./types.js";

export const webhook: ChannelDriver = {
  async send(spec, ctx) {
    await sendHttp(expectSpec(spec, "http"), ctx.http);
  },
};
