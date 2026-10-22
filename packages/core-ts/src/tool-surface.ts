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
    "ISO-8601 timestamp (e.g. '2026-05-13T08:00:00-04:00') by which the task must have completed. Must be in the future. Required.",
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
    "Optional hard cap on estimated grams CO2-equivalent for this task. Windows above the cap are dropped before the cleanest is chosen; if none inside the deadline meets the cap the task fails rather than dispatching to a dirty window.",
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
      "Which provider to dispatch this task through: 'anthropic', 'openai', 'gemini', 'ollama' (local), or 'claude-code' (runs through the local Claude Code login on the next `tidegap tick`, no API key; see 'tools'). Defaults to 'claude-code' when the task is queued from a Claude Code session (it then runs in a copy of that session, in its project directory), else 'anthropic'. An explicit 'anthropic' never resumes a session. 'anthropic' and 'openai' can auto-route through a 50%-cheaper Batch API when the deadline allows; 'gemini', 'ollama' and 'claude-code' always dispatch synchronously.",
  },
  {
    name: "provider",
    kind: "enum",
    hosts: ["openclaw"],
    values: ["anthropic", "openai", "gemini", "ollama"],
    optional: true,
    description:
      "Which provider to dispatch this task through: 'anthropic', 'openai', 'gemini', or 'ollama' (local). Defaults to 'anthropic'. 'anthropic' and 'openai' can auto-route through a 50%-cheaper Batch API when the deadline allows; 'gemini' and 'ollama' always dispatch synchronously.",
  },
];

const candidatesParam: ToolParam = {
  name: "candidates",
  kind: "array",
  itemKind: "string",
  optional: true,
  description:
    "Optional cross-provider routing candidates: 'provider:model' strings (e.g. ['anthropic:claude-haiku-4-5','openai:gpt-6-luna','ollama:llama-3-1-8b']) the caller EXPLICITLY allows. With >= 2 entries the scheduler scores them at the chosen dispatch window on a weighted blend of carbon, cost and latency and dispatches the winner (recording the full scored list on the signed receipt). No silent model swaps — routing only ever picks from this list. Absent or a single entry leaves the provider/model behavior unchanged. Every candidate model must exist in the price table or the task is rejected loudly.",
};

