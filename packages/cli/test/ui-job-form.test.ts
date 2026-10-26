/** The page's job form model (jobs U9): validation, prefill round trip, update patches, secrets by name, the folder hint, refresh and reload after a stale revision. */

import { describe, expect, it } from "vitest";

import { firstRunText, formValues, inputOf, jobFormModel, patchOf, refreshForm, reloadForm, scheduleOf, validateJob } from "../ui/job-form.js";
import { installFakeDom } from "./fixtures/fake-dom.js";

installFakeDom();

const TZ = "Europe/Berlin";

const COMMAND_JOB = {
  job_id: "job-1",
  title: "Mail triage",
  status: "active",
  revision: 4,
  cadence: { kind: "weekly", days: ["mon", "thu"] },
  window: { start: "00:00", end: "08:00" },
  time_zone: TZ,
  runner: "command",
  command: "himalaya envelope list --output json",
  prompt: "Say which messages need a reply.",
  provider: "anthropic",
  model: "claude-sonnet-4-5",
  tools: "none",
  cwd: "~/mail",
  secrets: ["IMAP_PASSWORD"],
  missing_secrets: [],
  caps: { command_timeout_s: 120, llm_timeout_s: 900, max_budget_usd: 0.5, output_cap_bytes: 10485760 },
  notify: "failures",
  actions: { edit: true, pause: true, resume: false, run_now: true, remove: true },
};

const fresh = () => ({ ...formValues(null, { timeZone: TZ }), title: "Daily", prompt: "summarize" });

describe("validateJob", () => {
  it("a window with every N hours is refused", () => {
    expect(validateJob({ ...fresh(), cadence: "hours", every: "6", windowOn: true }).window).toBe("A window needs daily, weekdays or weekly");
  });
  it("weekly with no day asks for one", () => {
    expect(validateJob({ ...fresh(), cadence: "weekly", days: [] }).cadence).toBe("weekly: pick at least one day");
  });
  it("every N hours needs a whole N from 2 to 168", () => {
    for (const every of ["1", "169", "2.5", ""]) expect(validateJob({ ...fresh(), cadence: "hours", every }).cadence).toMatch(/whole N from 2 to 168/);
    expect(validateJob({ ...fresh(), cadence: "hours", every: "6" }).cadence).toBeUndefined();
  });
  it("a command job needs its command; a prompt job its prompt; a title always", () => {
    expect(validateJob({ ...fresh(), runner: "command", command: " " }).command).toBe("Enter the command to run");
    expect(validateJob({ ...fresh(), prompt: "" }).prompt).toBe("Enter the prompt");
    expect(validateJob({ ...fresh(), title: "" }).title).toBe("Give the job a title");
    expect(validateJob(fresh())).toEqual({});
  });
  it("a relative directory, a bad zone and a zero cap are refused", () => {
    expect(validateJob({ ...fresh(), cwd: "src" }).cwd).toBe("Use ~ or a full path");
    expect(validateJob({ ...fresh(), timeZone: "Mars/Base" }).timeZone).toMatch(/Unknown time zone/);
    expect(validateJob({ ...fresh(), budget: "0" }).caps).toBe("Each cap must be a positive number");
  });
});

describe("prefill and save bodies", () => {
  it("an edit prefill round-trips every field of a Job into a JobInput", () => {
    expect(inputOf(formValues(COMMAND_JOB))).toEqual({
      title: "Mail triage",
      cadence: { kind: "weekly", days: ["mon", "thu"] },
      window: { start: "00:00", end: "08:00" },
      time_zone: TZ,
      runner: "command",
      command: "himalaya envelope list --output json",
      secrets: ["IMAP_PASSWORD"],
      cwd: "~/mail",
      prompt: "Say which messages need a reply.",
      provider: "anthropic",
      model: "claude-sonnet-4-5",
      caps: { command_timeout_s: 120, llm_timeout_s: 900, max_budget_usd: 0.5 },
      notify: "failures",
    });
  });

  it("an unchanged form sends only the revision; a changed window sends the window and the revision", () => {
    const v = formValues(COMMAND_JOB);
    expect(patchOf(v, v, 4)).toEqual({ revision: 4 });
    expect(patchOf({ ...v, end: "06:00" }, v, 4)).toEqual({ window: { start: "00:00", end: "06:00" }, revision: 4 });
    expect(patchOf({ ...v, windowOn: false }, v, 4)).toEqual({ window: null, revision: 4 });
  });

  it("a template change sends the whole template; clearing the summary clears its provider and model", () => {
    const v = formValues(COMMAND_JOB);
    expect(patchOf({ ...v, prompt: "" }, v, 4)).toEqual({
      runner: "command", command: COMMAND_JOB.command, secrets: ["IMAP_PASSWORD"], cwd: "~/mail", prompt: null, provider: null, model: null, revision: 4,
    });
    expect(patchOf({ ...v, runner: "prompt" }, v, 4)).toMatchObject({ runner: "prompt", prompt: COMMAND_JOB.prompt, tools: "none", revision: 4 });
  });

  it("a new prompt job leaves out empty optional fields and carries the default caps", () => {
    expect(inputOf(fresh())).toEqual({
      title: "Daily", cadence: { kind: "daily" }, time_zone: TZ, runner: "prompt", prompt: "summarize", provider: "claude-code", tools: "none", cwd: "~",
      caps: { command_timeout_s: 300, llm_timeout_s: 600, max_budget_usd: 1 }, notify: "every_run",
    });
    expect(scheduleOf({ ...fresh(), cadence: "weekly", days: ["thu", "mon"] }).cadence).toEqual({ kind: "weekly", days: ["mon", "thu"] });
  });
});

