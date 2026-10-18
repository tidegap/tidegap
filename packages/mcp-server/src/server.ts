#!/usr/bin/env node
/**
 * tidegap-mcp — Model Context Protocol server for carbon-aware AI task scheduling.
 *
 * Exposes ten tools to any MCP-compatible agent (Claude Desktop,
 * Claude Code, OpenClaw, Cursor, custom MCP clients):
 *
 *   - get_grid_forecast(region, hours?) → forecasted carbon intensity
 *   - recommend_window(deadline, region, ...) → planning-only window pick
 *   - schedule_task(prompt, deadline, ...) → enqueue (or dry-run preview)
 *   - check_queue_status(task_id?) → status / receipts
 *   - cancel_task / cancel_all / expedite_task / update_deadline / retry_task
 *   - reply_task(task_id, text, deadline?) → continue a completed task
 *
 * The server reads `TIDEGAP_ELECTRICITY_MAPS_API_KEY` from the environment; if
 * absent, it transparently falls back to a deterministic mock grid feed so
 * the whole stack still runs end-to-end.
 *
 * This module is import-safe: nothing connects to stdio (and no scheduler
 * or SQLite store is constructed) unless the file is executed directly.
 * Tests import `createEbbServer` / `TOOL_DEFINITIONS` and exercise the
 * real handlers over an in-memory transport.
 */

import { mkdirSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import {
  AnthropicAdapter,
  assessReadiness,
  buildDefaultGridFeed,
  claudeCodeToolsError,
  NEEDS_RESET_TIME,
  deadlineKindLabel,
  DEFAULT_CLAUDE_CODE_TOOLS,
  DEFAULT_MODEL_BY_PROVIDER,
  GeminiAdapter,
  loadQuotaResetConfig,
  OllamaAdapter,
  OpenAIAdapter,
  localTimeLabel,
  paramOptionalForHost,
  pendingProvidersFromStore,
  readTickRunners,
  runnersFromSnapshot,
  snapshotIsFresh,
  TaskStore,
  paramsForHost,
  loadCarbonBudgetConfig,
  recommendWindow,
  resolveQuotaDeadline,
  resolveQuotaProvider,
  resolveRegion,
  resolveTidegapHome,
  resumeCommand,
  Scheduler,
  stripControlChars,
  taskProvider,
  taskPrompt,
  toolsForHost,
  type CanonicalToolDef,
  type CarbonBudgetConfig,
  type CarbonBudgetStatus,
  type GridForecast,
  type PostponePreset,
  type PostponeTarget,
  type ProviderCallSpec,
  type ProviderName,
  type QuotaResetConfig,
  type Readiness,
  type RepeatRule,
  type TaskRecord,
  type TickAdapters,
  type ToolParam,
} from "@tidegap/core";
import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";

import {
  clockLabel,
  hostResetTarget,
  readUsageDocument,
  usageLimitResetSource,
  windowLabel,
  type UsageDocumentOptions,
} from "@tidegap/cli/usage";
import {
  describeRunsIn,
  effectiveTools,
  findAncestorPid,
  planRun,
  readCapture,
  resumeSettings,
  type SessionFs,
} from "@tidegap/cli/session";
import { readEnvCredentials, readOriginEnv, readUsageEnv, type ProviderCredentials } from "./env.js";
import { resolveOrigin, type OriginSources, type ResolvedOrigin } from "./origin.js";

/** The grid-feed interface is not re-exported by @tidegap/core's index;
 *  derive it structurally from the factory we already import. */
type GridFeed = ReturnType<typeof buildDefaultGridFeed>;

/**
 * Server version — read from this package's own package.json at runtime so
 * lockstep version bumps can never drift the advertised version. Sole
 * source of truth for both the MCP `serverInfo` field and the stderr
 * ready banner.
 */
const requireFromHere = createRequire(import.meta.url);
export const SERVER_VERSION: string = (
  requireFromHere("../package.json") as { version: string }
).version;

/**
 * Resolve where the scheduler should store its persistent queue. v0.7.1
 * makes persistence the default — without it, every MCP server restart
 * dropped the entire queue (one of the loudest UX bugs reported). The
 * order:
 *
 *   1. `TIDEGAP_DB_PATH` env var if set (explicit path, used unchanged).
 *   2. `~/.tidegap/queue.db` otherwise. Parent directory is created if
 *      missing so the first call doesn't crash with ENOENT.
 *
 * To opt out of persistence and use the old in-memory mode, set
 * `TIDEGAP_DB_PATH=:memory:` — the SQLite driver treats that as an ephemeral
 * database. Mostly useful for tests.
 *
 * If the parent directory cannot be created, we genuinely fall back to
 * in-memory mode (dbPath: undefined → the Scheduler constructs no store)
 * instead of crashing on first use of a dead path; the caller surfaces
 * `fallbackNote` in the ready banner so the operator knows persistence is
 * off.
 */
export function resolveStartupDb(explicit = readEnvCredentials().dbPath): {
  dbPath: string | undefined;
  fallbackNote?: string;
} {
  const requested = explicit ?? join(resolveTidegapHome(), "queue.db");
  if (requested === ":memory:") return { dbPath: ":memory:" };
  try {
    mkdirSync(dirname(requested), { recursive: true });
    return { dbPath: requested };
  } catch (err) {
    return {
      dbPath: undefined,
      fallbackNote:
        `could not create ${dirname(requested)} ` +
        `(${err instanceof Error ? err.message : String(err)})`,
    };
  }
}

/**
 * Build the dispatch adapters from host-supplied credentials.
 *
 * `@tidegap/core` no longer reads the environment, so the MCP server (the host)
 * reads it once via `readEnvCredentials()` and injects the values here. The
 * registration rules are unchanged: an adapter appears exactly when its
 * credential is present, Gemini prefers GEMINI_API_KEY over GOOGLE_API_KEY,
 * and Ollama is an explicit OLLAMA_HOST opt-in.
 */
export function buildAdapters(
  creds: ProviderCredentials = readEnvCredentials(),
): TickAdapters {
  const out: TickAdapters = {};
  if (creds.anthropicApiKey) {
    out.anthropic = new AnthropicAdapter({ apiKey: creds.anthropicApiKey });
  }
  if (creds.openaiApiKey) {
    out.openai = new OpenAIAdapter({ apiKey: creds.openaiApiKey });
  }
  // Gemini reads GEMINI_API_KEY, falling back to GOOGLE_API_KEY (resolved in
  // readEnvCredentials, so `geminiApiKey` here is already the winner).
  if (creds.geminiApiKey) {
    out.gemini = new GeminiAdapter({ apiKey: creds.geminiApiKey });
  }
  // Ollama is local + keyless: register it only when OLLAMA_HOST is set, an
  // explicit opt-in that a local server is being run. (The adapter still
  // defaults to http://localhost:11434 when constructed.)
  if (creds.ollamaHost) out.ollama = new OllamaAdapter({ host: creds.ollamaHost });
  return out;
}

// ─── Tool input schemas (derived from @tidegap/core's canonical surface) ─────
//
// The tool surface — names, descriptions, parameter sets, requiredness — is
// the single source of truth shared with the OpenClaw plugin
// (`@tidegap/core`'s tool-surface module, audit §2.2). Here we render each
// tool's neutral parameter descriptors into the zod validators the MCP server
// both parses incoming arguments with AND advertises (via zod-to-json-schema).
//
// The MCP renderer is the STRICT one: it applies every facet the descriptor
// carries (date-time format, string min-length, integer bounds, positivity),
// so `.parse()` accepts/rejects exactly what it always did. (Audit §1.9: the
// previous hand-written JSON schema for schedule_task silently omitted 5
// implemented parameters — deriving the schema forecloses that class of drift.)

/** Render one neutral parameter descriptor into its MCP zod validator. */
function buildZodField(param: ToolParam): z.ZodTypeAny {
  let base: z.ZodTypeAny;
  switch (param.kind) {
    case "string": {
      let s = z.string();
      if (param.minLength !== undefined) s = s.min(param.minLength);
      if (param.format === "date-time") s = s.datetime({ offset: true });
      base = s;
      break;
    }
    case "number": {
      let n = z.number();
      if (param.integer) n = n.int();
      if (param.min !== undefined) n = n.min(param.min);
      if (param.max !== undefined) n = n.max(param.max);
      if (param.positive) n = n.positive();
      base = n;
      break;
    }
    case "boolean":
      base = z.boolean();
      break;
    case "enum":
      base = z.enum(param.values as [string, ...string[]]);
      break;
    case "array":
      base =
        param.itemKind === "enum"
          ? z.array(z.enum(param.values as [string, ...string[]]))
          : z.array(z.string());
      break;
    case "object": {
      const shape: z.ZodRawShape = {};
      for (const sub of param.properties ?? []) {
        shape[sub.name] = buildZodField(sub);
      }
      base = z.object(shape);
      break;
    }
  }
  base = base.describe(param.description);
  return paramOptionalForHost(param, "mcp") ? base.optional() : base;
}

/** Render a canonical tool's MCP parameters into a zod object validator. */
function buildMcpSchema(def: CanonicalToolDef): z.ZodObject<z.ZodRawShape> {
  const shape: z.ZodRawShape = {};
  for (const param of paramsForHost(def, "mcp")) {
    shape[param.name] = buildZodField(param);
  }
  return z.object(shape);
}

/** One advertised MCP tool: name + description + the zod validator that is
 *  also used to parse incoming arguments. Derived from the shared surface. */
export interface ToolDefinition {
  name: string;
  description: string;
  schema: z.ZodObject<z.ZodRawShape>;
}

export const TOOL_DEFINITIONS: ReadonlyArray<ToolDefinition> = toolsForHost(
  "mcp",
).map((def) => ({
  name: def.name,
  description: def.description,
  schema: buildMcpSchema(def),
}));

/** The zod validator for a tool, by name. */
const SCHEMA_BY_NAME: ReadonlyMap<string, z.ZodObject<z.ZodRawShape>> = new Map(
  TOOL_DEFINITIONS.map((d) => [d.name, d.schema]),
);

function schemaOf(name: string): z.ZodObject<z.ZodRawShape> {
  const schema = SCHEMA_BY_NAME.get(name);
  if (!schema) throw new Error(`no MCP schema for tool: ${name}`);
  return schema;
}

/**
 * Convert a zod object validator into the JSON schema advertised over MCP.
 * `$refStrategy: "none"` inlines everything (MCP clients don't resolve
 * refs); the draft-07 `$schema` marker is stripped because the MCP spec
 * carries its own envelope.
 */
export function toInputSchema(
  schema: z.ZodTypeAny,
): { type: "object"; [k: string]: unknown } {
  const json = zodToJsonSchema(schema, { $refStrategy: "none" }) as Record<
    string,
    unknown
  >;
  delete json.$schema;
  return json as { type: "object"; [k: string]: unknown };
}

/** The exact tool list served to ListTools clients. */
export function buildToolList(): Array<{
  name: string;
  description: string;
  inputSchema: { type: "object"; [k: string]: unknown };
}> {
  return TOOL_DEFINITIONS.map((def) => ({
    name: def.name,
    description: def.description,
    inputSchema: toInputSchema(def.schema),
  }));
}

/**
 * Every task this scheduler knows about: the persisted ledger (survives
 * MCP-host restarts — audit §0.10) plus any in-memory-only tasks (present
 * only when the scheduler runs without a store). Persisted rows win on id
 * collision.
 */
function listKnownTasks(scheduler: Scheduler): TaskRecord<unknown>[] {
  const persisted = scheduler.listPersistedTasks();
  const ids = new Set(persisted.map((t) => t.taskId));
  const memoryOnly = scheduler.listTasks().filter((t) => !ids.has(t.taskId));
  return [...persisted, ...memoryOnly];
}

/**
 * Tick interval the MCP server assumes. It cannot see the daemon unit
 * (KTD2: ledger only), so it uses the daemon's 300 s: a tick a few minutes
 * old is never reported as "no tick daemon" (R2: problems only on evidence).
 */
const LEDGER_TICK_INTERVAL_S = 300;

/**
 * Readiness from the ledger only (coherence KTD2): the last tick, the
 * tick's runner snapshot while fresh, and the pending tasks. The daemon is
 * "unknown" here, so a ledger nobody ticked reads as "no tick daemon".
 */
export function ledgerReadiness(
  scheduler: Scheduler,
  store: Pick<TaskStore, "getMeta"> | undefined,
  now: Date = new Date(),
): Readiness {
  const snapshot = store ? readTickRunners(store) : null;
  const tasks = listKnownTasks(scheduler);
  return assessReadiness({
    daemon: "unknown",
    lastTickAt: scheduler.lastTickAt() ?? null,
    tickIntervalS: LEDGER_TICK_INTERVAL_S,
    runners:
      snapshot && snapshotIsFresh(snapshot, now, LEDGER_TICK_INTERVAL_S) ? runnersFromSnapshot(snapshot) : null,
    pendingByProvider: pendingProvidersFromStore({ list: ({ status }) => tasks.filter((t) => t.status === status) }),
    now,
  });
}

/**
 * The closing line of a schedule reply (R6): the readiness sentence when
 * tasks will not run, else when this one runs.
 */
export function readinessReplyLine(readiness: Readiness, record: TaskRecord<unknown>, now: Date = new Date()): string {
  if (!readiness.ready) return readiness.line ?? "Tasks will not run.";
  const at = record.scheduledFor ? new Date(record.scheduledFor) : undefined;
  return at && at.getTime() > now.getTime()
    ? `Runs at ${localTimeLabel(at, now)} local.`
    : "Runs on the next tick.";
}

/** Best-effort probe of which grid feed serves this region — used purely
 *  for provenance in tool responses. Never throws. */
async function fetchGridSource(
  feed: GridFeed,
  region: string,
): Promise<
  { source: GridForecast["source"]; signalType: GridForecast["signalType"] } | undefined
> {
  try {
    const forecast = await feed.fetchForecast(region, 1);
    return { source: forecast.source, signalType: forecast.signalType };
  } catch {
    return undefined;
  }
}

/** Render a grid_source line, disclosing mock + marginal signals honestly. */
function formatGridSourceLine(
  info: Awaited<ReturnType<typeof fetchGridSource>>,
): string {
  const source = info?.source ?? "unknown";
  const mockTail = source === "mock" ? `\n${SYNTHETIC_GRID_WARNING}` : "";
  const marginalTail =
    info?.signalType === "marginal"
      ? " (marginal-emissions signal — not an average-grid figure)"
      : "";
  return `grid_source: ${source}${marginalTail}${mockTail}`;
}

const SYNTHETIC_GRID_WARNING =
  "⚠ SYNTHETIC (mock) grid data — no live grid feed was available for this region, " +
  "so the carbon numbers above are illustrative, not measured. " +
  "Set TIDEGAP_ELECTRICITY_MAPS_API_KEY (or another supported feed key) for real intensity.";

export interface EbbServerDeps {
  /** Grid feed. Defaults to buildDefaultGridFeed() (live feeds when keys
   *  are configured, deterministic mock otherwise). */
  feed?: GridFeed;
  /** Pre-built scheduler (tests). When set, `dbPath` is not used to
   *  construct one. */
  scheduler?: Scheduler;
  /** SQLite ledger path. undefined → pure in-memory scheduler (no store);
   *  ":memory:" → ephemeral SQLite store. */
  dbPath?: string;
  defaultRegion?: string;
  /** Anthropic default model; other providers use DEFAULT_MODEL_BY_PROVIDER. */
  defaultModel?: string;
  /** Aggregate carbon-budget config (tests). Defaults to `loadCarbonBudgetConfig()`. */
  carbonBudget?: CarbonBudgetConfig;
  /**
   * Quota-reset config path (tests). Defaults to `~/.tidegap/config`. Read on
   * each quota-aware call so config edits apply without a restart.
   */
  quotaConfigPath?: string;
  /** Usage read overrides (tests): cache path, config path, env, fetch, log home. */
  usage?: UsageDocumentOptions;
  /** Origin capture overrides (tests): env, ancestor pid, capture reader, cwd. */
  origin?: Partial<OriginSources>;
  /** File access of the `runs_in:` preview (tests). */
  sessionFs?: SessionFs;
}

/** True under a test runner: no test walks the real process tree. */
function underTest(): boolean {
  return process.env.VITEST !== undefined || process.env.NODE_ENV === "test";
}

/** The origin sources of this process; the ancestor `claude` is looked up once. */
function originSources(over: Partial<OriginSources> = {}): OriginSources {
  let pid: number | undefined | null = null;
  return {
    env: over.env ?? readOriginEnv(),
    claudePid:
      over.claudePid ??
      (() => {
        if (pid === null) pid = underTest() ? undefined : findAncestorPid("claude");
        return pid;
      }),
    readCapture: over.readCapture ?? ((p) => readCapture(p)),
    fallbackCwd: over.fallbackCwd ?? (() => originCwd()),
  };
}

/**
 * The `runs_in:` reply line (R10): where the task is expected to run, by the
 * same rule the claude-code adapter applies at the clean hour (KTD8).
 */
function runsInLine(
  provider: ProviderName,
  origin: ResolvedOrigin,
  tools: string[] | undefined,
  sources: OriginSources,
  fs: SessionFs | undefined,
): string {
  const settings = resumeSettings({
    resume: sources.env.resume,
    maxTokens: sources.env.resumeMaxTokens,
    claudeConfigDir: sources.env.claudeConfigDir,
  });
  const runTools = effectiveTools(tools, origin.run, DEFAULT_CLAUDE_CODE_TOOLS);
  const plan = planRun({ provider, origin: origin.run, tools: runTools, settings, ...(fs ? { fs } : {}) });
  const warning = origin.warning ? `warning: ${origin.warning}\n` : "";
  return `runs_in: ${describeRunsIn(plan, origin.run, runTools, settings)}\n${warning}`;
}

/**
 * The refusal of `expedite_task` / `retry_task` for a `claude-code` task:
 * this server has no Claude Code adapter, so the task stays as it is and
 * the reply names the CLI command that runs it. Undefined for other tasks.
 */
function claudeCodeRefusal(scheduler: Scheduler, taskId: string, tool: string) {
  const record = scheduler.getTask(taskId);
  if (!record || taskProvider(record) !== "claude-code") return undefined;
  return {
    content: [
      {
        type: "text" as const,
        text:
          `${tool} rejected: task ${taskId} runs through Claude Code, which only \`tidegap tick\` can start. ` +
          `Run \`tidegap queue run-now ${taskId}\` to run it on the next tick.`,
      },
    ],
    isError: true,
  };
}

/**
 * The working directory to record as a task's origin: the host's project
 * directory (MCP hosts launch servers from the workspace). `/` and the home
 * directory carry no information, so they are not stored.
 */
export function originCwd(cwd: string = process.cwd()): string | undefined {
  return cwd === "/" || cwd === homedir() ? undefined : cwd;
}

/**
 * Build the real tidegap-mcp Server with all nine tool handlers registered.
 * Extracted from main() so tests can drive the actual handlers over an
 * InMemoryTransport instead of re-implementing a stub.
 */
export function createEbbServer(deps: EbbServerDeps = {}): {
  server: Server;
  scheduler: Scheduler;
  feed: GridFeed;
  dbPath: string | undefined;
  defaultRegion: string;
  defaultModel: string;
} {
  // The MCP server is the HOST: it reads its environment here, once, and
  // injects the values into the environment-pure core library.
  const env = readEnvCredentials();
  const feed = deps.feed ?? buildDefaultGridFeed(env.grid);
  // When TIDEGAP_DEFAULT_REGION is unset, guess the region from the host
  // timezone (shared with the CLI and the OpenClaw plugin) instead of
  // hard-coding one — falls back to GB.
  const defaultRegion =
    deps.defaultRegion ??
    resolveRegion(undefined, env.defaultRegion).region;
  // Anthropic default: injected > TIDEGAP_DEFAULT_MODEL > the shared map. Other
  // providers always take their own entry, so a task never carries another
  // vendor's model id (TIDEGAP_DEFAULT_MODEL is an Anthropic override only).
  const defaultModel =
    deps.defaultModel ??
    env.defaultModel ??
    DEFAULT_MODEL_BY_PROVIDER.anthropic;
  const defaultModelFor = (provider: ProviderName): string =>
    provider === "anthropic" ? defaultModel : DEFAULT_MODEL_BY_PROVIDER[provider];
  const dbPath = deps.dbPath;
  // Aggregate carbon-budget config (ROADMAP item 4): loaded so
  // check_queue_status can render a budget block. The MCP server does not
  // tick, so no onCarbonAlert hook is wired here — alerts fire from the
  // tickers (tidegap tick / the OpenClaw plugin). Display-only.
  const carbonBudget: CarbonBudgetConfig | undefined =
    deps.carbonBudget ?? loadCarbonBudgetConfig({ env: env.carbonBudget });
  const loadQuota = (): QuotaResetConfig =>
    loadQuotaResetConfig(
      deps.quotaConfigPath !== undefined ? { path: deps.quotaConfigPath } : {},
    );
  // The server keeps the store handle so readiness can read ledger meta
  // (the tick's runner snapshot); the scheduler owns and closes it.
  const store = deps.scheduler === undefined && dbPath ? new TaskStore({ dbPath }) : undefined;
  const scheduler =
    deps.scheduler ??
    new Scheduler({
      feed,
      defaultRegion,
      // cancel_task skips a series occurrence, which rolls a quota_reset
      // series to the label's next reset (ui v2).
      quotaConfig: loadQuota,
      // postpone_task after_limit_reset reads this machine's Claude limits.
      limitReset: usageLimitResetSource({ env: readUsageEnv(), ...deps.usage }),
      ...(store ? { store } : {}),
      ...(carbonBudget ? { carbonBudget } : {}),
    });
  const persistedAt =
    dbPath === undefined || dbPath === ":memory:" ? "(in-memory)" : dbPath;
  const origins = originSources(deps.origin);

  const server = new Server(
    { name: "tidegap", version: SERVER_VERSION },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: buildToolList(),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const name = req.params.name;
    const args = req.params.arguments ?? {};

    try {
      if (name === "get_grid_forecast") {
        const parsed = schemaOf("get_grid_forecast").parse(args) as {
          region: string;
          hours?: number;
        };
        const hours = parsed.hours ?? 24;
        const forecast = await feed.fetchForecast(parsed.region, hours);
        return {
          content: [
            {
              type: "text",
              text: formatForecast(forecast),
            },
          ],
        };
      }

      if (name === "recommend_window") {
        const parsed = schemaOf("recommend_window").parse(args) as {
          deadline: string;
          region: string;
          carbon_budget_g?: number;
          model?: string;
          candidates?: string[];
          route_weights?: { carbon?: number; cost?: number; latency?: number };
        };
        try {
          const result = await recommendWindow(
            {
              deadline: parsed.deadline,
              region: parsed.region,
              carbonBudgetG: parsed.carbon_budget_g,
              model: parsed.model,
              candidates: parsed.candidates,
              routeWeights: parsed.route_weights,
            },
            { feed },
          );
          return {
            content: [
              { type: "text", text: formatRecommendation(result) },
            ],
          };
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          return {
            content: [
              { type: "text", text: `recommend_window rejected: ${msg}` },
            ],
            isError: true,
          };
        }
      }

      if (name === "schedule_task") {
        const parsed = schemaOf("schedule_task").parse(args) as {
          prompt: string;
          deadline?: string;
          title?: string;
          deadline_kind?: "absolute" | "quota_reset";
          quota_provider?: string;
          model?: string;
          region?: string;
          carbon_budget_g?: number;
          dry_run?: boolean;
          dispatch?: boolean;
          provider?: ProviderName;
          output_path?: string;
          redact_in_receipt?: string[];
          candidates?: string[];
          route_weights?: { carbon?: number; cost?: number; latency?: number };
          repeat?: RepeatRule;
          origin_session_id?: string;
          after_limit_reset?: boolean;
          not_before?: string;
          tools?: string[];
        };
        try {
          // Checked before dry_run too, so a preview never shows a tool set
          // the real enqueue would refuse.
          const toolsError = parsed.tools !== undefined ? claudeCodeToolsError(parsed.tools) : undefined;
          if (toolsError) throw new Error(toolsError);
          // Resolve the deadline. A quota_reset task gets the next reset
          // minus margin from ~/.tidegap/config; `tidegap tick` re-resolves it if
          // that reset passes before the task runs.
          let deadline: string;
          let quotaLine = "";
          const kindOpts: {
            deadlineKind?: "absolute" | "quota_reset";
            quotaProvider?: string;
          } = {};
          if (parsed.deadline_kind === "quota_reset") {
            const pick = resolveQuotaProvider(loadQuota(), parsed.quota_provider);
            if (!pick.ok) throw new Error(pick.error);
            const resolved = resolveQuotaDeadline(pick.schedule, new Date());
            deadline = resolved.deadline.toISOString();
            kindOpts.deadlineKind = "quota_reset";
            kindOpts.quotaProvider = pick.schedule.label;
            quotaLine =
              `deadline_kind: quota reset (${pick.schedule.label}), ` +
              `reset_at ${resolved.resetAt.toISOString()}, margin_h ${pick.schedule.marginH}\n`;
          } else {
            if (parsed.quota_provider !== undefined) {
              throw new Error(`quota_provider is only valid with deadline_kind "quota_reset"`);
            }
            if (!parsed.deadline) {
              throw new Error(`deadline is required unless deadline_kind is "quota_reset"`);
            }
            deadline = parsed.deadline;
          }
          // after_limit_reset: the earliest start is the Claude limit reset
          // (KTD5). No limit state refuses, and nothing is queued.
          let notBefore: Date | undefined;
          let resetLine = "";
          if (parsed.not_before !== undefined) {
            if (parsed.after_limit_reset) throw new Error("pass not_before or after_limit_reset, not both");
            if (parsed.dispatch === false) throw new Error("not_before needs a persisted task (omit dispatch=false)");
            const now = new Date();
            const at = new Date(parsed.not_before);
            if (Number.isNaN(at.getTime())) throw new Error("not_before is not an ISO-8601 instant");
            if (at.getTime() <= now.getTime()) throw new Error(`not_before ${parsed.not_before} is not in the future`);
            if (at.getTime() > Date.parse(deadline)) {
              throw new Error(`not_before ${parsed.not_before} is after the deadline ${deadline}`);
            }
            notBefore = at;
            resetLine = `not_before: ${at.toISOString()} (${clockLabel(at, now)} local)\n`;
          }
          if (parsed.after_limit_reset) {
            if (parsed.dispatch === false) {
              throw new Error("after_limit_reset needs a persisted task (omit dispatch=false)");
            }
            const now = new Date();
            const res = await hostResetTarget({ env: readUsageEnv(), ...deps.usage, now });
            if (!res.ok) throw new Error(res.reason);
            notBefore = res.target.at;
            resetLine =
              `not_before: ${notBefore.toISOString()} (after the ${windowLabel(res.target.window)} limit reset, ` +
              `${clockLabel(notBefore, now)} local)\n`;
          }
          // KTD1: the argument (only when it looks like a real session id: an
          // unsubstituted "${CLAUDE_SESSION_ID}" is dropped), the hook's
          // capture file, then the environment.
          const origin = resolveOrigin(parsed.origin_session_id, origins);
          // KTD5: a task from a Claude Code session runs through Claude Code
          // unless the call names a provider.
          const provider: ProviderName =
            parsed.provider ?? (origin.spec?.agent === "claude-code" ? "claude-code" : "anthropic");
          const runsIn = runsInLine(provider, origin, parsed.tools, origins, deps.sessionFs);
          const identity = {
            title: parsed.title,
            originHost: "mcp" as const,
            originCwd: origin.cwd,
            originSessionId: origin.sessionId,
            ...(parsed.repeat !== undefined ? { repeat: parsed.repeat } : {}),
            ...kindOpts,
          };
          // dry_run: return the planned dispatch without persisting.
          if (parsed.dry_run) {
            const spec: ProviderCallSpec = {
              type: "provider_call",
              provider,
              // Same default as the real enqueue below — dry_run must
              // preview exactly what commit would do.
              model: parsed.model ?? defaultModelFor(provider),
              prompt: parsed.prompt,
              outputPath: parsed.output_path,
              redactInReceipt: parsed.redact_in_receipt,
              candidates: parsed.candidates,
              routeWeights: parsed.route_weights,
              ...(parsed.tools !== undefined ? { tools: parsed.tools } : {}),
              ...(origin.spec ? { origin: origin.spec } : {}),
            };
            const plan = await scheduler.previewProviderCall(spec, {
              deadline,
              region: parsed.region,
              carbonBudgetG: parsed.carbon_budget_g,
              ...(notBefore ? { notBefore } : {}),
            });
            const gridSource = await fetchGridSource(feed, plan.region);
            return {
              content: [
                {
                  type: "text",
                  text:
                    `dry_run plan (nothing persisted):\n` +
                    `provider: ${spec.provider}\n` +
                    `model: ${spec.model}\n` +
                    runsIn +
                    `region: ${plan.region}\n` +
                    `scheduled_for: ${plan.scheduledFor}\n` +
                    `deadline: ${notBefore ? plan.deadline : deadline}\n` +
                    quotaLine +
                    resetLine +
                    `intensity_g_co2_per_kwh: ${plan.intensityGCo2PerKwh}\n` +
                    `band: ${plan.band}\n` +
                    `estimated_carbon_g_co2: ${plan.estimatedCarbonGCo2}\n` +
                    `batch_eligible: ${plan.batchEligible}\n` +
                    (plan.routingPreview
                      ? `routing_preview: ${JSON.stringify(routingBlockPayload(plan.routingPreview))}\n`
                      : "") +
                    formatGridSourceLine(gridSource),
                },
              ],
            };
          }
          // Persistence-by-default (v0.7.1+) — dispatchable by `tidegap tick`.
          // Opt out with `dispatch=false` for the legacy in-memory closure
          // mode (mostly useful for testing or no-dispatch placeholders).
          const shouldDispatch = parsed.dispatch ?? true;
          if (shouldDispatch) {
            const spec: ProviderCallSpec = {
              type: "provider_call",
              provider,
              model: parsed.model ?? defaultModelFor(provider),
              prompt: parsed.prompt,
              outputPath: parsed.output_path,
              redactInReceipt: parsed.redact_in_receipt,
              candidates: parsed.candidates,
              routeWeights: parsed.route_weights,
              ...(parsed.tools !== undefined ? { tools: parsed.tools } : {}),
              ...(origin.spec ? { origin: origin.spec } : {}),
            };
            const record = await scheduler.enqueueProviderCall(spec, {
              deadline,
              region: parsed.region,
              carbonBudgetG: parsed.carbon_budget_g,
              ...(notBefore ? { notBefore } : {}),
              ...identity,
            });
            const gridSource = await fetchGridSource(feed, record.region);
            const resume = resumeCommand(record);
            return {
              content: [
                {
                  type: "text",
                  text:
                    `Task persisted (provider_call, dispatchable by \`tidegap tick\`).\n` +
                    `task_id: ${record.taskId}\n` +
                    (record.title ? `title: ${record.title}\n` : "") +
                    (record.repeat && record.repeat !== "none"
                      ? `repeat: ${record.repeat} (series ${record.seriesId})\n`
                      : "") +
                    (resume ? `resume: ${resume}\n` : "") +
                    `provider: ${spec.provider}\n` +
                    `model: ${spec.model}\n` +
                    runsIn +
                    `region: ${record.region}\n` +
                    `status: ${record.status}\n` +
                    `scheduled_for: ${record.scheduledFor ?? "(immediate)"}\n` +
                    `deadline: ${notBefore ? record.deadline : deadline}\n` +
                    quotaLine +
                    resetLine +
                    `estimated_carbon_g_co2: ${record.estimatedCarbonGCo2 ?? "(not scored)"}\n` +
                    (record.routingDecision
                      ? `routing: ${record.routingDecision.reasoning}\n`
                      : "") +
                    `${formatGridSourceLine(gridSource)}\n` +
                    `persisted_to: ${persistedAt}\n` +
                    `\n` +
                    readinessReplyLine(ledgerReadiness(scheduler, store), record),
                },
              ],
            };
          }
          // Legacy closure-based mode (opt-in via dispatch=false). The closure
          // does no LLM work — it's a placeholder useful for testing or for
          // workflows where the caller dispatches inline.
          const record = scheduler.enqueue(
            async () => ({
              prompt: parsed.prompt,
              model: parsed.model ?? null,
              dispatched: false,
              note: "closure placeholder — dispatch=true on schedule_task to persist a real provider_call",
            }),
            {
              deadline,
              region: parsed.region,
              carbonBudgetG: parsed.carbon_budget_g,
              ...identity,
            },
          );
          return {
            content: [
              {
                type: "text",
                text:
                  `Task queued (closure placeholder, in-process only).\n` +
                  `task_id: ${record.taskId}\n` +
                  `region: ${record.region}\n` +
                  `status: ${record.status}\n` +
                  `deadline: ${deadline}\n` +
                  `Note: dispatch=false placeholder. Will NOT actually call ` +
                  `the LLM. Remove dispatch=false to enqueue a real ` +
                  `provider_call (default in v0.7.1+).`,
              },
            ],
          };
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          return {
            content: [
              {
                type: "text",
                text: `schedule_task rejected: ${msg}`,
              },
            ],
            isError: true,
          };
        }
      }

      if (name === "tidegap_usage") {
        const parsed = schemaOf("tidegap_usage").parse(args) as { include_spend?: boolean };
        const doc = await readUsageDocument({
          env: readUsageEnv(),
          ...deps.usage,
          now: new Date(),
          spend: parsed.include_spend === true,
        });
        return {
          content: [{ type: "text", text: `${doc.line || "Claude limits: off"}\n${JSON.stringify(doc, null, 2)}` }],
        };
      }

      if (name === "check_queue_status") {
        const parsed = schemaOf("check_queue_status").parse(args) as {
          task_id?: string;
        };
        if (parsed.task_id) {
          // Persisted row first: a task this session scheduled is cached in
          // memory, but `tidegap tick` may have finished it in another process.
          // The in-memory record is the fallback when no store backs the
          // scheduler.
          const fresh = (): TaskRecord<unknown> | undefined =>
            scheduler.loadPersistedTask(parsed.task_id!) ??
            scheduler.getTask(parsed.task_id!);
          const task = fresh();
          if (!task) {
            return {
              content: [
                { type: "text", text: `Unknown task_id: ${parsed.task_id}` },
              ],
              isError: true,
            };
          }
          // Viewing a finished task's result marks it read (v0.17); the
          // store ignores unfinished tasks and already-read ones.
          if (task.status === "completed" || task.status === "failed") {
            scheduler.markTaskRead(task.taskId);
          }
          return {
            content: [
              {
                type: "text",
                text: formatTask(fresh() ?? task, loadQuota(), {
                  children: listKnownTasks(scheduler)
                    .filter((t) => t.parentTaskId === task.taskId)
                    .map((t) => t.taskId),
                }),
              },
            ],
          };
        }
        // Persisted ledger first (survives MCP-host restarts), in-memory
        // fallback when the scheduler runs without a store.
        const all = listKnownTasks(scheduler);
        // Aggregate carbon-budget status block (ROADMAP item 4): appended
        // only when a budget is configured and a store backs the scheduler.
        const budget = scheduler.getCarbonBudgetStatus();
        const summary = formatQueueSummary(all, {
          lastTickAt: scheduler.lastTickAt(),
        });
        return {
          content: [
            {
              type: "text",
              text: budget
                ? `${summary}\n\n${formatCarbonBudget(budget)}`
                : summary,
            },
          ],
        };
      }

      if (name === "cancel_task") {
        const parsed = schemaOf("cancel_task").parse(args) as {
          task_id: string;
          series?: boolean;
        };
        try {
          const rec = scheduler.cancelTask(parsed.task_id, { series: parsed.series === true });
          return {
            content: [
              {
                type: "text",
                text:
                  `Task ${parsed.task_id} status: ${rec.status}\n` +
                  (rec.completedAt ? `terminated_at: ${rec.completedAt}\n` : ``) +
                  (rec.seriesId && parsed.series ? `series ${rec.seriesId}: ended\n` : ``),
              },
            ],
          };
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          return { content: [{ type: "text", text: `cancel_task rejected: ${msg}` }], isError: true };
        }
      }

      if (name === "expedite_task") {
        const parsed = schemaOf("expedite_task").parse(args) as { task_id: string };
        try {
          const refusal = claudeCodeRefusal(scheduler, parsed.task_id, "expedite_task");
          if (refusal) return refusal;
          const adapters = buildAdapters();
          if (!adapters.anthropic && !adapters.openai) {
            return {
              content: [
                {
                  type: "text",
                  text:
                    `expedite_task rejected: no provider API key set (ANTHROPIC_API_KEY / OPENAI_API_KEY). ` +
                    `Set one in the MCP server env block, restart, and retry.`,
                },
              ],
              isError: true,
            };
          }
          const entry = await scheduler.expediteTask(parsed.task_id, adapters);
          return {
            content: [
              {
                type: "text",
                text:
                  `Task ${parsed.task_id} expedited.\n` +
                  `status: ${entry.status}\n` +
                  (entry.error ? `error: ${entry.error}\n` : ``),
              },
            ],
          };
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          return { content: [{ type: "text", text: `expedite_task rejected: ${msg}` }], isError: true };
        }
      }

      if (name === "postpone_task") {
        const parsed = schemaOf("postpone_task").parse(args) as {
          task_id: string;
          preset?: PostponePreset;
          until?: string;
          delay_minutes?: number;
          reset_at?: string;
        };
        try {
          const given = [parsed.preset, parsed.until, parsed.delay_minutes].filter((v) => v !== undefined);
          if (given.length !== 1) throw new Error("pass exactly one of preset, until or delay_minutes");
          if (parsed.reset_at !== undefined && parsed.preset !== "after_limit_reset") {
            throw new Error(`reset_at is only valid with preset "after_limit_reset"`);
          }
          const target: PostponeTarget =
            parsed.preset !== undefined
              ? { preset: parsed.preset, ...(parsed.reset_at !== undefined ? { resetAt: parsed.reset_at } : {}) }
              : parsed.until !== undefined
                ? { until: parsed.until }
                : { delayMs: parsed.delay_minutes! * 60_000 };
          const rec = await scheduler.postponeTask(parsed.task_id, target);
          const now = new Date();
          const local = (iso: string | undefined) =>
            iso ? `${iso} (${localTimeLabel(new Date(iso), now)} local)` : "(none)";
          return {
            content: [
              {
                type: "text",
                text:
                  `Task ${parsed.task_id} moved later.\n` +
                  `status: ${rec.status}\n` +
                  `not_before: ${local(rec.notBefore)}\n` +
                  `scheduled_for: ${rec.scheduledFor ? local(rec.scheduledFor) : "(picked at the window)"}\n` +
                  `deadline: ${local(rec.deadline)}`,
              },
            ],
          };
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          const hint = msg.endsWith(NEEDS_RESET_TIME) ? "; pass reset_at (ISO-8601, the time the limit resets)" : "";
          return { content: [{ type: "text", text: `postpone_task rejected: ${msg}${hint}` }], isError: true };
        }
      }

      if (name === "reply_task") {
        const parsed = schemaOf("reply_task").parse(args) as {
          task_id: string;
          text: string;
          deadline?: string;
        };
        try {
          if (parsed.text.length > REPLY_MAX_CHARS) {
            throw new Error(`text is longer than ${REPLY_MAX_CHARS} characters`);
          }
          const child = await scheduler.replyToTask(parsed.task_id, parsed.text, {
            ...(parsed.deadline !== undefined ? { deadline: parsed.deadline } : {}),
          });
          return {
            content: [
              {
                type: "text",
                text:
                  `Reply queued as a new task.\n` +
                  `task_id: ${child.taskId}\n` +
                  `parent_task_id: ${parsed.task_id}\n` +
                  `status: ${child.status}\n` +
                  `scheduled_for: ${child.scheduledFor ?? "(immediate)"}\n` +
                  `deadline: ${child.deadline}\n` +
                  `Runs on the next \`tidegap tick\` after its window (one provider call).`,
              },
            ],
          };
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          return { content: [{ type: "text", text: `reply_task rejected: ${msg}` }], isError: true };
        }
      }

      if (name === "update_deadline") {
        const parsed = schemaOf("update_deadline").parse(args) as {
          task_id: string;
          deadline: string;
        };
        try {
          // An explicit deadline replaces a quota_reset rule (v0.17).
          const rec = await scheduler.updateDeadline(parsed.task_id, parsed.deadline, {
            deadlineKind: "absolute",
          });
          return {
            content: [
              {
                type: "text",
                text:
                  `Task ${parsed.task_id} updated.\n` +
                  `status: ${rec.status}\n` +
                  `scheduled_for: ${rec.scheduledFor ?? "(immediate)"}\n` +
                  `new_deadline: ${parsed.deadline}`,
              },
            ],
          };
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          return { content: [{ type: "text", text: `update_deadline rejected: ${msg}` }], isError: true };
        }
      }

      if (name === "cancel_all") {
        const parsed = schemaOf("cancel_all").parse(args) as {
          status?: "queued" | "scheduled";
        };
        // Persisted ledger first (audit §0.10: the in-memory map is empty
        // after an MCP-host restart while queue.db still holds scheduled
        // tasks); in-memory fallback when the scheduler has no store.
        const allTasks = listKnownTasks(scheduler);
        const targets = allTasks.filter(
          (t): t is NonNullable<typeof t> =>
            !!t &&
            (t.status === "queued" || t.status === "scheduled") &&
            (!parsed.status || t.status === parsed.status),
        );
        let cancelled = 0;
        const errors: string[] = [];
        for (const t of targets) {
          try {
            scheduler.cancelTask(t.taskId);
            cancelled++;
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            errors.push(`${t.taskId}: ${msg}`);
          }
        }
        const lines = [
          `Cancelled ${cancelled} of ${targets.length} ${
            parsed.status ?? "queued/scheduled"
          } task(s).`,
        ];
        if (errors.length > 0) {
          lines.push("");
          lines.push("Errors:");
          for (const e of errors) lines.push(`  ${e}`);
        }
        return { content: [{ type: "text", text: lines.join("\n") }] };
      }

      if (name === "retry_task") {
        const parsed = schemaOf("retry_task").parse(args) as { task_id: string };
        try {
          const refusal = claudeCodeRefusal(scheduler, parsed.task_id, "retry_task");
          if (refusal) return refusal;
          const adapters = buildAdapters();
          if (!adapters.anthropic && !adapters.openai) {
            return {
              content: [
                {
                  type: "text",
                  text:
                    `retry_task rejected: no provider API key set (ANTHROPIC_API_KEY / OPENAI_API_KEY).`,
                },
              ],
              isError: true,
            };
          }
          const entry = await scheduler.retryTask(parsed.task_id, adapters);
          return {
            content: [
              {
                type: "text",
                text:
                  `Task ${parsed.task_id} retried.\n` +
                  `status: ${entry.status}\n` +
                  (entry.error ? `error: ${entry.error}\n` : ``),
              },
            ],
          };
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          return { content: [{ type: "text", text: `retry_task rejected: ${msg}` }], isError: true };
        }
      }

      return {
        content: [{ type: "text", text: `Unknown tool: ${name}` }],
        isError: true,
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        content: [{ type: "text", text: `Error: ${msg}` }],
        isError: true,
      };
    }
  });

  return { server, scheduler, feed, dbPath, defaultRegion, defaultModel };
}

