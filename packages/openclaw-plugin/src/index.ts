/**
 * Tidegap OpenClaw plugin — auto-defer "do it later" tasks to the cleanest
 * electricity-grid hour. Native OpenClaw tool plugin built with
 * `defineToolPlugin`, which registers the tools so they reach agent
 * sessions.
 *
 * Verify a build with `openclaw plugins inspect tidegap --runtime --json` — it
 * lists every tool. Note: plain `openclaw plugins inspect tidegap` reports
 * `Shape: non-capability` for tool plugins in OpenClaw 2026.5.18; that is
 * the expected label for this plugin kind, not an error.
 *
 * Scheduled provider-call tasks are executed in-process: a background loop
 * runs `Scheduler.tick`, dispatching due tasks through OpenClaw's own model
 * runtime (`api.runtime.llm.complete`, captured from a tool-call context) —
 * no separate API key required — or through the `anthropicApiKey` /
 * `openaiApiKey` plugin-config fields as a fallback.
 *
 * ── CONFIGURATION: PLUGIN CONFIG ONLY, NO ENVIRONMENT VARIABLES ────────────
 * This bundle reads ZERO environment variables. Everything — grid-feed
 * credentials, provider credentials, the carbon-budget threshold, the
 * delivery-store path, the startup opt-out — comes from OpenClaw plugin
 * config (`plugins.entries.tidegap.config`), declared in `./config.ts` and
 * mirrored into `openclaw.plugin.json`. `@tidegap/core` is environment-pure for
 * the same reason. Each config field's description names the environment
 * variable it replaces, and the credential fields accept OpenClaw's
 * `${ENV_VAR}` secret shorthand, so a user who exports the old variables can
 * keep doing so — the GATEWAY reads them, not this plugin.
 *
 * (The `tidegap` CLI and the `@tidegap/mcp` server are separate hosts and still
 * read those environment variables directly; their behaviour is unchanged.)
 *
 * Startup / restart behaviour (important — read before relying on the
 * "background loop"): the loop is started at module load (see
 * `bootstrapDispatcherOnStartup` below), which the manifest's
 * `activation.onStartup:true` triggers when the gateway boots. That catches
 * overdue tasks after a gateway restart WITHOUT waiting for a user to invoke
 * a tool. BUT the two things a task needs to actually *deliver* only exist
 * after the first tool call in the fresh process:
 *   - the OpenClaw runtime LLM bridge (`api.runtime.llm.complete`) — captured
 *     from a tool-call `context`, never present at boot; and
 *   - the gateway chat/config (`api.config`) used for chat/telegram delivery.
 * So at boot the dispatcher can dispatch via a direct API key
 * (`anthropicApiKey` / `openaiApiKey`, recovered from the captured gateway
 * config once available), but tasks whose only
 * viable path is the runtime bridge are SKIPPED (left `scheduled`, logged
 * once per provider) until the first tool call captures the bridge — see
 * `runDispatchTick`. This is honest about the limitation rather than failing
 * such tasks: a restart alone cannot recover bridge-only or chat-delivery
 * tasks; the first tool call in the new process does.
 *
 * Shares the SQLite ledger at ~/.tidegap/queue.db with the @tidegap/mcp MCP
 * server and the @tidegap/cli CLI — a task deferred in OpenClaw shows up in
 * `tidegap stats` and vice versa. Tool names match the MCP server surface.
 *
 * Tools:
 *   - schedule_task       — queue a task at the cleanest hour
 *   - recommend_window    — preview the cleanest hour (read-only, no DB)
 *   - check_queue_status  — list all tasks / detail one (marks a finished task read)
 *   - cancel_task         — cancel a queued task (idempotent)
 *   - get_grid_forecast   — hourly carbon-intensity forecast (read-only, no DB)
 *   - update_deadline     — move a queued task's deadline
 *   - cancel_all          — cancel every queued/scheduled task
 *   - set_delivery        — choose how a task's result is delivered
 *   - expedite_task       — dispatch a task now, skipping the clean window
 *   - retry_task          — re-dispatch a failed task
 *
 * When a task completes, its result is delivered through the chosen modes
 * (chat / telegram / webhook / file) and is always kept in the queue too.
 */

import { Type, type TSchema } from "typebox";
// @ts-expect-error -- the openclaw plugin SDK is provided by the OpenClaw runtime at load time
import { defineToolPlugin } from "openclaw/plugin-sdk/tool-plugin";

import {
  buildDefaultGridFeed,
  checkRequestedRegion,
  DEFAULT_MODEL_BY_PROVIDER,
  getToolDefOrThrow,
  loadCarbonBudgetConfig,
  loadQuotaResetConfig,
  prepareTick,
  recommendWindow,
  regionSettingReader,
  resolveRegion,
  resolveTidegapHome,
  Scheduler,
  stripControlChars,
  TaskStore,
  taskPrompt,
  type CarbonAlert,
  type ProviderCallSpec,
  type RegionResolution,
  type TaskRecord,
  type TickAdapters,
  type TickResult,
} from "@tidegap/core";

import { openclawToolParameters } from "./tool-schemas.js";

/** The canonical description for a tool, from the shared surface (audit §2.2). */
/** Longest reply text accepted by reply_task (same cap as MCP and `tidegap ui`). */
const REPLY_MAX_CHARS = 32_000;

function toolDescription(name: string): string {
  return getToolDefOrThrow(name).description;
}

import {
  availableProviders,
  buildAdapters,
  captureOpenClawRuntime,
  dispatchCapability,
  getCapturedOpenClawConfig,
  inferProvider,
  type DispatchAdapters,
} from "./dispatch.js";

import {
  carbonBudgetOverrides,
  gridCredentials,
  mergeConfig,
  pluginConfigFromGatewayConfig,
  pluginConfigSchema,
  type PluginConfig,
} from "./config.js";

import {
  deliverCarbonAlert,
  deliverResult,
  formatCarbonAlertMessage,
  getDeliveryConfig,
  readDeliveryRecord,
  recordDeliveryOutcomes,
  scanDeliveryOptions,
  setDeliveryConfig,
  setDeliveryStorePath,
  setOsNotificationsDisabled,
  telegramTarget,
  validateDeliveryConfig,
  type DeliveryConfig,
  type DeliveryMode,
  type ReportFormat,
} from "./delivery.js";

