/**
 * Canonical tool surface — the single source of truth for the Tidegap tool
 * definitions that BOTH the @tidegap/mcp MCP server and the @vitalini/tidegap
 * OpenClaw plugin expose.
 *
 * Before this module the two hosts hand-authored their tool lists
 * independently (zod schemas in the MCP server, TypeBox schemas in the
 * OpenClaw plugin), and the two surfaces had silently diverged (audit
 * §2.2): a tool's advertised name, parameter set, requiredness, and
 * description could drift on one host without the other noticing.
 *
 * The representation here is deliberately NEUTRAL — a compact per-parameter
 * descriptor — rather than a zod or TypeBox schema, so that:
 *
 *   - @tidegap/core takes on no schema-library dependency (zod stays in the
 *     MCP package, TypeBox stays in the OpenClaw plugin); and
 *   - each host renders these descriptors into whatever its runtime needs
 *     (MCP → zod validators → JSON Schema; OpenClaw → TypeBox TSchema).
 *
 * The descriptors capture the UNION of what each host enforces (e.g. the
 * `hours` integer bounds, the `deadline` date-time format). Each host's
 * renderer applies the subset appropriate to its historical strictness —
 * the MCP renderer validates strictly (it `.parse()`s incoming arguments),
 * the OpenClaw renderer advertises the looser shapes it always has — so the
 * observable wire contract on each host is preserved while the surface
 * (names, parameter sets, requiredness, descriptions) is unified. A tool
 * whose handler differs per host carries a `descriptionPerHost` override;
 * resolve the text with `descriptionForHost`.
 *
 * Host applicability is first-class: `set_delivery` is OpenClaw-only, and a
 * handful of parameters are host-scoped (MCP's `dry_run` / `dispatch` /
 * `output_path` / `redact_in_receipt`; OpenClaw's `deliver` / `webhook_url`
 * / `file_path` / `file_format`; the MCP-only `model` on recommend_window).
 * Region requiredness legitimately differs per host (OpenClaw can default a
 * missing region from its config / the host timezone; the MCP server and the
 * planning-only recommend_window are intentionally explicit) — that is
 * modelled with `optionalPerHost` rather than dropped.
 */

import { DEFAULT_MODEL_BY_PROVIDER } from "./providers/defaults.js";

/** The two hosts that register these tools. */
export type ToolHost = "mcp" | "openclaw";

/** Every host, in a stable order (used by the divergence-canary snapshot). */
export const ALL_TOOL_HOSTS: readonly ToolHost[] = ["mcp", "openclaw"];

/** The neutral kinds a parameter can take. */
export type ToolParamKind = "string" | "number" | "boolean" | "enum" | "array" | "object";

/**
 * One parameter of one tool, in a schema-library-neutral form. The `min` /
 * `max` / `integer` / `positive` / `minLength` / `format` facts describe the
 * UNION of what any host enforces; a renderer is free to apply only the
 * subset its host historically enforced.
 */
export interface ToolParam {
  name: string;
  kind: ToolParamKind;
  description: string;
  /** Optional on every host that exposes it. Default: false (required). */
  optional?: boolean;
  /** Per-host optionality override — wins over `optional` for that host. */
  optionalPerHost?: Partial<Record<ToolHost, boolean>>;
  /** Hosts that expose this parameter. Default: the tool's `hosts`. */
  hosts?: readonly ToolHost[];

  // string facets
  format?: "date-time";
  minLength?: number;

  // number facets
  integer?: boolean;
  min?: number;
  max?: number;
  positive?: boolean;

  // enum facet (kind === "enum") and array-of-enum item values
  values?: readonly string[];

  // array facet (kind === "array")
  itemKind?: "string" | "enum";

  // object facet (kind === "object"): the fixed sub-parameters. Each is a
  // normal ToolParam (its own kind / facets / optionality). Renderers build a
  // closed object schema from these.
  properties?: readonly ToolParam[];
}

/**
 * MCP tool annotations (the four behavior hints plus a display title).
 * Neutral data: the MCP server advertises them in `tools/list`; OpenClaw has
 * no analogue and ignores them. A description must never contradict them.
 */
export interface ToolAnnotations {
  title: string;
  /** Writes no file and no row. */
  readOnlyHint: boolean;
  /** Deletes or irreversibly replaces existing data. */
  destructiveHint: boolean;
  /** A second identical call changes nothing more. */
  idempotentHint: boolean;
  /** The call reaches a provider API, a grid feed or a usage endpoint. */
  openWorldHint: boolean;
}

/** One tool: its wire name, canonical description, host applicability, and
 *  the ordered parameter descriptors. */
export interface CanonicalToolDef {
  name: string;
  /** The MCP text; also used on any host without an override. */
  description: string;
  /** Per-host description, for a host whose handler differs from the MCP one. */
  descriptionPerHost?: Partial<Record<ToolHost, string>>;
  annotations?: ToolAnnotations;
  hosts: readonly ToolHost[];
  params: readonly ToolParam[];
}

// ── Reusable parameter descriptors ──────────────────────────────────────────
// Defined once so a description or shape can never drift between the two
// tools/hosts that share it.

const deadlineParam: ToolParam = {
  name: "deadline",
  kind: "string",
  format: "date-time",
  description:
    "When the task must be finished: ISO-8601 with a UTC offset, in the future. Convert the user's words, e.g. \"by 8am tomorrow\" in New York becomes '2026-05-13T08:00:00-04:00'.",
};

const regionParam = (opts: {
  optionalPerHost?: Partial<Record<ToolHost, boolean>>;
  minLength?: number;
  description: string;
}): ToolParam => ({
  name: "region",
  kind: "string",
  description: opts.description,
  optionalPerHost: opts.optionalPerHost,
  ...(opts.minLength !== undefined ? { minLength: opts.minLength } : {}),
});

