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
 * (names, parameter sets, requiredness, descriptions) is unified.
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

/** One tool: its wire name, canonical description, host applicability, and
 *  the ordered parameter descriptors. */
export interface CanonicalToolDef {
  name: string;
  description: string;
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
      "Which provider to dispatch this task through: 'anthropic', 'openai', 'gemini', 'ollama' (local), or 'claude-code' (runs through the local Claude Code login on the next `tidegap tick`, no API key, read-only web tools by default; see 'tools'). Defaults to 'anthropic'. 'anthropic' and 'openai' can auto-route through a 50%-cheaper Batch API when the deadline allows; 'gemini', 'ollama' and 'claude-code' always dispatch synchronously.",
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
      "Return the projected electricity-grid carbon intensity for a region, hour by hour. Use this when deciding whether to run an expensive AI task now or defer it — intensity is reported in grams CO2-equivalent per kWh with a categorical band (very_clean / clean / average / dirty / very_dirty). Read-only; does not touch the task queue.",
    params: [
      regionParam({
        // Required on the MCP server; optional on OpenClaw, which defaults a
        // missing region from its config / the host timezone (else GB).
        optionalPerHost: { mcp: false, openclaw: true },
        description:
          "Electricity Maps grid zone code (e.g. 'US-CAL-CISO', 'US-TEX-ERCO', 'GB', 'FR', 'DE'). On hosts that allow omitting it, defaults to the configured region, else a host-timezone guess, else GB.",
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
      "Return the optimal carbon-aware execution window for a task WITHOUT scheduling it. Use this for non-committal planning — to see when the cleanest grid moment falls inside the deadline (and the savings vs running now) before deciding whether to commit via schedule_task. Returns the chosen window, top alternatives, a batch_eligible flag, the grid_source (which feed produced the forecast — 'mock' means synthetic data), and a one-line reasoning string. Read-only; does not touch the task queue.",
    params: [
      deadlineParam,
      regionParam({
        // Required on the MCP server (with a non-empty check); OpenClaw
        // historically made it optional — kept as-is.
        optionalPerHost: { mcp: false, openclaw: true },
        minLength: 1,
        description:
          "Electricity Maps grid zone code (e.g. 'US-CAL-CISO', 'FR') the recommendation reasons over. On hosts that allow omitting it, defaults to the configured region, else a host-timezone guess, else GB.",
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
      "Queue an AI task to run during off-peak hours inside the given deadline. Three parallel wins: (1) lighter on the electricity grid — deferring non-urgent tasks smooths projected AI compute demand; (2) 50% of sync list price (projected) — auto-routes through Anthropic/OpenAI Batch APIs when the deadline allows; (3) lower carbon — dispatch at the cleanest electricity-grid hour. Invoke this tool whenever the user phrases a request with deferral language: \"do this later\", \"by tomorrow\", \"tonight\", \"overnight\", \"by EOD\", \"sometime this week\", \"when you have a moment\", \"remind me to\", \"queue this up\", \"schedule this\", \"no rush\", \"not urgent\". Convert the user's wording to an ISO-8601 deadline and pass the task as the prompt. Returns a task_id you can later check with check_queue_status. Good fits: nightly digests, batch summaries, research sweeps, evaluator runs, multi-step report generation — anything the user is fine waiting on. Do NOT use for live chat, interactive code edits, or any task the user is actively waiting to see complete.",
    params: [
      {
        name: "prompt",
        kind: "string",
        minLength: 1,
        description:
          "The prompt or task description to dispatch when the chosen window arrives.",
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
          "Grid-region override (Electricity Maps zone code such as 'US-CAL-CISO'). Defaults to the host's configured region, else a host-timezone guess, else GB.",
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
          "Claude Code tools for a 'claude-code' run. Allowed names: 'WebSearch', 'WebFetch', 'Read', 'Grep', 'Glob'; [] means no tools. Omit for the default, WebSearch and WebFetch (TIDEGAP_CLAUDE_TOOLS overrides it). Any other name (Bash, Write, Edit, ...) is rejected, and so is a set that combines a file tool (Read, Grep, Glob) with a web tool. Web content is untrusted, so tools that run commands or write files are never offered.",
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
          "Claude Code session id of the conversation that queued the task, so the task detail can show `claude --resume <id>`. Pass it only when the host substitutes it (e.g. ${CLAUDE_SESSION_ID} in a slash command); values that are not 8-128 letters, digits, '-' or '_' are ignored.",
      },
      {
        name: "after_limit_reset",
        kind: "boolean",
        optional: true,
        hosts: ["mcp"],
        description:
          "If true, the task does not start before the Claude subscription limit resets (the latest reset of an exhausted 5-hour or weekly window, else the reset of the fuller window; see tidegap_usage); it then runs at the cleanest hour after that. The deadline rises to at least two hours after the reset. Fails, queuing nothing, when no limit state is known.",
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
      "Report on the Tidegap task queue. With no arguments, returns a summary of all known tasks (including tasks persisted by previous sessions — the queue survives host restarts). With task_id, returns full detail for one task, including its title, prompt, result and any carbon receipt (estimated vs actual grams, grid_source, energy_source); viewing a completed or failed task marks it read. Never changes a task's status.",
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
      "Read-only: report the Claude Code subscription limits of this machine's login: percent used of the 5-hour and weekly windows (and per-model weekly windows when known), when each resets, how old the reading is, and the time schedule_task's after_limit_reset would wait for. Returns the usage/v1 JSON document with a one-line summary. Never changes anything. Use it before queuing heavy Claude Code work: if a window is at 90% or more, schedule with after_limit_reset.",
    params: [],
  },
  {
    name: "cancel_task",
    hosts: ["mcp", "openclaw"],
    description:
      "Cancel a queued or scheduled task. Idempotent — if the task is already completed/failed/cancelled this returns the existing status without error. Throws only if task_id is unknown. Cancelling one occurrence of a repeating task skips it and queues the next one; pass series=true to end the series.",
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
      "Dispatch a queued or scheduled provider-call task immediately, bypassing the scheduler's chosen carbon window. The resulting receipt records intensitySource='expedited'. Only provider-call tasks still queued/scheduled can be expedited; running, submitted (awaiting Batch API results), or terminal (completed/failed/cancelled) tasks are rejected with an explanatory error.",
    params: [{ ...taskIdRequired, description: "The id of the task to dispatch now." }],
  },
  {
    name: "update_deadline",
    hosts: ["mcp", "openclaw"],
    description:
      "Re-score and reschedule a queued or scheduled task against a new deadline; the scheduler re-picks the cleanest window inside it. Throws if the task is already running or terminal, or if the new deadline is invalid or in the past.",
    params: [
      { ...taskIdRequired, description: "The id of the task to reschedule." },
      { ...deadlineParam, description: "New ISO-8601 deadline. Must be in the future." },
    ],
  },
  {
    name: "reply_task",
    hosts: ["mcp", "openclaw"],
    description:
      "Continue a completed task's conversation: creates a NEW task that sends the earlier prompt, the model's reply and this text to the same provider and model, and runs at the next clean window before its deadline (default one hour). Costs one provider call. Only completed tasks accept a reply; failed or cancelled tasks are rejected. Returns the new task id and its scheduled time.",
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
      "Re-dispatch a failed provider-call task. Only valid when the task's current status is 'failed' — queued/scheduled/running/submitted/completed tasks are rejected with an explanatory error. The new run's receipt overwrites the old.",
    params: [{ ...taskIdRequired, description: "The id of the failed task to retry." }],
  },
  {
    name: "cancel_all",
    hosts: ["mcp", "openclaw"],
    description:
      "Bulk-cancel every task in the queue that is still cancellable (status queued or scheduled). Running/completed/failed/cancelled tasks are left untouched. Optionally filter by status. Returns the number of tasks cancelled.",
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

/** The tools a given host registers, in canonical order. */
export function toolsForHost(host: ToolHost): CanonicalToolDef[] {
  return TOOL_SURFACE.filter((t) => t.hosts.includes(host));
}

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
  params: NeutralParamSnapshot[];
}> {
  return toolsForHost(host).map((def) => ({
    name: def.name,
    description: def.description,
    params: paramsForHost(def, host).map((p) => neutralParam(p, host)),
  }));
}