import { dirname, join } from "node:path";
import { mkdirSync } from "node:fs";

// Loud SYNTHETIC-data disclosure, mirroring the @tidegap/mcp server so the two
// surfaces read identically. "mock" grid source ⇒ the carbon numbers are
// illustrative, not measured.
const SYNTHETIC_GRID_WARNING =
  "⚠ SYNTHETIC (mock) grid data — no live grid feed was available for this region, " +
  "so the carbon numbers above are illustrative, not measured. " +
  "Set the plugin's electricityMapsApiKey (or another supported feed credential) " +
  "in the gateway config for real intensity.";

/**
 * The plugin-config field that configures each provider's direct-dispatch
 * route. (These replaced the ANTHROPIC_API_KEY / OPENAI_API_KEY /
 * GEMINI_API_KEY / OLLAMA_HOST environment variables — the plugin reads no
 * environment variables.)
 */
const PROVIDER_CONFIG_FIELD: Record<
  "anthropic" | "openai" | "gemini" | "ollama",
  string
> = {
  anthropic: "anthropicApiKey",
  openai: "openaiApiKey",
  gemini: "geminiApiKey",
  ollama: "ollamaHost",
};

/**
 * Surface receipt provenance for a completed/expedited/retried task, mirroring
 * the MCP server: actual vs estimated grams, the signed delta, the grid
 * intensity + its source ("mock" ⇒ SYNTHETIC), and the energy-coefficient
 * confidence tier. Returns undefined when there is no receipt yet.
 */
function receiptProvenance(
  receipt: import("@tidegap/core").CarbonReceipt | undefined,
): Record<string, unknown> | undefined {
  if (!receipt) return undefined;
  const out: Record<string, unknown> = {};
  if (typeof receipt.estimatedCarbonGCo2 === "number")
    out.estimated_carbon_g_co2 = receipt.estimatedCarbonGCo2;
  if (typeof receipt.actualCarbonGCo2 === "number")
    out.actual_carbon_g_co2 = receipt.actualCarbonGCo2;
  if (typeof receipt.deltaPct === "number") out.delta_pct = receipt.deltaPct;
  if (typeof receipt.intensityGCo2PerKwh === "number")
    out.intensity_g_co2_per_kwh = receipt.intensityGCo2PerKwh;
  if (receipt.gridSource !== undefined) {
    out.grid_source = receipt.gridSource;
    if (receipt.gridSource === "mock")
      out.grid_source_note = "SYNTHETIC (mock) grid data, not a measurement";
  }
  if (receipt.energySource !== undefined) out.energy_source = receipt.energySource;
  if (receipt.energyResolution !== undefined)
    out.energy_resolution = receipt.energyResolution;
  return out;
}

type ToolDefinition = {
  name: string;
  label?: string;
  description: string;
  parameters: TSchema;
  optional?: boolean;
  execute: (params: never, config: PluginConfig, context?: unknown) => unknown;
};
type ToolFactory = (def: ToolDefinition) => unknown;

/**
 * Wrap the SDK's tool factory so every `execute` receives the RESOLVED plugin
 * config instead of the raw one.
 *
 * One seam for all eleven tools: the raw `config` OpenClaw passes is merged over
 * this plugin's block in the captured gateway config, and the delivery-store
 * path is published to the delivery module. Doing it here means no tool body
 * has to remember to resolve config — and, critically, no tool body has any
 * reason to reach for the ambient environment.
 */
function withEffectiveConfig(
  rawTool: ToolFactory,
  build: (tool: ToolFactory) => unknown[],
): unknown[] {
  const wrapped: ToolFactory = (def) =>
    rawTool({
      ...def,
      execute: (params: never, config: PluginConfig, context?: unknown) =>
        def.execute(params, effectiveConfig(config), context),
    });
  return build(wrapped);
}

// ── Effective plugin config ─────────────────────────────────────────────────
// OpenClaw hands each tool its own config as the second argument of `execute`.
// The background dispatcher and the startup bootstrap have no such argument,
// so they fall back to this plugin's block inside the captured gateway config
// (`api.config` → `plugins.entries.tidegap.config`) once a tool call has captured
// it. The explicit argument always wins.
//
// This is the plugin's ONLY configuration source. Nothing here reads the
// ambient environment — see `config.ts` for the env-var → config-field map.

function effectiveConfig(config: PluginConfig = {}): PluginConfig {
  const merged = mergeConfig(
    pluginConfigFromGatewayConfig(getCapturedOpenClawConfig()),
    config,
  );
  // The delivery store is reached from module-level helpers with no config
  // parameter, so publish the resolved path to it here.
  setDeliveryStorePath(merged.deliveryStorePath);
  return merged;
}

// ── Grid feed (no SQLite) ───────────────────────────────────────────────────
// The grid feed has no database dependency, so `recommend_window` and
// `get_grid_forecast` keep working even when the SQLite queue cannot open.
//
// Cached per credential set: the feed is a pure function of the five grid
// credentials, and re-deriving it on a config change is what makes a newly
// configured API key take effect without a gateway restart.
let cachedGridFeed:
  | { key: string; feed: ReturnType<typeof buildDefaultGridFeed> }
  | undefined;

function getGridFeed(
  config: PluginConfig = {},
): ReturnType<typeof buildDefaultGridFeed> {
  const credentials = gridCredentials(config);
  const key = JSON.stringify([
    credentials.electricityMapsApiKey ?? "",
    credentials.eiaApiKey ?? "",
    credentials.entsoeSecurityToken ?? "",
    credentials.wattTimeUsername ?? "",
    credentials.wattTimePassword ?? "",
  ]);
  if (cachedGridFeed?.key !== key) {
    cachedGridFeed = { key, feed: buildDefaultGridFeed(credentials) };
  }
  return cachedGridFeed.feed;
}

// ── Queue runtime (SQLite-backed) ───────────────────────────────────────────
// Built lazily on the first queue-tool call. Constructing TaskStore here (not
// at module load) keeps plugin import side-effect free.
type QueueRuntime = {
  store: TaskStore;
  scheduler: Scheduler;
  dbPath: string;
};
let cachedQueueRuntime: QueueRuntime | undefined;

