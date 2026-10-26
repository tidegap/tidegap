/** The job form's controller (jobs U9): a stale revision offers Reload, Reload keeps only typed fields, job events refresh a clean form and spare a dirty one, close during Save, preview Retry, Remove. API, toasts and dialogs are stubbed; the drawer is a fake element. */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { FakeElement, FakeNode, installFakeDom, textOf, walk } from "./fixtures/fake-dom.js";

const job = vi.fn();
const updateJob = vi.fn();
const previewJob = vi.fn();
const jobAction = vi.fn();
const toast = vi.fn();
const errorToast = vi.fn();
const confirmDialog = vi.fn();
const drawer = new FakeElement("aside");

vi.mock("../ui/api.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../ui/api.js")>()),
  api: {
    job: (...a: unknown[]) => job(...a),
    updateJob: (...a: unknown[]) => updateJob(...a),
    previewJob: (...a: unknown[]) => previewJob(...a),
    jobAction: (...a: unknown[]) => jobAction(...a),
    jobs: async () => ({ jobs: [] }),
  },
}));
vi.mock("../ui/toast.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../ui/toast.js")>()),
  toast: (...a: unknown[]) => toast(...a),
  errorToast: (...a: unknown[]) => errorToast(...a),
}));
vi.mock("../ui/dialog.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../ui/dialog.js")>()),
  confirmDialog: (...a: unknown[]) => confirmDialog(...a),
}));
vi.mock("../ui/jobs.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../ui/jobs.js")>()),
  showDrawer: (nodes: unknown[]) => drawer.replaceChildren(...(nodes.flat(Infinity).filter(Boolean) as FakeElement[])),
  hideDrawer: () => drawer.replaceChildren(),
  returnFocus: () => {},
}));

import { ApiError } from "../ui/api.js";
import { closeJobForm, leaveJobForm, onJobFormEvent, openJobForm, STALE_LINE } from "../ui/job-form.js";
import { jobsState } from "../ui/jobs.js";

installFakeDom();

const replaceState = vi.fn();
const loc = { hash: "" };
beforeAll(() => {
  // What the form's in-place update needs from the drawer: lookup by id, child swaps.
  Object.assign(drawer, { querySelector: (sel: string) => (sel.startsWith("#") ? (byId(sel.slice(1)) ?? null) : null) });
  Object.defineProperty(FakeElement.prototype, "childNodes", { configurable: true, get(this: FakeElement) { return this.children; } });
  Object.assign(FakeNode.prototype, { isEqualNode: () => false });
  Object.assign(FakeElement.prototype, { removeAttribute(this: FakeElement, k: string) { delete this.attrs[k]; } });
  Object.assign(globalThis.document, { getElementById: (id: string) => (id === "drawer" ? drawer : null), querySelector: () => null });
  vi.stubGlobal("location", loc);
  vi.stubGlobal("history", { replaceState });
  vi.stubGlobal("requestAnimationFrame", () => 0);
});
afterAll(() => vi.unstubAllGlobals());

const JOB = {
  job_id: "job-1",
  title: "Mail triage",
  status: "active",
  revision: 4,
  cadence: { kind: "daily" },
  window: { start: "00:00", end: "08:00" },
  time_zone: "Europe/Berlin",
  runner: "command",
  command: "himalaya envelope list",
  prompt: null,
  provider: null,
  model: null,
  tools: "none",
  cwd: "~/mail",
  secrets: [],
  caps: { command_timeout_s: 120, llm_timeout_s: 900, max_budget_usd: 0.5 },
  notify: "failures",
  actions: { edit: true, pause: true, resume: false, run_now: true, remove: true },
};
const RENAMED = { ...JOB, revision: 5, title: "Mail (renamed elsewhere)" };
const PREVIEW = { first_run: { earliest: "2026-10-26T23:00:00Z", deadline: "2026-10-27T07:00:00Z", planned_at: null, intensity_g_per_kwh: null }, guarantee: "runs every day between 00:00 and 08:00" };

const settle = () => new Promise((r) => setTimeout(r, 0));
const els = () => walk(drawer.children).els;
const byId = (id: string) => els().find((e) => e.attrs.id === id);
const text = () => textOf(drawer);
async function open() {
  await openJobForm("job-1", "#/jobs/job-1");
  await settle();
}
function type(id: string, value: string) {
  const input = byId(id)!;
  Object.assign(input, { value });
  input.dispatch("input");
}
async function submit() {
  els().find((e) => e.tagName === "form")!.dispatch("submit", { preventDefault() {} });
  await settle();
}
const stale = () => new ApiError(409, "job changed meanwhile (revision 5); reload it and try again", { code: "stale_revision" });

