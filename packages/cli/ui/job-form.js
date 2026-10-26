// Job create/edit form (jobs plan U9) in the shared drawer. The model is
// pure (`formValues`, `validateJob`, `inputOf`, `patchOf`, `jobFormModel`);
// the DOM part only renders it through `h()`. A refresh of the job list
// never rebuilds an open form: its values live here, not in the list.
// Before Save the form makes read calls only (the job, the secret names)
// plus the debounced schedule preview.
// Secrets show by name only; values are set with the CLI, never here.

import { api, ApiError, errorText } from "./api.js";
import { confirmDialog } from "./dialog.js";
import { h, swapChildren } from "./dom.js";
import { drawerHead, expire, hideDrawer, jobsState, jobTime, probeAuthor, removeJob, returnFocus, showDrawer, upsertJob, validZone, VIEWER_TZ } from "./jobs.js";
import { toast } from "./toast.js";

export const DAYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];
const DAY_LABEL = { mon: "Mon", tue: "Tue", wed: "Wed", thu: "Thu", fri: "Fri", sat: "Sat", sun: "Sun" };
export const PROVIDERS = ["claude-code", "anthropic", "openai", "gemini", "ollama"];
const TOOLS_LABEL = { none: "none", files: "read-only files", web: "web" };
const NOTIFY_LABEL = { every_run: "every run", failures: "failures only", summary: "summary only" };
const CADENCE_LABEL = { daily: "daily", weekdays: "weekdays", weekly: "weekly", hours: "every N hours" };
/** Server defaults (core DEFAULT_JOB_CAPS): 5 min command, 10 min LLM step, 1 USD. */
const DEFAULT_CAPS = { command_timeout_s: 300, llm_timeout_s: 600, max_budget_usd: 1 };
const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
/** Folders the macOS privacy prompt guards: a daemon there needs Files & Folders access. */
const GUARDED_DIR = /^(~|\/Users\/[^/]+)\/(Documents|Desktop|Downloads)(\/|$)/;
const PREVIEW_DEBOUNCE_MS = 500;

export const TRUST_NOTE =
  "The command runs on this computer as you, through /bin/sh, while nobody watches. Add only a command you trust. Secrets reach it as environment variables; their values never show here.";
export const DIR_HINT = "The daemon needs Files & Folders access for this folder (System Settings > Privacy).";
export const STALE_LINE = "This job changed while you edited it.";

// ── pure model ──────────────────────────────────────────────────────────

const differs = (a, b) => JSON.stringify(a) !== JSON.stringify(b);
const num = (n) => String(Number(n.toFixed(2)));

/** The form's values for `job`, or a new job's defaults. */
export function formValues(job, { timeZone = VIEWER_TZ } = {}) {
  if (!job) {
    return {
      title: "", cadence: "daily", days: [], every: "6", windowOn: false, start: "00:00", end: "08:00", timeZone,
      runner: "prompt", command: "", secrets: [], cwd: "~", prompt: "", provider: "claude-code", model: "", tools: "none",
      commandMin: num(DEFAULT_CAPS.command_timeout_s / 60), llmMin: num(DEFAULT_CAPS.llm_timeout_s / 60), budget: DEFAULT_CAPS.max_budget_usd.toFixed(2),
      notify: "every_run",
    };
  }
  const c = job.cadence || { kind: "daily" };
  const caps = { ...DEFAULT_CAPS, ...(job.caps || {}) };
  return {
    title: job.title || "",
    cadence: c.kind,
    days: c.kind === "weekly" ? [...(c.days || [])] : [],
    every: c.kind === "hours" ? String(c.every) : "6",
    windowOn: !!job.window,
    start: job.window?.start || "00:00",
    end: job.window?.end || "08:00",
    timeZone: job.time_zone || timeZone,
    runner: job.runner,
    command: job.command || "",
    secrets: [...(job.secrets || [])],
    cwd: job.cwd || "~",
    prompt: job.prompt || "",
    provider: job.provider || "claude-code",
    model: job.model || "",
    tools: job.tools || "none",
    commandMin: num(caps.command_timeout_s / 60),
    llmMin: num(caps.llm_timeout_s / 60),
    budget: Number(caps.max_budget_usd).toFixed(2),
    notify: job.notify || "every_run",
  };
}