describe("jobFormModel", () => {
  it("offers only secret names from the secrets file, and warns about a chosen one the file lacks", () => {
    const m = jobFormModel(COMMAND_JOB, ["IMAP_PASSWORD", "API_KEY"]);
    expect(m.offered).toEqual(["API_KEY"]);
    expect(m.missing).toEqual([]);
    const gone = jobFormModel(COMMAND_JOB, ["API_KEY"]);
    expect(gone.offered).toEqual(["API_KEY"]);
    expect(gone.missing).toEqual(["IMAP_PASSWORD"]);
    expect(jobFormModel(null, []).noSecrets).toBe(true);
  });

  it("a directory under ~/Documents raises the Files & Folders hint", () => {
    const v = formValues(COMMAND_JOB);
    expect(jobFormModel(COMMAND_JOB, [], { ...v, cwd: "~/Documents/mail" }).folderHint).toBe(true);
    expect(jobFormModel(COMMAND_JOB, [], { ...v, cwd: "/Users/someone/Downloads" }).folderHint).toBe(true);
    expect(jobFormModel(COMMAND_JOB, [], { ...v, cwd: "~/DocumentsX" }).folderHint).toBe(false);
    expect(jobFormModel(COMMAND_JOB, [], v).folderHint).toBe(false);
  });

  it("dirty follows the typed values; a schedule error blocks the preview", () => {
    const v = formValues(COMMAND_JOB);
    expect(jobFormModel(COMMAND_JOB, [], v).dirty).toBe(false);
    expect(jobFormModel(COMMAND_JOB, [], { ...v, title: "Mail" }).dirty).toBe(true);
    expect(jobFormModel(COMMAND_JOB, [], { ...v, days: [] }).scheduleValid).toBe(false);
    expect(jobFormModel(COMMAND_JOB, [], { ...v, command: "" }).scheduleValid).toBe(true);
  });
});

describe("refresh and reload", () => {
  const changed = { ...COMMAND_JOB, revision: 5, title: "Mail (renamed elsewhere)" };

  it("a refresh while the form is dirty keeps the typed values and the old revision", () => {
    const original = formValues(COMMAND_JOB);
    const form = { job: COMMAND_JOB, original, values: { ...original, command: "typed by hand" } };
    const next = refreshForm(form, changed);
    expect(next).toBe(form);
    expect(next.values.command).toBe("typed by hand");
    expect(next.job.revision).toBe(4);
  });

  it("a refresh of a clean form follows the fresh job", () => {
    const original = formValues(COMMAND_JOB);
    const next = refreshForm({ job: COMMAND_JOB, original, values: { ...original } }, changed);
    expect(next.values.title).toBe("Mail (renamed elsewhere)");
    expect(next.job.revision).toBe(5);
  });

  it("Reload after a stale revision takes the new revision, keeps the typed fields and lets the others follow the fresh job", () => {
    const original = formValues(COMMAND_JOB);
    const typed = { ...original, command: "typed by hand" };
    const next = reloadForm({ job: COMMAND_JOB, original, values: typed, stale: true, error: "This job changed while you edited it." }, changed);
    expect(next.values.command).toBe("typed by hand");
    expect(next.values.title).toBe("Mail (renamed elsewhere)");
    expect(next.job.revision).toBe(5);
    expect(next.stale).toBe(false);
    const patch = patchOf(next.values, next.original, next.job.revision);
    expect(patch).toMatchObject({ command: "typed by hand", revision: 5 });
    expect(patch).not.toHaveProperty("title");
  });
});

describe("firstRunText", () => {
  const v = { ...fresh(), windowOn: true };
  it("names the planned hour and its intensity, or says the hour is picked later", () => {
    expect(firstRunText({ first_run: { earliest: "x", deadline: "y", planned_at: new Date(Date.now() + 86_400_000 * 2).toISOString(), intensity_g_per_kwh: 41.4 } }, v)).toMatch(/, 41 g CO2\/kWh$/);
    expect(firstRunText({ first_run: { earliest: "x", deadline: "y", planned_at: null, intensity_g_per_kwh: null } }, v)).toBe(
      "between 00:00 and 08:00; the hour is picked when the forecast covers it",
    );
  });
});