beforeEach(() => {
  for (const f of [job, updateJob, previewJob, jobAction, toast, errorToast, confirmDialog, replaceState]) f.mockReset();
  Object.assign(jobsState, { loaded: true, jobs: [JOB], canAuthor: true, secretNames: [], ops: new Map() });
  job.mockResolvedValue(JOB);
  previewJob.mockResolvedValue(PREVIEW);
  loc.hash = "#/jobs/job-1";
});
afterEach(() => closeJobForm());

describe("stale revision", () => {
  it("a 409 stale_revision offers Reload; Reload takes the fresh job and Save sends only the typed field", async () => {
    await open();
    type("jf-command", "himalaya envelope list --output json");
    updateJob.mockRejectedValueOnce(stale());
    await submit();
    expect(text()).toContain(STALE_LINE);
    const reload = els().find((e) => (e.attrs.class ?? "").includes("jf-reload"))!;
    expect(reload).toBeDefined();

    job.mockResolvedValue(RENAMED);
    reload.dispatch("click");
    await settle();
    expect(text()).not.toContain(STALE_LINE);
    expect(byId("jf-title")!.value).toBe("Mail (renamed elsewhere)");
    expect(byId("jf-command")!.value).toBe("himalaya envelope list --output json");

    updateJob.mockResolvedValueOnce({ ...RENAMED, revision: 6, next_run: null });
    await submit();
    const patch = updateJob.mock.calls.at(-1)![1];
    expect(patch).toMatchObject({ command: "himalaya envelope list --output json", revision: 5 });
    expect(patch).not.toHaveProperty("title");
    expect(toast).toHaveBeenCalledWith("Job saved.");
    expect(loc.hash).toBe("#/jobs");
  });

  it("another 409 (no stale_revision code) shows the server's sentence without Reload", async () => {
    await open();
    type("jf-command", "x");
    updateJob.mockRejectedValueOnce(new ApiError(409, "job was removed"));
    await submit();
    expect(text()).toContain("job was removed");
    expect(els().some((e) => (e.attrs.class ?? "").includes("jf-reload"))).toBe(false);
  });
});

describe("job events while the form is open", () => {
  it("a dirty form keeps the typed values and its old revision", async () => {
    await open();
    type("jf-command", "typed by hand");
    job.mockResolvedValue(RENAMED);
    await onJobFormEvent();
    expect(byId("jf-command")!.value).toBe("typed by hand");
    expect(byId("jf-title")!.value).toBe("Mail triage");
    updateJob.mockRejectedValueOnce(stale());
    await submit();
    expect(updateJob.mock.calls[0]![1]).toMatchObject({ revision: 4 });
  });

  it("a clean form follows the fresh job and previews its new schedule", async () => {
    await open();
    expect(previewJob).toHaveBeenCalledTimes(1);
    job.mockResolvedValue({ ...RENAMED, window: { start: "01:00", end: "06:00" } });
    await onJobFormEvent();
    expect(byId("jf-title")!.value).toBe("Mail (renamed elsewhere)");
    expect(byId("jf-start")!.value).toBe("01:00");
    await vi.waitFor(() => expect(previewJob).toHaveBeenCalledTimes(2), { timeout: 2000 });
    expect(previewJob.mock.calls[1]![0]).toMatchObject({ window: { start: "01:00", end: "06:00" } });
  });
});

describe("close, preview and remove", () => {
  it("closing during Save keeps the form and puts its route back in the address", async () => {
    await open();
    type("jf-command", "x");
    updateJob.mockReturnValue(new Promise(() => {}));
    await submit();
    expect(await leaveJobForm("#/jobs")).toBe(false);
    expect(replaceState).toHaveBeenCalledWith(null, "", "#/jobs/job-1");
  });

  it("a failed preview shows the reason and a Retry that asks again", async () => {
    previewJob.mockReset();
    previewJob.mockRejectedValueOnce(new ApiError(429, "Wait 30 seconds and try again.")).mockResolvedValueOnce(PREVIEW);
    await open();
    expect(text()).toContain("Wait 30 seconds and try again.");
    byId("jf-preview-retry")!.dispatch("click");
    await settle();
    expect(previewJob).toHaveBeenCalledTimes(2);
    expect(byId("jf-preview-retry")).toBeUndefined();
  });

  it("Remove in the footer confirms, removes through the list's remover and closes the form", async () => {
    await open();
    confirmDialog.mockResolvedValue(true);
    jobAction.mockResolvedValue({ job_id: "job-1", status: "removed" });
    els().find((e) => e.tagName === "button" && textOf(e) === "Remove")!.dispatch("click");
    await settle();
    expect(jobAction).toHaveBeenCalledWith("job-1", "remove");
    expect(toast).toHaveBeenCalledWith("Removed “Mail triage”");
    expect(jobsState.jobs).toEqual([]);
    expect(drawer.children).toHaveLength(0);
    expect(loc.hash).toBe("#/jobs");
  });
});
