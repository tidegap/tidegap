/**
 * @tidegap/core — carbon-aware scheduling for agentic AI workflows.
 *
 * Everything re-exported below is the public surface; the export list
 * itself is the source of truth. The main entry points:
 *
 *   import { defer, Scheduler, recommendWindow } from "@tidegap/core";
 *   import { AnthropicAdapter, OpenAIAdapter } from "@tidegap/core";
 *   import { TaskStore } from "@tidegap/core";
 *
 * Highlights: Anthropic + OpenAI + Gemini + Ollama provider adapters,
 * SQLite-backed durable queue with a cross-process audit ledger,
 * per-model energy coefficients, Ed25519-signed carbon receipts,
 * multi-source grid feeds with a deterministic mock fallback.
 *
 * Still out of scope (tracked in ROADMAP.md):
 *   - Cross-provider routing.
 *
 * ── ENVIRONMENT PURITY ──────────────────────────────────────────────────────
 * This library reads NO environment variables. Every credential, host URL and
 * threshold is an explicit argument; the HOST application decides where its
 * configuration comes from and injects it:
 *
 *   - `tidegap` CLI and `@tidegap/mcp` server → read the documented env vars
 *     (ANTHROPIC_API_KEY, OPENAI_API_KEY, GEMINI_API_KEY / GOOGLE_API_KEY,
 *     OLLAMA_HOST, TIDEGAP_EIA_API_KEY, TIDEGAP_ELECTRICITY_MAPS_API_KEY,
 *     TIDEGAP_ENTSOE_SECURITY_TOKEN, WATTTIME_USERNAME / WATTTIME_PASSWORD,
 *     TIDEGAP_CARBON_BUDGET_*) at their own entry points.
 *   - the OpenClaw plugin (`@vitalini/tidegap`) → reads its OpenClaw plugin
 *     config and reads no environment variables at all, so the published
 *     bundle contains zero ambient-environment accesses.
 *
 * The `~/.tidegap/config` FILE is still read by `loadCarbonBudgetConfig` —
 * that is filesystem I/O against a path this project owns, not ambient state.
 *
 * NOTE — deliberate TS/Python asymmetry: the Python mirror (`tidegap`, in
 * packages/core-py) is NOT environment-pure. It is used directly as its own
 * host (scripts, notebooks) rather than being bundled into a third-party
 * plugin, so its `os.environ` fallbacks stay for ergonomics.
 */

