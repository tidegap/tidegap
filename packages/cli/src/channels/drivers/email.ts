/** Email driver (U11): one mail through the SMTP client (KTD5). */

import { sendSmtp } from "../smtp.js";
import { expectSpec, type ChannelDriver } from "./types.js";

export const email: ChannelDriver = {
  async send(spec, ctx) {
    await sendSmtp(expectSpec(spec, "smtp"), { ...ctx.smtp, uiPorts: ctx.http.uiPorts, lookup: ctx.smtp?.lookup ?? ctx.http.lookup });
  },
};
