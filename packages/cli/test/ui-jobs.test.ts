/** The page's Jobs view (jobs U9): row order and buttons, every row state's status line, the daemon banner, job times in the job's zone, deep links, rendering as text. */

import { describe, expect, it } from "vitest";

import { parseFragment } from "../ui/api.js";
import { DAEMON_LINE, jobButtons, jobsModel, jobsState, jobStatusLine, jobTime, renderJobs, runLine } from "../ui/jobs.js";
import { badges } from "../ui/row.js";
import { state } from "../ui/state.js";
import { FakeElement, installFakeDom, textOf, walk } from "./fixtures/fake-dom.js";

installFakeDom();

const TZ = "Europe/Berlin";
const NOW = Date.parse("2026-10-22T10:00:00Z"); // Thu 12:00 in Berlin
const opts = { now: NOW, viewerTz: TZ };
const at = (iso: string) => new Date(iso).toISOString();

const ACTIVE = { edit: true, pause: true, resume: false, run_now: true, remove: true };
const PAUSED = { edit: true, pause: false, resume: true, run_now: false, remove: true };

function job(over: Record<string, unknown> = {}): Record<string, any> {
  return {
    job_id: "job-1",
    title: "Mail triage",
    status: "active",
    revision: 3,
    cadence: { kind: "daily" },
    window: { start: "00:00", end: "08:00" },
    time_zone: TZ,
    guarantee: "runs every day between 00:00 and 08:00",
    runner: "prompt",
    prompt: "check mail",
    secrets: [],
    missing_secrets: [],
    next_run: {
      task_id: "job-1~4",
      status: "scheduled",
      earliest: at("2026-10-22T22:00:00Z"),
      deadline: at("2026-10-23T06:00:00Z"),
      scheduled_for: at("2026-10-23T00:00:00Z"),
      intensity_g_per_kwh: 41,
      via_batch: false,
    },
    last_run: { task_id: "job-1~3", outcome: "ok", started_at: at("2026-10-22T01:10:00Z"), completed_at: at("2026-10-22T01:12:00Z"), preview: "3 messages need a reply" },
    consecutive_failures: 0,
    pause_reason: null,
    actions: ACTIVE,
    ...over,
  };
}

describe("jobTime", () => {
  it("shows the job's zone: today as HH:MM, tomorrow, a weekday within a week, else the date", () => {
    expect(jobTime(at("2026-10-22T01:12:00Z"), TZ, opts)).toBe("03:12");
    expect(jobTime(at("2026-10-23T00:00:00Z"), TZ, opts)).toBe("tomorrow 02:00");
    expect(jobTime(at("2026-10-24T00:00:00Z"), TZ, opts)).toBe("Sat 02:00");
    expect(jobTime(at("2026-11-05T09:00:00Z"), TZ, opts)).toBe("5 Nov 10:00");
  });

  it("adds the zone's abbreviation only when its offset differs from the viewer's", () => {
    expect(jobTime(at("2026-10-22T13:00:00Z"), "America/New_York", opts)).toMatch(/^09:00 (EDT|GMT-4)$/);
    expect(jobTime(at("2026-10-22T13:00:00Z"), "Europe/Paris", opts)).toBe("15:00");
  });
});