function resolveDbPath(cfg: PluginConfig): string {
  const path = cfg.dbPath ?? join(resolveTidegapHome(), "queue.db");
  try {
    mkdirSync(dirname(path), { recursive: true });
  } catch {
    // ignore EEXIST — the parent dir already exists
  }
  return path;
}

/** The stored setting (`~/.tidegap/config`), re-read when the file changes. */
const readRegionSetting = regionSettingReader({
  warn: (message) => console.warn(`[tidegap] ${message}`),
});

/**
 * The region of a tool call: the tool argument (a catalog zone, or a zone a
 * configured key gives a live feed) > plugin `defaultRegion` > the
 * stored setting > time-zone guess > GB. Resolved per call (KTD11).
 */
function regionFor(
  requested: string | undefined,
  config: PluginConfig,
  tool: string,
): RegionResolution {
  if (requested?.trim()) {
    const checked = checkRequestedRegion(requested, gridCredentials(config));
    if ("error" in checked) throw new Error(`${tool} rejected: ${checked.error}`);
    return checked;
  }
  return defaultRegionFor(config);
}

/** The region when a call names none: plugin `defaultRegion` > setting > time zone > GB. */
function defaultRegionFor(config: PluginConfig): RegionResolution {
  return resolveRegion({
    configured: { value: config.defaultRegion, source: "config" },
    setting: readRegionSetting(),
  });
}

function getQueueRuntime(config: PluginConfig): QueueRuntime {
  const dbPath = resolveDbPath(config);
  // Cache is keyed by the resolved DB path. The startup bootstrap opens the
  // DEFAULT path before any tool call; if the plugin is then configured with
  // a custom `dbPath`, the first tool call must re-open against it rather than
  // silently keep serving the default-path handle. (Also lets the test suite
  // point successive calls at different temp DBs.)
  if (cachedQueueRuntime && cachedQueueRuntime.dbPath === dbPath) {
    return cachedQueueRuntime;
  }

  let store: TaskStore;
  try {
    store = new TaskStore({ dbPath });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(
      `Tidegap: could not open the task queue at ${dbPath} (${msg}). The queue ` +
        `uses Node's built-in node:sqlite — make sure the OpenClaw gateway runs ` +
        `on Node 22.5 or newer. (recommend_window and get_grid_forecast work ` +
        `without the queue.)`,
    );
  }

  // Aggregate carbon-budget alerts (ROADMAP item 4): the ~/.tidegap/config
  // FILE is still read by core, with the plugin's carbonBudgetG /
  // carbonBudgetWindow config fields taking precedence (they replaced the
  // TIDEGAP_CARBON_BUDGET_G / TIDEGAP_CARBON_BUDGET_WINDOW environment variables).
  // When set, a crossing inside Scheduler.tick routes through the SAME
  // delivery machinery — chat by default via the captured gateway config —
  // and is logged to the gateway.
  const carbonBudget = loadCarbonBudgetConfig({
    env: carbonBudgetOverrides(config),
  });
  const scheduler = new Scheduler({
    actor: "openclaw",
    feed: getGridFeed(config),
    store,
    defaultRegion: () => defaultRegionFor(config).region,
    eager: false,
    // A quota_reset series rolls to the label's next reset (ui v2). A
    // getter: the long-lived gateway sees config edits.
    quotaConfig: () => loadQuotaResetConfig(),
    ...(carbonBudget
      ? {
          carbonBudget,
          onCarbonAlert: (alert: CarbonAlert) => onCarbonAlert(alert),
        }
      : {}),
  });
  cachedQueueRuntime = { store, scheduler, dbPath };
  // Re-point the background dispatcher at whatever config is now active, so a
  // custom `dbPath` supplied by the first tool call is what the loop sweeps
  // (the startup bootstrap starts the loop against the default path).
  activeDispatchConfig = config;
  ensureDispatcher(config);
  return cachedQueueRuntime;
}

// ── In-process dispatcher ───────────────────────────────────────────────────
// Provider-call tasks only *execute* when Scheduler.tick runs. The OpenClaw
// gateway is long-lived, so the plugin drains due tasks on a background
// interval. The interval is started BOTH at module load (see
// `bootstrapDispatcherOnStartup`, driven by the manifest's
// `activation.onStartup:true`) AND lazily on the first queue-tool call, so
// after a gateway restart already-overdue persisted tasks are picked up
// without waiting for a user to invoke a tool. See the file header for the
// hard limitation: at boot only the direct-API-key path can dispatch — tasks
// whose only route is the OpenClaw runtime bridge, and any chat/telegram
// delivery, need the first tool call of the fresh process to capture the
// bridge and the gateway config. (The CLI's `tidegap tick` is the other
// dispatcher, for non-gateway setups.)

const DISPATCH_INTERVAL_MS = 60_000;
let dispatcherStarted = false;
// The config the background sweep runs against. Seeded by the startup
// bootstrap (default path) and re-pointed by getQueueRuntime once a tool call
// supplies the real plugin config (which may carry a custom dbPath).
let activeDispatchConfig: PluginConfig = {};

// Skipped-provider log throttle: emit the "no adapter yet" warning once per
// provider per process, not once per sweep, so a boot with no keys doesn't
// spam the gateway log every 60s.
const loggedSkippedProviders = new Set<string>();

/**
 * Drain every due scheduled task once. Exported so tests and the smoke
 * script can run a single deterministic sweep. `adaptersOverride` lets a
 * test inject a stub instead of the runtime-bridge / HTTP adapters.
 *
 * Tasks whose provider has no adapter yet are SKIPPED, not failed. At boot
 * (before the first tool call captures the runtime bridge) or when a
 * provider's API key is absent, `Scheduler.tick` would otherwise mark such a
 * task `failed` with "no adapter configured for provider …". We roll that
 * transient failure straight back to `scheduled` so the task keeps its clean
 * window and is retried once an adapter becomes available, and we log the gap
 * once per provider.
 */
