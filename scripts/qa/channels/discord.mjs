// Discord kind (integrations plan U8, S13.4) against the fake sink standing in for discord.com (loopback is allowed).

export const kind = "discord";

const HOOK = "/api/webhooks/1000/qa-discord-sEcReT-5523";

export const cases = [
  {
    id: "S13.4",
    title: "a finished task arrives as one embed, wait=true, no allowed mentions",
    async run({ sink, addChannel, writeChannelSecrets, runTask, lastDelivery, expect }) {
      addChannel("discord");
      writeChannelSecrets("discord", { url: `${sink.base}${HOOK}` });
      await runTask("qa discord @everyone [x](https://evil)");
      const reqs = await sink.requests(HOOK);
      expect(reqs.length === 1, `sink got ${reqs.length} request(s)`);
      expect(reqs[0].path.endsWith("?wait=true"), "no wait=true");
      const body = JSON.parse(reqs[0].body);
      expect(Array.isArray(body.allowed_mentions?.parse) && body.allowed_mentions.parse.length === 0, "mentions are allowed");
      expect(body.embeds?.[0]?.title?.includes("\\[x\\]\\(https://evil\\)"), "the masked link is not escaped");
      expect(lastDelivery("discord")?.ok === true, "channel_last:discord is not ok");
    },
  },
];

/** S2.29: the card's fields for a connect against the sink. */
export const ui = { fields: (sink) => ({ url: `${sink.base}/api/webhooks/2000/qa-discord-ui-6612` }) };