export {
  CarbonBudgetExceededError,
  defer,
  InvalidDeadlineError,
  LAST_TICK_META_KEY,
  pickBestWindow,
  Scheduler,
  TaskActionError,
} from "./scheduler.js";
export type {
  ReplyOptions,
  RescheduleTarget,
  SchedulerOptions,
  ActorOptions,
  TickAdapters,
} from "./scheduler.js";
export { recommendWindow } from "./recommend.js";
// Task visibility (v0.17): titles, history, display helpers.
export {
  TITLE_MAX_CHARS,
  deadlineKindLabel,
  deriveTitle,
  displayTitle,
  isRepeating,
  isValidSessionId,
  resumeCommand,
  SESSION_ID_PATTERN,
  shellQuote,
  taskActions,
  stripControlChars,
  capHistory,
  HISTORY_MAX_CHARS,
  taskHistory,
  taskPrompt,
  taskResultText,
} from "./history.js";
export type { TaskActions } from "./history.js";
// Readiness (coherence KTD1 to KTD3).
export {
  assessReadiness,
  pendingProvidersFromStore,
  problemLine,
  readTickRunners,
  runnersFromSnapshot,
  snapshotIsFresh,
  TICKER_CODES,
  tickIntervalFor,
  TICK_RUNNERS_META_KEY,
  writeTickRunners,
} from "./readiness.js";
export type {
  DaemonFact,
  Readiness,
  ReadinessCode,
  ReadinessFacts,
  ReadinessProblem,
  RunnerFact,
  TickRunnersSnapshot,
} from "./readiness.js";
// "Later" presets (coherence KTD4 to KTD6).
export {
  LIMIT_RESET_HINT_META_KEY,
  NEEDS_RESET_TIME,
  POSTPONE_LABELS,
  POSTPONE_PRESETS,
  localTimeLabel,
  MORNING_START_H,
  plannedStart,
  postponeOptions,
  readLimitResetHint,
  resolveLimitReset,
  resolvePostpone,
  taskProvider,
  TONIGHT_START_H,
  writeLimitResetHint,
} from "./postpone.js";
export type {
  LimitReset,
  LimitResetSource,
  PostponeOption,
  PostponePreset,
  PostponeTarget,
  ResolvedPostpone,
} from "./postpone.js";
// Channels: registry, Telegram client, bot commands and texts (coherence KTD10 to KTD15).
export {
  CALLBACK_ACTIONS,
  CALLBACK_PRESETS,
  cleanWindowMessage,
  commandContextFor,
  callbackFits,
  encodeCallback,
  CHANNEL_KINDS,
  channelQuiet,
  descriptorData,
  EVENT_KINDS,
  eventMessage,
  isChannelKind,
  isQuietTime,
  KIND_DESCRIPTORS,
  payloadFor,
  testPayload,
  TEST_MESSAGE_TEXT,
  validateFields,
  WEBHOOK_BODY_VERSION,
  webhookBody,
  HELP_TEXT,
  telegramCommands,
  isLoopbackApiBase,
  isRedactedTask,
  LATER_GRAMMAR,
  laterMenuMessage,
  laterTarget,
  LISTING_TTL_MS,
  messageTitle,
  nextClockTime,
  notReadyMessage,
  osChannel,
  parseCallback,
  parseCommand,
  planNotifications,
  QUEUE_LIST_MAX,
  QueueListing,
  queueMessage,
  RESULT_MAX_PARTS,
  resultMessages,
  runCallback,
  runCommand,
  splitMessage,
  taskDoneMessage,
  taskFailedMessage,
  telegramChatId,
  TELEGRAM_API_BASE,
  TELEGRAM_CALL_TIMEOUT_MS,
  TELEGRAM_CALLBACK_MAX_BYTES,
  TELEGRAM_MESSAGE_MAX,
  TELEGRAM_PREVIEW_CHARS,
  TelegramClient,
  TelegramError,
} from "./channels/index.js";
export type {
  CallbackAction,
  CallbackActionName,
  CallbackOutcome,
  Channel,
  ChannelCommand,
  ChannelEvent,
  ChannelKind,
  CleanWindowEvent,
  DeliverySpec,
  FieldErrorCode,
  FieldInput,
  FieldOption,
  FieldValidation,
  FieldValues,
  KindDescriptor,
  KindDescriptorData,
  KindErrorText,
  KindField,
  KindPreset,
  KindStep,
  NotificationLevel,
  NotificationPayload,
  PayloadEvent,
  QuietMode,
  RegistryKind,
  CommandContext,
  EventKind,
  InlineButton,
  InlineKeyboard,
  LaterArg,
  OutgoingMessage,
  SendJob,
  TaskRef,
  TelegramCallbackQuery,
  TelegramChannelConfig,
  TelegramChat,
  TelegramClientOptions,
  TelegramErrorKind,
  TelegramMessage,
  TelegramUpdate,
  TelegramUser,
} from "./channels/index.js";
// Cross-provider routing (ROADMAP item 1).
export {
  scoreCandidates,
  previewRouting,
  parseCandidate,
  parseCandidates,
  candidateId,
  normalizeRouteWeights,
  priceForModel,
  DEFAULT_ROUTE_WEIGHTS,
  ROUTING_PREVIEW_DISCLOSURE,
  SCORE_TIE_EPSILON,
  InvalidCandidateError,
  InvalidRouteWeightsError,
  MissingPriceError,
} from "./routing.js";
export type {
  RouteWeights,
  RoutingCandidate,
  RoutingDecision,
  RoutingPreview,
  ScoredCandidate,
  LatencyClass,
  ModelPrice,
  ScoreCandidatesOptions,
} from "./routing.js";
export {
  selectWindow,
  inDeadlineEntries,
  TOLERANCE_FLOOR_G,
  TOLERANCE_FRACTION,
} from "./select-window.js";
export type {
  SelectWindowOptions,
  SelectWindowResult,
} from "./select-window.js";
export {
  ASSUMED_KWH_PER_CALL,
  classifyBand,
  aggregateStats,
  aggregateByRegion,
  bandHistogram,
  achievements,
} from "./aggregator.js";
export type {
  CarbonStats,
  RegionStats,
  BandHistogram,
  Achievement,
} from "./aggregator.js";
// Aggregate carbon-budget alerts (ROADMAP item 4).
// Desktop notifications (v0.17): pure command builder, hosts spawn it.
export {
  NOTIFY_PREVIEW_CHARS,
  WIN_NOTIFY_BODY_VAR,
  WIN_NOTIFY_TITLE_VAR,
  osNotifyCommand,
  taskNotificationContent,
} from "./notify.js";
export type { OsNotifyCommand, OsNotifyOptions } from "./notify.js";
export {
  CLAUDE_CODE_TOOL_ALLOWLIST,
  DEFAULT_CLAUDE_CODE_TOOLS,
  DEFAULT_ORIGIN_TOOLS,
  claudeCodeToolsError,
  includesFileTool,
  includesWebTool,
} from "./claude-tools.js";
export { forkCommand, freshReasonText, runSessionSummary, shortSessionId, taskOrigin, tokensLabel } from "./run-session.js";
export type { FreshReason, RunSession, RunSessionMode } from "./run-session.js";
export {
  carbonBudgetConfigPath,
  carbonBudgetStatus,
  carbonBudgetUsage,
  loadCarbonBudgetConfig,
  parseKeyValues,
  KEY_PREFIX,
  receiptCarbonG,
  windowBounds,
} from "./budget.js";
export type {
  CarbonAlert,
  CarbonBudgetConfig,
  CarbonBudgetEnv,
  CarbonBudgetStatus,
  CarbonBudgetUsage,
  CarbonBudgetWindowKind,
  LoadCarbonBudgetOptions,
} from "./budget.js";
// Quota-reset deadlines and the shared pre-tick step (v0.17).
export {
  DEFAULT_QUOTA_MARGIN_H,
  loadQuotaResetConfig,
  nextQuotaReset,
  prepareTick,
  previousQuotaReset,
  replanSweep,
  resolveQuotaDeadline,
  resolveQuotaProvider,
  sweepQuotaDeadlines,
} from "./quota.js";
export type {
  LoadQuotaResetOptions,
  QuotaResetConfig,
  QuotaResetSchedule,
  ResolveQuotaProviderResult,
} from "./quota.js";
export {
  mockGridFeed,
  electricityMapsFeed,
  ukCarbonIntensityFeed,
  eiaFeed,
  entsoeFeed,
  wattTimeFeed,
  multiSourceGridFeed,
  buildDefaultGridFeed,
  regionDataSource,
} from "./grid.js";
export type { GridFeedCredentials, RegionDataSource } from "./grid.js";
export type {
  DeferOptions,
  GridFeed,
  GridForecast,
  GridForecastEntry,
  GridSignalType,
  CarbonReceipt,
  DeadlineKind,
  ProviderCallOrigin,
  ProviderCallSpec,
  ProviderName,
  RecommendAlternative,
  RecommendOptions,
  RecommendResult,
  RepeatRule,
  TaskRecord,
  TaskMessage,
  TaskOriginHost,
  TaskStatus,
  TickResult,
  TickResultEntry,
} from "./types.js";
export {
  AnthropicAdapter,
  OpenAIAdapter,
  GeminiAdapter,
  OllamaAdapter,
  DEFAULT_MODEL_BY_PROVIDER,
  ProviderRefusalError,
} from "./providers/index.js";
export { ProviderDeferError } from "./providers/defer.js";
export type {
  BatchHandle,
  DispatchOptions,
  DispatchOrigin,
  DispatchResult,
  ProviderAdapter,
} from "./providers/index.js";
export { TaskStore } from "./storage/sqlite.js";
export {
  TASK_EVENT_KINDS,
  eventSummary,
  formatTaskEvent,
  isTaskEventKind,
  normalizeActor,
  taskEventJson,
} from "./task-events.js";
export type { TaskEvent, TaskEventActor, TaskEventInput, TaskEventKind } from "./task-events.js";
export type { TaskListFilter, TaskStoreOptions } from "./storage/sqlite.js";
export {
  FALLBACK_REGION,
  REGION_SETTING_KEY,
  REGION_CATALOG,
  TIMEZONE_REGION,
  APPROXIMATE_TIMEZONE_REGION,
  catalogZone,
  closestRegions,
  regionForTimezone,
  guessRegionFromTimeZone,
  hostTimeZone,
  detectRegionFromTimezone,
  ignoredRegionMessage,
  loadRegionSetting,
  resolveRegion,
} from "./region.js";
export {
  checkRequestedRegion,
  regionRequestUrl,
  regionSettingReader,
  unknownRegionMessage,
} from "./region-host.js";
export type { RegionSettingReaderOptions } from "./region-host.js";
export type {
  RegionApproximation,
  RegionCatalogEntry,
  RegionResolution,
  RegionSource,
  ResolveRegionInput,
} from "./region.js";
export {
  DEFAULT_PUE,
  LEGACY_KWH_PER_TASK,
  MODEL_ENERGY_COEFFICIENTS,
  MODEL_FAMILIES,
  ENERGY_SOURCES,
  normalizeModelName,
  lookupModelEnergy,
  resolveModelEnergy,
  estimateEnergyKwh,
  gramsForIntensity,
} from "./energy.js";
export type {
  EnergySourceTier,
  EnergyResolutionTier,
  ModelLifecycleStatus,
  ModelEnergyCoefficients,
  ModelFamily,
  ResolvedModelEnergy,
  EstimateEnergyOpts,
} from "./energy.js";
export {
  ALL_TOOL_HOSTS,
  TOOL_SURFACE,
  getToolDef,
  getToolDefOrThrow,
  toolsForHost,
  paramHosts,
  paramIncludedForHost,
  paramsForHost,
  paramOptionalForHost,
  neutralSurfaceForHost,
} from "./tool-surface.js";
export type {
  ToolHost,
  ToolParamKind,
  ToolParam,
  CanonicalToolDef,
} from "./tool-surface.js";
export {
  canonicalize,
  defaultSigningKeyPath,
  loadOrCreateSigningKey,
  signReceipt,
  verifyReceipt,
} from "./sign.js";
export type {
  SigningKeyOptions,
  SigningKeyPair,
  VerifyOutcome,
  VerifyResult,
} from "./sign.js";
export {
  TIDEGAP_HOME_DIR,
  resolveTidegapHome,
  tidegapPath,
} from "./paths.js";
export type { ResolveHomeOptions } from "./paths.js";