const positive = (v) => {
  const n = Number(v);
  return String(v).trim() !== "" && Number.isFinite(n) && n > 0;
};

/** Field name -> message. Mirrors the server's rules, so Save stays off until they hold. */
export function validateJob(v) {
  const e = {};
  if (!v.title.trim()) e.title = "Give the job a title";
  if (v.cadence === "weekly" && v.days.length === 0) e.cadence = "weekly: pick at least one day";
  if (v.cadence === "hours") {
    const n = Number(v.every);
    if (!Number.isInteger(n) || n < 2 || n > 168) e.cadence = "every N hours needs a whole N from 2 to 168";
  }
  if (v.windowOn) {
    if (v.cadence === "hours") e.window = "A window needs daily, weekdays or weekly";
    else if (!HHMM.test(v.start) || !HHMM.test(v.end)) e.window = "Use HH:MM for both times";
    else if (v.start === v.end) e.window = "window start and end must differ";
  }
  if (!validZone(v.timeZone)) e.timeZone = "Unknown time zone; use an IANA name such as Europe/Berlin";
  if (v.runner === "command" && !v.command.trim()) e.command = "Enter the command to run";
  if (v.runner === "prompt" && !v.prompt.trim()) e.prompt = "Enter the prompt";
  const cwd = v.cwd.trim();
  if (cwd && !(cwd === "~" || cwd.startsWith("~/") || cwd.startsWith("/"))) e.cwd = "Use ~ or a full path";
  if (![v.commandMin, v.llmMin, v.budget].every(positive)) e.caps = "Each cap must be a positive number";
  return e;
}

/** The errors that block a preview (the schedule rows). */
export const SCHEDULE_FIELDS = ["cadence", "window", "timeZone"];

function cadenceOf(v) {
  if (v.cadence === "weekly") return { kind: "weekly", days: DAYS.filter((d) => v.days.includes(d)) };
  if (v.cadence === "hours") return { kind: "hours", every: Number(v.every) };
  return { kind: v.cadence };
}

/** The preview body: schedule fields only. */
export function scheduleOf(v) {
  return { cadence: cadenceOf(v), window: v.windowOn ? { start: v.start, end: v.end } : null, time_zone: v.timeZone };
}

/** The template keys of `v`'s runner; empty optional fields are null (cleared). */
function templateOf(v) {
  const cwd = v.cwd.trim() || "~";
  const model = v.model.trim() || null;
  if (v.runner === "prompt") return { runner: "prompt", prompt: v.prompt, provider: v.provider, model, tools: v.tools, cwd };
  const summary = v.prompt.trim() ? v.prompt : null;
  return {
    runner: "command",
    command: v.command,
    secrets: [...v.secrets],
    cwd,
    prompt: summary,
    provider: summary ? v.provider : null,
    model: summary ? model : null,
  };
}

/** A full `JobInput` for create. Null optional fields are left out. */
export function inputOf(v) {
  const out = {
    title: v.title.trim(),
    ...scheduleOf(v),
    ...templateOf(v),
    caps: { command_timeout_s: Math.round(Number(v.commandMin) * 60), llm_timeout_s: Math.round(Number(v.llmMin) * 60), max_budget_usd: Number(v.budget) },
    notify: v.notify,
  };
  for (const k of Object.keys(out)) if (out[k] === null) delete out[k];
  return out;
}

const TEMPLATE_KEYS = ["runner", "prompt", "command", "provider", "model", "tools", "cwd", "secrets"];

/**
 * An update: only the keys that changed against `original`, plus
 * `revision`. A template change sends the whole template of the runner
 * (a runner switch starts the server's template from the keys given).
 */