export function formatForecast(forecast: GridForecast): string {
  const lines: string[] = [];
  lines.push(`Region: ${forecast.region}`);
  lines.push(`Source: ${forecast.source}`);
  if (forecast.signalType === "marginal") {
    lines.push(
      `Signal: marginal (co2_moer — the marginal generator's rate, not the average-grid figure)`,
    );
  }
  lines.push(`Generated: ${forecast.generatedAt}`);
  lines.push("");
  lines.push("Hour | gCO2/kWh | band");
  lines.push("---  | ---      | ---");
  for (const e of forecast.entries) {
    const hour = e.datetime.slice(11, 16);
    lines.push(
      `${hour} | ${String(e.carbonIntensityGCo2PerKwh).padStart(4)} | ${e.band}`,
    );
  }
  type Entry = (typeof forecast.entries)[number];
  const min = forecast.entries.reduce((a: Entry, b: Entry) =>
    a.carbonIntensityGCo2PerKwh <= b.carbonIntensityGCo2PerKwh ? a : b,
  );
  const max = forecast.entries.reduce((a: Entry, b: Entry) =>
    a.carbonIntensityGCo2PerKwh >= b.carbonIntensityGCo2PerKwh ? a : b,
  );
  lines.push("");
  lines.push(`Cleanest hour: ${min.datetime} (${min.carbonIntensityGCo2PerKwh} gCO2/kWh, ${min.band})`);
  lines.push(`Dirtiest hour: ${max.datetime} (${max.carbonIntensityGCo2PerKwh} gCO2/kWh, ${max.band})`);
  return lines.join("\n");
}