const carbonBudgetParam: ToolParam = {
  name: "carbon_budget_g",
  kind: "number",
  positive: true,
  optional: true,
  description:
    "Hard cap on the task's estimated grams CO2e, e.g. 5. Windows above it are skipped; if no window before the deadline fits, the task fails instead of running on a dirty grid. Omit for no cap.",
};

// `claude-code` runs only in `tidegap tick` (the CLI host spawns the local
// Claude Code CLI), so it is offered on MCP and not on OpenClaw.
const providerParams: ToolParam[] = [
  {
    name: "provider",
    kind: "enum",
    hosts: ["mcp"],
    values: ["anthropic", "openai", "gemini", "ollama", "claude-code"],
    optional: true,
    description:
      "Where the task runs. 'claude-code' uses the local Claude Code login on the next `tidegap tick`, with no API key (see tools); 'ollama' is a local model; the others need their API key. Defaults to 'claude-code' when queued from a Claude Code session (it then runs in a copy of that session, in its project directory), else 'anthropic'; an explicit 'anthropic' never resumes a session. 'anthropic' and 'openai' can use the 50%-cheaper Batch API when the deadline allows; the others always run synchronously.",
  },
  {
    name: "provider",
    kind: "enum",
    hosts: ["openclaw"],
    values: ["anthropic", "openai", "gemini", "ollama"],
    optional: true,
    description:
      "Where the task runs; 'ollama' is a local model, the others need their key in the plugin config. Defaults to the provider the model name implies ('gpt-…' is openai, 'gemini-…' is gemini, a configured Ollama model is ollama), else 'anthropic'. 'anthropic' and 'openai' can use the 50%-cheaper Batch API when the deadline allows; 'gemini' and 'ollama' always run synchronously.",
  },
];

const candidatesParam: ToolParam = {
  name: "candidates",
  kind: "array",
  itemKind: "string",
  optional: true,
  description:
    "'provider:model' pairs the user allows, e.g. ['anthropic:claude-haiku-4-5','ollama:llama-3-1-8b']. With 2 or more, the scheduler scores each at the chosen window on carbon, cost and latency (see route_weights), runs the winner and records the scores on the receipt; it never picks a model outside this list. Omit, or pass one entry, to keep provider and model as given. A model missing from the price table is rejected.",
};

const routeWeightsParam: ToolParam = {
  name: "route_weights",
  kind: "object",
  optional: true,
  description:
    "How to rank candidates, e.g. {\"carbon\": 1} for carbon only. Weights are relative and normalized; a key left out counts as 0. Omit for the default {carbon: 0.6, cost: 0.3, latency: 0.1}. Ignored unless candidates has 2 or more entries.",
  properties: [
    { name: "carbon", kind: "number", min: 0, optional: true, description: "Relative weight on the estimated grams CO2e at the chosen window. Omit to weight it 0 when route_weights is given." },
    { name: "cost", kind: "number", min: 0, optional: true, description: "Relative weight on the estimated USD list cost, batch discount included when eligible. Omit to weight it 0 when route_weights is given." },
    { name: "latency", kind: "number", min: 0, optional: true, description: "Relative weight on speed: local beats hosted sync, which beats hosted batch. Omit to weight it 0 when route_weights is given." },
  ],
};

const modelParam = (opts: { hosts?: readonly ToolHost[]; description: string }): ToolParam => ({
  name: "model",
  kind: "string",
  optional: true,
  hosts: opts.hosts,
  description: opts.description,
});

const scheduleModelDescription = (anthropicOverride: string): string =>
  `Model id for the chosen provider, e.g. 'claude-sonnet-5' (anthropic) or 'gpt-6-sol' (openai). Omit for the provider default: anthropic '${DEFAULT_MODEL_BY_PROVIDER.anthropic}'${anthropicOverride}, openai '${DEFAULT_MODEL_BY_PROVIDER.openai}', gemini '${DEFAULT_MODEL_BY_PROVIDER.gemini}', ollama '${DEFAULT_MODEL_BY_PROVIDER.ollama}'. With 2 or more candidates, routing may pick another model from that list.`;

const taskIdRequired: ToolParam = {
  name: "task_id",
  kind: "string",
  minLength: 1,
  description: "The task's id, e.g. 't-3f2a…', from the schedule_task reply or the check_queue_status list.",
};

const deliverModes = ["chat", "telegram", "webhook", "file", "queue", "os"] as const;
const reportFormats = ["md", "html", "txt", "json", "pdf"] as const;

const deliverParam = (optional: boolean): ToolParam => ({
  name: "deliver",
  kind: "array",
  itemKind: "enum",
  values: deliverModes,
  optional,
  hosts: ["openclaw"],
  description:
    "Where the result goes when the task completes, one or more modes, e.g. ['chat','file']. chat is the user's active OpenClaw chat; os is a desktop notification on the gateway host; queue sends nothing. Default: chat. Ask the user first; set_delivery can change it later.",
});

const webhookUrlParam: ToolParam = {
  name: "webhook_url",
  kind: "string",
  optional: true,
  hosts: ["openclaw"],
  description: "URL that receives the full result as a POST, e.g. 'https://example.com/hooks/tidegap'. Needed when deliver includes 'webhook'; omit otherwise.",
};

const filePathParam: ToolParam = {
  name: "file_path",
  kind: "string",
  optional: true,
  hosts: ["openclaw"],
  description: "Path on the gateway host to write the report to, e.g. '/var/reports/digest.md'. Needed when deliver includes 'file'; omit otherwise.",
};

const fileFormatParam: ToolParam = {
  name: "file_format",
  kind: "enum",
  values: reportFormats,
  optional: true,
  hosts: ["openclaw"],
  description:
    "Report format for 'file' delivery, e.g. 'html'. Default: md. 'pdf' renders the HTML report and needs puppeteer on the gateway.",
};

// ── The canonical surface ───────────────────────────────────────────────────