export function patchOf(v, original, revision) {
  const next = { title: v.title.trim(), ...scheduleOf(v), caps: inputOf(v).caps, notify: v.notify };
  const prev = { title: original.title.trim(), ...scheduleOf(original), caps: inputOf(original).caps, notify: original.notify };
  const out = {};
  for (const k of Object.keys(next)) if (differs(next[k], prev[k])) out[k] = next[k];
  const t = templateOf(v);
  const was = templateOf(original);
  if (TEMPLATE_KEYS.some((k) => differs(t[k], was[k]))) Object.assign(out, t);
  return { ...out, revision };
}

/** True when `cwd` sits in a folder the macOS privacy prompt guards. */
export function needsFolderAccess(cwd) {
  return GUARDED_DIR.test(cwd.trim());
}

/**
 * The form's view-model: values, errors, whether Save may run, the secrets
 * the picker offers (names from the secrets file only, not yet chosen) and
 * the chosen ones the file lacks.
 */
export function jobFormModel(job, secretNames, values = formValues(job), original = formValues(job)) {
  const names = [...(secretNames || [])];
  const errors = validateJob(values);
  return {
    editing: !!job,
    jobId: job?.job_id ?? null,
    revision: job?.revision ?? null,
    values,
    errors,
    valid: Object.keys(errors).length === 0,
    scheduleValid: !SCHEDULE_FIELDS.some((f) => errors[f]),
    dirty: differs(values, original),
    offered: names.filter((n) => !values.secrets.includes(n)),
    missing: values.secrets.filter((n) => !names.includes(n)),
    noSecrets: names.length === 0,
    folderHint: needsFolderAccess(values.cwd),
  };
}

/**
 * A job event while the form is open: a clean form follows the fresh job;
 * a dirty one keeps the typed values and the old revision (Save then gets
 * 409 and offers Reload).
 */
export function refreshForm(form, fresh) {
  if (differs(form.values, form.original)) return form;
  const values = formValues(fresh);
  return { ...form, job: fresh, original: values, values: { ...values } };
}

/**
 * Reload after a 409: the fresh revision and baseline. Fields the user
 * changed keep the typed value; every other field takes the fresh job's
 * value, so Save does not send back what another writer changed.
 */
export function reloadForm(form, fresh) {
  const original = formValues(fresh);
  const values = {};
  for (const k of Object.keys(original)) values[k] = differs(form.values[k], form.original[k]) ? form.values[k] : original[k];
  return { ...form, job: fresh, original, values, stale: false, error: null };
}

/** "First run" text from a preview answer. */
export function firstRunText(preview, v) {
  const fr = preview?.first_run;
  if (!fr) return "";
  if (fr.planned_at) {
    const g = fr.intensity_g_per_kwh;
    return `${jobTime(fr.planned_at, v.timeZone)}${typeof g === "number" ? `, ${Math.round(g)} g CO2/kWh` : ""}`;
  }
  return v.windowOn
    ? `between ${v.start} and ${v.end}; the hour is picked when the forecast covers it`
    : `by ${jobTime(fr.deadline, v.timeZone)}; the hour is picked when the forecast covers it`;
}

/** The toast after Save: the saved job's planned hour, else its latest time. */
export function savedText(job) {
  const n = job.next_run;
  const at = n ? jobTime(n.scheduled_for || n.deadline, job.time_zone) : "";
  return at ? `Job saved. First run ${at}` : "Job saved.";
}

// ── controller ──────────────────────────────────────────────────────────

const form = {
  open: false,
  hash: null,
  job: null,
  loading: false,
  loadError: null,
  values: null,
  original: null,
  /** {state: "idle" | "loading" | "ok" | "error", answer?, text?, key?} */
  preview: { state: "idle" },
  previewSeq: 0,
  previewTimer: null,
  saving: false,
  error: null,
  stale: false,
  pick: "",
};

function model() {
  return jobFormModel(form.job, jobsState.secretNames, form.values, form.original);
}

export function jobFormOpen() {
  return form.open;
}

