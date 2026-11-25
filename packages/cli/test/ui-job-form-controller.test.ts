/** The job form's controller (jobs U9): a stale revision offers Reload, Reload keeps only typed fields, job events refresh a clean form and spare a dirty one, close during Save, preview Retry, Remove, the end date and run count. API, toasts and dialogs are stubbed; the drawer is a fake element. */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { FakeElement, FakeNode, installFakeDom, textOf, walk } from "./fixtures/fake-dom.js";

const job = vi.fn();
const createJob = vi.fn();
const updateJob = vi.fn();
const previewJob = vi.fn();
const jobAction = vi.fn();
const jobSecrets = vi.fn();
const toast = vi.fn();
const errorToast = vi.fn();
const confirmDialog = vi.fn();
const drawer = new FakeElement("aside");

vi.mock("../ui/api.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../ui/api.js")>()),
  api: {
    job: (...a: unknown[]) => job(...a),
    createJob: (...a: unknown[]) => createJob(...a),
    updateJob: (...a: unknown[]) => updateJob(...a),
    previewJob: (...a: unknown[]) => previewJob(...a),
    jobAction: (...a: unknown[]) => jobAction(...a),
    jobSecrets: (...a: unknown[]) => jobSecrets(...a),
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
import { ACCESS_ERROR_LINE, closeJobForm, leaveJobForm, onJobFormEvent, openJobForm, READ_ONLY_LINE, REMOVED_LINE, STALE_LINE } from "../ui/job-form.js";
import { jobsState } from "../ui/jobs.js";

installFakeDom();

/** The address bar: `replaceState` keeps its state object, as a browser does. */
const hist = { state: null as unknown };
const replaceState = vi.fn();
const loc = { hash: "" };
beforeAll(() => {
  // What the form's in-place update needs from the drawer: lookup by id, child swaps.
  Object.assign(drawer, { querySelector: (sel: string) => (sel.startsWith("#") ? (byId(sel.slice(1)) ?? null) : null) });
  Object.defineProperty(FakeElement.prototype, "childNodes", { configurable: true, get(this: FakeElement) { return this.children; } });
  Object.assign(FakeNode.prototype, { isEqualNode: () => false });
  Object.assign(FakeElement.prototype, { removeAttribute(this: FakeElement, k: string) { delete this.attrs[k]; } });
  Object.assign((globalThis as Record<string, unknown>).document as object, { getElementById: (id: string) => (id === "drawer" ? drawer : null), querySelector: () => null });
  vi.stubGlobal("location", loc);
  vi.stubGlobal("history", Object.assign(hist, { replaceState }));
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
  for (const f of [job, createJob, updateJob, previewJob, jobAction, jobSecrets, toast, errorToast, confirmDialog, replaceState]) f.mockReset();
  hist.state = null;
  replaceState.mockImplementation((state: unknown, _title: string, url: string) => {
    hist.state = state;
    loc.hash = url;
  });
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

describe("end date and run count", () => {
  const BOUNDED = { ...JOB, ends: { until: "2026-12-01", runs_left: 3 } };

  it("a new job with an end date sends until and no count", async () => {
    loc.hash = "#/jobs/new";
    await openJobForm(null, "#/jobs/new");
    await settle();
    type("jf-title", "Digest");
    type("jf-prompt", "summarize the day");
    type("jf-until", "2026-12-01");
    createJob.mockResolvedValueOnce({ ...JOB, job_id: "job-2", ends: { until: "2026-12-01", runs_left: null }, next_run: null });
    await submit();
    const body = createJob.mock.calls[0]![0];
    expect(body).toMatchObject({ title: "Digest", until: "2026-12-01" });
    expect(body).not.toHaveProperty("count");
    expect(toast).toHaveBeenCalledWith("Job saved.");
  });

  it("an edit prefills the runs left and sends a changed count only", async () => {
    job.mockResolvedValue(BOUNDED);
    await open();
    expect(byId("jf-until")!.value).toBe("2026-12-01");
    expect(byId("jf-count")!.value).toBe("3");
    type("jf-count", "5");
    updateJob.mockResolvedValueOnce({ ...BOUNDED, revision: 5, ends: { until: "2026-12-01", runs_left: 5 }, next_run: null });
    await submit();
    expect(updateJob.mock.calls[0]![1]).toEqual({ count: 5, revision: 4 });
  });

  it("empty and none clear both: the patch sends until and count as null", async () => {
    job.mockResolvedValue(BOUNDED);
    await open();
    type("jf-until", "");
    type("jf-count", "none");
    updateJob.mockResolvedValueOnce({ ...BOUNDED, revision: 5, ends: null, next_run: null });
    await submit();
    expect(updateJob.mock.calls[0]![1]).toEqual({ until: null, count: null, revision: 4 });
  });

  it("the API's 400 for an end date shows in the form, which stays open with the typed value", async () => {
    await open();
    type("jf-until", "2020-01-01");
    updateJob.mockRejectedValueOnce(new ApiError(400, 'until "2020-01-01" has passed; give a later day or instant'));
    await submit();
    expect(byId("jf-form-error") && textOf(byId("jf-form-error")!)).toContain('until "2020-01-01" has passed; give a later day or instant');
    expect(byId("jf-until")!.value).toBe("2020-01-01");
    expect(toast).not.toHaveBeenCalled();
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

describe("read-only form states (KTD16)", () => {
  const removed = { ...JOB, revision: 5, status: "removed", actions: { edit: false, pause: false, resume: false, run_now: false, remove: false } };
  const save = () => byId("jf-save")!;
  const fieldset = () => els().find((e) => e.tagName === "fieldset")!;
  const removeButton = () => els().find((e) => e.tagName === "button" && textOf(e) === "Remove");

  it("a job removed elsewhere turns the open form read-only; typed text stays; Close leaves without asking", async () => {
    await open();
    type("jf-command", "typed by hand");
    job.mockResolvedValue(removed);
    await onJobFormEvent();
    expect(text()).toContain(REMOVED_LINE);
    expect(els().find((e) => e.attrs.role === "status")).toBeDefined();
    expect(fieldset().attrs.disabled).toBe("");
    expect(save().attrs.disabled).toBe("");
    expect(removeButton()).toBeUndefined();
    expect(byId("jf-command")!.value).toBe("typed by hand");
    expect(byId("jf-close")).toBeDefined();
    expect(await leaveJobForm("#/jobs")).toBe(true);
    expect(confirmDialog).not.toHaveBeenCalled();
    expect(drawer.children).toHaveLength(0);
  });

  it("a job that is gone (404) on a job event reads as removed", async () => {
    await open();
    job.mockRejectedValue(new ApiError(404, "job not found"));
    await onJobFormEvent();
    expect(text()).toContain(REMOVED_LINE);
    expect(save().attrs.disabled).toBe("");
  });

  it("a job without the edit action opens read-only with the token line", async () => {
    job.mockResolvedValue({ ...JOB, actions: { ...JOB.actions, edit: false, remove: false } });
    await open();
    expect(text()).toContain(READ_ONLY_LINE);
    expect(fieldset().attrs.disabled).toBe("");
    expect(save().attrs.disabled).toBe("");
  });

  it("an ended job opens read-only with the ended line, not the token line, and no field error", async () => {
    const ended = { ...JOB, status: "ended", ended_at: "2026-11-17T08:00:00Z", end_reason: "count", ends: { until: null, runs_left: 0 }, actions: { ...JOB.actions, edit: false, pause: false, run_now: false } };
    job.mockResolvedValue(ended);
    await open();
    expect(text()).toContain("This job ended 17 Nov: its runs are done. An ended job cannot be edited.");
    expect(text()).not.toContain(READ_ONLY_LINE);
    expect(byId("jf-count")!.value).toBe("0");
    expect(textOf(byId("jf-err-count")!)).toBe("");
    expect(fieldset().attrs.disabled).toBe("");
    expect(save().attrs.disabled).toBe("");
    closeJobForm();
    job.mockResolvedValue(JOB);
    await open();
    job.mockResolvedValue({ ...ended, end_reason: "until", ends: { until: "2026-11-17", runs_left: null } });
    await onJobFormEvent();
    expect(text()).toContain("This job ended 17 Nov: its end date passed. An ended job cannot be edited.");
    expect(save().attrs.disabled).toBe("");
  });

  it("an ended job's read-only form shows Remove: it confirms, removes and closes the form", async () => {
    const ended = { ...JOB, status: "ended", ended_at: "2026-11-17T08:00:00Z", end_reason: "count", ends: { until: null, runs_left: 0 }, actions: { edit: false, pause: false, resume: false, run_now: false, remove: true } };
    job.mockResolvedValue(ended);
    await open();
    expect(save().attrs.disabled).toBe("");
    expect(textOf(byId("jf-close")!)).toBe("Close");
    confirmDialog.mockResolvedValue(true);
    jobAction.mockResolvedValue({ job_id: "job-1", status: "removed" });
    removeButton()!.dispatch("click");
    await settle();
    expect(confirmDialog).toHaveBeenCalledTimes(1);
    expect(jobAction).toHaveBeenCalledWith("job-1", "remove");
    expect(toast).toHaveBeenCalledWith("Removed “Mail triage”");
    expect(drawer.children).toHaveLength(0);
    expect(loc.hash).toBe("#/jobs");
  });

  it("an ended job whose answer does not allow remove shows no Remove", async () => {
    job.mockResolvedValue({ ...JOB, status: "ended", ended_at: "2026-11-17T08:00:00Z", end_reason: "count", actions: { edit: false, pause: false, resume: false, run_now: false, remove: false } });
    await open();
    expect(removeButton()).toBeUndefined();
  });

  it("a read-only form hides Remove even when the answer still allows it", async () => {
    job.mockResolvedValue({ ...JOB, actions: { ...JOB.actions, edit: false, remove: true } });
    await open();
    expect(text()).toContain(READ_ONLY_LINE);
    expect(removeButton()).toBeUndefined();
    closeJobForm();
    job.mockResolvedValue({ ...removed, actions: { ...removed.actions, remove: true } });
    await open();
    expect(text()).toContain(REMOVED_LINE);
    expect(removeButton()).toBeUndefined();
  });

  it("a 403 from the author probe never renders an editable form", async () => {
    jobsState.canAuthor = null;
    let answer!: (e: unknown) => void;
    jobSecrets.mockReturnValue(new Promise((_r, reject) => (answer = reject)));
    const opening = openJobForm(null, "#/jobs/new");
    expect(byId("jf-title")).toBeUndefined();
    answer(new ApiError(403, "forbidden"));
    expect(await opening).toBe(false);
    expect(byId("jf-title")).toBeUndefined();
  });

  it("a failed author probe says so and shows no fields", async () => {
    jobsState.canAuthor = null;
    jobSecrets.mockRejectedValue(new ApiError(500, "boom"));
    expect(await openJobForm("job-1", "#/jobs/job-1")).toBe(true);
    await settle();
    expect(text()).toContain(ACCESS_ERROR_LINE);
    expect(byId("jf-title")).toBeUndefined();
    expect(job).not.toHaveBeenCalled();
  });
});

describe("late answers", () => {
  it("a job event during Reload does not drop the Reload answer", async () => {
    await open();
    type("jf-command", "typed by hand");
    updateJob.mockRejectedValueOnce(stale());
    await submit();
    let answer!: (v: unknown) => void;
    job.mockReturnValueOnce(new Promise((r) => (answer = r))).mockResolvedValue(RENAMED);
    els().find((e) => (e.attrs.class ?? "").includes("jf-reload"))!.dispatch("click");
    await onJobFormEvent();
    answer(RENAMED);
    await settle();
    expect(job).toHaveBeenCalledTimes(2);
    expect(text()).not.toContain(STALE_LINE);
    expect(byId("jf-title")!.value).toBe("Mail (renamed elsewhere)");
    expect(byId("jf-command")!.value).toBe("typed by hand");
  });

  it("a failed read from a form that was closed and opened again does not reach the new form", async () => {
    let fail!: (e: unknown) => void;
    job.mockReturnValueOnce(new Promise((_r, reject) => (fail = reject))).mockResolvedValue(JOB);
    const first = openJobForm("job-1", "#/jobs/job-1");
    await settle();
    closeJobForm();
    await open();
    fail(new ApiError(500, "boom"));
    await first;
    await settle();
    expect(text()).not.toContain("Could not load this job.");
    expect(byId("jf-title")!.value).toBe(JOB.title);
  });

  it("two job answers that resolve out of order on a clean form: the newer one wins", async () => {
    await open();
    let older!: (v: unknown) => void;
    job.mockReturnValueOnce(new Promise((r) => (older = r))).mockResolvedValueOnce({ ...RENAMED, revision: 6, title: "Newest" });
    const first = onJobFormEvent();
    await onJobFormEvent();
    older(RENAMED);
    await first;
    expect(byId("jf-title")!.value).toBe("Newest");
  });

  it("Back during the Discard dialog, then Discard: the form closes and the address stays where Back put it", async () => {
    await open();
    type("jf-command", "typed by hand");
    loc.hash = "#/jobs";
    confirmDialog.mockImplementation(async () => {
      // Back: the browser shows the previous entry, whose state is not the form's.
      hist.state = null;
      loc.hash = "#/agenda";
      return true;
    });
    expect(await leaveJobForm("#/jobs")).toBe(false);
    expect(drawer.children).toHaveLength(0);
    expect(loc.hash).toBe("#/agenda");
  });

  it("Discard without Back goes to the address the user asked for", async () => {
    await open();
    type("jf-command", "typed by hand");
    loc.hash = "#/jobs";
    confirmDialog.mockResolvedValue(true);
    expect(await leaveJobForm("#/jobs")).toBe(true);
    expect(loc.hash).toBe("#/jobs");
  });
});

describe("preview debounce", () => {
  afterEach(() => vi.useRealTimers());

  it("two schedule edits inside 500 ms make one preview call; an older answer after a newer one is dropped", async () => {
    await open();
    previewJob.mockClear();
    vi.useFakeTimers();
    type("jf-start", "01:00");
    await vi.advanceTimersByTimeAsync(200);
    type("jf-start", "02:00");
    await vi.advanceTimersByTimeAsync(499);
    expect(previewJob).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(previewJob).toHaveBeenCalledTimes(1);
    expect(previewJob.mock.calls[0]![0]).toMatchObject({ window: { start: "02:00" } });

    let older!: (v: unknown) => void;
    previewJob.mockReturnValueOnce(new Promise((r) => (older = r))).mockResolvedValueOnce({ ...PREVIEW, guarantee: "newer" });
    type("jf-start", "03:00");
    await vi.advanceTimersByTimeAsync(500);
    type("jf-start", "04:00");
    await vi.advanceTimersByTimeAsync(500);
    expect(previewJob).toHaveBeenCalledTimes(3);
    expect(text()).toContain("between 04:00 and 08:00");
    older({ ...PREVIEW, first_run: { ...PREVIEW.first_run, planned_at: "2030-01-01T00:00:00Z" } });
    await vi.advanceTimersByTimeAsync(0);
    expect(text()).toContain("between 04:00 and 08:00");
    expect(text()).not.toContain("1 Jan");
  });
});