export function formatRecommendation(
  r: Awaited<ReturnType<typeof recommendWindow>>,
): string {
  // Emit canonical snake_case JSON so an LLM caller can parse the result
  // directly. The fields mirror the Python `RecommendResult.to_dict()`
  // 1:1 — keep this in lockstep when either side adds a field.
  const payload = {
    scheduled_for: r.scheduledFor,
    intensity_g_co2_per_kwh: r.intensityGCo2PerKwh,
    band: r.band,
    estimated_carbon_g_co2: r.estimatedCarbonGCo2,
    estimated_savings_vs_now_pct: r.estimatedSavingsVsNowPct,
    batch_eligible: r.batchEligible,
    // Provenance (v0.12+): which grid feed produced the forecast this
    // plan was scored against. "mock" = SYNTHETIC data — surface that.
    grid_source: r.gridSource ?? null,
    // Signal type (v0.14+): "marginal" (WattTime co2_moer) or null ⇒
    // average. The reasoning string discloses it in prose too.
    signal_type: r.signalType ?? null,
    alternatives: r.alternatives.map((a) => ({
      scheduled_for: a.scheduledFor,
      intensity_g_co2_per_kwh: a.intensityGCo2PerKwh,
      band: a.band,
      estimated_carbon_g_co2: a.estimatedCarbonGCo2,
      estimated_savings_vs_now_pct: a.estimatedSavingsVsNowPct,
    })),
    reasoning: r.reasoning,
    // Non-binding cross-provider routing preview (ROADMAP item 1) — present
    // only when >= 2 candidates were supplied. `preview: true` and the
    // reasoning prefix disclose that the binding pick is decided at schedule
    // time and may differ if the forecast shifts.
    ...(r.routingPreview
      ? { routing_preview: routingBlockPayload(r.routingPreview) }
      : {}),
  };
  return JSON.stringify(payload, null, 2);
}