/** The route the form was opened on (`#/jobs/new` or `#/jobs/<id>`). */
export function jobFormHash() {
  return form.hash;
}

/**
 * Open the form for `id` (null: a new job). Resolves false when this caller
 * may not author jobs (an extension token): the caller shows History instead.
 */
export async function openJobForm(id, hash) {
  if (form.open && form.hash === hash) return true;
  closeJobForm();
  Object.assign(form, {
    open: true, hash, job: null, loading: !!id, loadError: null, values: formValues(null), original: formValues(null),
    preview: { state: "idle" }, saving: false, error: null, stale: false, pick: "",
  });
  render();
  if (!id) focusTitle();
  const author = jobsState.canAuthor === null ? await probeAuthor() : jobsState.canAuthor;
  if (form.hash !== hash) return true;
  if (author === false) {
    closeJobForm();
    return false;
  }
  if (id) {
    try {
      const job = await api.job(id);
      if (form.hash !== hash) return true;
      const values = formValues(job);
      Object.assign(form, { job, values: { ...values }, original: values, loading: false });
    } catch (err) {
      if (form.hash !== hash || expire(err)) return true;
      Object.assign(form, { loading: false, loadError: err });
    }
  }
  render();
  if (id) focusTitle();
  schedulePreview(0);
  return true;
}

/** Focus the title field (the drawer's heading when the job did not load). */
function focusTitle() {
  requestAnimationFrame(() => (document.querySelector("#drawer #jf-title") || document.querySelector("#drawer #drawer-title"))?.focus());
}

export function closeJobForm() {
  if (!form.open) return;
  clearTimeout(form.previewTimer);
  form.previewSeq++;
  const opener = form.hash;
  form.open = false;
  form.hash = null;
  hideDrawer("job-form");
  returnFocus(opener);
}

/**
 * Leave the form for `target` (a route change, Esc, × or Cancel). A dirty
 * form asks first; on "Keep" the address goes back to the form's route.
 * Resolves true when the form is closed.
 */
export async function leaveJobForm(target) {
  if (!form.open) return true;
  if (form.saving) {
    // The form stays open until Save answers: put its route back in the
    // address, so a later Esc, x or Cancel changes the hash again.
    history.replaceState(null, "", form.hash);
    return false;
  }
  if (!model().dirty) {
    closeJobForm();
    return true;
  }
  const back = form.hash;
  history.replaceState(null, "", back);
  const ok = await confirmDialog({ heading: "Discard changes?", body: "The changes you typed in this job are lost.", confirm: "Discard", danger: true });
  if (!ok || form.hash !== back) return false;
  closeJobForm();
  history.replaceState(null, "", target);
  return true;
}

/** A job event: an open edit form follows the fresh job only while it is clean. */
export async function onJobFormEvent() {
  if (!form.open || !form.job || form.saving) return;
  const hash = form.hash;
  try {
    const fresh = await api.job(form.job.job_id);
    if (form.hash !== hash) return;
    const next = refreshForm(form, fresh);
    if (next !== form) {
      // Inputs hold their text in the value property, which the drawer's
      // equality check does not see: rebuild them when a value changed.
      const changed = differs(next.values, form.values);
      Object.assign(form, next);
      render({ rebuild: changed });
      schedulePreview();
    }
  } catch {
    // The list shows the trouble; the form keeps what it has.
  }
}

function set(key, value, { structural = false } = {}) {
  form.values = { ...form.values, [key]: value };
  form.error = null;
  if (structural) render();
  else update();
  if (["cadence", "days", "every", "windowOn", "start", "end", "timeZone"].includes(key)) schedulePreview();
}