export async function runDispatchTick(
  config: PluginConfig,
  adaptersOverride?: DispatchAdapters,
): Promise<TickResult> {
  // The background sweep has no tool-call config of its own, so fold in the
  // plugin block from the captured gateway config when one is available.
  const cfg = effectiveConfig(config);
  const { scheduler, store } = getQueueRuntime(cfg);
  // Shared pre-tick step (same as `tidegap tick`): record last_tick_at and
  // re-resolve quota_reset tasks whose weekly reset already passed, so they
  // are rescheduled through the window picker instead of dispatched late.
  // Quota schedules come from the ~/.tidegap/config FILE (no env reads).
  const preTickMessages = await prepareTick(scheduler, {
    quotaConfig: loadQuotaResetConfig(),
  });
  for (const message of preTickMessages) {
    // eslint-disable-next-line no-console
    console.warn(`[tidegap] dispatcher: ${message}`);
  }
  const adapters = adaptersOverride ?? buildAdapters(cfg);
  const covered = new Set<string>(
    Object.entries(adapters)
      .filter(([, a]) => a !== undefined)
      .map(([p]) => p),
  );

  // Snapshot which due scheduled tasks have NO adapter for their provider.
  // Log the gap once per provider so the reason a task is still `scheduled`
  // after a restart is visible without spamming every sweep.
  const uncovered = new Set<string>(); // task ids we expect tick to fail
  for (const rec of store.list({ status: "scheduled" })) {
    const provider = providerOf(rec);
    if (!provider) continue;
    if (covered.has(provider)) continue;
    uncovered.add(rec.taskId);
    if (!loggedSkippedProviders.has(provider)) {
      loggedSkippedProviders.add(provider);
      // eslint-disable-next-line no-console
      const keyHint =
        PROVIDER_CONFIG_FIELD[provider as keyof typeof PROVIDER_CONFIG_FIELD] ??
        "its provider credential";
      console.warn(
        `[tidegap] dispatcher: no adapter for provider "${provider}" yet ` +
          `(runtime bridge is captured on the first tool call; plugin config ` +
          `"${keyHint}" is not set). ` +
          `Leaving those tasks scheduled; they dispatch once an adapter is available.`,
      );
    }
  }

  // DispatchAdapter omits dispatchBatch on purpose — Scheduler.tick guards
  // `typeof adapter.dispatchBatch === "function"`, so dispatch stays
  // synchronous. The cast is safe under that runtime guard.
  const result = await scheduler.tick(adapters as TickAdapters);

  // Undo any "no adapter configured" failure tick may have written: those
  // tasks must stay `scheduled`, not be marked terminal. Drop them from the
  // per-task results and adjust the aggregate counters so callers/tests see a
  // genuine skip rather than a failure.
  const skippedIds = new Set<string>();
  for (const entry of result.results) {
    if (
      entry.status === "failed" &&
      uncovered.has(entry.taskId) &&
      typeof entry.error === "string" &&
      /no adapter configured for provider/i.test(entry.error)
    ) {
      restoreToScheduled(store, entry.taskId);
      skippedIds.add(entry.taskId);
    }
  }
  if (skippedIds.size > 0) {
    result.results = result.results.filter((e) => !skippedIds.has(e.taskId));
    result.failed = Math.max(0, result.failed - skippedIds.size);
  }

  // Deliver the result of every task this sweep just completed.
  for (const entry of result.results) {
    if (entry.status === "completed") {
      await deliverCompletedTask(scheduler, entry.taskId);
    }
  }
  return result;
}