export const TOOL_SURFACE: readonly CanonicalToolDef[] = [
  {
    name: "get_grid_forecast",
    hosts: ["mcp", "openclaw"],
    description:
      "Return the hour-by-hour grid carbon intensity forecast for one region, up to 72 hours ahead. Use when: the user asks how clean the grid is now or later, or wants the raw curve. Do not use to pick a run time for a task (use recommend_window) or to queue work (use schedule_task). Behavior: writes nothing; reads one grid feed, no login; GB is live without a key, other zones need a feed key or get synthetic data (Source: mock). Returns: region, source, generated time, one row per hour (gCO2/kWh and band), and the cleanest and dirtiest hour. Rejects an unknown zone and lists the closest zones.",
    descriptionPerHost: {
      openclaw:
        "Return the hour-by-hour grid carbon intensity forecast for one region, up to 72 hours ahead. Use when: the user asks how clean the grid is now or later, or wants the raw curve. Do not use to pick a run time for a task (use recommend_window) or to queue work (use schedule_task). Behavior: writes nothing; reads one grid feed; GB is live without a key, other zones need a feed key in the plugin config or get synthetic data (source: mock). Returns: region, source, generatedAt and entries (datetime, carbonIntensityGCo2PerKwh, band). Throws on an unknown zone, naming the closest ones.",
    },
    annotations: {
      title: "Grid carbon forecast",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    params: [
      regionParam({
        // Required on the MCP server; optional on OpenClaw, which defaults a
        // missing region from its config / the host timezone (else GB).
        optionalPerHost: { mcp: false, openclaw: true },
        description:
          "Grid zone code, e.g. 'US-CAL-CISO', 'GB' or 'DE'; take it from the user's location or the data center they name. `tidegap region list` prints the supported zones; any zone works with an Electricity Maps key. Defaults, where the host lets it be omitted, to the configured region, else the stored setting (`tidegap region set`), else a time-zone guess, else GB.",
      }),
      {
        name: "hours",
        kind: "number",
        integer: true,
        min: 1,
        max: 72,
        optional: true,
        description: "How many hours ahead to forecast, e.g. 12 to cover \"tonight\". Defaults to 24; 72 is the most.",
      },
    ],
  },
  {
    name: "recommend_window",
    hosts: ["mcp", "openclaw"],
    description:
      "Preview the cleanest run window before a task's deadline, without queuing it. Use when: the user asks when a task would run or what waiting saves. Do not use to queue the task (use schedule_task) or for the raw hourly curve (use get_grid_forecast). Behavior: writes nothing; reads the grid forecast; no login or key. Returns: scheduled_for, intensity, band, estimated_carbon_g_co2, estimated_savings_vs_now_pct, batch_eligible, grid_source (mock = synthetic), alternatives, reasoning; routing_preview with 2+ candidates. Rejects a past deadline, an unknown zone, or a carbon_budget_g no window meets.",
    descriptionPerHost: {
      openclaw:
        "Preview the cleanest run window before a task's deadline, without queuing it. Use when: the user asks when a task would run or what waiting saves. Do not use to queue the task (use schedule_task) or for the raw hourly curve (use get_grid_forecast). Behavior: writes nothing; reads the grid forecast; no key needed. Returns: scheduledFor, intensityGCo2PerKwh, band, estimatedCarbonGCo2, estimatedSavingsVsNowPct, batchEligible, gridSource (mock = synthetic), alternatives, reasoning, routingPreview with 2+ candidates. Throws on a past deadline, an unknown zone, or a carbon_budget_g no window meets.",
    },
    annotations: {
      title: "Preview cleanest window",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    params: [
      deadlineParam,
      regionParam({
        // Required on the MCP server (with a non-empty check); OpenClaw
        // historically made it optional — kept as-is.
        optionalPerHost: { mcp: false, openclaw: true },
        minLength: 1,
        description:
          "Grid zone the task would run against, e.g. 'US-CAL-CISO' or 'FR'. `tidegap region list` prints the supported zones; any zone works with an Electricity Maps key. Defaults, where the host lets it be omitted, to the configured region, else the stored setting (`tidegap region set`), else a time-zone guess, else GB.",
      }),
      carbonBudgetParam,
      modelParam({
        // MCP-only: affects the reasoning string. OpenClaw's recommend_window
        // never exposed a model parameter.
        hosts: ["mcp"],
        description:
          "Model name to mention in the reasoning text, e.g. 'claude-sonnet-5'; it does not change the window. Omit to leave it out.",
      }),
      candidatesParam,
      routeWeightsParam,
    ],
  },
  {
    name: "schedule_task",
    hosts: ["mcp", "openclaw"],
    description:
      "Queue an AI task or recurring job to run at the cleanest grid hour before its deadline; long deadlines may use the provider Batch API. Use when: the user defers work (\"tonight\", \"no rush\", \"before my limit resets\") or wants it repeated (\"every night\", \"daily\", a cron); map that to deadline or repeat. Do not use for work the user waits on (do it now), to preview only (use recommend_window or dry_run) or for limits (use tidegap_usage). Behavior: adds one task to the local queue (dry_run writes nothing), or with repeat a job whose runs are new tasks in this project; reads the grid forecast; no login; runs happen on `tidegap tick`. Returns: task_id, status, scheduled_for, deadline, provider, model, runs_in, estimated_carbon_g_co2, a readiness line; a job adds job_id and its guarantee. Rejects a past deadline, an unknown zone, disallowed tools and shell commands.",
    descriptionPerHost: {
      openclaw:
        "Queue an AI task or recurring job to run at the cleanest grid hour before its deadline; long deadlines may use the provider Batch API. Use when: the user defers work (\"tonight\", \"no rush\") or wants it repeated (\"every night\", \"daily\", a cron); map that to deadline or repeat. Do not use for work the user waits on (do it now) or to preview only (use recommend_window). Behavior: adds one task to the local queue, or with repeat a job whose runs are new tasks with chat delivery; reads the grid forecast. The gateway runs them with a plugin provider key or the OpenClaw runtime. Returns: task_id, status, scheduled_for, region, provider, model, estimated_carbon_g_co2, grid_source, dispatch, delivery_options, next_step (ask, then call set_delivery); a job returns job_id, guarantee, first_task_id. Throws on a past deadline, an unknown zone, a provider with no key, or shell commands.",
    },
    annotations: {
      title: "Schedule task at cleanest hour",
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
    params: [
      {
        name: "prompt",
        kind: "string",
        minLength: 1,
        hosts: ["openclaw"],
        description:
          "The full instruction the model receives when the window arrives, e.g. 'Summarize today's AI policy news in 5 bullets'. Include every fact the run needs.",
      },
      {
        name: "prompt",
        kind: "string",
        minLength: 1,
        hosts: ["mcp"],
        description:
          "The full instruction the model receives when the window arrives, e.g. 'Summarize today's AI policy news in 5 bullets'. The run may start in a fresh session without this conversation (the reply's runs_in line says which), so name the files, decisions and constraints it needs.",
      },
      // OpenClaw keeps `deadline` required. On MCP it is optional because a
      // `deadline_kind: "quota_reset"` task has its deadline resolved by the
      // server from the quota config.
      { ...deadlineParam, hosts: ["openclaw"] },
      {
        ...deadlineParam,
        hosts: ["mcp"],
        optional: true,
        description:
          "When the task must be finished: ISO-8601 with a UTC offset, in the future. Convert the user's words, e.g. \"by 8am tomorrow\" in New York becomes '2026-05-13T08:00:00-04:00'. Omit with deadline_kind 'quota_reset', which sets it (a value is then ignored), or with a job repeat, whose first run then follows the cadence.",
      },
      regionParam({
        // Optional on BOTH hosts for schedule_task.
        optionalPerHost: { mcp: true, openclaw: true },
        description:
          "Grid zone to plan against, e.g. 'US-CAL-CISO' or 'FR'; pass it only when the user names a place. `tidegap region list` prints the supported zones; any zone works with an Electricity Maps key. Defaults to the host's configured region (MCP: TIDEGAP_DEFAULT_REGION; OpenClaw: defaultRegion), else the stored setting (`tidegap region set`), else a time-zone guess, else GB. The reply's region_source names the rule that applied.",
      }),
      carbonBudgetParam,
      // The TIDEGAP_DEFAULT_MODEL override is read only by the MCP server, so the
      // sentence naming it is MCP-only; OpenClaw gets the plain defaults.
      modelParam({
        hosts: ["mcp"],
        description: scheduleModelDescription(" (TIDEGAP_DEFAULT_MODEL overrides it)"),
      }),
      modelParam({
        hosts: ["openclaw"],
        description: scheduleModelDescription(""),
      }),
      ...providerParams,
      candidatesParam,
      routeWeightsParam,
      // ── MCP-only parameters ──
      {
        name: "tools",
        kind: "array",
        itemKind: "string",
        optional: true,
        hosts: ["mcp"],
        description:
          "Claude Code tools for a 'claude-code' run, e.g. ['WebSearch','WebFetch'] for a research task; [] means none. Allowed: WebSearch, WebFetch, Read, Grep, Glob. Omit for the default: Read, Grep and Glob in the session's project directory for a task queued from a Claude Code session, else WebSearch and WebFetch (TIDEGAP_CLAUDE_TOOLS overrides that one). A web tool makes a task from a session run fresh, without its context. Rejected: any other name (Bash, Write, Edit, ...) and a set that mixes a file tool with a web tool, because web content is untrusted. A job keeps the whole group: any file tool means Read, Grep and Glob; any web tool means WebSearch and WebFetch. A job stores its tools when created and ignores TIDEGAP_CLAUDE_TOOLS.",
      },
      {
        name: "dry_run",
        kind: "boolean",
        optional: true,
        hosts: ["mcp"],
        description:
          "true previews the plan (window, carbon estimate, provider, model, runs_in) and queues nothing, e.g. to confirm with the user first. Defaults to false.",
      },
      {
        name: "dispatch",
        kind: "boolean",
        optional: true,
        hosts: ["mcp"],
        description:
          "Defaults to true: store a task that `tidegap tick` runs. false queues an in-memory placeholder that never calls a model (tests only) and cannot combine with not_before or after_limit_reset. Omit it in normal use.",
      },
      {
        name: "output_path",
        kind: "string",
        optional: true,
        hosts: ["mcp"],
        description:
          "Absolute file path, e.g. '/tmp/digest.json'; when the task completes, { taskId, result, receipt } is written there as JSON. Omit to keep the result only in the queue (check_queue_status).",
      },
      {
        name: "redact_in_receipt",
        kind: "array",
        itemKind: "string",
        optional: true,
        hosts: ["mcp"],
        description:
          "Regex patterns removed from the prompt before it is stored on the receipt, e.g. ['customer-[0-9]+'] for customer ids. Omit for the default, which strips API-key-looking strings.",
      },
      {
        name: "title",
        kind: "string",
        optional: true,
        hosts: ["mcp"],
        description:
          "Short label for queue lists, e.g. 'Weekly digest'. Defaults to the prompt's first line, cut to 80 characters; API-key-looking strings are redacted.",
      },
      {
        name: "deadline_kind",
        kind: "enum",
        values: ["absolute", "quota_reset"],
        optional: true,
        hosts: ["mcp"],
        description:
          "Defaults to 'absolute': the deadline parameter sets the due time. 'quota_reset' sets it to the next weekly subscription-quota reset minus a margin, from ~/.tidegap/config (TIDEGAP_QUOTA_RESET_<LABEL>=<weekday> <HH:MM> [<IANA zone>]; margin TIDEGAP_QUOTA_MARGIN_H_<LABEL>, default 2 hours). Use it when the user says \"before my weekly limit resets\". A due time more than 24 hours away can use the provider Batch API.",
      },
      {
        name: "quota_provider",
        kind: "string",
        optional: true,
        hosts: ["mcp"],
        description:
          "Which configured quota to follow with deadline_kind 'quota_reset', e.g. 'claude' or 'codex'. Omit when exactly one label is configured; rejected with any other deadline_kind.",
      },
      {
        name: "repeat",
        kind: "enum",
        values: ["none", "daily", "weekdays", "weekly", "every_n_hours", "quota_reset"],
        optional: true,
        hosts: ["mcp"],
        description:
          "Defaults to 'none', a one-off. 'daily', 'weekdays', 'weekly' and 'every_n_hours' create a job: each run is a new task with this prompt, started fresh (never a copy of this session) in this project at the cleanest hour of its period, e.g. \"every night\" is 'daily' with window '22:00-08:00'. A job rejects per-task options (region, carbon_budget_g, candidates, not_before, dry_run and the like). With deadline_kind 'quota_reset', 'daily', 'weekly' and 'quota_reset' start the older series instead, which follows the quota reset; 'weekdays' and 'every_n_hours' are rejected there. End a job or series with cancel_task series=true.",
      },
      {
        name: "repeat",
        kind: "enum",
        values: ["none", "daily", "weekdays", "weekly", "every_n_hours"],
        optional: true,
        hosts: ["openclaw"],
        description:
          "Defaults to 'none', a one-off. 'daily', 'weekdays', 'weekly' and 'every_n_hours' create a job: each run is a new task with this prompt at the cleanest hour of its period, e.g. \"every night\" is 'daily' with window '22:00-08:00'; deadline then bounds only the first run. A job rejects per-task options (region, carbon_budget_g, candidates, route_weights, deliver, webhook_url, file_path, file_format). End the job with cancel_task series=true.",
      },
      {
        name: "every_hours",
        kind: "number",
        integer: true,
        min: 2,
        max: 168,
        optional: true,
        description:
          "Hours between runs for repeat 'every_n_hours', e.g. 6 for \"every 6 hours\". Each run comes at most this long after the previous start and not sooner than half of it. Required with 'every_n_hours'; omit for any other repeat.",
      },
      {
        name: "days",
        kind: "array",
        itemKind: "enum",
        values: ["mon", "tue", "wed", "thu", "fri", "sat", "sun"],
        optional: true,
        description:
          "Weekdays for repeat 'weekly', e.g. ['mon','thu'] for \"Mondays and Thursdays\". Defaults to today's weekday in time_zone; omit for any other repeat.",
      },
      {
        name: "window",
        kind: "string",
        optional: true,
        description:
          "Local hours a job may run in, 'HH:MM-HH:MM', e.g. '22:00-08:00' for \"at night\"; '22:00-06:00' crosses midnight. Each run then picks its cleanest hour inside that day's window. Only with repeat 'daily', 'weekdays' or 'weekly'; omit to allow any hour.",
      },
      {
        name: "time_zone",
        kind: "string",
        optional: true,
        description:
          "IANA zone that window and days are read in, e.g. 'Europe/Berlin'; take it from the user's location. Defaults to the host's system zone. Only with a job repeat.",
      },
      {
        name: "origin_session_id",
        kind: "string",
        optional: true,
        hosts: ["mcp"],
        description:
          "Claude Code session id of the conversation that queued the task. Omit it: the server finds the current session itself when the Tidegap plugin is installed. Pass it only when the host substitutes it (e.g. ${CLAUDE_SESSION_ID} in a slash command); it then wins. Values that are not 8-128 letters, digits, '-' or '_' are ignored.",
      },
      {
        name: "after_limit_reset",
        kind: "boolean",
        optional: true,
        hosts: ["mcp"],
        description:
          "true when the user says \"after my limit resets\": the task starts no earlier than the Claude subscription limit reset (the latest reset of an exhausted 5-hour or weekly window, else the fuller window's reset; see tidegap_usage), then runs at the cleanest hour after it. The deadline rises to at least two hours after the reset. Fails, queuing nothing, when no limit reading exists. Defaults to false; cannot combine with not_before.",
      },
      {
        name: "not_before",
        kind: "string",
        format: "date-time",
        optional: true,
        hosts: ["mcp"],
        description:
          "Earliest start, ISO-8601 with offset, e.g. '2026-05-12T18:00:00+02:00' for \"not before 6pm\" or \"after lunch\". The task then runs at the cleanest hour between it and the deadline; it must be in the future and not after the deadline. Omit to allow any time up to the deadline; cannot combine with after_limit_reset.",
      },
      // ── OpenClaw-only parameters (result delivery) ──
      deliverParam(true),
      webhookUrlParam,
      filePathParam,
      fileFormatParam,
    ],
  },
  {
    name: "check_queue_status",
    hosts: ["mcp", "openclaw"],
    description:
      "Show the local task queue and jobs: every task in brief or one in full. Use when: the user asks what is queued or repeats, whether a task finished, or for its result. Do not use to change a task (use cancel_task, postpone_task, update_deadline or retry_task) or for limits (use tidegap_usage). Behavior: no network or login; marks a shown completed or failed task read; never changes a status. Returns: without task_id, status counts, last_tick_at, a line per task and job (guarantee, next run and id, last result); with task_id, its prompt, result, receipt and events. Rejects an unknown task_id.",
    descriptionPerHost: {
      openclaw:
        "Show the local task queue and jobs: every task in brief, or one task in full. Use when: the user asks what is queued or repeats, whether a task finished, or for its result. Do not use to change a task (use cancel_task, update_deadline or retry_task) or to set delivery (use set_delivery). Behavior: no network or login; marks a completed or failed task read when shown; never changes a status. Returns: without task_id, total, last_tick_at, tasks (task_id, title, status, scheduled_for, job_id) and jobs (guarantee, next_run, last_outcome); with task_id, its record. Throws on an unknown task_id.",
    },
    annotations: {
      title: "Show task queue",
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    params: [
      {
        name: "task_id",
        kind: "string",
        optional: true,
        description:
          "One task's id, e.g. 't-3f2a…', from schedule_task or this tool's summary, to get its full record. Omit for the summary of all tasks.",
      },
    ],
  },
  {
    name: "tidegap_usage",
    hosts: ["mcp"],
    description:
      "Report this machine's Claude Code limits: 5-hour and weekly percent used, reset times, and Codex limits if present. Use when: the user asks how much quota is left, or before heavy Claude Code work; at 90% or more, pass after_limit_reset to schedule_task. Do not use for task state (use check_queue_status). Behavior: reads the statusline reading, no API key; TIDEGAP_USAGE_OAUTH=1 calls the usage endpoint with the Claude Code login and caches it in ~/.tidegap/usage.json; never writes tasks or settings. Returns: a summary line and the usage/v1 JSON (windows, reading age, after_limit_reset wait).",
    annotations: {
      title: "Claude usage limits",
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    params: [
      {
        name: "include_spend",
        kind: "boolean",
        optional: true,
        description:
          "true adds claude_spend: tokens and an API list-price cost estimate for the current 5-hour window from the local Claude Code logs (total, by model, the five latest sessions), plus the tokens of recent Codex sessions. Use it when the user asks what their usage would cost; the scan takes a few seconds. Defaults to false.",
      },
    ],
  },
  {
    name: "cancel_task",
    hosts: ["mcp", "openclaw"],
    description:
      "Cancel one queued or scheduled task by task_id; for all pending, use cancel_all. Use when: the user drops one task. Do not use to delay it (use postpone_task) or rerun a failed one (use retry_task). Behavior: marks it cancelled locally (no network) and redacts its prompt. Also cancels running and submitted tasks; a Batch call may still bill. A job or series skips this run; series=true ends it, even from a finished run. Else a finished task or repeat call changes nothing. Returns: \"Task <id> status: <status>\", terminated_at, and a job or series line when ended. Rejects an unknown task_id.",
    descriptionPerHost: {
      openclaw:
        "Cancel one queued or scheduled task by task_id; for all pending, use cancel_all. Use when: the user drops a task. Do not use to delay it (use update_deadline) or rerun a failed one (use retry_task). Behavior: marks it cancelled locally (no network) and redacts its prompt. Also cancels running and submitted tasks; a Batch call may still bill. A job or series skips this run; series=true ends it, even from a finished run. Else a finished task or repeat call changes nothing. Returns: task_id, status, completed_at, job_id and job_ended or series_id and series_ended. Throws on an unknown task_id.",
    },
    annotations: {
      title: "Cancel one task",
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: false,
    },
    params: [
      { ...taskIdRequired, description: "Id of the task to cancel, e.g. 't-3f2a…', from the schedule_task reply or the check_queue_status list." },
      {
        name: "series",
        kind: "boolean",
        optional: true,
        description:
          "true also ends the job or series this task is a run of, so no further run is queued; use it for \"stop this for good\". Defaults to false: skip only this run; a job then plans its next one. No effect on a one-off task.",
      },
    ],
  },
  {
    name: "expedite_task",
    hosts: ["mcp", "openclaw"],
    description:
      "Run one queued or scheduled task now, skipping its clean window. Use when: the user wants the result now. Do not use for a failed task (use retry_task), to pick a new deadline (use update_deadline), or for a claude-code task (run `tidegap queue run-now <id>`). Behavior: drops its earliest start and makes one provider call at the current grid intensity; needs the task provider's key in the server env (and ANTHROPIC_API_KEY or OPENAI_API_KEY); the receipt records intensitySource=expedited. Returns: status and error on failure. Rejects running, submitted, finished and unknown tasks.",
    descriptionPerHost: {
      openclaw:
        "Run one queued or scheduled task now, skipping its clean-grid window. Use when: the user wants the result now (\"do it now\", \"don't wait\"). Do not use for a failed task (use retry_task) or to pick a new deadline (use update_deadline). Behavior: drops its earliest start and makes one provider call at the current grid intensity, through the OpenClaw runtime or a provider key in the plugin config, then delivers the result; the receipt records intensitySource=expedited. Returns: status, error on failure, result, receipt and delivery. Throws on running, submitted, finished and unknown tasks.",
    },
    annotations: {
      title: "Run task now",
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
    params: [{ ...taskIdRequired, description: "Id of the queued or scheduled task to run now, e.g. 't-3f2a…', from the schedule_task reply or the check_queue_status list." }],
  },
  {
    name: "update_deadline",
    hosts: ["mcp", "openclaw"],
    description:
      "Change the deadline of one queued or scheduled task and re-pick its cleanest window inside it. Use when: the user moves the due time, earlier or later (\"by 6pm instead\"). Do not use to delay the start inside the same deadline (use postpone_task), to run now (use expedite_task) or to stop it (use cancel_task). Behavior: rewrites only this task in the local queue, clears its earliest start and quota rule, re-reads the grid forecast; no login. A repeat call only re-picks the hour. Returns: status, scheduled_for, new_deadline. Rejects running, finished or unknown tasks and a past deadline.",
    descriptionPerHost: {
      openclaw:
        "Change the deadline of one queued or scheduled task and re-pick its cleanest window inside it. Use when: the user moves the due time, earlier or later (\"by 6pm instead\"). Do not use to run now (use expedite_task) or to stop it (use cancel_task). Behavior: rewrites only this task in the local queue, clears its quota rule and re-reads the grid forecast; no login or key. A repeat call only re-picks the hour. Returns: task_id, status, scheduled_for, new_deadline. Throws on running, finished or unknown tasks and a past deadline.",
    },
    annotations: {
      title: "Change task deadline",
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    params: [
      { ...taskIdRequired, description: "Id of the queued or scheduled task to move, e.g. 't-3f2a…', from the schedule_task reply or the check_queue_status list." },
      { ...deadlineParam, description: "The new due time, ISO-8601 with offset, earlier or later than the current one and in the future, e.g. '2026-05-12T18:00:00+02:00' for \"by 6pm instead\"." },
    ],
  },
  {
    name: "postpone_task",
    hosts: ["mcp"],
    description:
      "Move one queued or scheduled task later; it never runs earlier than planned. Use when: the user says \"tonight\" or \"after my limit resets\"; pass exactly one of preset, until or delay_minutes. Do not use to set a new due time (use update_deadline) or to stop it (use cancel_task). Behavior: rewrites this task's earliest start in the local queue and re-picks the cleanest hour after it, but an until time is kept exactly; after_limit_reset reads the Claude limits. Returns: status, not_before, scheduled_for, deadline. Rejects a target at or before the planned start, finished and unknown tasks.",
    annotations: {
      title: "Postpone task",
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
    params: [
      { ...taskIdRequired, description: "Id of the queued or scheduled task to move later, e.g. 't-3f2a…', from the schedule_task reply or the check_queue_status list." },
      {
        name: "preset",
        kind: "enum",
        values: ["1h", "tonight", "tomorrow_morning", "after_limit_reset"],
        optional: true,
        description: "A named later time, in this machine's local time: '1h' is one hour after the planned start; 'tonight' is 22:00 to 06:00 (after midnight: now to 06:00); 'tomorrow_morning' is 09:00 to 12:00 tomorrow; 'after_limit_reset' is 5 minutes after the Claude limit reset (needs reset_at, this machine's limit reading or a reset time given before). Omit when passing until or delay_minutes.",
      },
      {
        name: "until",
        kind: "string",
        format: "date-time",
        optional: true,
        description: "The exact time the user picked, ISO-8601 with offset, after the planned start, e.g. '2026-05-12T21:30:00+02:00'. Omit when passing preset or delay_minutes.",
      },
      {
        name: "delay_minutes",
        kind: "number",
        integer: true,
        min: 1,
        max: 10080,
        optional: true,
        description: "Minutes to add to the planned start, e.g. 90 for \"an hour and a half later\"; at most 10080 (7 days). Omit when passing preset or until.",
      },
      {
        name: "reset_at",
        kind: "string",
        format: "date-time",
        optional: true,
        description:
          "When the Claude limit resets, ISO-8601 with offset, if the user says it (\"my limit resets at 15:00\"). Only with preset 'after_limit_reset'; must be in the future and is remembered for later tasks. Omit to use this machine's limit reading.",
      },
    ],
  },
  {
    name: "reply_task",
    hosts: ["mcp", "openclaw"],
    description:
      "Send a follow-up message in a completed task's conversation, as a new queued task. Use when: the user follows up on a finished task's result. Do not use for a failed task (use retry_task) or for an unrelated new task (use schedule_task). Behavior: each call adds one task to the local queue with earlier turns as history, the same provider and model, and its own clean window; no login now; it runs later as one provider call with the original's credentials. Returns: task_id, parent_task_id, status, scheduled_for, deadline. Rejects non-completed and unknown tasks and text over 32000 characters.",
    annotations: {
      title: "Reply to a completed task",
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
    params: [
      { ...taskIdRequired, description: "Id of the completed task to continue, e.g. 't-3f2a…', from the check_queue_status list (status completed)." },
      {
        name: "text",
        kind: "string",
        minLength: 1,
        description: "The user's follow-up, sent as the next turn after the task's earlier reply, e.g. 'Now cut it to 3 bullets'. Up to 32000 characters.",
      },
      {
        ...deadlineParam,
        optional: true,
        description: "When the reply must be finished, ISO-8601 with offset, e.g. '2026-05-12T20:00:00Z'. Defaults to one hour from now.",
      },
    ],
  },
  {
    name: "retry_task",
    hosts: ["mcp", "openclaw"],
    description:
      "Run a failed task again now, with the same prompt, provider and model. Use when: a task failed on a transient error (rate limit, 5xx). Do not use for a task that did not fail (use expedite_task to run it now, update_deadline to move it), or for a claude-code task (run `tidegap queue run-now <id>`). Behavior: one provider call now; needs the task provider's key in the server env (and ANTHROPIC_API_KEY or OPENAI_API_KEY); the new result and signed receipt replace the old ones. Returns: status (completed or failed) and error on failure. Rejects non-failed and unknown tasks.",
    descriptionPerHost: {
      openclaw:
        "Run a failed task again now, with the same prompt, provider and model. Use when: a task failed on a transient error (rate limit, 5xx) and the user wants it redone. Do not use for a task that did not fail (use expedite_task to run it now, update_deadline to move it). Behavior: one provider call now, through the OpenClaw runtime or a provider key in the plugin config; the new result and signed receipt replace the old ones, then the result is delivered. Returns: status, error on failure, result, receipt and delivery. Throws on tasks that are not failed and unknown task_ids.",
    },
    annotations: {
      title: "Retry a failed task",
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: true,
    },
    params: [{ ...taskIdRequired, description: "Id of the failed task to run again, e.g. 't-3f2a…', from the check_queue_status list (status failed)." }],
  },
  {
    name: "cancel_all",
    hosts: ["mcp", "openclaw"],
    description:
      "Cancel every queued and scheduled task in the local queue at once; for a single task use cancel_task. Use when: the user says \"cancel everything\" or \"clear the queue\". Do not use to drop one task or to end a repeating series (use cancel_task, with series=true for a series). Behavior: marks each pending task cancelled; running, submitted and finished tasks stay as they are; no network or login. A repeating task skips this occurrence and its next one is queued, so a second call cancels that one too. Returns: \"Cancelled N of M task(s).\" and one error line per task that could not be cancelled.",
    descriptionPerHost: {
      openclaw:
        "Cancel every queued and scheduled task in the local queue at once; for a single task use cancel_task. Use when: the user says \"cancel everything\" or \"clear the queue\". Do not use to drop one task or to end a repeating series (use cancel_task, with series=true for a series). Behavior: marks each pending task cancelled; running, submitted and finished tasks stay as they are; no network or login. A repeating task skips this occurrence and its next one is queued, so a second call cancels that one too. Returns: matched, cancelled, and errors (task_id and error per task that could not be cancelled).",
    },
    annotations: {
      title: "Cancel all pending tasks",
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: false,
    },
    params: [
      {
        name: "status",
        kind: "enum",
        values: ["queued", "scheduled"],
        optional: true,
        description:
          "Cancel only tasks in one state: 'queued' (no window picked yet) or 'scheduled' (window picked). Omit to cancel both.",
      },
    ],
  },
  {
    // OpenClaw-only: the MCP server has no result-delivery subsystem.
    name: "set_delivery",
    hosts: ["openclaw"],
    description:
      "Set how a scheduled task's result is delivered when it completes; several modes allowed. Use when: right after schedule_task, once the user has chosen. Do not use to read a result (use check_queue_status). Behavior: saves the setting locally, without checking the task exists; sends nothing now. queue transmits nothing; chat may route through Telegram; telegram, webhook and file send or write the FULL result, so confirm those destinations first. Default: chat. Returns: task_id and the saved delivery. Throws on a missing webhook_url or file_path.",
    params: [
      { ...taskIdRequired, description: "Id of the task, e.g. 't-3f2a…', from the schedule_task reply or the check_queue_status list." },
      { ...deliverParam(false), description: "The modes the user chose, e.g. ['telegram'] or ['chat','file']. webhook needs webhook_url; file needs file_path. Confirm telegram, webhook and file destinations with the user first." },
      webhookUrlParam,
      filePathParam,
      fileFormatParam,
    ],
  },
];

// ── Helpers ─────────────────────────────────────────────────────────────────

const BY_NAME: ReadonlyMap<string, CanonicalToolDef> = new Map(
  TOOL_SURFACE.map((t) => [t.name, t]),
);

/** Look up a canonical tool by its wire name. */
export function getToolDef(name: string): CanonicalToolDef | undefined {
  return BY_NAME.get(name);
}

/** Like {@link getToolDef} but throws when the name is unknown. */
export function getToolDefOrThrow(name: string): CanonicalToolDef {
  const def = BY_NAME.get(name);
  if (!def) throw new Error(`unknown Tidegap tool: ${name}`);
  return def;
}

/** A tool's description as one host shows it (its override, else the base). */
export function descriptionForHost(def: CanonicalToolDef, host: ToolHost): string {
  return def.descriptionPerHost?.[host] ?? def.description;
}

/** The tools a given host registers, in canonical order, each carrying the
 *  description resolved for that host. */
export function toolsForHost(host: ToolHost): CanonicalToolDef[] {
  return TOOL_SURFACE.filter((t) => t.hosts.includes(host)).map((t) => ({
    ...t,
    description: descriptionForHost(t, host),
  }));
}

/** Tool counts per host; the site derives its "N tools" copy from these. */
export const MCP_TOOL_COUNT = toolsForHost("mcp").length;
export const OPENCLAW_TOOL_COUNT = toolsForHost("openclaw").length;

/** Which hosts expose a given parameter (defaults to the tool's hosts). */
export function paramHosts(param: ToolParam, def: CanonicalToolDef): readonly ToolHost[] {
  return param.hosts ?? def.hosts;
}

/** Whether a parameter is exposed on a given host. */
export function paramIncludedForHost(
  param: ToolParam,
  def: CanonicalToolDef,
  host: ToolHost,
): boolean {
  return paramHosts(param, def).includes(host);
}

/** The parameters a given host exposes for a tool, in canonical order. */
export function paramsForHost(def: CanonicalToolDef, host: ToolHost): ToolParam[] {
  return def.params.filter((p) => paramIncludedForHost(p, def, host));
}

/** Whether a parameter is optional on a given host. */
export function paramOptionalForHost(param: ToolParam, host: ToolHost): boolean {
  return param.optionalPerHost?.[host] ?? param.optional ?? false;
}

/**
 * A schema-library-neutral snapshot of the surface a host exposes — the
 * shape used by the divergence-canary test. Any edit to a descriptor
 * (name, description, kind, requiredness, host scope, or a facet) changes
 * this output, so a snapshot diff surfaces the drift for review.
 */
export interface NeutralParamSnapshot {
  name: string;
  kind: ToolParamKind;
  required: boolean;
  description: string;
  format?: "date-time";
  values?: readonly string[];
  itemKind?: "string" | "enum";
  integer?: boolean;
  min?: number;
  max?: number;
  positive?: boolean;
  minLength?: number;
  /** Sub-parameters of an object-kind parameter (recursively snapshotted). */
  properties?: NeutralParamSnapshot[];
}

function neutralParam(p: ToolParam, host: ToolHost): NeutralParamSnapshot {
  return {
    name: p.name,
    kind: p.kind,
    required: !paramOptionalForHost(p, host),
    description: p.description,
    ...(p.format ? { format: p.format } : {}),
    ...(p.values ? { values: p.values } : {}),
    ...(p.itemKind ? { itemKind: p.itemKind } : {}),
    ...(p.integer ? { integer: p.integer } : {}),
    ...(p.min !== undefined ? { min: p.min } : {}),
    ...(p.max !== undefined ? { max: p.max } : {}),
    ...(p.positive ? { positive: p.positive } : {}),
    ...(p.minLength !== undefined ? { minLength: p.minLength } : {}),
    ...(p.properties ? { properties: p.properties.map((sub) => neutralParam(sub, host)) } : {}),
  };
}

export function neutralSurfaceForHost(host: ToolHost): Array<{
  name: string;
  description: string;
  annotations?: ToolAnnotations;
  params: NeutralParamSnapshot[];
}> {
  return toolsForHost(host).map((def) => ({
    name: def.name,
    description: def.description,
    ...(def.annotations ? { annotations: def.annotations } : {}),
    params: paramsForHost(def, host).map((p) => neutralParam(p, host)),
  }));
}