/**
 * snake_case JSON rendering of a routing decision/preview for the MCP text
 * payloads. Shared by recommend_window, schedule_task dry_run, and the
 * committed schedule response so the block reads identically everywhere.
 */
export function routingBlockPayload(
  routing: import("@tidegap/core").RoutingDecision & { preview?: true },
): Record<string, unknown> {
  return {
    ...(routing.preview ? { preview: true } : {}),
    chosen: routing.chosen,
    ...(routing.fallbackFrom ? { fallback_from: routing.fallbackFrom } : {}),
    weights: routing.weights,
    considered: routing.considered.map((c) => ({
      provider: c.provider,
      model: c.model,
      est_carbon_g: c.estCarbonG,
      est_cost_usd: c.estCostUsd,
      latency_class: c.latencyClass,
      score: c.score,
    })),
    reasoning: routing.reasoning,
  };
}

/** Longest reply text accepted by reply_task (same cap as the `tidegap ui` API). */
const REPLY_MAX_CHARS = 32_000;

export function formatTask(
  task: TaskRecord<unknown> | undefined,
  quota: QuotaResetConfig = {},
  related: { children?: readonly string[] } = {},
): string {
  if (!task) return "";
  const lines = [`task_id: ${task.taskId}`];
  if (task.title) lines.push(`title: ${task.title}`);
  lines.push(
    `status: ${task.status}`,
    `region: ${task.region}`,
    `enqueued_at: ${task.enqueuedAt}`,
  );
  if (task.originHost)
    lines.push(`origin: ${task.originHost}${task.originCwd ? ` (${task.originCwd})` : ""}`);
  if (task.originSessionId) lines.push(`origin_session_id: ${task.originSessionId}`);
  const resume = resumeCommand(task);
  if (resume) lines.push(`resume: ${resume}`);
  if (task.parentTaskId) lines.push(`parent_task_id: ${task.parentTaskId}`);
  if (related.children && related.children.length > 0)
    lines.push(`children: ${related.children.join(", ")}`);
  if (task.seriesId) lines.push(`series_id: ${task.seriesId}`);
  if (task.repeat && task.repeat !== "none") lines.push(`repeat: ${task.repeat}`);
  else if (task.seriesId) lines.push(`repeat: none (series ended)`);
  if (task.scheduledFor) lines.push(`scheduled_for: ${task.scheduledFor}`);
  if (task.deadline) lines.push(`deadline: ${task.deadline}`);
  lines.push(`deadline_kind: ${deadlineKindLabel(task, quota)}`);
  if (task.completedAt) lines.push(`completed_at: ${task.completedAt}`);
  if (task.readAt) lines.push(`read_at: ${task.readAt}`);
  if (task.carbonBudgetG)
    lines.push(`carbon_budget_g: ${task.carbonBudgetG}`);
  const prompt = taskPrompt(task);
  if (prompt !== undefined) {
    lines.push(`prompt: ${stripControlChars(prompt, { multiline: true })}`);
  }
  if (task.receipt) {
    lines.push("");
    lines.push("Carbon receipt:");
    lines.push(`  ran_at: ${task.receipt.ranAt}`);
    lines.push(`  estimated_carbon_g: ${task.receipt.estimatedCarbonGCo2}`);
    if (task.receipt.actualCarbonGCo2 !== undefined)
      lines.push(`  actual_carbon_g: ${task.receipt.actualCarbonGCo2}`);
    if (task.receipt.deltaPct !== undefined)
      lines.push(`  delta_pct: ${task.receipt.deltaPct}`);
    if (task.receipt.intensityGCo2PerKwh !== undefined)
      lines.push(
        `  intensity_g_co2_per_kwh: ${task.receipt.intensityGCo2PerKwh}`,
      );
    if (task.receipt.gridSource !== undefined)
      lines.push(
        `  grid_source: ${task.receipt.gridSource}` +
          (task.receipt.gridSource === "mock"
            ? " — SYNTHETIC (mock) grid data, not a measurement"
            : "") +
          (task.receipt.signalType === "marginal"
            ? " (marginal-emissions signal — not an average-grid figure)"
            : ""),
      );
    if (task.receipt.energySource !== undefined)
      lines.push(`  energy_source: ${task.receipt.energySource}`);
    if (task.receipt.energyResolution !== undefined)
      lines.push(`  energy_resolution: ${task.receipt.energyResolution}`);
    if (task.receipt.durationMs)
      lines.push(`  duration_ms: ${task.receipt.durationMs}`);
  }
  // Cross-provider routing (ROADMAP item 1): show the scored candidate list
  // and the chosen candidate. Prefer the signed receipt's copy (post-run);
  // fall back to the schedule-time decision on the task row (pre-run).
  const routing = task.receipt?.routing ?? task.routingDecision;
  if (routing) {
    lines.push("");
    lines.push("Cross-provider routing:");
    lines.push(`  chosen: ${routing.chosen}`);
    if (routing.fallbackFrom)
      lines.push(`  fallback_from: ${routing.fallbackFrom}`);
    lines.push(
      `  weights: carbon=${routing.weights.carbon} cost=${routing.weights.cost} latency=${routing.weights.latency}`,
    );
    lines.push("  considered:");
    for (const c of routing.considered) {
      lines.push(
        `    ${c.provider}:${c.model} — score ${c.score}, carbon ${c.estCarbonG}g, cost $${c.estCostUsd}, latency ${c.latencyClass}`,
      );
    }
    lines.push(`  reasoning: ${routing.reasoning}`);
  }
  if (task.result !== undefined) {
    lines.push("");
    lines.push("Result:");
    lines.push(
      typeof task.result === "string"
        ? task.result
        : JSON.stringify(task.result, null, 2),
    );
  }
  if (task.error) lines.push(`error: ${task.error}`);
  return lines.join("\n");
}