function schedulePreview(delay = PREVIEW_DEBOUNCE_MS) {
  const m = model();
  if (!m.scheduleValid) {
    clearTimeout(form.previewTimer);
    form.previewSeq++;
    form.preview = { state: "idle" };
    return update();
  }
  const body = scheduleOf(form.values);
  const key = JSON.stringify(body);
  // The same schedule: keep the answer, or the call already waiting for it.
  if (form.preview.key === key && (form.preview.state === "ok" || form.preview.state === "loading")) return;
  clearTimeout(form.previewTimer);
  form.preview = { state: "loading", key };
  update();
  const mine = ++form.previewSeq;
  form.previewTimer = setTimeout(async () => {
    try {
      const answer = await api.previewJob(body);
      if (mine !== form.previewSeq) return;
      form.preview = { state: "ok", key, answer };
    } catch (err) {
      if (mine !== form.previewSeq || expire(err)) return;
      form.preview = { state: "error", key, text: errorText(err) };
    }
    update();
  }, delay);
}

async function save() {
  const m = model();
  if (!canSave(m)) return;
  // The fieldset is disabled while saving, so the focused field loses
  // focus; give it back if the save fails.
  const focusId = document.activeElement?.id;
  form.saving = true;
  form.error = null;
  render();
  try {
    const job = m.editing
      ? await api.updateJob(m.jobId, patchOf(form.values, form.original, m.revision))
      : await api.createJob(inputOf(form.values));
    closeJobForm();
    upsertJob(job);
    location.hash = "#/jobs";
    toast(savedText(job));
  } catch (err) {
    form.saving = false;
    if (expire(err)) return;
    if (err instanceof ApiError && err.status === 409 && err.code === "stale_revision") {
      form.stale = true;
      form.error = STALE_LINE;
    } else {
      form.error = errorText(err);
    }
    render();
    if (focusId) document.getElementById(focusId)?.focus({ preventScroll: true });
  }
}

async function reload() {
  if (!form.job) return;
  const hash = form.hash;
  try {
    const fresh = await api.job(form.job.job_id);
    if (form.hash !== hash) return;
    Object.assign(form, reloadForm(form, fresh));
  } catch (err) {
    if (form.hash !== hash || expire(err)) return;
    form.error = `Could not reload: ${errorText(err)}`;
  }
  render();
}

async function remove() {
  const id = form.job?.job_id;
  if (!id) return;
  if (!(await removeJob(id, form.job.title)) || form.job?.job_id !== id) return;
  closeJobForm();
  location.hash = "#/jobs";
}

function canSave(m) {
  return m.valid && !form.saving && !form.loading && !form.loadError && form.preview.state === "ok" && (!m.editing || m.dirty);
}

// ── render ──────────────────────────────────────────────────────────────

const err = (m, field) => h("p", { class: "jf-error", id: `jf-err-${field}`, role: m.errors[field] ? "alert" : undefined }, m.errors[field] || "");

function row(label, forId, ...body) {
  return h("div", { class: "jf-row" },
    forId ? h("label", { class: "jf-label", for: forId }, label) : h("span", { class: "jf-label" }, label),
    h("div", { class: "jf-body" }, body));
}

function radio(name, value, current, label, onPick) {
  return h("label", { class: "jf-choice" },
    h("input", { type: "radio", id: `${name}-${value}`, name, value, checked: value === current, onchange: () => onPick(value) }), label);
}

function text(id, key, v, attrs = {}) {
  const input = h(attrs.multiline ? "textarea" : "input", {
    id,
    class: ["input", attrs.multiline && "jf-textarea", attrs.mono && "jf-mono"],
    ...(attrs.multiline ? { rows: "3" } : { type: attrs.type || "text" }),
    placeholder: attrs.placeholder,
    autocomplete: "off",
    spellcheck: attrs.mono ? "false" : undefined,
    "aria-describedby": attrs.describedBy,
    inputmode: attrs.inputmode,
  });
  input.value = v[key];
  input.addEventListener("input", () => set(key, input.value));
  return input;
}

function zoneSelect(v) {
  const zones = typeof Intl.supportedValuesOf === "function" ? Intl.supportedValuesOf("timeZone") : [];
  const all = zones.includes(v.timeZone) ? zones : [v.timeZone, ...zones];
  const sel = h("select", { id: "jf-tz", class: "select", "aria-describedby": "jf-err-timeZone" },
    all.map((z) => h("option", { value: z, selected: z === v.timeZone }, z)));
  sel.addEventListener("change", () => set("timeZone", sel.value));
  return sel;
}