describe("row states", () => {
  const line = (over: Record<string, unknown>) => jobStatusLine(job(over), opts);

  it("ok: last result, then the planned hour with its intensity", () => {
    expect(line({})).toBe("last: ok, 03:12 · next tomorrow 02:00 (41 g)");
  });

  const failed = { outcome: "failed", started_at: at("2026-10-22T00:00:00Z"), completed_at: at("2026-10-22T00:00:30Z") };

  it("a failure with its retry planned (core's `~<seq>r` occurrence; the count is unchanged): the retry before the window ends", () => {
    expect(line({ last_run: failed, consecutive_failures: 0, next_run: { ...job().next_run, task_id: "job-1~4r", scheduled_for: at("2026-10-22T10:30:00Z"), deadline: at("2026-10-22T12:00:00Z") } })).toBe(
      "last: failed 02:00 · retry planned 12:30, before 14:00",
    );
  });

  it("failing while active after the retry failed too: the count of three, then a regular next run", () => {
    expect(line({ last_run: failed, consecutive_failures: 1, next_run: { ...job().next_run, task_id: "job-1~5" } })).toBe("last: failed 02:00 (1 of 3) · next tomorrow 02:00 (41 g)");
  });

  it("running: one line, no last result", () => {
    expect(line({ next_run: { ...job().next_run, status: "running" } })).toBe("running now");
  });

  it("overdue: a planned hour long past says the machine was off or asleep", () => {
    expect(line({ next_run: { ...job().next_run, scheduled_for: at("2026-10-22T08:00:00Z") } })).toBe("last: ok, 03:12 · waiting to run - the machine was off or asleep");
  });

  it("unplanned: the window, and that the hour is picked when the forecast covers it", () => {
    expect(line({ last_run: null, next_run: { ...job().next_run, scheduled_for: null } })).toBe("next: between 00:00 and 08:00, hour picked when the forecast covers it");
  });

  it("via Batch: the deadline and Batch", () => {
    expect(line({ last_run: null, next_run: { ...job().next_run, via_batch: true } })).toBe("next: by tomorrow 08:00 via Batch");
  });

  it("run-anchored (every N hours): '~' and the latest time, not a planned hour", () => {
    expect(line({ cadence: { kind: "hours", every: 24 }, window: null, last_run: null })).toBe("next ~tomorrow 08:00");
  });

  it("paused by hand, and paused after three failures with the reason", () => {
    expect(line({ status: "paused", pause_reason: "manual", next_run: null, actions: PAUSED })).toBe("paused");
    expect(line({ status: "paused", pause_reason: "auto: ssh: connect timed out", consecutive_failures: 3, next_run: null, actions: PAUSED })).toBe(
      "paused after 3 failures: ssh: connect timed out",
    );
  });

  it("a new job with nothing planned yet", () => {
    expect(line({ last_run: null, next_run: null })).toBe("waiting for its first run");
  });
});

describe("jobsModel", () => {
  it("orders active before paused, then by next run; a paused job shows Resume and Remove", () => {
    const later = job({ job_id: "job-b", title: "B", next_run: { ...job().next_run, scheduled_for: at("2026-10-24T00:00:00Z") } });
    const sooner = job({ job_id: "job-a", title: "A" });
    const paused = job({ job_id: "job-p", title: "P", status: "paused", pause_reason: "auto: boom", consecutive_failures: 3, next_run: null, actions: PAUSED });
    const m = jobsModel([paused, later, sooner], null, opts);
    expect(m.rows.map((r) => r.id)).toEqual(["job-a", "job-b", "job-p"]);
    expect(m.rows[2]!.buttons).toEqual(["resume", "edit", "history", "remove"]);
    expect(m.rows[2]!.line).toBe("paused after 3 failures: boom");
    expect(m.rows[0]!.buttons).toEqual(["pause", "run-now", "edit", "history"]);
  });

  it("a running job hides Run now (the server's run_now flag)", () => {
    const running = job({ next_run: { ...job().next_run, status: "running" }, actions: { ...ACTIVE, run_now: false } });
    expect(jobButtons(running)).toEqual(["pause", "edit", "history"]);
    expect(jobsModel([running], null, opts).rows[0]!.running).toBe(true);
  });

  it("an extension caller (edit and remove false) gets no Edit or Remove", () => {
    expect(jobButtons(job({ status: "paused", actions: { edit: false, pause: false, resume: true, run_now: false, remove: false } }))).toEqual(["resume", "history"]);
  });

  it("the daemon banner shows for a ticker readiness problem only", () => {
    const down = { ready: false, problems: [{ code: "no_daemon" }] };
    expect(jobsModel([], down, opts).banner).toBe(DAEMON_LINE);
    expect(jobsModel([], { ready: false, problems: [{ code: "no_runner" }] }, opts).banner).toBeNull();
    expect(jobsModel([], { ready: true, problems: [] }, opts).banner).toBeNull();
    expect(jobsModel([], null, opts).empty).toBe(true);
  });
});