export function formatQueueSummary(
  tasks: ReadonlyArray<TaskRecord<unknown> | undefined>,
  opts: { lastTickAt?: string } = {},
): string {
  // When a ticker (`tidegap tick` or the OpenClaw loop) last ran: tells the
  // caller whether scheduled tasks are actually being dispatched.
  const tickLine = `last_tick_at: ${opts.lastTickAt ?? "never recorded"}`;
  if (tasks.length === 0) {
    return `Queue is empty.\n${tickLine}`;
  }
  const counts: Record<string, number> = {};
  for (const t of tasks) {
    if (!t) continue;
    counts[t.status] = (counts[t.status] ?? 0) + 1;
  }
  const lines = [
    `Total tasks: ${tasks.length}`,
    ...Object.entries(counts).map(([s, n]) => `  ${s}: ${n}`),
    tickLine,
    "",
    "Tasks:",
  ];
  for (const t of tasks) {
    if (!t) continue;
    lines.push(
      `  ${t.taskId} | ${t.status.padEnd(10)} | region=${t.region}${
        t.scheduledFor ? ` | sched=${t.scheduledFor}` : ""
      }${t.deadlineKind === "quota_reset" ? ` | quota=${t.quotaProvider ?? "?"}` : ""}${
        t.title ? ` | ${t.title}` : ""
      }`,
    );
  }
  return lines.join("\n");
}