function select(id, key, v, options, structural = false) {
  const sel = h("select", { id, class: "select" }, options.map(([value, label]) => h("option", { value, selected: value === v[key] }, label)));
  sel.addEventListener("change", () => set(key, sel.value, { structural }));
  return sel;
}

function previewNodes(m) {
  const p = form.preview;
  if (!m.scheduleValid) return [];
  if (p.state === "loading" || p.state === "idle") return ["Checking…"];
  if (p.state === "error") {
    return [h("span", { class: "jf-error-text", role: "alert" }, p.text), " ",
      h("button", { type: "button", id: "jf-preview-retry", class: "btn btn-sm", onclick: () => schedulePreview(0) }, "Retry")];
  }
  return [firstRunText(p.answer, m.values)];
}

function guaranteeNodes(m) {
  const g = form.preview.state === "ok" ? form.preview.answer?.guarantee : null;
  return g ? [`→ ${g}, at the cleanest hour`] : [];
}

function secretsRow(m) {
  const v = m.values;
  const chosen = v.secrets.map((n) =>
    h("span", { class: "chip jf-secret" }, n,
      h("button", { type: "button", id: `jf-secret-x-${n}`, class: "jf-secret-x", "aria-label": `Remove secret ${n}`, onclick: () => set("secrets", v.secrets.filter((x) => x !== n), { structural: true }) }, "×")));
  const body = [chosen];
  if (m.noSecrets && v.secrets.length === 0) {
    body.push(h("p", { class: "jf-note" }, "No secrets yet. Run: tidegap jobs secrets set NAME"));
  } else if (m.offered.length) {
    if (!m.offered.includes(form.pick)) form.pick = m.offered[0];
    const sel = h("select", { id: "jf-secret-pick", class: "select", "aria-label": "Secret name" }, m.offered.map((n) => h("option", { value: n, selected: n === form.pick }, n)));
    sel.addEventListener("change", () => (form.pick = sel.value));
    body.push(h("span", { class: "jf-inline" }, sel,
      h("button", { type: "button", id: "jf-secret-add", class: "btn btn-sm", "aria-label": "Add secret", onclick: () => set("secrets", [...v.secrets, form.pick], { structural: true }) }, "+")),
    h("p", { class: "jf-note" }, "Set values with: tidegap jobs secrets set NAME"));
  }
  for (const n of m.missing) body.push(h("p", { class: "jf-warn" }, `${n} is not set; run: tidegap jobs secrets set ${n}`));
  return row("Secrets", m.offered.length ? "jf-secret-pick" : null, body);
}

function cadenceRow(m) {
  const v = m.values;
  const pick = (value) => set("cadence", value, { structural: true });
  const days = h("span", { class: "jf-days", role: "group", "aria-label": "Days" }, DAYS.map((d) =>
    h("label", { class: "jf-day" },
      h("input", {
        type: "checkbox", id: `jf-day-${d}`, value: d, checked: v.days.includes(d), disabled: v.cadence !== "weekly",
        onchange: (e) => set("days", e.target.checked ? [...v.days, d] : v.days.filter((x) => x !== d), { structural: true }),
      }), DAY_LABEL[d])));
  const every = text("jf-every", "every", v, { type: "number", inputmode: "numeric", describedBy: "jf-err-cadence" });
  every.setAttribute("min", "2");
  every.setAttribute("max", "168");
  if (v.cadence !== "hours") every.setAttribute("disabled", "");
  return row("Cadence", null,
    h("div", { class: "jf-choices", role: "radiogroup", "aria-label": "Cadence" },
      ["daily", "weekdays", "weekly"].map((c) => radio("jf-cadence", c, v.cadence, CADENCE_LABEL[c], pick)),
      days,
      radio("jf-cadence", "hours", v.cadence, ["every", every, "hours"], pick)),
    err(m, "cadence"));
}