/** Read a persisted task's provider from its serialized body, if any. */
function providerOf(rec: TaskRecord<unknown>): string | undefined {
  if (!rec.bodyJson) return undefined;
  try {
    const spec = JSON.parse(rec.bodyJson) as Partial<ProviderCallSpec>;
    return spec?.type === "provider_call" ? spec.provider : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Roll a task tick just marked `failed` (for a missing adapter) back to
 * `scheduled`, preserving its chosen window so a later sweep retries it.
 * Best-effort — a storage error here must never crash the dispatcher.
 */
function restoreToScheduled(store: TaskStore, taskId: string): void {
  try {
    const rec = store.get(taskId);
    if (!rec || rec.status !== "failed") return;
    rec.status = "scheduled";
    rec.error = undefined;
    rec.completedAt = undefined;
    store.upsert(rec);
  } catch {
    // leave it as-is; the next sweep re-evaluates from the store
  }
}

/**
 * Deliver one completed task's result through its configured channels.
 * Never throws — a delivery failure must not disturb the dispatcher; the
 * result is always retained in the queue regardless.
 */
async function deliverCompletedTask(
  scheduler: Scheduler,
  taskId: string,
): Promise<void> {
  try {
    const task = scheduler.getTask(taskId);
    if (!task) return;
    const openclawConfig = getCapturedOpenClawConfig();
    const chatAvailable = telegramTarget(openclawConfig) !== undefined;
    const cfg = await getDeliveryConfig(taskId, chatAvailable);
    const outcomes = await deliverResult(task, cfg, openclawConfig);
    // Persist the per-mode outcomes so delivery is auditable afterwards
    // via check_queue_status (the `delivery` field).
    await recordDeliveryOutcomes(taskId, cfg, outcomes);
  } catch {
    // best-effort: the result stays retrievable via check_queue_status
  }
}

/**
 * Route a crossed aggregate carbon budget (ROADMAP item 4) through the
 * gateway. Logs the alert prominently and pushes it through the existing
 * delivery machinery (chat by default, using the captured gateway config).
 * Never throws — an alert delivery failure must not disturb the dispatcher.
 */
async function onCarbonAlert(alert: CarbonAlert): Promise<void> {
  // eslint-disable-next-line no-console
  console.warn(`[tidegap] ${formatCarbonAlertMessage(alert).replace(/\n/g, " · ")}`);
  try {
    await deliverCarbonAlert(alert, getCapturedOpenClawConfig());
  } catch {
    // best-effort: the marker is already persisted; the alert is logged above
  }
}

// Timer handles, kept so `disableStartupDispatch: true` arriving later (via
// plugin config on the first tool call) can actually stop the loop.
let dispatchFirstSweepTimer: ReturnType<typeof setTimeout> | undefined;
let dispatchIntervalTimer: ReturnType<typeof setInterval> | undefined;

/** Stop the background dispatch loop, if running. Idempotent. */
function stopDispatcher(): void {
  if (dispatchFirstSweepTimer) clearTimeout(dispatchFirstSweepTimer);
  if (dispatchIntervalTimer) clearInterval(dispatchIntervalTimer);
  dispatchFirstSweepTimer = undefined;
  dispatchIntervalTimer = undefined;
  dispatcherStarted = false;
}

/** Start the background dispatch loop — once per process. */
function ensureDispatcher(config: PluginConfig): void {
  activeDispatchConfig = config;
  setOsNotificationsDisabled(config.disableOsNotifications === true);
  // `disableStartupDispatch` (formerly EBB_DISABLE_STARTUP_DISPATCH=1) is a
  // plugin-config field, and plugin config only reaches this module once a
  // tool call supplies it — after the module-load bootstrap may already have
  // started the loop. So honour it here by STOPPING an already-running loop,
  // not just by declining to start one.
  if (config.disableStartupDispatch === true) {
    stopDispatcher();
    return;
  }
  if (dispatcherStarted) return;
  dispatcherStarted = true;
  const sweep = (): void => {
    // A failing sweep must never crash the gateway; per-task failures are
    // recorded on the task records by Scheduler.tick. Always reads the
    // currently-active config so a later custom-dbPath tool call re-points it.
    void runDispatchTick(activeDispatchConfig).catch(() => {});
  };
  // First sweep shortly after start — catches already-overdue tasks.
  dispatchFirstSweepTimer = setTimeout(sweep, 4000);
  dispatchFirstSweepTimer.unref?.();
  dispatchIntervalTimer = setInterval(sweep, DISPATCH_INTERVAL_MS);
  dispatchIntervalTimer.unref?.();
}

// ── Startup bootstrap ────────────────────────────────────────────────────────
// The OpenClaw plugin SDK's `defineToolPlugin` surface exposes only
// { id, name, description, configSchema, tools } — there is NO explicit
// init/activate/onStartup lifecycle hook to register a callback on (the SDK
// is injected by the gateway at load time and offers no such seam; the
// manifest's `activation.onStartup:true` governs *when the module is loaded*,
// not a hook we can pass a function to). So we start the dispatcher at module
// load, guarded behind a short unref'd `setTimeout` for two reasons:
//   1. it defers the SQLite open past import so a bad DB path fails a tool
//      call (with a clear message) rather than crashing plugin load; and
//   2. `.unref()` keeps the timer from holding a short-lived process open
//      (tests, `--version`, inspect), while a long-lived gateway keeps
//      draining every DISPATCH_INTERVAL_MS.
// `ensureDispatcher` is idempotent, so the later first-tool-call path is a
// no-op once this has fired.
//
// OPT-OUT: `disableStartupDispatch: true` in plugin config (which replaced
// `EBB_DISABLE_STARTUP_DISPATCH=1`) suppresses this — but note the ordering
// limitation it inherits from the SDK: at module load NO config exists yet, so
// the flag can only be honoured (a) when a caller passes it here directly —
// how the test suite and embedders drive it — or (b) on the first tool call,
// where `ensureDispatcher` STOPS the loop this bootstrap started. It cannot
// prevent the single deferred queue-open below. That is a deliberate trade:
// the alternative was reading the ambient environment, which is exactly what
// this plugin no longer does.
let startupBootstrapped = false;
export function bootstrapDispatcherOnStartup(config: PluginConfig = {}): void {
  if (startupBootstrapped) return;
  startupBootstrapped = true;
  if (config.disableStartupDispatch === true) return;
  // Defer the queue open + dispatcher start off the import path.
  setTimeout(() => {
    // Re-check at fire time: a caller may have opted out in the meantime.
    if (startupDispatchSuppressed) return;
    try {
      // getQueueRuntime() calls ensureDispatcher() internally.
      getQueueRuntime(config);
    } catch {
      // A missing/broken DB at boot must never crash plugin load; the queue
      // opens (with a clear error) on the first tool call instead.
    }
  }, 1000).unref?.();
}

/**
 * Suppress the module-load startup dispatcher from OUTSIDE the plugin entry.
 *
 * `defineToolPlugin` has no init hook, so `bootstrapDispatcherOnStartup()` runs
 * at import — before any caller can pass `disableStartupDispatch`. This seam
 * lets an embedder (and the test suite, via `vitest` `setupFiles`) opt out
 * between the import and the deferred queue-open 1s later. It replaces the
 * `EBB_DISABLE_STARTUP_DISPATCH=1` environment variable for that purpose;
 * inside a gateway, prefer the `disableStartupDispatch` plugin-config field.
 */
let startupDispatchSuppressed = false;
export function suppressStartupDispatch(suppressed = true): void {
  startupDispatchSuppressed = suppressed;
}

// Kick the dispatcher at module load — the manifest's activation.onStartup
// loads this module when the gateway boots, so persisted overdue tasks are
// swept without waiting for a user to invoke a tool.
bootstrapDispatcherOnStartup();

export default defineToolPlugin({
  id: "tidegap",
  name: "Tidegap — carbon-aware deferral",
  description:
    'Auto-defer "do it later" tasks to the cleanest electricity-grid hour inside the deadline.',
  // Every setting lives in ./config.ts, which is also the source of truth for
  // openclaw.plugin.json's configSchema. The plugin reads no environment
  // variables; each field's description names the variable it replaced.
  configSchema: pluginConfigSchema,
  tools: (rawTool: ToolFactory) => withEffectiveConfig(rawTool, (tool) => [
    // ── schedule_task ─────────────────────────────────────────────────────
    tool({
      name: "schedule_task",
      label: "Schedule task at cleanest grid hour",
      description: toolDescription("schedule_task"),
      parameters: openclawToolParameters("schedule_task"),
      async execute(
        params: {
          prompt: string;
          deadline: string;
          region?: string;
          carbon_budget_g?: number;
          model?: string;
          provider?: "anthropic" | "openai" | "gemini" | "ollama";
          deliver?: string[];
          webhook_url?: string;
          file_path?: string;
          file_format?: string;
          candidates?: string[];
          route_weights?: { carbon?: number; cost?: number; latency?: number };
        },
        config: PluginConfig,
        context?: unknown,
      ) {
        captureOpenClawRuntime(context);
        const { scheduler, dbPath } = getQueueRuntime(config);
        const { region, source } = regionFor(params.region, config, "schedule_task");
        const explicitModel = params.model?.trim();

        // Provider: explicit param wins; else infer from the model prefix
        // (gpt-*/o<n>* → openai, gemini-* → gemini, an OLLAMA_MODELS-listed id
        // → ollama, claude-* → anthropic; default anthropic).
        const provider = params.provider ?? inferProvider(explicitModel, config);
        const providerInferred = params.provider === undefined;
        // A concrete model is stored for the direct-API-key path and for the
        // audit record; the OpenClaw runtime bridge ignores it and uses the
        // gateway agent's own model. Default the model to the chosen
        // provider's flagship so a task never carries a foreign model.
        const model = explicitModel || DEFAULT_MODEL_BY_PROVIDER[provider];

        // How this task will execute when due: "openclaw-runtime" (gateway
        // model, no key), "api-key", or "unconfigured".
        const dispatch = dispatchCapability(config);

        // Key validation on the API-key dispatch path: if the ONLY route is a
        // direct API key and the chosen provider has none, the task would
        // fail 100% of the time at dispatch (and, worse, a gpt-* model would
        // be POSTed to api.anthropic.com under the old hardcoded provider).
        // Reject here so the failure surfaces at schedule time, not silently
        // at the clean-grid hour. On the runtime-bridge path the gateway model
        // runs regardless of `provider`, so no rejection is warranted there;
        // when unconfigured we WARN loudly instead of rejecting, because this
        // same call may have just captured the bridge (context-dependent).
        // Cross-provider routing: >= 2 candidates means the winning provider is
        // decided at the chosen window, and the dispatch-time fallback walks to
        // the next-best candidate whose adapter is ready — so a missing key on
        // the (fallback) primary provider is not a hard reject here.
        const routingActive =
          Array.isArray(params.candidates) && params.candidates.length >= 2;
        if (dispatch === "api-key" && !routingActive) {
          const providers = availableProviders(config);
          if (!providers.has(provider)) {
            const keyName = PROVIDER_CONFIG_FIELD[provider];
            throw new Error(
              `schedule_task rejected: this task would dispatch via provider "${provider}" ` +
                `(${providerInferred ? `inferred from model "${model}"` : "explicitly requested"}), ` +
                `but the tidegap plugin's "${keyName}" config field is not set on the gateway. ` +
                `Set it in plugins.entries.tidegap.config and retry, or choose a ` +
                `provider whose credential is configured (${[...providers].join(", ") || "none"}).`,
            );
          }
        }

        const task = await scheduler.enqueueProviderCall(
          {
            type: "provider_call",
            provider,
            model,
            prompt: params.prompt,
            candidates: params.candidates,
            routeWeights: params.route_weights,
          },
          {
            deadline: new Date(params.deadline),
            region,
            carbonBudgetG: params.carbon_budget_g,
            originHost: "openclaw",
          },
        );

        // Result delivery — store the preference if the caller already
        // provided one; otherwise the result asks the agent to collect it.
        const deliveryOptions = scanDeliveryOptions(getCapturedOpenClawConfig());
        let deliverySet: DeliveryConfig | undefined;
        let deliveryError: string | undefined;
        if (params.deliver && params.deliver.length > 0) {
          const cfg: DeliveryConfig = {
            modes: params.deliver as DeliveryMode[],
            webhookUrl: params.webhook_url,
            filePath: params.file_path,
            format: params.file_format as ReportFormat | undefined,
          };
          deliveryError = validateDeliveryConfig(cfg) ?? undefined;
          if (!deliveryError) {
            await setDeliveryConfig(task.taskId, cfg);
            deliverySet = cfg;
          }
        }

        // Grid-source disclosure: the scheduler scores against the grid feed,
        // which falls back to a deterministic SYNTHETIC curve when no live
        // feed key is set. Surface that honestly on the schedule response.
        const gridSource = task.receipt?.gridSource ?? getGridFeed(config).source;
        const synthetic = gridSource === "mock";

        // Warn (do not reject) when nothing can dispatch yet: the bridge may
        // be captured on a later tool call, so the task is still worth queuing.
        const unconfiguredWarning =
          dispatch === "unconfigured"
            ? "No dispatch route is configured yet: no ANTHROPIC_API_KEY / OPENAI_API_KEY, " +
              "and the OpenClaw runtime bridge has not been captured. The task is queued and " +
              "will dispatch once a route is available (the bridge is captured on the first " +
              "tool call in this process, or set a provider API key)."
            : undefined;

        return {
          task_id: task.taskId,
          status: task.status,
          region: task.region,
          region_source: source,
          provider,
          provider_source: providerInferred ? "inferred" : "flag",
          model,
          scheduled_for: task.scheduledFor ?? null,
          estimated_carbon_g_co2: task.estimatedCarbonGCo2 ?? null,
          grid_source: gridSource,
          persisted_to: dbPath,
          dispatch,
          delivery: deliverySet ?? null,
          ...(task.routingDecision
            ? {
                routing: {
                  chosen: task.routingDecision.chosen,
                  weights: task.routingDecision.weights,
                  considered: task.routingDecision.considered,
                  reasoning: task.routingDecision.reasoning,
                },
              }
            : {}),
          delivery_options: deliveryOptions
            .filter((o) => o.available)
            .map((o) => `${o.mode} — ${o.detail}`),
          next_step: deliverySet
            ? "Result delivery is configured."
            : "Ask the user how they want this task's result delivered — they may pick several from delivery_options (default: chat). Then call set_delivery with the task_id and their choice.",
          ...(synthetic ? { synthetic_grid_data: SYNTHETIC_GRID_WARNING } : {}),
          ...(deliveryError ? { delivery_error: deliveryError } : {}),
          ...(unconfiguredWarning ? { warning: unconfiguredWarning } : {}),
          ...(explicitModel && dispatch === "openclaw-runtime"
            ? {
                note:
                  `model "${explicitModel}" is honoured only on the direct ` +
                  `API-key dispatch path; via the OpenClaw runtime bridge the ` +
                  `task runs on the gateway agent's configured model.`,
              }
            : {}),
        };
      },
    }),

    // ── recommend_window ──────────────────────────────────────────────────
    tool({
      name: "recommend_window",
      label: "Preview cleanest dispatch window",
      description: toolDescription("recommend_window"),
      parameters: openclawToolParameters("recommend_window"),
      async execute(
        params: {
          deadline: string;
          region?: string;
          carbon_budget_g?: number;
          candidates?: string[];
          route_weights?: { carbon?: number; cost?: number; latency?: number };
        },
        config: PluginConfig,
        context?: unknown,
      ) {
        captureOpenClawRuntime(context);
        const { region } = regionFor(params.region, config, "recommend_window");
        // The result carries a non-binding `routingPreview` (scored candidate
        // list + provisional pick) whenever >= 2 candidates were supplied.
        return await recommendWindow(
          {
            deadline: new Date(params.deadline),
            region,
            carbonBudgetG: params.carbon_budget_g,
            candidates: params.candidates,
            routeWeights: params.route_weights,
          },
          { feed: getGridFeed(config) },
        );
      },
    }),

    // ── check_queue_status ────────────────────────────────────────────────
    tool({
      name: "check_queue_status",
      label: "Check Tidegap queue status",
      description: toolDescription("check_queue_status"),
      parameters: openclawToolParameters("check_queue_status"),
      async execute(
        params: { task_id?: string },
        config: PluginConfig,
        context?: unknown,
      ) {
        captureOpenClawRuntime(context);
        const { scheduler } = getQueueRuntime(config);
        const tasks = scheduler.listPersistedTasks();
        if (params.task_id) {
          const task = tasks.find((t) => t.taskId === params.task_id);
          if (!task) {
            throw new Error(
              `No Tidegap task found with id ${params.task_id}. ` +
                "Call this tool with no arguments to list every task.",
            );
          }
          // Viewing a finished task's result marks it read (v0.17).
          if (task.status === "completed" || task.status === "failed") {
            const now = new Date();
            if (scheduler.markTaskRead(task.taskId, now)) task.readAt = now.toISOString();
          }
          // Omit bodyJson — it is the internal serialized request spec and
          // is misleading as a status field: it shows the requested model,
          // not the model that actually ran. The receipt records what ran.
          const { bodyJson: _bodyJson, ...view } = task;
          const provenance = receiptProvenance(task.receipt);
          const synthetic = task.receipt?.gridSource === "mock";
          // The stored prompt (redacted once the task finished), as the
          // shared check_queue_status description promises.
          const prompt = taskPrompt(task);
          return {
            ...view,
            ...(prompt !== undefined
              ? { prompt: stripControlChars(prompt, { multiline: true }) }
              : {}),
            // Surface receipt provenance (actual/delta/intensity/grid_source/
            // energy_source) in one place, mirroring the MCP server.
            ...(provenance ? { receipt_provenance: provenance } : {}),
            ...(synthetic ? { synthetic_grid_data: SYNTHETIC_GRID_WARNING } : {}),
            delivery: (await readDeliveryRecord(params.task_id)) ?? null,
          };
        }
        return {
          total: tasks.length,
          // When a ticker last ran (this loop or `tidegap tick`), v0.17.
          last_tick_at: scheduler.lastTickAt() ?? null,
          tasks: tasks.map((t) => ({
            task_id: t.taskId,
            title: t.title ?? null,
            status: t.status,
            region: t.region,
            scheduled_for: t.scheduledFor ?? null,
            // "submitted" (v0.12 batch routing): the task is awaiting Batch API
            // results. Surface the batch id whenever the core recorded one so a
            // submitted task is legible instead of looking stuck.
            ...(t.batchId ? { batch_id: t.batchId } : {}),
          })),
        };
      },
    }),

    // ── cancel_task ───────────────────────────────────────────────────────
    tool({
      name: "cancel_task",
      label: "Cancel an Tidegap task",
      description: toolDescription("cancel_task"),
      parameters: openclawToolParameters("cancel_task"),
      async execute(
        params: { task_id: string; series?: boolean },
        config: PluginConfig,
        context?: unknown,
      ) {
        captureOpenClawRuntime(context);
        const { scheduler } = getQueueRuntime(config);
        const series = params.series === true;
        const result = scheduler.cancelTask(params.task_id, { series });
        return {
          task_id: params.task_id,
          status: result.status,
          completed_at: result.completedAt ?? null,
          ...(result.seriesId ? { series_id: result.seriesId, series_ended: series } : {}),
        };
      },
    }),

    // ── reply_task ────────────────────────────────────────────────────────
    tool({
      name: "reply_task",
      label: "Reply to a completed task",
      description: toolDescription("reply_task"),
      parameters: openclawToolParameters("reply_task"),
      async execute(
        params: { task_id: string; text: string; deadline?: string },
        config: PluginConfig,
        context?: unknown,
      ) {
        captureOpenClawRuntime(context);
        if (typeof params.text !== "string" || params.text.length > REPLY_MAX_CHARS) {
          throw new Error(`reply_task: text must be 1 to ${REPLY_MAX_CHARS} characters`);
        }
        const { scheduler } = getQueueRuntime(config);
        let child;
        try {
          child = await scheduler.replyToTask(params.task_id, params.text, {
            ...(params.deadline !== undefined ? { deadline: params.deadline } : {}),
          });
        } catch (err) {
          // The core's refusal names the rule (e.g. "is failed; only
          // completed provider-call tasks accept a reply").
          throw new Error(err instanceof Error ? err.message : String(err));
        }
        return {
          task_id: child.taskId,
          parent_task_id: params.task_id,
          status: child.status,
          scheduled_for: child.scheduledFor ?? null,
          deadline: child.deadline ?? null,
        };
      },
    }),

    // ── get_grid_forecast ─────────────────────────────────────────────────
    tool({
      name: "get_grid_forecast",
      label: "Forecast grid carbon intensity",
      description: toolDescription("get_grid_forecast"),
      parameters: openclawToolParameters("get_grid_forecast"),
      async execute(
        params: { region?: string; hours?: number },
        config: PluginConfig,
        context?: unknown,
      ) {
        captureOpenClawRuntime(context);
        const { region } = regionFor(params.region, config, "get_grid_forecast");
        const forecast = await getGridFeed(config).fetchForecast(
          region,
          params.hours ?? 24,
        );
        return forecast;
      },
    }),

    // ── update_deadline ───────────────────────────────────────────────────
    tool({
      name: "update_deadline",
      label: "Move a task's deadline",
      description: toolDescription("update_deadline"),
      parameters: openclawToolParameters("update_deadline"),
      async execute(
        params: { task_id: string; deadline: string },
        config: PluginConfig,
        context?: unknown,
      ) {
        captureOpenClawRuntime(context);
        const { scheduler } = getQueueRuntime(config);
        // An explicit deadline replaces a quota_reset rule, as in MCP.
        const record = await scheduler.updateDeadline(
          params.task_id,
          new Date(params.deadline),
          { deadlineKind: "absolute" },
        );
        return {
          task_id: params.task_id,
          status: record.status,
          scheduled_for: record.scheduledFor ?? null,
          new_deadline: params.deadline,
        };
      },
    }),

    // ── cancel_all ────────────────────────────────────────────────────────
    tool({
      name: "cancel_all",
      label: "Cancel all queued tasks",
      description: toolDescription("cancel_all"),
      parameters: openclawToolParameters("cancel_all"),
      async execute(
        params: { status?: "queued" | "scheduled" },
        config: PluginConfig,
        context?: unknown,
      ) {
        captureOpenClawRuntime(context);
        const { scheduler } = getQueueRuntime(config);
        const targets = scheduler
          .listPersistedTasks()
          .filter(
            (t) =>
              (t.status === "queued" || t.status === "scheduled") &&
              (!params.status || t.status === params.status),
          );
        let cancelled = 0;
        const errors: Array<{ task_id: string; error: string }> = [];
        for (const t of targets) {
          try {
            scheduler.cancelTask(t.taskId);
            cancelled++;
          } catch (err) {
            errors.push({
              task_id: t.taskId,
              error: err instanceof Error ? err.message : String(err),
            });
          }
        }
        return { matched: targets.length, cancelled, errors };
      },
    }),

    // ── set_delivery ──────────────────────────────────────────────────────
    tool({
      name: "set_delivery",
      label: "Set how a task's result is delivered",
      description: toolDescription("set_delivery"),
      parameters: openclawToolParameters("set_delivery"),
      async execute(
        params: {
          task_id: string;
          deliver: string[];
          webhook_url?: string;
          file_path?: string;
          file_format?: string;
        },
        _config: PluginConfig,
        context?: unknown,
      ) {
        captureOpenClawRuntime(context);
        const cfg: DeliveryConfig = {
          modes: params.deliver as DeliveryMode[],
          webhookUrl: params.webhook_url,
          filePath: params.file_path,
          format: params.file_format as ReportFormat | undefined,
        };
        const error = validateDeliveryConfig(cfg);
        if (error) throw new Error(`set_delivery: ${error}`);
        await setDeliveryConfig(params.task_id, cfg);
        return { task_id: params.task_id, delivery: cfg };
      },
    }),

    // ── expedite_task ─────────────────────────────────────────────────────
    tool({
      name: "expedite_task",
      label: "Dispatch a task immediately",
      description: toolDescription("expedite_task"),
      parameters: openclawToolParameters("expedite_task"),
      async execute(
        params: { task_id: string },
        config: PluginConfig,
        context?: unknown,
      ) {
        captureOpenClawRuntime(context);
        const { scheduler } = getQueueRuntime(config);
        let entry;
        try {
          entry = await scheduler.expediteTask(
            params.task_id,
            buildAdapters(config) as TickAdapters,
          );
        } catch (err) {
          // Surface the scheduler's own rejection message verbatim (e.g. a
          // task in `submitted`/`running`/terminal state cannot be expedited)
          // rather than a generic failure.
          throw new Error(
            `expedite_task could not run task ${params.task_id}: ${
              err instanceof Error ? err.message : String(err)
            }`,
          );
        }
        if (entry.status === "completed") {
          await deliverCompletedTask(scheduler, params.task_id);
        }
        const task = scheduler.getTask(params.task_id);
        const provenance = receiptProvenance(task?.receipt);
        return {
          task_id: params.task_id,
          status: entry.status,
          ...(entry.error ? { error: entry.error } : {}),
          receipt: task?.receipt ?? null,
          ...(provenance ? { receipt_provenance: provenance } : {}),
          ...(task?.receipt?.gridSource === "mock"
            ? { synthetic_grid_data: SYNTHETIC_GRID_WARNING }
            : {}),
          result: task?.result ?? null,
          delivery: (await readDeliveryRecord(params.task_id)) ?? null,
        };
      },
    }),

    // ── retry_task ────────────────────────────────────────────────────────
    tool({
      name: "retry_task",
      label: "Retry a failed task",
      description: toolDescription("retry_task"),
      parameters: openclawToolParameters("retry_task"),
      async execute(
        params: { task_id: string },
        config: PluginConfig,
        context?: unknown,
      ) {
        captureOpenClawRuntime(context);
        const { scheduler } = getQueueRuntime(config);
        let entry;
        try {
          entry = await scheduler.retryTask(
            params.task_id,
            buildAdapters(config) as TickAdapters,
          );
        } catch (err) {
          // Surface the scheduler's own rejection message verbatim (e.g. a
          // task in `submitted`/`running`/non-failed state cannot be retried).
          throw new Error(
            `retry_task could not re-dispatch task ${params.task_id}: ${
              err instanceof Error ? err.message : String(err)
            }`,
          );
        }
        if (entry.status === "completed") {
          await deliverCompletedTask(scheduler, params.task_id);
        }
        const task = scheduler.getTask(params.task_id);
        const provenance = receiptProvenance(task?.receipt);
        return {
          task_id: params.task_id,
          status: entry.status,
          ...(entry.error ? { error: entry.error } : {}),
          receipt: task?.receipt ?? null,
          ...(provenance ? { receipt_provenance: provenance } : {}),
          ...(task?.receipt?.gridSource === "mock"
            ? { synthetic_grid_data: SYNTHETIC_GRID_WARNING }
            : {}),
          result: task?.result ?? null,
          delivery: (await readDeliveryRecord(params.task_id)) ?? null,
        };
      },
    }),
  ]),
});