/**
 * Render the aggregate carbon-budget status block (ROADMAP item 4) for
 * check_queue_status: used / threshold / window / alerted. snake_case keys
 * to match the rest of the MCP text payloads.
 */
export function formatCarbonBudget(status: CarbonBudgetStatus): string {
  const lines = [
    "carbon_budget:",
    `  window: ${status.windowKind}`,
    `  window_start: ${status.windowStart}`,
    `  used_g: ${status.usedG}`,
    `  threshold_g: ${status.thresholdG}`,
    `  percent: ${status.pct}%`,
    `  tasks: ${status.taskCount}`,
    `  exceeded: ${status.exceeded}`,
    `  alerted: ${status.alerted}`,
  ];
  return lines.join("\n");
}

/** Start the stdio server: the `tidegap-mcp` bin, and the `@ebb-ai/mcp` 0.17.1 shim. */
export async function main() {
  const { dbPath, fallbackNote } = resolveStartupDb();
  if (fallbackNote) {
    // stderr only — stdout belongs to the MCP stdio protocol.
    // eslint-disable-next-line no-console
    console.error(
      `[tidegap-mcp] ${fallbackNote} — falling back to an in-memory queue; ` +
        `tasks will NOT survive a restart of this server.`,
    );
  }
  const { server, feed, defaultRegion } = createEbbServer({ dbPath });
  const transport = new StdioServerTransport();
  await server.connect(transport);
  const dbLabel =
    dbPath === undefined
      ? fallbackNote
        ? "in-memory (FALLBACK: db directory unavailable)"
        : "in-memory"
      : dbPath === ":memory:"
        ? "in-memory"
        : dbPath;
  // eslint-disable-next-line no-console
  console.error(
    `[tidegap-mcp] ready (stdio, v${SERVER_VERSION}) — region=${defaultRegion}, ` +
      `grid feed=${feed.source}, ` +
      `db=${dbLabel}`,
  );
}

/** Run main() only when executed as a script (node dist/server.js or the
 *  `tidegap-mcp` bin shim) — importing this module has no side effects. */
function isDirectRun(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    // realpath: npm bin shims are symlinks into dist/.
    return import.meta.url === pathToFileURL(realpathSync(entry)).href;
  } catch {
    return false;
  }
}

if (isDirectRun()) {
  main().catch((err: unknown) => {
    // eslint-disable-next-line no-console
    console.error("[tidegap-mcp] fatal:", err);
    process.exit(1);
  });
}