function windowRow(m) {
  const v = m.values;
  const on = h("input", { type: "checkbox", id: "jf-window", checked: v.windowOn, onchange: (e) => set("windowOn", e.target.checked, { structural: true }) });
  const start = text("jf-start", "start", v, { type: "time" });
  const end = text("jf-end", "end", v, { type: "time" });
  if (!v.windowOn) {
    start.setAttribute("disabled", "");
    end.setAttribute("disabled", "");
  }
  return row("Window", null,
    h("span", { class: "jf-inline" }, h("label", { class: "jf-choice" }, on, "only between"), start, "and", end),
    h("p", { class: "jf-note", id: "jf-guarantee" }, guaranteeNodes(m)),
    err(m, "window"));
}

function providerRow(v, note = null) {
  return row("Provider", "jf-provider", h("span", { class: "jf-inline" },
    select("jf-provider", "provider", v, PROVIDERS.map((p) => [p, p])),
    text("jf-model", "model", v, { placeholder: "default model" }),
    note));
}

function runnerRows(m) {
  const v = m.values;
  const out = [row("Runner", null,
    h("div", { class: "jf-choices", role: "radiogroup", "aria-label": "Runner" },
      radio("jf-runner", "command", v.runner, "command + summary", (r) => set("runner", r, { structural: true })),
      radio("jf-runner", "prompt", v.runner, "prompt only", (r) => set("runner", r, { structural: true }))))];
  if (v.runner === "command") {
    out.push(
      row("Command", "jf-command", text("jf-command", "command", v, { mono: true, placeholder: "himalaya envelope list --output json", describedBy: "jf-err-command" }), err(m, "command"),
        h("p", { class: "jf-trust", role: "note" }, TRUST_NOTE)),
      secretsRow(m),
      dirRow(m),
      row("Summary", "jf-prompt", text("jf-prompt", "prompt", v, { multiline: true, placeholder: "Optional: what the LLM should say about the output" })),
      providerRow(v, h("span", { class: "muted" }, "(no tools in this step)")),
    );
  } else {
    out.push(
      row("Prompt", "jf-prompt", text("jf-prompt", "prompt", v, { multiline: true, describedBy: "jf-err-prompt" }), err(m, "prompt")),
      row("Tools", "jf-tools", select("jf-tools", "tools", v, Object.entries(TOOLS_LABEL))),
      dirRow(m),
      providerRow(v),
    );
  }
  return out;
}

function dirRow(m) {
  return row("Directory", "jf-cwd", text("jf-cwd", "cwd", m.values, { mono: true, describedBy: "jf-err-cwd" }), err(m, "cwd"),
    h("p", { class: "jf-note", id: "jf-dir-hint" }, m.folderHint ? DIR_HINT : ""));
}

function capsRow(m) {
  const v = m.values;
  const n = (id, key, step) => {
    const i = text(id, key, v, { type: "number", inputmode: "decimal" });
    i.setAttribute("min", step);
    i.setAttribute("step", step);
    return i;
  };
  return row("Caps", null,
    h("span", { class: "jf-inline" },
      h("label", { for: "jf-cap-command" }, "command"), n("jf-cap-command", "commandMin", "1"), "min ·",
      h("label", { for: "jf-cap-llm" }, "LLM"), n("jf-cap-llm", "llmMin", "1"), "min ·",
      h("label", { for: "jf-cap-budget" }, "budget"), n("jf-cap-budget", "budget", "0.01"), "USD"),
    err(m, "caps"));
}

function footer(m) {
  const save = h("button", { type: "submit", class: "btn btn-primary", id: "jf-save", disabled: !canSave(m) }, form.saving ? "Saving…" : "Save");
  return h("footer", { class: "jf-foot" },
    m.editing && form.job?.actions?.remove ? h("button", { type: "button", class: "btn btn-danger", onclick: () => void remove() }, "Remove") : h("span", {}),
    h("span", { class: "jf-foot-end" },
      h("button", { type: "button", class: "btn btn-ghost", "data-action": "close" }, "Cancel"),
      save));
}

