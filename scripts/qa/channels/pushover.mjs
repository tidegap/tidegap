// Pushover kind (integrations plan U10, S13.6): the fake sink is the API (TIDEGAP_PUSHOVER_API_BASE in the QA env).

export const kind = "pushover";

const USER = "uqaPushoverUserKeysEcReT000001";
const TOKEN = "aqaPushoverAppTokensEcReT00002";

export const cases = [
  {
    id: "S13.6",
    title: "a finished task posts the form to /1/messages.json with the user key, the token and the title",
    async run({ sink, addChannel, writeChannelSecrets, runTask, lastDelivery, expect }) {
      addChannel("pushover");
      writeChannelSecrets("pushover", { user_key: USER, app_token: TOKEN });
      await runTask("qa pushover push");
      const reqs = await sink.requests("/1/messages.json");
      expect(reqs.length === 1, `sink got ${reqs.length} request(s)`);
      const form = new URLSearchParams(reqs[0].body);
      expect(form.get("user") === USER && form.get("token") === TOKEN, "user key or token missing from the form");
      expect(form.get("title")?.includes("qa pushover push"), "no title with the task title");
      expect(lastDelivery("pushover")?.ok === true, "channel_last:pushover is not ok");
    },
  },
];

/** S2.29: the card's fields for a connect against the sink. */
export const ui = { fields: () => ({ user_key: "uqaPushoverUiUserKey0000000001", app_token: "aqaPushoverUiAppToken000000002" }) };