describe("renderJobs", () => {
  const render = () => {
    const root = new FakeElement("div");
    renderJobs(root as never);
    return root;
  };

  it("loading, empty with New job for an author, and a list rendered as text", () => {
    Object.assign(jobsState, { loaded: false, error: null, jobs: [], canAuthor: true });
    state.status = null;
    expect(walk([render()]).els.some((e) => (e.attrs.class ?? "").includes("row-skeleton"))).toBe(true);

    jobsState.loaded = true;
    let root = render();
    expect(textOf(root)).toContain("No jobs yet.");
    expect(walk([root]).els.some((e) => e.attrs.href === "#/jobs/new")).toBe(true);

    jobsState.jobs = [job({ title: "<img src=x onerror=alert(1)>", last_run: { ...job().last_run, preview: "<b>hi</b>" } })];
    root = render();
    const out = walk([root]);
    expect(out.els.map((e) => e.tagName)).not.toContain("img");
    expect(out.text).toContain("<img src=x onerror=alert(1)>");
    expect(out.els.some((e) => e.attrs["data-action"] === "job-pause")).toBe(true);
    expect(out.els.some((e) => e.attrs.href === "#/jobs/job-1/history")).toBe(true);
  });

  it("a read-only caller sees no New job button", () => {
    Object.assign(jobsState, { loaded: true, error: null, jobs: [], canAuthor: false });
    expect(walk([render()]).els.some((e) => e.attrs.href === "#/jobs/new")).toBe(false);
  });
});

describe("history and badges", () => {
  it("a run line: when, outcome, grams, receipt id and the quoted text", () => {
    expect(runLine({ task_id: "job-1~3", status: "completed", completed_at: at("2026-10-22T01:12:00Z"), receipt_id: "job-1~3", carbon_g: 0.41, via_batch: false, preview: "ok", error: null }, TZ, opts)).toEqual({
      when: "03:12", word: "ok", tone: "completed", carbon: "0.41 g", receipt: "job-1~3", text: "ok",
    });
    expect(runLine({ task_id: "job-1~2", status: "failed", completed_at: at("2026-10-21T00:00:00Z"), receipt_id: null, carbon_g: null, via_batch: false, preview: null, error: "ssh: connect timed out" }, TZ, opts)).toMatchObject({
      word: "failed", carbon: "", receipt: null, text: "ssh: connect timed out",
    });
  });

  it("a run's Agenda row carries a job badge that links to the job", () => {
    const [badge] = badges({ task_id: "job-1~4", job_id: "job-1", job_title: "Mail triage" }) as unknown as FakeElement[];
    expect(badge!.attrs.href).toBe("#/jobs/job-1");
    expect(textOf(badge!)).toContain("Mail triage");
    expect(badges({ task_id: "t-1" })).toEqual([]);
  });
});

describe("job deep links (the Mac app's &view=)", () => {
  it("opens the Jobs view", () => {
    expect(parseFragment("#token=abc&view=jobs")).toEqual({ token: "abc", view: "jobs" });
  });
  it("opens the new-job form", () => {
    expect(parseFragment("#token=abc&view=jobs/new")).toEqual({ token: "abc", view: "jobs/new" });
  });
  it("opens one job's form; an id outside the charset opens the Agenda", () => {
    expect(parseFragment("#token=abc&view=jobs/job-3f9a1c2e")).toEqual({ token: "abc", view: "jobs/job-3f9a1c2e" });
    expect(parseFragment("#token=abc&view=jobs/a_b~1-C")).toEqual({ token: "abc", view: "jobs/a_b~1-C" });
    expect(parseFragment("#token=abc&view=jobs/../x")).toEqual({ token: "abc", view: "agenda" });
    expect(parseFragment("#token=abc&view=jobs/x%2Fy")).toEqual({ token: "abc", view: "agenda" });
  });
});