/**
 * The whole drawer. Called on structural changes (a radio, a checkbox, a
 * secret, Save). `rebuild` drops the live nodes first, for value changes
 * the drawer's equality check cannot see.
 */
function render({ rebuild = false } = {}) {
  if (!form.open) return;
  const m = model();
  const head = drawerHead(m.editing ? `Edit ${form.job?.title || "job"}` : form.loading ? "Edit job" : "New job");
  if (form.loading) return showDrawer([...head, h("div", { class: "sk sk-block" }), h("div", { class: "sk sk-block" })], "job-form");
  if (form.loadError) {
    const notFound = form.loadError instanceof ApiError && form.loadError.status === 404;
    return showDrawer([...head, h("p", { class: "muted", role: "alert" }, notFound ? "This job does not exist on this ledger." : "Could not load this job."),
      h("p", {}, h("a", { class: "btn", href: "#/jobs" }, "Back to Jobs"))], "job-form");
  }
  const focus = document.activeElement?.id;
  const v = m.values;
  const fields = h("fieldset", { class: "jf-fields", disabled: form.saving },
    row("Title", "jf-title", text("jf-title", "title", v, { placeholder: "Mail triage", describedBy: "jf-err-title" }), err(m, "title")),
    cadenceRow(m),
    windowRow(m),
    row("Timezone", "jf-tz", zoneSelect(v), err(m, "timeZone")),
    ...runnerRows(m),
    capsRow(m),
    row("Notify", null, h("div", { class: "jf-choices", role: "radiogroup", "aria-label": "Notify" },
      Object.entries(NOTIFY_LABEL).map(([k, label]) => radio("jf-notify", k, v.notify, label, (x) => set("notify", x, { structural: true }))))),
    row("First run", null, h("p", { class: "jf-first", id: "jf-first-run", "aria-live": "polite" }, previewNodes(m))));
  const formEl = h("form", { class: "job-form", novalidate: true }, fields,
    h("div", { id: "jf-form-error" }, formErrorNodes()),
    footer(m));
  formEl.addEventListener("submit", (e) => {
    e.preventDefault();
    void save();
  });
  if (rebuild) document.getElementById("drawer").replaceChildren();
  showDrawer([...head, formEl], "job-form");
  // A control that went away (a removed secret's x) hands focus to the title.
  if (focus) (document.getElementById(focus) || (focus.startsWith("jf-") ? document.getElementById("jf-title") : null))?.focus({ preventScroll: true });
}

function formErrorNodes() {
  if (!form.error) return [];
  return [h("p", { class: "form-error", role: "alert" }, form.error,
    form.stale ? h("button", { type: "button", class: "btn btn-sm jf-reload", onclick: () => void reload() }, "Reload") : null)];
}

/** Text typing: refresh only the parts that depend on the values, so the focused input stays. */
function update() {
  if (!form.open || form.loading || form.loadError) return;
  const root = document.getElementById("drawer");
  const m = model();
  for (const field of ["title", "cadence", "window", "timeZone", "command", "prompt", "cwd", "caps"]) {
    const slot = root.querySelector(`#jf-err-${field}`);
    if (!slot) continue;
    swapChildren(slot, [m.errors[field] || ""]);
    if (m.errors[field]) slot.setAttribute("role", "alert");
    else slot.removeAttribute("role");
  }
  const swap = (id, nodes) => {
    const slot = root.querySelector(`#${id}`);
    if (slot) swapChildren(slot, nodes);
  };
  swap("jf-first-run", previewNodes(m));
  swap("jf-guarantee", guaranteeNodes(m));
  swap("jf-dir-hint", m.folderHint ? [DIR_HINT] : []);
  swap("jf-form-error", formErrorNodes());
  const save = root.querySelector("#jf-save");
  if (save) save.disabled = !canSave(m);
}
