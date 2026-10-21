// Email kind (integrations plan U11, S13.7): the fake SMTP server (plain, loopback, any login) on portBase + 70.

import { startFakeSmtp } from "../env.mjs";

export const kind = "email";

const PASSWORD = "qa-smtp-pass-sEcReT-3391";

/** One fake SMTP server per QA process, started on first use. */
let smtp;
const fakeSmtp = async (s) => (smtp ??= await startFakeSmtp(s, s.qa.ports.smtp));

export const cases = [
  {
    id: "S13.7",
    title: "a finished task sends one mail through SMTP with the login, the subject and the text",
    async run({ s, addChannel, writeChannelSecrets, runTask, lastDelivery, expect }) {
      const server = await fakeSmtp(s);
      await server.clear();
      addChannel("email", { config: { user: "qa@example.com", host: "127.0.0.1", port: server.port, security: "none", to: "ops@example.com" } });
      writeChannelSecrets("email", { password: PASSWORD });
      await runTask("qa email mail");
      const mails = await server.messages();
      expect(mails.length === 1, `fake SMTP got ${mails.length} mail(s)`);
      const [mail] = mails;
      expect(mail.user === "qa@example.com" && mail.from === "qa@example.com" && mail.to[0] === "ops@example.com", `envelope: ${mail.from} → ${mail.to}`);
      expect(mail.subject.startsWith("Tidegap: Done: qa email mail"), `subject: ${mail.subject}`);
      expect(mail.text.includes("qa email mail"), "the body misses the task title");
      expect(lastDelivery("email")?.ok === true, "channel_last:email is not ok");
    },
  },
];

/** S2.29: Other provider, the fake server, security None, no password. */
export const ui = {
  fields: async (_sink, s) => {
    const server = await fakeSmtp(s);
    return { preset: "", host: "127.0.0.1", port: server.port, security: "none", user: "qa-ui@example.com" };
  },
};
