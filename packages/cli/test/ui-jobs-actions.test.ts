/** The Jobs view's controller (jobs U9): row actions with rollback, remove, the list's stale-answer guard, the author probe, history page merge. API, toasts and the confirm dialog are stubbed. */

import { beforeEach, describe, expect, it, vi } from "vitest";

const jobAction = vi.fn();
const jobs = vi.fn();
const jobSecrets = vi.fn();
const toast = vi.fn();
const errorToast = vi.fn();
const confirmDialog = vi.fn();

vi.mock("../ui/api.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../ui/api.js")>()),
  api: {
    jobAction: (...a: unknown[]) => jobAction(...a),
    jobs: (...a: unknown[]) => jobs(...a),
    jobSecrets: (...a: unknown[]) => jobSecrets(...a),
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

import { ApiError } from "../ui/api.js";
import { jobAction as act, jobsState, loadJobs, mergeRuns, probeAuthor, removeJob } from "../ui/jobs.js";
import { installFakeDom } from "./fixtures/fake-dom.js";

installFakeDom();

const ACTIVE = { edit: true, pause: true, resume: false, run_now: true, remove: true };
const job = (over: Record<string, unknown> = {}) => ({ job_id: "job-1", title: "Mail triage", status: "active", revision: 3, next_run: null, last_run: null, actions: ACTIVE, ...over });
const settle = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  for (const f of [jobAction, jobs, jobSecrets, toast, errorToast, confirmDialog]) f.mockReset();
  jobs.mockResolvedValue({ jobs: [job()] });
  Object.assign(jobsState, { loaded: true, error: null, jobs: [job()], canAuthor: true, secretNames: [], ops: new Map() });
});

describe("row actions", () => {
  it("Pause shows at once; the server's answer replaces the row and a toast confirms", async () => {
    let answer!: (j: unknown) => void;
    jobAction.mockReturnValue(new Promise((r) => (answer = r)));
    const done = act("pause", "job-1");
    expect(jobsState.jobs[0]).toMatchObject({ status: "paused", actions: { pause: false, resume: true } });
    expect(jobsState.ops.get("job-1")).toBe("Pausing…");
    answer(job({ status: "paused", revision: 4 }));
    await done;
    expect(jobsState.ops.size).toBe(0);
    expect(jobsState.jobs[0]).toMatchObject({ status: "paused", revision: 4 });
    expect(toast).toHaveBeenCalledWith("Paused “Mail triage”");
  });

  it("a refusal (409) restores the row, shows the server's sentence and reloads the list", async () => {
    jobAction.mockRejectedValue(new ApiError(409, "job is already paused"));
    await act("pause", "job-1");
    expect(jobsState.jobs[0]).toEqual(job());
    expect(jobsState.ops.size).toBe(0);
    expect(errorToast).toHaveBeenCalledWith("Pause failed: job is already paused");
    expect(jobs).toHaveBeenCalledTimes(1);
  });

  it("a 500 shows a fixed sentence, a network error says nothing changed", async () => {
    jobAction.mockRejectedValueOnce(new ApiError(500, "SQLITE_BUSY at /x")).mockRejectedValueOnce(new TypeError("fetch failed"));
    await act("run-now", "job-1");
    expect(errorToast).toHaveBeenLastCalledWith("Run now failed: the server could not apply it; nothing changed.");
    await act("resume", "job-1");
    expect(errorToast).toHaveBeenLastCalledWith("Resume failed: Network error; nothing changed.");
  });

  it("a second press while the first is in flight sends nothing", async () => {
    jobAction.mockReturnValue(new Promise(() => {}));
    void act("pause", "job-1");
    await act("pause", "job-1");
    expect(jobAction).toHaveBeenCalledTimes(1);
  });
});