const routeWeightsParam: ToolParam = {
  name: "route_weights",
  kind: "object",
  optional: true,
  description:
    "Optional routing weights {carbon, cost, latency}, non-negative and normalized internally. Default {carbon:0.6, cost:0.3, latency:0.1}. Only used when 'candidates' has >= 2 entries.",
  properties: [
    { name: "carbon", kind: "number", min: 0, optional: true, description: "Weight on estimated grams CO2e at the chosen window (non-negative)." },
    { name: "cost", kind: "number", min: 0, optional: true, description: "Weight on estimated USD list cost, batch discount applied when eligible (non-negative)." },
    { name: "latency", kind: "number", min: 0, optional: true, description: "Weight on the static latency tier: local < hosted-sync < hosted-batch (non-negative)." },
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
  `Model to dispatch with (e.g. 'claude-sonnet-5' for Anthropic, 'gpt-6-sol' for OpenAI). Defaults per provider: anthropic '${DEFAULT_MODEL_BY_PROVIDER.anthropic}'${anthropicOverride}, openai '${DEFAULT_MODEL_BY_PROVIDER.openai}', gemini '${DEFAULT_MODEL_BY_PROVIDER.gemini}', ollama '${DEFAULT_MODEL_BY_PROVIDER.ollama}'. When >= 2 'candidates' are supplied, routing may overwrite this with the winning candidate.`;

const taskIdRequired: ToolParam = {
  name: "task_id",
  kind: "string",
  minLength: 1,
  description: "Task identifier returned by schedule_task.",
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
    "How to deliver the result when the task completes — one or more of: chat (the user's active OpenClaw chat), telegram, webhook, file, queue, os (a native desktop notification on the gateway host). Default: chat.",
});

const webhookUrlParam: ToolParam = {
  name: "webhook_url",
  kind: "string",
  optional: true,
  hosts: ["openclaw"],
  description: "Target URL when deliver includes 'webhook'.",
};

const filePathParam: ToolParam = {
  name: "file_path",
  kind: "string",
  optional: true,
  hosts: ["openclaw"],
  description: "Output path when deliver includes 'file'.",
};

const fileFormatParam: ToolParam = {
  name: "file_format",
  kind: "enum",
  values: reportFormats,
  optional: true,
  hosts: ["openclaw"],
  description:
    "Report format for 'file' delivery: md, html, txt, json, or pdf (pdf renders the HTML report via puppeteer if installed on the gateway). Default: md.",
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
          "Electricity Maps grid zone code (e.g. 'US-CAL-CISO', 'US-TEX-ERCO', 'GB', 'FR', 'DE'). Must be a supported zone (`tidegap region list`) unless an Electricity Maps key is configured; an unknown zone is rejected with the closest matches. On hosts that allow omitting it, defaults to the host's configured region, else the stored region setting (`tidegap region set`), else a host-timezone guess, else GB.",
      }),
      {
        name: "hours",
        kind: "number",
        integer: true,
        min: 1,
        max: 72,
        optional: true,
        description: "Forecast horizon in hours (1-72). Defaults to 24.",
      },
    ],
  },
  {
    name: "recommend_window",
    hosts: ["mcp", "openclaw"],
    description:
      "Preview the cleanest run window for a task before its deadline, without queuing it. Use when: the user asks when a task would run or what waiting saves. Do not use to queue the task (use schedule_task) or for the raw hourly curve (use get_grid_forecast). Behavior: writes nothing; reads the grid forecast; no login and no provider key. Returns: JSON with scheduled_for, intensity and band, estimated_carbon_g_co2, estimated_savings_vs_now_pct, batch_eligible, grid_source (mock = synthetic), alternatives, reasoning; routing_preview with 2+ candidates. Rejects a past deadline and an unknown zone.",
    descriptionPerHost: {
      openclaw:
        "Preview the cleanest run window for a task before its deadline, without queuing it. Use when: the user asks when a task would run or what waiting saves. Do not use to queue the task (use schedule_task) or for the raw hourly curve (use get_grid_forecast). Behavior: writes nothing; reads the grid forecast; no provider key needed. Returns: scheduledFor, intensityGCo2PerKwh, band, estimatedCarbonGCo2, estimatedSavingsVsNowPct, batchEligible, gridSource (mock = synthetic), alternatives, reasoning, and routingPreview with 2+ candidates. Throws on a past deadline or an unknown zone.",
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
          "Electricity Maps grid zone code (e.g. 'US-CAL-CISO', 'FR') the recommendation reasons over. Must be a supported zone (`tidegap region list`) unless an Electricity Maps key is configured; an unknown zone is rejected with the closest matches. On hosts that allow omitting it, defaults to the host's configured region, else the stored region setting (`tidegap region set`), else a host-timezone guess, else GB.",
      }),
      carbonBudgetParam,
      modelParam({
        // MCP-only: affects the reasoning string. OpenClaw's recommend_window
        // never exposed a model parameter.
        hosts: ["mcp"],
        description:
          "Optional vendor model name (e.g. 'claude-sonnet-5'). Affects the reasoning string only.",
      }),
      candidatesParam,
      routeWeightsParam,
    ],
  },
  {
    name: "schedule_task",
    hosts: ["mcp", "openclaw"],
    description:
      "Queue an AI task to run at the cleanest grid hour before its deadline; long deadlines go through the provider Batch API at batch price. Use when: the user defers work (\"later\", \"tonight\", \"by tomorrow\", \"no rush\", \"before my limit resets\"); turn that into an ISO-8601 deadline. Do not use for work the user waits on (do it now), to preview only (use recommend_window or dry_run), or to read Claude limits (use tidegap_usage). Behavior: each call adds one task to the local queue (dry_run writes nothing) and reads the grid forecast; no login. The provider call runs later, on `tidegap tick`, with that provider's API key or the Claude Code login. Returns: task_id (for check_queue_status), status, scheduled_for, deadline, region_source, provider, model, runs_in, estimated_carbon_g_co2, a readiness line. Rejects a past deadline, an unknown zone and a disallowed tools set.",
    descriptionPerHost: {
      openclaw:
        "Queue an AI task to run at the cleanest grid hour before its deadline; long deadlines go through the provider Batch API at batch price. Use when: the user defers work (\"later\", \"tonight\", \"by tomorrow\", \"no rush\"); turn that into an ISO-8601 deadline. Do not use for work the user waits on (do it now) or to preview only (use recommend_window). Behavior: each call adds one task to the local queue and reads the grid forecast. The gateway runs it later with the provider key from the plugin config or the OpenClaw runtime. Returns: task_id, status, scheduled_for, region, region_source, provider, model, estimated_carbon_g_co2, grid_source, dispatch, delivery_options and next_step (ask the user, then call set_delivery). Throws on a past deadline, an unknown zone, or a provider with no key when an API key is the only dispatch route.",
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
          "The prompt or task description to dispatch when the chosen window arrives.",
      },
      {
        name: "prompt",
        kind: "string",
        minLength: 1,
        hosts: ["mcp"],
        description:
          "The prompt or task description to dispatch when the chosen window arrives. The run may start in a fresh session without this conversation (the reply's runs_in line says which), so name the files, decisions and constraints the task needs.",
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
          "ISO-8601 timestamp (e.g. '2026-05-13T08:00:00-04:00') by which the task must have completed. Must be in the future. Required unless deadline_kind is 'quota_reset', in which case it is ignored.",
      },
      regionParam({
        // Optional on BOTH hosts for schedule_task.
        optionalPerHost: { mcp: true, openclaw: true },
        description:
          "Grid-region override (Electricity Maps zone code such as 'US-CAL-CISO'); must be a supported zone (`tidegap region list`) unless an Electricity Maps key is configured. Defaults to the host's configured region (MCP: TIDEGAP_DEFAULT_REGION; OpenClaw: defaultRegion), else the stored region setting (`tidegap region set`), else a host-timezone guess, else GB. The reply's region_source names the rule that applied.",
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
          "Claude Code tools for a 'claude-code' run. Allowed names: 'WebSearch', 'WebFetch', 'Read', 'Grep', 'Glob'; [] means no tools. Omit for the default: Read, Grep and Glob inside the session's project directory for a task queued from a Claude Code session; else WebSearch and WebFetch (TIDEGAP_CLAUDE_TOOLS overrides that one). A web tool makes a task from a session run fresh, without the session's context. Any other name (Bash, Write, Edit, ...) is rejected, and so is a set that combines a file tool (Read, Grep, Glob) with a web tool. Web content is untrusted, so tools that run commands or write files are never offered.",
      },
      {
        name: "dry_run",
        kind: "boolean",
        optional: true,
        hosts: ["mcp"],
        description:
          "If true, return the planned dispatch (recommended window + carbon estimate) WITHOUT persisting anything. Useful for confirmation flows.",
      },
      {
        name: "dispatch",
        kind: "boolean",
        optional: true,
        hosts: ["mcp"],
        description:
          "If true (default), persist a provider_call task body that `tidegap tick` (CLI) or scheduler.tick (library) can dispatch. Set to false only to enqueue a placeholder prompt without a dispatchable body (legacy in-memory mode).",
      },
      {
        name: "output_path",
        kind: "string",
        optional: true,
        hosts: ["mcp"],
        description:
          "Optional absolute file path. When the task completes, Tidegap writes { taskId, result, receipt } as JSON to this path.",
      },
      {
        name: "redact_in_receipt",
        kind: "array",
        itemKind: "string",
        optional: true,
        hosts: ["mcp"],
        description:
          "Optional regex patterns to strip from the prompt before storing it on the receipt. Omit to use the default redaction of API-key-looking strings.",
      },
      {
        name: "title",
        kind: "string",
        optional: true,
        hosts: ["mcp"],
        description:
          "Optional short title for the task (shown in queue lists). Defaults to the first line of the prompt, cut to 80 characters. API-key-looking strings are redacted.",
      },
      {
        name: "deadline_kind",
        kind: "enum",
        values: ["absolute", "quota_reset"],
        optional: true,
        hosts: ["mcp"],
        description:
          "How the deadline is chosen. 'absolute' (default): use 'deadline'. 'quota_reset': run before the next weekly subscription-quota reset, minus a safety margin, as configured in ~/.tidegap/config (TIDEGAP_QUOTA_RESET_<LABEL>=<weekday> <HH:MM> [<IANA zone>], optional TIDEGAP_QUOTA_MARGIN_H_<LABEL>=<hours>, default 2). Use it when the user says 'before my weekly limit resets' or similar. A deadline more than 24 hours away can route the task through the provider Batch API.",
      },
      {
        name: "quota_provider",
        kind: "string",
        optional: true,
        hosts: ["mcp"],
        description:
          "Quota label for deadline_kind 'quota_reset' (e.g. 'claude', 'codex'). Optional when exactly one label is configured.",
      },
      {
        name: "repeat",
        kind: "enum",
        values: ["none", "daily", "weekly", "quota_reset"],
        optional: true,
        hosts: ["mcp"],
        description:
          "Repeat rule. Defaults to 'none' (a one-off), also for deadline_kind 'quota_reset'; pass 'weekly' (or 'daily') to repeat. 'quota_reset' follows the weekly quota reset and needs deadline_kind 'quota_reset'. When an occurrence finishes (or is cancelled as a skip), the next one is queued automatically with the same prompt; each occurrence costs one provider call. Stop the series with cancel_task series=true.",
      },
      {
        name: "origin_session_id",
        kind: "string",
        optional: true,
        hosts: ["mcp"],
        description:
          "Claude Code session id of the conversation that queued the task. Optional: the server finds the current session itself when the Tidegap plugin is installed. Pass it only when the host substitutes it (e.g. ${CLAUDE_SESSION_ID} in a slash command); it then wins, and values that are not 8-128 letters, digits, '-' or '_' are ignored.",
      },
      {
        name: "after_limit_reset",
        kind: "boolean",
        optional: true,
        hosts: ["mcp"],
        description:
          "If true, the task does not start before the Claude subscription limit resets (the latest reset of an exhausted 5-hour or weekly window, else the reset of the fuller window; see tidegap_usage); it then runs at the cleanest hour after that. The deadline rises to at least two hours after the reset. Fails, queuing nothing, when no limit state is known.",
      },
      {
        name: "not_before",
        kind: "string",
        format: "date-time",
        optional: true,
        hosts: ["mcp"],
        description:
          "Optional ISO-8601 earliest start: the task does not run before this time, then runs at the cleanest hour between it and the deadline. Must be in the future and at or before the deadline. Use it when the user says 'not before 18:00' or 'after lunch'. Cannot be combined with after_limit_reset.",
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
      "Show the local task queue: every task in brief, or one task in full. Use when: the user asks what is queued, whether a task finished, or for its result. Do not use to change a task (use cancel_task, postpone_task, update_deadline or retry_task) or to read Claude limits (use tidegap_usage). Behavior: no network or login; marks a completed or failed task read when shown, nothing else; never changes a status. Returns: without task_id, status counts, last_tick_at and one line per task; with task_id, its prompt, result, carbon receipt and recent events. Rejects an unknown task_id.",
    descriptionPerHost: {
      openclaw:
        "Show the local task queue: every task in brief, or one task in full. Use when: the user asks what is queued, whether a task finished, or for its result. Do not use to change a task (use cancel_task, update_deadline or retry_task) or to set result delivery (use set_delivery). Behavior: no network or login; marks a completed or failed task read when shown, nothing else; never changes a status. Returns: without task_id, total, last_tick_at and tasks (task_id, title, status, region, scheduled_for); with task_id, its record with prompt, result, receipt and delivery. Throws on an unknown task_id.",
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
          "If present, return only this task. If omitted, return a queue summary.",
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
          "If true, also add claude_spend: tokens and an API list-price cost estimate of the current 5-hour window from the local Claude Code logs (total, by model, the five most recent sessions), and the tokens of recent Codex sessions. The scan takes a few seconds. Default false.",
      },
    ],
  },
  {
    name: "cancel_task",
    hosts: ["mcp", "openclaw"],
    description:
      "Cancel one queued or scheduled task by task_id; to cancel every pending task use cancel_all. Use when: the user drops one task. Do not use to run it later (use postpone_task) or to rerun a failed task (use retry_task). Behavior: marks the task cancelled in the local queue and redacts its stored prompt; no network or login. A finished task comes back unchanged; a repeat call changes nothing. A repeating task skips this occurrence and queues the next; series=true ends the series. Returns: \"Task <id> status: <status>\", terminated_at, and a series line when ended. Rejects an unknown task_id.",
    descriptionPerHost: {
      openclaw:
        "Cancel one queued or scheduled task by task_id; to cancel every pending task use cancel_all. Use when: the user drops one task. Do not use to run it later (use update_deadline) or to rerun a failed task (use retry_task). Behavior: marks the task cancelled in the local queue and redacts its stored prompt; no network or login. A finished task comes back unchanged; a repeat call changes nothing. A repeating task skips this occurrence and queues the next; series=true ends the series. Returns: task_id, status, completed_at, plus series_id and series_ended for a series. Throws on an unknown task_id.",
    },
    annotations: {
      title: "Cancel one task",
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: false,
    },
    params: [
      { ...taskIdRequired, description: "The id of the task to cancel." },
      {
        name: "series",
        kind: "boolean",
        optional: true,
        description:
          "If true and the task repeats, also end its series: no further occurrence is queued. Default false (skip only this occurrence).",
      },
    ],
  },
  {
    name: "expedite_task",
    hosts: ["mcp", "openclaw"],
    description:
      "Run one queued or scheduled task now, skipping its clean-grid window. Use when: the user wants the result now (\"do it now\"). Do not use for a failed task (use retry_task), to pick a new deadline (use update_deadline), or for a claude-code task (run `tidegap queue run-now <id>`). Behavior: makes one provider call at the current grid intensity; needs the task provider's key in the server env (and ANTHROPIC_API_KEY or OPENAI_API_KEY); the receipt records intensitySource=expedited. Returns: status (completed or failed) and error on failure. Rejects running, submitted, finished and unknown tasks.",
    descriptionPerHost: {
      openclaw:
        "Run one queued or scheduled task now, skipping its clean-grid window. Use when: the user wants the result now (\"do it now\", \"don't wait\"). Do not use for a failed task (use retry_task) or to pick a new deadline (use update_deadline). Behavior: makes one provider call at the current grid intensity, through the OpenClaw runtime or a provider key in the plugin config, then delivers the result; the receipt records intensitySource=expedited. Returns: status, error on failure, result, receipt and delivery. Throws on running, submitted, finished and unknown tasks.",
    },
    annotations: {
      title: "Run task now",
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
    params: [{ ...taskIdRequired, description: "The id of the task to dispatch now." }],
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
      { ...taskIdRequired, description: "The id of the task to reschedule." },
      { ...deadlineParam, description: "New ISO-8601 deadline. Must be in the future." },
    ],
  },
  {
    name: "postpone_task",
    hosts: ["mcp"],
    description:
      "Move one queued or scheduled task later; it never runs earlier than planned. Use when: the user says \"tonight\" or \"after my limit resets\"; pass exactly one of preset, until or delay_minutes. Do not use to set a new due time (use update_deadline) or to stop it (use cancel_task). Behavior: rewrites this task's earliest start in the local queue and re-picks the cleanest hour after it; after_limit_reset reads the Claude limits; no login. A repeat delay moves it again. Returns: status, not_before, scheduled_for, deadline. Rejects a target at or before the planned start, finished and unknown tasks.",
    annotations: {
      title: "Postpone task",
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
    params: [
      { ...taskIdRequired, description: "The id of the task to run later." },
      {
        name: "preset",
        kind: "enum",
        values: ["1h", "tonight", "tomorrow_morning", "after_limit_reset"],
        optional: true,
        description: "A Later preset: '1h', 'tonight', 'tomorrow_morning' or 'after_limit_reset'.",
      },
      {
        name: "until",
        kind: "string",
        format: "date-time",
        optional: true,
        description: "An exact ISO-8601 time to run the task at (the user picked a time).",
      },
      {
        name: "delay_minutes",
        kind: "number",
        integer: true,
        min: 1,
        max: 10080,
        optional: true,
        description: "Not before the planned start plus this many minutes (1 to 10080).",
      },
      {
        name: "reset_at",
        kind: "string",
        format: "date-time",
        optional: true,
        description:
          "ISO-8601 time the Claude limit resets, when the user says it ('my limit resets at 15:00'). Only with preset 'after_limit_reset'. Must be in the future; it is remembered for later tasks.",
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
      { ...taskIdRequired, description: "The id of the completed task to reply to." },
      {
        name: "text",
        kind: "string",
        minLength: 1,
        description: "The follow-up message (1 to 32000 characters).",
      },
      {
        ...deadlineParam,
        optional: true,
        description: "Optional ISO-8601 deadline for the reply. Defaults to one hour from now.",
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
    params: [{ ...taskIdRequired, description: "The id of the failed task to retry." }],
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
          "Optional. If set, cancel only tasks in this status. Valid: 'queued', 'scheduled'. Defaults to both.",
      },
    ],
  },
  {
    // OpenClaw-only: the MCP server has no result-delivery subsystem.
    name: "set_delivery",
    hosts: ["openclaw"],
    description:
      "Set or change how a scheduled task's result is delivered when it completes. Call this right after schedule_task, once you have ASKED the user how they want the result. The user may pick several modes. Modes: chat (their active OpenClaw chat), telegram, webhook (needs webhook_url), file (needs file_path; format md/html/txt/json/pdf), queue (no push — retrievable via check_queue_status), os (a native desktop notification on the gateway host). PRIVACY BOUNDARY — queue is the only mode that transmits nothing (the result stays in the local ledger; read it back with check_queue_status). chat delivers through the gateway's configured chat channel, which on a Telegram-backed gateway is the SAME Telegram Bot API path as the telegram mode — do not describe chat to the user as staying inside OpenClaw. telegram sends the FULL result to a third-party service, webhook POSTs the FULL result to whatever URL is supplied (Tidegap does not restrict or inspect that destination), and file writes it to any path on the gateway host. Never pick telegram, webhook or file on the user's behalf: confirm the destination with them first, and for sensitive tasks prefer queue. Default if the user is unsure: chat.",
    params: [
      { ...taskIdRequired, description: "The id returned by schedule_task." },
      { ...deliverParam(false), description: "One or more delivery modes the user chose." },
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
