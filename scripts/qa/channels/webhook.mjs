// Webhook kind (integrations plan U6, S13.1–S13.2) against the fake sink.
// No `ui` export: S2.28 and S2.30 drive the webhook card themselves.

import { createHmac } from "node:crypto";

export const kind = "webhook";

const HOOK = "/hook/qa-webhook-kind-sEcReT-4410";
const SIGNING = "qa-signing-sEcReT-9921";

export const cases = [
  {
    id: "S13.1",
    title: "a finished task reaches the sink as one signed POST the harness verifies, with the custom header",
    async run({ sink, addChannel, writeChannelSecrets, runTask, expect }) {
      addChannel("webhook");
      writeChannelSecrets("webhook", { url: `${sink.base}${HOOK}`, secret: SIGNING, headers: "X-QA-Env: channels" });
      const { id } = await runTask("qa webhook signed");
      const reqs = await sink.requests(HOOK);
      expect(reqs.length === 1, `sink got ${reqs.length} request(s)`);
      const [req] = reqs;
      const ts = req.headers["x-tidegap-timestamp"];
      const want = `sha256=${createHmac("sha256", SIGNING).update(`${ts}.${req.body}`).digest("hex")}`;
      expect(req.headers["x-tidegap-signature"] === want, "the signature does not verify");
      expect(req.headers["x-qa-env"] === "channels", "the custom header is missing");
      const body = JSON.parse(req.body);
      expect(body.version === 1 && body.event === "task_done" && body.task?.id === id, "not the Tidegap JSON of the task");
    },
  },
  {
    id: "S13.2",
    title: "503 twice, then 200: three requests with one delivery id",
    async run({ sink, addChannel, writeChannelSecrets, runTask, lastDelivery, expect }) {
      addChannel("webhook");
      writeChannelSecrets("webhook", { url: `${sink.base}${HOOK}` });
      await sink.script(HOOK, [{ status: 503 }, { status: 503 }, { status: 200 }]);
      await runTask("qa webhook retries");
      const reqs = await sink.requests(HOOK);
      expect(reqs.length === 3, `sink got ${reqs.length} request(s)`);
      expect(new Set(reqs.map((r) => r.headers["x-tidegap-delivery"])).size === 1, "the attempts carry different delivery ids");
      expect(lastDelivery("webhook")?.ok === true, "channel_last:webhook is not ok");
    },
  },
];