describe("remove", () => {
  it("a declined confirm sends nothing", async () => {
    confirmDialog.mockResolvedValue(false);
    expect(await removeJob("job-1")).toBe(false);
    expect(jobAction).not.toHaveBeenCalled();
  });

  it("removes the row and names the job; the form's title wins over the list", async () => {
    confirmDialog.mockResolvedValue(true);
    jobAction.mockResolvedValue({ job_id: "job-1", status: "removed" });
    expect(await removeJob("job-1", "Mail (form)")).toBe(true);
    expect(jobsState.jobs).toEqual([]);
    expect(toast).toHaveBeenCalledWith("Removed “Mail (form)”");
  });

  it("a failure shows the sentence and reloads the list", async () => {
    confirmDialog.mockResolvedValue(true);
    jobAction.mockRejectedValue(new ApiError(404, "job not found"));
    expect(await removeJob("job-1")).toBe(false);
    expect(errorToast).toHaveBeenCalledWith("Remove failed: job not found");
    expect(jobs).toHaveBeenCalledTimes(1);
  });
});

describe("list and author probe", () => {
  it("an older list answer that lands after a newer one is dropped", async () => {
    let first!: (v: unknown) => void;
    jobs.mockReturnValueOnce(new Promise((r) => (first = r))).mockResolvedValueOnce({ jobs: [job({ revision: 9 })] });
    const a = loadJobs();
    await loadJobs();
    first({ jobs: [job({ revision: 1 })] });
    await a;
    expect(jobsState.jobs[0]!.revision).toBe(9);
  });

  it("a list answer that started before a row action finished does not undo the action's row", async () => {
    let old!: (v: unknown) => void;
    jobs.mockReturnValueOnce(new Promise((r) => (old = r)));
    const loading = loadJobs();
    jobAction.mockResolvedValue(job({ status: "paused", revision: 4 }));
    await act("pause", "job-1");
    old({ jobs: [job({ revision: 3 })] });
    await loading;
    expect(jobsState.jobs[0]).toMatchObject({ status: "paused", revision: 4 });
  });

  it("a list answer that started before a remove does not bring the job back", async () => {
    let old!: (v: unknown) => void;
    jobs.mockReturnValueOnce(new Promise((r) => (old = r)));
    const loading = loadJobs();
    confirmDialog.mockResolvedValue(true);
    jobAction.mockResolvedValue({ job_id: "job-1", status: "removed" });
    expect(await removeJob("job-1")).toBe(true);
    old({ jobs: [job()] });
    await loading;
    expect(jobsState.jobs).toEqual([]);
  });

  it("403 on the secrets route means read-only; any other failure asks again later", async () => {
    jobSecrets.mockRejectedValueOnce(new ApiError(403, "forbidden")).mockRejectedValueOnce(new TypeError("fetch failed")).mockResolvedValueOnce({ names: ["IMAP_PASSWORD"] });
    expect(await probeAuthor()).toBe(false);
    expect(await probeAuthor()).toBeNull();
    expect(await probeAuthor()).toBe(true);
    expect(jobsState.secretNames).toEqual(["IMAP_PASSWORD"]);
    await settle();
  });
});

describe("history refresh", () => {
  const run = (n: number) => ({ task_id: `job-1~${n}` });
  const page = (from: number, to: number) => Array.from({ length: from - to + 1 }, (_, i) => run(from - i));

  it("keeps the older pages the user loaded below a refreshed first page", () => {
    // Loaded: runs 40..1 (two pages), cursor exhausted. A new run 41 arrives.
    const next = mergeRuns({ runs: page(40, 1), next: null }, { runs: page(41, 22), next_before: "c-22" });
    expect(next.runs.map((r) => r.task_id)).toEqual(page(41, 1).map((r) => r.task_id));
    expect(next.next).toBeNull();
  });

  it("an unchanged first page keeps its own cursor; a page that does not overlap replaces the list", () => {
    expect(mergeRuns({ runs: page(20, 1), next: "c-1" }, { runs: page(20, 1), next_before: "c-1" })).toEqual({ runs: page(20, 1), next: "c-1" });
    expect(mergeRuns({ runs: page(20, 1), next: "c-1" }, { runs: page(60, 41), next_before: "c-41" })).toEqual({ runs: page(60, 41), next: "c-41" });
  });
});
