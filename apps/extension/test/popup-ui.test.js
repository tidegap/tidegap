process.env.TZ = "UTC";
// popup.js against the fake tidegap ui, with a minimal DOM (no jsdom in the
// workspace): covers act() and the job wiring that model.js tests cannot.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { after, before, describe, it } from "node:test";
import { job, startFakeServer } from "./fake-server.js";

class El {
  constructor(tag, id = "") {
    Object.assign(this, { tag, id, children: [], attrs: {}, listeners: {}, hidden: false, className: "", text: "" });
  }
  setAttribute(k, v) {
    this.attrs[k] = v;
  }
  addEventListener(type, fn) {
    this.listeners[type] = fn;
  }
  append(...nodes) {
    this.children.push(...nodes);
  }
  replaceChildren() {
    this.children = [];
  }
  set textContent(v) {
    this.text = v;
    this.children = [];
  }
  get textContent() {
    return this.text + this.children.map((c) => c.textContent).join("");
  }
  get disabled() {
    return "disabled" in this.attrs;
  }
  click() {
    return this.listeners.click?.();
  }
  find(pred, out = []) {
    for (const c of this.children) if (c instanceof El) (pred(c) && out.push(c), c.find(pred, out));
    return out;
  }
}

const ids = [...readFileSync(new URL("../src/popup/popup.html", import.meta.url), "utf8").matchAll(/id="([^"]+)"/g)].map((m) => m[1]);
const els = Object.fromEntries(ids.map((id) => [id, new El("x", id)]));
globalThis.document = {
  getElementById: (id) => els[id],
  createElement: (tag) => new El(tag),
  createTextNode: (text) => ({ textContent: text }),
};

const tick = () => new Promise((ok) => setTimeout(ok, 25));
const settle = async () => {
  for (let i = 0; i < 20; i++) await tick();
};
const jobRow = (id) => els["job-rows"].find((e) => e.attrs["data-job"] === id)[0];
const btn = (row, action) => row.find((e) => e.tag === "button" && e.attrs["data-action"] === action)[0];

describe("popup.js job wiring", () => {
  let fake;
  const tabs = [];
  before(async () => {
    fake = await startFakeServer({ tasks: [], jobs: [job("job-a"), job("job-b")] });
    globalThis.chrome = {
      storage: { local: { get: async () => fake.settings, set: async () => {} } },
      runtime: { sendMessage: async () => ({}), openOptionsPage() {} },
      tabs: { create: (o) => tabs.push(o.url) },
    };
    await import("../src/popup/popup.js");
    await settle();
  });
  after(() => fake.close());
  const posts = () => fake.state.requests.filter((r) => r.method === "POST").map((r) => r.path);

  it("shows the job rows", () => {
    assert.equal(els.jobs.hidden, false);
    assert.ok(jobRow("job-a") && jobRow("job-b"));
  });

  it("Pause acts at once, with no confirm, and the row flips to Resume", async () => {
    btn(jobRow("job-a"), "pause").click();
    await settle();
    assert.deepEqual(posts(), ["/api/jobs/job-a/pause"]);
    assert.equal(els["jobs-msg"].text, "Paused.");
    assert.ok(btn(jobRow("job-a"), "resume"));
    assert.equal(jobRow("job-a").find((e) => e.attrs["data-confirm"]).length, 0);
  });

  it("Run now opens the confirm first, then posts with no body", async () => {
    const before = posts().length;
    btn(jobRow("job-b"), "runJobNow").click();
    await settle();
    assert.equal(posts().length, before);
    const yes = jobRow("job-b").find((e) => e.attrs["data-confirm"] === "runJobNow")[0].find((e) => e.className === "yes" || e.attrs.class === "yes")[0];
    yes.click();
    await settle();
    assert.equal(posts().at(-1), "/api/jobs/job-b/run-now");
    assert.equal(fake.state.requests.filter((r) => r.path === "/api/jobs/job-b/run-now").at(-1).body, "");
    assert.equal(els["jobs-msg"].text, "Runs on the next tick.");
  });

  it("a 409 shows the server's sentence and refreshes the stale row", async () => {
    // Another client pauses job-b behind the popup's back.
    fake.state.jobs.get("job-b").status = "paused"; // the popup still offers Pause on job-b
    fake.state.jobs.get("job-b").actions = { edit: false, pause: false, resume: true, run_now: false, remove: false };
    btn(jobRow("job-b"), "pause").click();
    await settle();
    assert.equal(els["jobs-msg"].text, "job is already paused");
    assert.ok(btn(jobRow("job-b"), "resume"), "row was not refreshed");
    assert.equal(btn(jobRow("job-b"), "pause"), undefined);
  });

  it("an offline error shows its message and does not refresh", async () => {
    const gets = () => fake.state.requests.filter((r) => r.method === "GET").length;
    await fake.close();
    const n = gets();
    btn(jobRow("job-a"), "resume").click();
    await settle();
    assert.match(els["jobs-msg"].text, /not running/);
    assert.equal(gets(), n);
    fake.close = async () => {};
  });

  it("Manage jobs opens the page on the jobs view", () => {
    els["manage-jobs"].click();
    assert.ok(tabs.at(-1).endsWith("&view=jobs"), tabs.at(-1));
  });
});
