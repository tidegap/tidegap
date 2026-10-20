// ntfy kind (integrations plan U9, S13.5): the fake sink is the ntfy server.

export const kind = "ntfy";

const TOPIC = "qa-ntfy-sEcReT-8814";
const TOKEN = "tk_qa_ntfy_sEcReT_2290";

export const cases = [
  {
    id: "S13.5",
    title: "a finished task publishes to <server>/<topic> with Title, Priority 3, Tags and the Bearer token",
    async run({ sink, addChannel, writeChannelSecrets, runTask, lastDelivery, expect }) {
      addChannel("ntfy", { config: { server: sink.base, priority: "auto" } });
      writeChannelSecrets("ntfy", { topic: TOPIC, token: TOKEN });
      await runTask("qa ntfy push");
      const reqs = await sink.requests(`/${TOPIC}`);
      expect(reqs.length === 1, `sink got ${reqs.length} request(s)`);
      const [req] = reqs;
      expect(req.headers.title?.includes("qa ntfy push"), "no Title header with the task title");
      expect(req.headers.priority === "3" && req.headers.tags === "white_check_mark", "priority or tags do not follow the done event");
      expect(req.headers.authorization === `Bearer ${TOKEN}`, "no Bearer token");
      expect(req.headers["content-type"]?.startsWith("text/plain"), "the body is not plain text");
      expect(lastDelivery("ntfy")?.ok === true, "channel_last:ntfy is not ok");
    },
  },
];

/** S2.29: the card's fields for a connect against the sink. */
export const ui = { fields: (sink) => ({ server: sink.base, topic: "qa-ntfy-ui-7731" }) };
