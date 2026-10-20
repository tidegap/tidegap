// Slack kind (integrations plan U7, S13.3) against the fake sink standing in for hooks.slack.com (loopback is allowed).

export const kind = "slack";

const HOOK = "/services/T0QA/B0QA/qa-slack-sEcReT-3317";

export const cases = [
  {
    id: "S13.3",
    title: "a finished task arrives as text plus one mrkdwn block with the same text",
    async run({ sink, addChannel, writeChannelSecrets, runTask, lastDelivery, expect }) {
      addChannel("slack");
      writeChannelSecrets("slack", { url: `${sink.base}${HOOK}` });
      await runTask("qa slack <done> & co");
      const reqs = await sink.requests(HOOK);
      expect(reqs.length === 1, `sink got ${reqs.length} request(s)`);
      const body = JSON.parse(reqs[0].body);
      expect(body.blocks?.[0]?.type === "section" && body.blocks[0].text.text.endsWith(body.text), "the block text is not the payload text");
      expect(body.text.includes("&lt;done&gt; &amp; co"), "the title is not escaped");
      expect(lastDelivery("slack")?.ok === true, "channel_last:slack is not ok");
    },
  },
];

/** S2.29: the card's fields for a connect against the sink. */
export const ui = { fields: (sink) => ({ url: `${sink.base}/services/T0UI/B0UI/qa-slack-ui-4471` }) };
