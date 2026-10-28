/**
 * Scheduler — the in-process orchestrator for Tidegap.
 *
 * Responsibilities:
 *   - Hold a queue of deferrable tasks (closure-based `defer`/`enqueue`
 *     and JSON-persistable provider-call tasks).
 *   - Score candidate execution windows for each task using a grid feed.
 *   - Sleep until the chosen window (closure tasks) or mark the window
 *     for a later `tick()` (provider-call tasks), then dispatch.
 *   - Record a signed carbon receipt on the resulting TaskRecord.
 *   - Optionally write every state transition through to a SQLite
 *     audit ledger (`dbPath`), shared safely across processes via WAL
 *     plus a row-level dispatch claim.
 *
 * Still out of scope (see ROADMAP.md):
 *   - Cross-provider routing.
 *   - Multi-region failover.
 */

import { randomUUID } from "node:crypto";
import {
  carbonBudgetUsage,
  receiptCarbonG,
  windowBounds,
  type CarbonAlert,
  type CarbonBudgetConfig,
} from "./budget.js";
import { billModelUsage, gramsForIntensity, resolveModelEnergy } from "./energy.js";
import { claudeCodeToolsError } from "./claude-tools.js";
import { mockGridFeed } from "./grid.js";
import type { DispatchOptions, ModelUsage, ProviderAdapter, RunDetails } from "./providers/base.js";
import type { RunSession } from "./run-session.js";
import { deferRetryAt } from "./providers/defer.js";
import {
  postponeOptions,
  resolveLimitReset,
  resolvePostpone,
  taskProvider,
  writeLimitResetHint,
  type LimitResetSource,
  type PostponeOption,
  type PostponeTarget,
} from "./postpone.js";
import {
  candidateId,
  parseCandidates,
  previewRouting,
  scoreCandidates,
  type RoutingDecision,
  type RoutingPreview,
} from "./routing.js";
import { capHistory, deriveTitle, displayTitle, isRepeating, taskActions, taskHistory } from "./history.js";
import { JOB_INTERRUPTED_ERROR } from "./jobs.js";
import { resolveQuotaDeadline, type QuotaResetConfig } from "./quota.js";
import { redactBodyJson, redactPrompt } from "./redact.js";
import { selectWindow } from "./select-window.js";
import {
  loadOrCreateSigningKey,
  signReceipt,
  type SigningKeyPair,
} from "./sign.js";
import { TaskStore } from "./storage/sqlite.js";
import { eventDetails, impliedEventKind, type TaskEvent, type TaskEventActor, type TaskEventInput } from "./task-events.js";
import type {
  CarbonReceipt,
  DeferOptions,
  DeferrableTask,
  GridFeed,
  GridForecast,
  GridForecastEntry,
  ProviderCallSpec,
  ProviderName,
  RepeatRule,
  TaskRecord,
  TaskStatus,
  TickResult,
  TickResultEntry,
} from "./types.js";

/** Target of {@link Scheduler.rescheduleTask} (ui v2): exactly one shape. */
export type RescheduleTarget =
  /** A new deadline; the window picker chooses the hour. */
  | { deadline: string | Date }
  /** An exact time; no picker. The deadline rises to it if needed. */
  | { at: string | Date }
  /** A local day as two instants; the picker chooses an hour inside it. */
  | { dayStart: string | Date; dayEnd: string | Date }
  /**
   * An earliest start (a usage-limit reset); the picker chooses an hour at
   * or after it. The deadline rises to at least `notBefore + 2 h`.
   */
  | { notBefore: string | Date; deadline?: string | Date };

/** Options of {@link Scheduler.replyToTask} (ui v2). */
export interface ReplyOptions {
  /** Default: one hour from now. */
  deadline?: string | Date;
  /** Default: "Re: <parent title>". */
  title?: string;
  /** Defaults to the parent's origin. */
  originHost?: DeferOptions["originHost"];
  originCwd?: string;
  originSessionId?: string;
  /**
   * Keep the parent's origin session (`spec.origin`), so the reply runs in
   * a copy of that session too. Default false: only a caller that is the
   * user (the CLI, the page) or that session itself may resume it; any other
   * caller's reply runs fresh.
   */
  keepOrigin?: boolean;
}

const PENDING_STATUSES: readonly TaskStatus[] = ["queued", "scheduled"];
const UNFINISHED_STATUSES: readonly TaskStatus[] = ["queued", "scheduled", "submitted", "running"];
const TERMINAL: ReadonlySet<TaskStatus> = new Set(["completed", "failed", "cancelled"]);

const DEFAULT_REGION = "US-CAL-CISO";
const MAX_HORIZON_HOURS = 72;
/** Ledger meta key holding the ISO time a ticker last ran. */
export const LAST_TICK_META_KEY = "last_tick_at";

/**
 * The adapters map `tick` (and the expedite / retry / batch helpers) accept:
 * a provider name → adapter. A partial record so a caller can supply only the
 * providers it has configured; an unmapped provider fails the task with a
 * clear "no adapter configured" error rather than silently dropping it.
 */
export type TickAdapters = Partial<Record<ProviderName, ProviderAdapter>>;

/** Options of {@link Scheduler.tick}. */
export interface TickOptions {
  /**
   * Leave a due row whose provider has no adapter (and no routing candidate
   * with one) `scheduled` instead of failing it. For a host that serves no
   * LLM provider at all, such as the CLI tick with only command jobs: the
   * row waits for a host that can run it.
   */
  holdUnserved?: boolean;
  /**
   * Stop the tick cooperatively: once aborted, no further row is claimed,
   * submitted, dispatched or polled. A dispatch already running finishes
   * (its runner decides how a stop signal ends it); the tick returns what
   * it did so far. Rows it did not reach stay as they were.
   */
  signal?: AbortSignal;
}

/** Providers `enqueueProviderCall` accepts. Keep in sync with {@link ProviderName}. */
const SUPPORTED_PROVIDERS: ReadonlySet<ProviderName> = new Set([
  "anthropic",
  "openai",
  "gemini",
  "ollama",
  "claude-code",
]);

/** Thrown when no candidate window meets the user-supplied carbon budget. */
export class CarbonBudgetExceededError extends Error {
  constructor(public readonly minimumGCo2: number, public readonly budgetGCo2: number) {
    super(
      `No window inside the deadline keeps the task under ${budgetGCo2.toFixed(1)} gCO2e. ` +
        `Cheapest reachable window costs ${minimumGCo2.toFixed(1)} gCO2e.`,
    );
    this.name = "CarbonBudgetExceededError";
  }
}

/** Thrown when the supplied deadline cannot be parsed or is already in the past. */
export class InvalidDeadlineError extends Error {
  constructor(public readonly received: unknown) {
    super(`Invalid deadline: expected an ISO-8601 timestamp in the future, received ${JSON.stringify(received)}`);
    this.name = "InvalidDeadlineError";
  }
}

export interface SchedulerOptions {
  feed?: GridFeed;
  /**
   * Default region to use when DeferOptions does not name one. A getter is
   * called on every schedule, so a host can follow a changed setting
   * without a restart.
   */
  defaultRegion?: string | (() => string);
  /** If true (default), background loop ticks immediately on `defer`. */
  eager?: boolean;
  /**
   * Absolute path to a SQLite file for durable persistence. When set,
   * every state transition writes through to the on-disk audit ledger
   * and persisted records can be reloaded after restart via
   * `Scheduler.listPersistedTasks()` / `Scheduler.loadPersistedTask()`.
   * Omit for v0.1-style in-memory operation.
   */
  dbPath?: string;
  /** Inject a pre-built TaskStore. Mostly for tests. */
  store?: TaskStore;
  /**
   * Ed25519 receipt-signing configuration. By default the scheduler
   * signs every receipt with a per-installation keypair at
   * `~/.tidegap/signing.key` (lazily created on first dispatch). Pass:
   *   - `false` to disable signing entirely (receipts shipped without
   *     signature/signerPublicKey/signedAt fields — back to v0.10 shape).
   *   - `{ keyPath: "..." }` to override the keypair location (mostly
   *     for tests so each scheduler instance gets a fresh key).
   *
   * v0.11+.
   */
  signing?: false | { keyPath?: string };
  /**
   * Inject a pseudo-random number generator returning [0, 1). Defaults to
   * `Math.random`. Used by the cleanest-tolerance-band tie-break in every
   * committing scheduling path so a region's committed tasks spread across
   * the clean band instead of all landing on the single trough hour
   * (§2.1). A seeded PRNG makes window selection deterministic in tests.
   */
  rng?: () => number;
  /**
   * Aggregate carbon-budget alerts (ROADMAP item 4). When set, every
   * `tick()` that completes a receipt checks the configured rolling
   * window's total consumption (actual, falling back to estimated) against
   * `thresholdG` and, on the first crossing per (window, threshold), records
   * a DB marker and invokes {@link SchedulerOptions.onCarbonAlert}. Distinct
   * from the per-task `carbonBudgetG` hard cap. Requires a store (dbPath) —
   * the marker lives in the ledger. Omit to disable.
   */
  carbonBudget?: CarbonBudgetConfig;
  /**
   * Hook fired exactly once per (window, threshold) when the aggregate
   * carbon budget is first crossed inside `tick()`. Receives the crossing
   * window, the threshold, the window's total consumption, and the id of the
   * task whose completion pushed it over. May be async; a throwing hook is
   * logged and swallowed so it can never disturb dispatch. No-op unless
   * `carbonBudget` is also set.
   */
  onCarbonAlert?: (alert: CarbonAlert) => void | Promise<void>;
  /**
   * Quota reset schedules (ui v2), read when a `repeat: "quota_reset"`
   * series rolls over: the successor's deadline is the label's next reset
   * minus the margin. Without it the successor falls back to +7 days and
   * the quota sweep corrects the drift. A getter, so a long-lived scheduler
   * sees config edits.
   */
  quotaConfig?: () => QuotaResetConfig;
  /**
   * The plugged-in limit-reset source for "Later → after limit reset"
   * (coherence KTD5), for example the CLI usage module's Claude reset.
   * A caller-given reset wins over it; a stored hint is the fallback.
   */
  limitReset?: LimitResetSource;
  /**
   * Who this scheduler's writes are recorded as in `task_events` (for
   * example `cli`, `tick`, `agent:mcp`). Default `system`. A mutation
   * method's own `{ actor }` wins.
   */
  actor?: TaskEventActor;
  /**
   * The machine's sleep counter (`boot_at`, `slept_ms`), read by the host
   * (the CLI tick). Stored on each `dispatched` event as `sleep`, so the job
   * sweep counts a run's age on awake time: a run the machine slept
   * through is not interrupted (`sleep-gap-is-not-a-dead-daemon.md`).
   */
  sleepCounter?: () => { boot_at: number; slept_ms: number } | null;
}

/** Per-call options of the task actions: who the change is recorded as. */
export interface ActorOptions {
  actor?: TaskEventActor;
}

export class Scheduler {
  private readonly feed: GridFeed;
  private readonly defaultRegionOption: string | (() => string);
  private readonly rng: () => number;
  private readonly tasks = new Map<string, TaskRecord<unknown>>();
  private readonly pendingTimers = new Map<string, NodeJS.Timeout>();
  private readonly resolvers = new Map<
    string,
    { resolve: (v: unknown) => void; reject: (e: unknown) => void }
  >();
  private readonly bodies = new Map<string, DeferrableTask<unknown>>();
  /** Rows a tick moved to `running` whose dispatch has not settled (KTD12). */
  private readonly held = new Map<string, TaskRecord<unknown>>();
  private readonly store: TaskStore | undefined;
  // Mutable: a single load failure disables signing for the rest of
  // this scheduler instance (see `getSigningKey`).
  private signingConfig: false | { keyPath?: string };
  private signingKey: SigningKeyPair | undefined;
  private readonly carbonBudget: CarbonBudgetConfig | undefined;
  private readonly onCarbonAlert:
    | ((alert: CarbonAlert) => void | Promise<void>)
    | undefined;
  private readonly quotaConfig: (() => QuotaResetConfig) | undefined;
  private readonly limitReset: LimitResetSource | undefined;
  private readonly actor: TaskEventActor;
  private readonly sleepCounter: SchedulerOptions["sleepCounter"];

  private defaultRegion(): string {
    const option = this.defaultRegionOption;
    return typeof option === "function" ? option() : option;
  }

  constructor(opts: SchedulerOptions = {}) {
    this.feed = opts.feed ?? mockGridFeed();
    this.defaultRegionOption = opts.defaultRegion ?? DEFAULT_REGION;
    this.rng = opts.rng ?? Math.random;
    if (opts.store) {
      this.store = opts.store;
    } else if (opts.dbPath) {
      this.store = new TaskStore({ dbPath: opts.dbPath });
    }
    this.signingConfig = opts.signing ?? {};
    this.carbonBudget = opts.carbonBudget;
    this.onCarbonAlert = opts.onCarbonAlert;
    this.quotaConfig = opts.quotaConfig;
    this.limitReset = opts.limitReset;
    this.actor = opts.actor ?? "system";
    this.sleepCounter = opts.sleepCounter;
  }

  /**
   * Compute the current aggregate carbon-budget status (ROADMAP item 4)
   * over this scheduler's ledger, or `undefined` when no budget is
   * configured or there is no store to read. Read-only; used by
   * `check_queue_status` and callers that want the used/threshold/percent
   * figure without ticking.
   */
  getCarbonBudgetStatus(
    at: Date = new Date(),
  ): import("./budget.js").CarbonBudgetStatus | undefined {
    if (!this.carbonBudget || !this.store) return undefined;
    const rows = this.store.list({ status: "completed" });
    const usage = carbonBudgetUsage(rows, this.carbonBudget.windowKind, at);
    let alerted = false;
    try {
      alerted = this.store.hasBudgetAlert(
        this.carbonBudget.windowKind,
        usage.windowStart,
        this.carbonBudget.thresholdG,
      );
    } catch {
      // best-effort: a probe failure just reports "not yet alerted"
    }
    const pct =
      this.carbonBudget.thresholdG > 0
        ? Math.round((usage.usedG / this.carbonBudget.thresholdG) * 100)
        : 0;
    return {
      windowKind: this.carbonBudget.windowKind,
      windowStart: usage.windowStart,
      windowEnd: usage.windowEnd,
      thresholdG: this.carbonBudget.thresholdG,
      usedG: usage.usedG,
      pct,
      taskCount: usage.taskCount,
      exceeded: usage.usedG >= this.carbonBudget.thresholdG,
      alerted,
    };
  }

  /**
   * After a `tick()` sweep, check whether this tick's completions pushed the
   * configured rolling window over its threshold, and fire the alert hook
   * exactly once per (window, threshold). Called only from `tick` (the sync
   * due-sweep and the batch-poll sweep both funnel their completed entries
   * here), so expedite / retry / closure dispatch do NOT fire alerts — they
   * still count toward consumption, but the alert is a tick-time signal.
   *
   * Idempotency + the multi-process double-fire guard live in the DB marker
   * (`recordBudgetAlert`): only the caller that inserts the row invokes the
   * hook. A restart re-runs this harmlessly — the marker is already there.
   */
  private async checkCarbonBudget(completedTaskIds: string[]): Promise<void> {
    const budget = this.carbonBudget;
    if (!budget || !this.store || completedTaskIds.length === 0) return;
    const at = new Date();
    let rows: TaskRecord<unknown>[];
    try {
      rows = this.store.list({ status: "completed" });
    } catch {
      return;
    }
    const usage = carbonBudgetUsage(rows, budget.windowKind, at);
    if (usage.usedG < budget.thresholdG) return;
    // Attribute the crossing honestly: replay this tick's completions on top
    // of the pre-tick baseline and take the first one to tip the window over.
    const { start, end } = windowBounds(budget.windowKind, at);
    const startMs = start.getTime();
    const endMs = end.getTime();
    const completedSet = new Set(completedTaskIds);
    const gramsById = new Map<string, number>();
    let baseline = 0;
    for (const row of rows) {
      if (!row.receipt?.ranAt) continue;
      const t = new Date(row.receipt.ranAt).getTime();
      if (Number.isNaN(t) || t < startMs || t >= endMs) continue;
      const g = receiptCarbonG(row.receipt);
      if (completedSet.has(row.taskId)) {
        gramsById.set(row.taskId, g);
      } else {
        baseline += g;
      }
    }
    let running = baseline;
    let crossingId: string | undefined;
    for (const id of completedTaskIds) {
      running += gramsById.get(id) ?? 0;
      if (running >= budget.thresholdG) {
        crossingId = id;
        break;
      }
    }
    crossingId ??= completedTaskIds[completedTaskIds.length - 1]!;
    let fired = false;
    try {
      fired = this.store.recordBudgetAlert(
        budget.windowKind,
        usage.windowStart,
        budget.thresholdG,
        usage.usedG,
        crossingId,
        new Date().toISOString(),
      );
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn(
        `[tidegap/scheduler] failed to record carbon-budget alert marker: ${describeErr(err)}`,
      );
      return;
    }
    if (!fired) return;
    const alert: CarbonAlert = {
      windowKind: budget.windowKind,
      windowStart: usage.windowStart,
      thresholdG: budget.thresholdG,
      actualG: usage.usedG,
      taskIdThatCrossed: crossingId,
    };
    try {
      await this.onCarbonAlert?.(alert);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn(
        `[tidegap/scheduler] onCarbonAlert hook threw (${describeErr(err)}); ignoring`,
      );
    }
  }

  /**
   * Lazy-load the signing keypair the first time a receipt needs to be
   * signed. Returns undefined when signing is disabled or a fatal error
   * is encountered while loading; the scheduler then drops back to v0.10
   * unsigned receipts rather than failing the dispatch.
   */
  private getSigningKey(): SigningKeyPair | undefined {
    if (this.signingConfig === false) return undefined;
    if (this.signingKey) return this.signingKey;
    try {
      this.signingKey = loadOrCreateSigningKey({
        privateKeyPath: this.signingConfig.keyPath,
      });
      return this.signingKey;
    } catch (err) {
      // The receipt remains valid — it just goes out unsigned. Log to
      // stderr once so operators notice without crashing dispatch.
      // eslint-disable-next-line no-console
      console.warn(
        `[tidegap/scheduler] failed to load signing key, receipts will go out unsigned: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      this.signingConfig = false;
      return undefined;
    }
  }

  /** Sign a receipt if signing is enabled; otherwise return it unchanged. */
  private maybeSign(receipt: CarbonReceipt): CarbonReceipt {
    const key = this.getSigningKey();
    if (!key) return receipt;
    return signReceipt(receipt, key);
  }

  /** Reload a previously-persisted task by id. */
  loadPersistedTask<T>(taskId: string): TaskRecord<T> | undefined {
    return this.store?.get(taskId) as TaskRecord<T> | undefined;
  }

  /** Snapshot every task ever persisted (queued, running, completed, failed). */
  listPersistedTasks(): TaskRecord<unknown>[] {
    return this.store?.list() ?? [];
  }

  /**
   * Mark a finished task read (v0.17). Returns true iff this call set the
   * marker. No-op without a store, for unfinished tasks, or when already read.
   */
  markTaskRead(taskId: string, at: Date = new Date()): boolean {
    const changed = this.store?.markRead(taskId, at) ?? false;
    if (changed) {
      const cached = this.tasks.get(taskId);
      if (cached) cached.readAt = at.toISOString();
    }
    return changed;
  }

  /** Clear a task's read marker (v0.17). Returns true iff it was set. */
  markTaskUnread(taskId: string): boolean {
    const changed = this.store?.markUnread(taskId) ?? false;
    const cached = this.tasks.get(taskId);
    if (cached) cached.readAt = undefined;
    return changed;
  }

  /** A task's events from the ledger, oldest first; [] without a store. */
  listTaskEvents(taskId: string, opts: { limit?: number } = {}): TaskEvent[] {
    return this.store?.listTaskEvents(taskId, opts) ?? [];
  }

  /** Record that a ticker ran at `at` (ledger meta `last_tick_at`). No-op without a store. */
  recordTickRun(at: Date = new Date()): void {
    this.store?.setMeta(LAST_TICK_META_KEY, at.toISOString());
  }

  /** When a ticker (`tidegap tick` or the OpenClaw loop) last ran, if ever recorded. */
  lastTickAt(): string | undefined {
    return this.store?.getMeta(LAST_TICK_META_KEY);
  }

  /** The ledger this scheduler writes through to, if any. Jobs live there too. */
  ledger(): TaskStore | undefined {
    return this.store;
  }

  /**
   * Insert one job occurrence and plan it (floating recurring jobs, KTD4).
   * The row is built here, not through `enqueueProviderCall` (which refuses
   * `provider: "command"`): `scheduled`, `notBefore = earliest`,
   * `scheduledFor = earliest + 1 min` (never equal to `notBefore`, which
   * would read as an exact pin), the slot deadline with no widening,
   * `repeat = none` and no series, so `rollSeries` never touches it. The
   * insert is `insertIfAbsent` on the derived id; returns false, writing
   * nothing, when the row exists. Planning picks the cleanest forecast hour
   * inside `[earliest, deadline]`, or leaves the row unplanned for
   * `replanSweep` when the forecast does not reach it (or fails).
   */
  async materializeOccurrence(
    occ: {
      taskId: string;
      jobId: string;
      earliest: string;
      deadline: string;
      title: string;
      bodyJson: string;
      originHost?: TaskRecord["originHost"];
      originCwd?: string;
    },
    details: Record<string, unknown>,
  ): Promise<boolean> {
    if (!this.store) throw new Error("materializeOccurrence: jobs need a ledger (dbPath)");
    const earliestMs = Date.parse(occ.earliest);
    const deadlineMs = Date.parse(occ.deadline);
    const record: TaskRecord<unknown> = {
      taskId: occ.taskId,
      status: "scheduled",
      enqueuedAt: new Date().toISOString(),
      region: this.defaultRegion(),
      bodyJson: occ.bodyJson,
      deadline: new Date(deadlineMs).toISOString(),
      notBefore: new Date(earliestMs).toISOString(),
      scheduledFor: new Date(Math.min(earliestMs + MINUTE_MS, deadlineMs)).toISOString(),
      title: occ.title,
      originHost: occ.originHost,
      originCwd: occ.originCwd,
      repeat: "none",
      jobId: occ.jobId,
    };
    const created = this.eventFor(undefined, record, { kind: "created", actor: "system", details });
    if (!this.store.insertIfAbsent(record, created)) return false;
    this.cacheRow(record);
    try {
      await this.scheduleProviderCall(record.taskId, new Date(deadlineMs));
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn(
        `[tidegap/scheduler] could not plan job occurrence ${record.taskId}: ${describeErr(err)}; replanSweep plans it later`,
      );
    }
    return true;
  }

  /**
   * Defer a task. Returns a promise that resolves with the task's eventual
   * result when Tidegap dispatches it.
   *
   * For testing / synchronous workflows, see `enqueue` + `tick` + `flush`.
   */
  async defer<T>(task: DeferrableTask<T>, opts: DeferOptions = {}): Promise<T> {
    const record = this.enqueue(task, opts);
    return new Promise<T>((resolve, reject) => {
      this.resolvers.set(record.taskId, {
        resolve: resolve as (v: unknown) => void,
        reject,
      });
    });
  }

  /**
   * Enqueue a task without awaiting it. Returns the TaskRecord immediately
   * with status "queued". Mostly used by the MCP server, which returns the
   * task_id to the caller and lets them poll.
   */
  enqueue<T>(task: DeferrableTask<T>, opts: DeferOptions = {}): TaskRecord<T> {
    const deadline = normalizeDeadline(opts.deadline);
    if (opts.taskId !== undefined) {
      if (typeof opts.taskId !== "string" || opts.taskId.length === 0) {
        throw new Error(`Invalid taskId: must be a non-empty string`);
      }
      // Check both the in-memory map and the durable store: a fresh
      // process re-using an old id must not silently overwrite a
      // persisted (possibly completed + signed) ledger row.
      if (this.tasks.has(opts.taskId) || this.store?.get(opts.taskId)) {
        throw new Error(`Task id "${opts.taskId}" is already in the queue`);
      }
    }
    validateDeadlineKind(opts);
    if (validateRepeat(opts.repeat) !== "none") {
      throw new Error(
        `repeat ${JSON.stringify(opts.repeat)} needs a provider-call task; closure tasks cannot repeat`,
      );
    }
    const taskId = opts.taskId ?? `t-${randomUUID()}`;
    const region = opts.region ?? this.defaultRegion();
    const record: TaskRecord<T> = {
      taskId,
      status: "queued",
      enqueuedAt: new Date().toISOString(),
      region,
      carbonBudgetG: opts.carbonBudgetG,
      deadline: deadline.toISOString(),
      ...identityFields(taskId, opts, opts.title !== undefined ? deriveTitle(opts.title) : undefined),
    };
    this.tasks.set(taskId, record);
    this.bodies.set(taskId, task as DeferrableTask<unknown>);
    this.store?.upsert(record, this.eventFor(undefined, record, { kind: "created", actor: opts.actor }));
    // Fire-and-forget, but never unhandled: a rejecting grid feed (or any
    // scheduling error) must fail the task — rejecting the defer() promise
    // — instead of crashing the process with an unhandledRejection.
    this.schedule(taskId, deadline).catch((err) => {
      this.failTask(taskId, err instanceof Error ? err : new Error(String(err)));
    });
    return record;
  }

  /**
   * Enqueue a persistent provider-call task. The body is JSON-serialized
   * into the SQLite ledger, so the task survives the enqueuing process
   * exiting — `Scheduler.tick(adapters)`, typically invoked from
   * `tidegap tick` on a cron, can rehydrate the spec and dispatch it.
   *
   * Unlike `enqueue`, no in-process closure is registered; the scheduler
   * does NOT call `dispatch` for these tasks at the chosen window. They
   * are exclusively driven by `tick` so that any process (this one, or a
   * later cron-tick) can pick them up.
   */
  async enqueueProviderCall(
    spec: ProviderCallSpec,
    opts: DeferOptions = {},
  ): Promise<TaskRecord<unknown>> {
    if (spec.type !== "provider_call") {
      throw new Error(
        `enqueueProviderCall: spec.type must be "provider_call", got ${JSON.stringify((spec as { type?: unknown }).type)}`,
      );
    }
    if (!SUPPORTED_PROVIDERS.has(spec.provider)) {
      throw new Error(
        `enqueueProviderCall: unsupported provider ${JSON.stringify(spec.provider)}`,
      );
    }
    if (typeof spec.model !== "string" || spec.model.length === 0) {
      throw new Error("enqueueProviderCall: spec.model must be a non-empty string");
    }
    if (typeof spec.prompt !== "string" || spec.prompt.length === 0) {
      throw new Error("enqueueProviderCall: spec.prompt must be a non-empty string");
    }
    if (spec.tools !== undefined) {
      const toolsError = claudeCodeToolsError(spec.tools);
      if (toolsError) throw new Error(`enqueueProviderCall: ${toolsError}`);
    }
    const requested = normalizeDeadline(opts.deadline);
    const notBefore = earliestStart(opts.notBefore);
    const start = notBefore ? startFields(notBefore.getTime(), requested.getTime()) : undefined;
    const deadline = start ? new Date(start.deadline) : requested;
    if (opts.taskId !== undefined) {
      if (typeof opts.taskId !== "string" || opts.taskId.length === 0) {
        throw new Error(`Invalid taskId: must be a non-empty string`);
      }
      // Check both the in-memory map and the durable store: a fresh
      // process re-using an old id must not silently overwrite a
      // persisted (possibly completed + signed) ledger row.
      if (this.tasks.has(opts.taskId) || this.store?.get(opts.taskId)) {
        throw new Error(`Task id "${opts.taskId}" is already in the queue`);
      }
    }
    validateDeadlineKind(opts);
    if (validateRepeat(opts.repeat) === "quota_reset" && opts.deadlineKind !== "quota_reset") {
      throw new Error(`repeat "quota_reset" needs deadlineKind "quota_reset" and a quotaProvider label`);
    }
    const taskId = opts.taskId ?? `t-${randomUUID()}`;
    const region = opts.region ?? this.defaultRegion();
    // The title is never rewritten at terminal transitions, so it is stored
    // redacted from the start (same patterns as the receipt prompt).
    const title =
      deriveTitle(opts.title ?? spec.prompt, spec.redactInReceipt) ??
      (opts.title !== undefined ? deriveTitle(spec.prompt, spec.redactInReceipt) : undefined);
    const record: TaskRecord<unknown> = {
      taskId,
      status: "queued",
      enqueuedAt: new Date().toISOString(),
      region,
      carbonBudgetG: opts.carbonBudgetG,
      bodyJson: JSON.stringify(spec),
      deadline: deadline.toISOString(),
      ...identityFields(taskId, opts, title),
    };
    if (start) {
      record.notBefore = start.notBefore;
      record.scheduledFor = start.scheduledFor;
    }
    this.tasks.set(taskId, record);
    this.store?.upsert(
      record,
      this.eventFor(undefined, record, {
        kind: "created",
        actor: opts.actor,
        details: opts.parentTaskId ? { parent_task_id: opts.parentTaskId } : {},
      }),
    );
    // Schedule a carbon window but DO NOT register an in-process timer that
    // calls `dispatch` — provider-call tasks are driven exclusively by
    // `Scheduler.tick`. We still write `scheduled` + `scheduledFor` so the
    // ledger reflects the chosen window and so `tick` can compare against
    // `Date.now()`.
    try {
      await this.scheduleProviderCall(taskId, deadline);
    } catch (err) {
      // A scheduling failure after the queued-row upsert must not strand
      // a permanently-"queued" row in the ledger.
      this.failTask(taskId, err instanceof Error ? err : new Error(String(err)));
      throw err;
    }
    return record;
  }

  /**
   * Drain due provider-call tasks against the supplied adapters. Returns a
   * `TickResult` summarising what happened. Closure-based tasks
   * (`enqueue` / `defer`) are NOT touched by this method — only this
   * process can run those.
   */
  async tick(adapters: TickAdapters, opts: TickOptions = {}): Promise<TickResult> {
    const results: TickResultEntry[] = [];
    let dispatched = 0;
    let failed = 0;
    let deferred = 0;
    let inspected = 0;
    // Provider and model → retryAt after its first defer this tick: later due
    // tasks on that provider and model defer to the same time without a
    // dispatch (KTD7.4). Keyed by model too: a spent per-model window (for
    // example a weekly "Fable" limit) must not hold back the other models.
    const deferrals = new Map<string, Date>();
    const count = (entry: TickResultEntry) => {
      if (entry.status === "completed") dispatched++;
      else if (entry.status === "deferred") deferred++;
      else failed++;
    };

    // ---- (1) Batch-submit sweep, BEFORE the due sweep ----
    // A batch-eligible task's deferral mechanism IS the Batch API: the
    // provider runs it within its own 24h SLA and picks the execution
    // hour. We deliberately do NOT wait for a clean local window — the
    // whole point is to submit early and let the provider place the run.
    // Carbon scoring does not apply to batch-routed tasks (the provider
    // owns the hour); cost does (50% off). See §0.1.
    let batchSubmitted = 0;
    // Tasks submitted in THIS tick must not be polled in the same tick's
    // poll sweep — submit and poll are distinct ticks (the provider needs
    // time to start the batch).
    const submittedThisTick = new Set<string>();
    for (const record of this.collectBatchSubmitCandidates(adapters)) {
      if (opts.signal?.aborted) break;
      // Reuse the scheduled→running claim so a racing tick can't submit
      // the same row twice (double-billed batch). In-memory-only mode
      // has no cross-process race, so claim only when a store exists.
      if (this.store) {
        let claimed = false;
        try {
          claimed = this.store.claimScheduled(record.taskId);
        } catch (err) {
          // eslint-disable-next-line no-console
          console.warn(
            `[tidegap/scheduler] tick: could not claim task ${record.taskId} for batch submit: ${describeErr(err)}; skipping this round`,
          );
          continue;
        }
        if (!claimed) continue;
        // The claim succeeded on the stored row; re-read it so a write from
        // another process (run now, reschedule) since our list is honoured.
        // If the fresh row no longer qualifies for the Batch API, it goes
        // to the sync path when due, else back to `scheduled`.
        this.reloadClaimed(record);
        if (!this.isBatchCandidate(record, adapters, Date.now())) {
          if (!this.isDue(record, Date.now())) {
            this.releaseClaim(record);
            continue;
          }
          inspected++;
          const entry = await this.holding(record, () => this.dispatchProviderCall(record, adapters, deferrals));
          results.push(entry);
          count(entry);
          continue;
        }
      } else {
        // In-memory guard: flip to running so a re-entrant tick skips it.
        if (record.status !== "scheduled") continue;
        record.status = "running";
      }
      inspected++;
      const entry = await this.holding(record, () => this.submitBatch(record, adapters));
      results.push(entry);
      if (entry.status === "submitted") {
        batchSubmitted++;
        submittedThisTick.add(record.taskId);
      } else if (entry.status === "completed") dispatched++;
      else failed++;
    }

    // ---- (2) Due sweep (sync provider calls) ----
    const now = Date.now();
    // Source-of-truth is the in-memory map for this process, plus any
    // persisted records (e.g. when a v0.4 `tidegap tick` opens the SQLite file).
    const seen = new Set<string>();
    const candidates: TaskRecord<unknown>[] = [];
    if (this.store) {
      // The ledger is the source of truth: refresh cached copies so a
      // long-lived scheduler sees writes made by other processes.
      for (const row of this.store.list({ status: "scheduled" })) this.cacheRow(row);
    }
    for (const record of this.tasks.values()) {
      if (record.status !== "scheduled") continue;
      if (!record.bodyJson) continue;
      if (!this.isDue(record, now)) continue;
      // A command job's shell step runs only where a `command` adapter
      // exists (the CLI tick). Elsewhere the row stays `scheduled`: no
      // claim, no failure. With `holdUnserved`, so does any row this host
      // has no adapter for.
      if (unservedCommand(record, adapters)) continue;
      if (opts.holdUnserved && unserved(record, adapters)) continue;
      candidates.push(record);
      seen.add(record.taskId);
    }

    for (const record of candidates) {
      if (opts.signal?.aborted) break;
      // Row-level claim: only one tick gets to dispatch this task. If
      // the store is configured, the claim is also visible to other
      // processes pointing at the same SQLite file (e.g. an
      // interactive `tidegap tick` racing the launchd cron).
      if (this.store) {
        let claimed = false;
        try {
          claimed = this.store.claimScheduled(record.taskId);
        } catch (err) {
          // A locked / throwing row (e.g. SQLITE_BUSY under heavy
          // multi-process contention) is skipped — it stays "scheduled"
          // and a later tick retries. It must never abort the whole tick.
          // eslint-disable-next-line no-console
          console.warn(
            `[tidegap/scheduler] tick: could not claim task ${record.taskId}: ${describeErr(err)}; skipping this round`,
          );
          continue;
        }
        if (!claimed) continue;
        // Re-read after the claim (KTD1): a reschedule written between our
        // list and the claim must not be dispatched on the old time.
        this.reloadClaimed(record);
        if (!this.isDue(record, Date.now())) {
          this.releaseClaim(record);
          continue;
        }
      }
      inspected++;
      const entry = await this.holding(record, () => this.dispatchProviderCall(record, adapters, deferrals));
      results.push(entry);
      count(entry);
    }

    // ---- (3) Batch-poll sweep, AFTER the due sweep ----
    let batchPolled = 0;
    for (const record of this.collectSubmittedCandidates(submittedThisTick)) {
      if (opts.signal?.aborted) break;
      // Claim submitted→running so two racing ticks can't double-complete.
      if (this.store) {
        let claimed = false;
        try {
          claimed = this.store.claimSubmitted(record.taskId);
        } catch (err) {
          // eslint-disable-next-line no-console
          console.warn(
            `[tidegap/scheduler] tick: could not claim submitted task ${record.taskId}: ${describeErr(err)}; skipping this round`,
          );
          continue;
        }
        if (!claimed) continue;
      } else {
        if (record.status !== "submitted") continue;
        record.status = "running";
      }
      inspected++;
      const entry = await this.holding(record, () => this.pollBatch(record, adapters));
      results.push(entry);
      if (entry.status === "completed") dispatched++;
      else if (entry.status === "submitted") batchPolled++;
      else failed++;
    }

    // ---- (4) Aggregate carbon-budget alert (ROADMAP item 4) ----
    // After every receipt this tick wrote (sync due-sweep + batch poll),
    // check the rolling window against the configured threshold and fire
    // the alert hook once per (window, threshold). No-op unless a budget is
    // configured. Fail-soft: never let the budget check disturb the tick.
    if (this.carbonBudget) {
      const completedIds = results
        .filter((e) => e.status === "completed")
        .map((e) => e.taskId);
      await this.checkCarbonBudget(completedIds);
    }

    return {
      inspected,
      dispatched,
      failed,
      results,
      batchSubmitted,
      batchPolled,
      deferred,
    };
  }

  /**
   * Collect scheduled provider-call tasks that should be routed through a
   * Batch API this tick: preferBatch !== false, an adapter with a
   * dispatchBatch function exists, a deadline is persisted, and
   * (deadline − now) > 24h. Legacy rows with no persisted deadline are
   * skipped (they fall through to the sync due-sweep), never errored.
   */
  private collectBatchSubmitCandidates(adapters: TickAdapters): TaskRecord<unknown>[] {
    const now = Date.now();
    if (this.store) {
      for (const row of this.store.list({ status: "scheduled" })) this.cacheRow(row);
    }
    const out: TaskRecord<unknown>[] = [];
    for (const record of this.tasks.values()) {
      if (record.status !== "scheduled") continue;
      if (this.isBatchCandidate(record, adapters, now)) out.push(record);
    }
    return out;
  }

  /**
   * Batch API eligibility of one scheduled row: preferBatch !== false, a
   * batch-capable adapter, a persisted deadline more than 24 h away, not
   * run-now (`expedited`), not pinned to an exact time, and no future
   * `notBefore`. A pinned row would otherwise be submitted on the next tick
   * and run whenever the provider picks, ignoring the chosen time.
   */
  private isBatchCandidate(record: TaskRecord<unknown>, adapters: TickAdapters, now: number): boolean {
    if (!record.bodyJson) return false;
    if (!record.deadline) return false; // legacy row → sync path
    if (new Date(record.deadline).getTime() - now <= 24 * 60 * 60 * 1000) return false;
    if (record.intensitySource === "expedited") return false;
    if (record.notBefore) {
      if (Date.parse(record.notBefore) > now) return false;
      if (record.notBefore === record.scheduledFor) return false;
    }
    let spec: Partial<ProviderCallSpec>;
    try {
      spec = JSON.parse(record.bodyJson) as Partial<ProviderCallSpec>;
    } catch {
      return false; // corrupt body → sync due-sweep fails it with a clear error
    }
    if (spec.type !== "provider_call") return false;
    if (spec.preferBatch === false) return false;
    if (spec.provider !== "anthropic" && spec.provider !== "openai") return false;
    const adapter = adapters[spec.provider];
    return adapter !== undefined && typeof adapter.dispatchBatch === "function";
  }

  /** A scheduled row whose time has come (and whose pin, if any, has passed). */
  private isDue(record: TaskRecord<unknown>, now: number): boolean {
    if (!record.scheduledFor) return false;
    if (Date.parse(record.scheduledFor) > now) return false;
    return !(record.notBefore && Date.parse(record.notBefore) > now);
  }

  /** Replace a just-claimed cached record with the stored row (status `running`). */
  private reloadClaimed(record: TaskRecord<unknown>): void {
    const fresh = this.store?.get(record.taskId);
    if (fresh) Object.assign(record, fresh);
  }

  /** Undo a claim on a row that turned out not to be ready: back to `scheduled`. */
  private releaseClaim(record: TaskRecord<unknown>): void {
    this.writeIf(record, { ...record, status: "scheduled" }, ["running"]);
  }

  /**
   * Collect every "submitted" provider-call task awaiting batch results.
   * `exclude` skips tasks submitted earlier in the same tick — submit and
   * poll are distinct ticks by design.
   */
  private collectSubmittedCandidates(
    exclude: Set<string> = new Set(),
  ): TaskRecord<unknown>[] {
    const out: TaskRecord<unknown>[] = [];
    const seen = new Set<string>();
    for (const record of this.tasks.values()) {
      if (exclude.has(record.taskId)) continue;
      if (record.status !== "submitted") continue;
      if (!record.batchId) continue;
      out.push(record);
      seen.add(record.taskId);
    }
    if (this.store) {
      for (const record of this.store.list({ status: "submitted" })) {
        if (exclude.has(record.taskId) || seen.has(record.taskId)) continue;
        if (!record.batchId) continue;
        this.tasks.set(record.taskId, record);
        out.push(record);
      }
    }
    return out;
  }

  /**
   * Look up a task by id. Returns the in-process record if present;
   * otherwise hydrates it from the durable store, so cancel / update /
   * retry / dispatch keep working after the enqueuing process has exited
   * (e.g. an OpenClaw gateway restart). The store is the source of truth
   * for persisted tasks — `this.tasks` is a write-through cache, not the
   * sole index.
   */
  private resolveTask(taskId: string): TaskRecord<unknown> | undefined {
    const inMemory = this.tasks.get(taskId);
    if (inMemory) return inMemory;
    const persisted = this.store?.get(taskId);
    if (persisted) {
      this.tasks.set(taskId, persisted);
      return persisted;
    }
    return undefined;
  }

  /**
   * Fresh read for a write path (ui v2): the stored row, merged into the
   * cached object so every holder sees it. Falls back to the cache for
   * in-memory schedulers and process-local closure tasks.
   */
  private refreshTask(taskId: string): TaskRecord<unknown> | undefined {
    const stored = this.store?.get(taskId);
    if (!stored) return this.tasks.get(taskId);
    return this.cacheRow(stored);
  }

  /** Stop and forget the in-process timer for `taskId`, if any. */
  private clearPendingTimer(taskId: string): void {
    const timer = this.pendingTimers.get(taskId);
    if (timer) {
      clearTimeout(timer);
      this.pendingTimers.delete(taskId);
    }
  }

  /** Merge a stored row into the cache, keeping the cached object identity. */
  private cacheRow(row: TaskRecord<unknown>): TaskRecord<unknown> {
    const cached = this.tasks.get(row.taskId);
    if (!cached) {
      this.tasks.set(row.taskId, row);
      return row;
    }
    Object.assign(cached, row);
    return cached;
  }

  /** `{ sleep }` for a `dispatched` event when the host reads a sleep counter; else nothing. Never throws. */
  private sleepDetails(): { sleep?: { boot_at: number; slept_ms: number } } {
    try {
      const r = this.sleepCounter?.();
      return r && Number.isFinite(r.boot_at) && Number.isFinite(r.slept_ms) ? { sleep: { boot_at: r.boot_at, slept_ms: r.slept_ms } } : {};
    } catch {
      return {};
    }
  }

  /**
   * Compare-and-set write: store `next` only while the row's status is in
   * `expected`; on success copy it onto the cached record. On a miss the
   * cache is reloaded from the ledger and false is returned. Without a
   * store the write always succeeds.
   */
  private writeIf(
    record: TaskRecord<unknown>,
    next: TaskRecord<unknown>,
    expected: readonly TaskStatus[],
    event?: TaskEventInput,
  ): boolean {
    if (this.store && !this.store.transitionIf(next, expected, undefined, this.eventFor(record, next, event))) {
      const current = this.store.get(record.taskId);
      if (current) Object.assign(record, current);
      return false;
    }
    Object.assign(record, next);
    return true;
  }

  /**
   * The `task_events` row for a write from `prev` to `next`: the given kind,
   * or a terminal kind the status change implies; undefined = no event.
   * `spec.details` are extra keys on top of {@link eventDetails}.
   */
  private eventFor(
    prev: TaskRecord<unknown> | undefined,
    next: TaskRecord<unknown>,
    spec?: TaskEventInput,
  ): TaskEventInput | undefined {
    const kind = spec?.kind ?? (prev ? impliedEventKind(prev.status, next.status) : undefined);
    if (!kind) return undefined;
    return { kind, actor: spec?.actor ?? this.actor, details: eventDetails(kind, prev, next, spec?.details) };
  }

  /**
   * Series rollover (ui v2, KTD6). Called when an occurrence with a repeat
   * rule finishes (completed, failed, or cancelled as a skip), BEFORE its
   * terminal write and before its body is redacted. Inserts the successor
   * `<series_id>~<n+1>` with `insertIfAbsent`, so two dispatchers create one
   * successor and a crash between the two writes leaves the series alive.
   * The successor is `scheduled` and unplanned: `notBefore` = the previous
   * deadline, `scheduledFor` = its deadline minus one hour, no estimate;
   * `replanSweep` gives it a window once the forecast reaches it. No
   * forecast is fetched here. A stop written by another process (stored
   * `repeat = none`) wins. Failures are logged, never thrown.
   */
  private rollSeries(record: TaskRecord<unknown>): void {
    if (!isRepeating(record) || !record.seriesId || !record.bodyJson) return;
    try {
      const stored = this.store?.get(record.taskId);
      const rule = stored ? stored.repeat : record.repeat;
      if (!rule || rule === "none") return;
      const now = Date.now();
      const prevMs = record.deadline ? Date.parse(record.deadline) : now;
      let deadlineMs: number;
      let deadlineKind = record.deadlineKind;
      let quotaProvider = record.quotaProvider;
      if (rule === "quota_reset") {
        // Kind and label follow the series rule, so one moved (absolute)
        // occurrence does not detach the series from the reset.
        deadlineKind = "quota_reset";
        quotaProvider = this.seriesQuotaLabel(record) ?? quotaProvider;
        const schedule = quotaProvider ? this.quotaConfig?.()[quotaProvider] : undefined;
        deadlineMs = schedule
          ? resolveQuotaDeadline(schedule, new Date(Math.max(prevMs, now + HOUR_MS))).deadline.getTime()
          : nextPeriod(prevMs, 7 * DAY_MS, now);
      } else {
        deadlineMs = nextPeriod(prevMs, rule === "daily" ? DAY_MS : 7 * DAY_MS, now);
      }
      const successor: TaskRecord<unknown> = {
        taskId: `${record.seriesId}~${occurrenceNumber(record) + 1}`,
        status: "scheduled",
        enqueuedAt: new Date(now).toISOString(),
        region: record.region,
        carbonBudgetG: record.carbonBudgetG,
        bodyJson: record.bodyJson,
        deadline: new Date(deadlineMs).toISOString(),
        notBefore: new Date(prevMs).toISOString(),
        scheduledFor: new Date(Math.max(deadlineMs - HOUR_MS, prevMs)).toISOString(),
        title: record.title,
        originHost: record.originHost,
        originCwd: record.originCwd,
        originSessionId: record.originSessionId,
        seriesId: record.seriesId,
        repeat: rule,
        deadlineKind,
        quotaProvider: deadlineKind === "quota_reset" ? quotaProvider : undefined,
      };
      if (this.store) {
        const created = this.eventFor(undefined, successor, {
          kind: "created",
          actor: "system",
          details: { series_id: record.seriesId, previous_task_id: record.taskId },
        });
        if (this.store.insertIfAbsent(successor, created)) {
          this.cacheRow(successor);
          // A stop written between the read above and the insert: end the
          // successor too. `cancelTask(..., {series})` also cancels pending
          // occurrences after its write, so one side always sees the other.
          if (this.store.get(record.taskId)?.repeat === "none") this.endSeriesOccurrences(record);
        }
      } else if (!this.tasks.has(successor.taskId)) {
        this.tasks.set(successor.taskId, successor);
      }
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn(
        `[tidegap/scheduler] series rollover after ${record.taskId} failed: ${describeErr(err)}`,
      );
    }
  }

  /**
   * Cancel every pending occurrence of `record`'s series other than
   * `record` itself, with `repeat = none` (stop series). Compare-and-set per
   * row; a row another process claimed meanwhile is left to the dispatcher.
   */
  private endSeriesOccurrences(record: TaskRecord<unknown>, actor?: TaskEventActor): void {
    if (!this.store || !record.seriesId) return;
    for (const row of this.store.list({ seriesId: record.seriesId })) {
      if (row.taskId === record.taskId) continue;
      if (row.status !== "queued" && row.status !== "scheduled") continue;
      const cached = this.tasks.get(row.taskId) ?? row;
      this.clearPendingTimer(row.taskId);
      this.writeIf(
        cached,
        {
          ...row,
          status: "cancelled",
          completedAt: new Date().toISOString(),
          bodyJson: redactBodyJson(row.bodyJson),
          repeat: "none",
        },
        ["queued", "scheduled"],
        { kind: "cancelled", actor, details: { series: true } },
      );
    }
  }

  /** The newest quota label stored on any occurrence of the record's series. */
  private seriesQuotaLabel(record: TaskRecord<unknown>): string | undefined {
    const rows = this.store?.list({ seriesId: record.seriesId! }) ?? [];
    for (let i = rows.length - 1; i >= 0; i--) {
      if (rows[i]!.quotaProvider) return rows[i]!.quotaProvider;
    }
    return undefined;
  }

  /** Snapshot the current state of one task. */
  getTask<T>(taskId: string): TaskRecord<T> | undefined {
    return this.resolveTask(taskId) as TaskRecord<T> | undefined;
  }

  /**
   * Cancel a task. Idempotent — if the task is already in a terminal
   * state, this is a no-op and returns the existing record. Throws
   * only if the task does not exist on this scheduler.
   *
   * The row is re-read from the ledger and written with a status
   * compare-and-set, so a cancel from another process (the UI, the CLI)
   * never overwrites a completion a ticker wrote meanwhile. When a ticker
   * claimed the row first, the cancel lands on the `running` row; the
   * dispatcher re-checks the status before finalizing and drops the late
   * result. `opts.series` also ends the series (`repeat = none`) in the
   * same write ("stop series"); on a finished occurrence it ends the
   * series at its live occurrence. `opts.expectedStatus` cancels only a row in
   * one of those states and returns any other row unchanged: the job code
   * passes the pending states, so a row a tick claimed runs to its end.
   */
  cancelTask(
    taskId: string,
    opts: { series?: boolean; details?: Record<string, unknown>; expectedStatus?: readonly TaskStatus[] } & ActorOptions = {},
  ): TaskRecord<unknown> {
    for (let attempt = 0; attempt < 2; attempt++) {
      const record = this.refreshTask(taskId);
      if (!record) {
        throw new TaskActionError(`cancelTask: task ${JSON.stringify(taskId)} not found`);
      }
      if (TERMINAL.has(record.status)) {
        // "Stop series" from a finished occurrence ends the series at its
        // live occurrence, so a later run does not roll it on.
        if (opts.series && record.seriesId) {
          const live = this.store?.list({ seriesId: record.seriesId }).find((r) => !TERMINAL.has(r.status));
          if (live) this.cancelTask(live.taskId, { series: true, actor: opts.actor });
        }
        return record;
      }
      if (opts.expectedStatus && !opts.expectedStatus.includes(record.status)) return record;
      this.clearPendingTimer(taskId);
      if (record.status === "submitted") {
        // The task is already in flight at the provider's Batch API. We
        // have no adapter handle here (cancelTask takes no adapters), so we
        // cannot issue a provider-side cancel — mark it cancelled locally
        // and warn that the batch may still run and bill.
        // eslint-disable-next-line no-console
        console.warn(
          `[tidegap/scheduler] cancelTask: task ${taskId} was submitted to the provider's Batch API (batch id ${record.batchId ?? "unknown"}); marking cancelled locally, but the provider-side batch may still run and bill`,
        );
      }
      const next: TaskRecord<unknown> = {
        ...record,
        status: "cancelled",
        completedAt: new Date().toISOString(),
        // Terminal transition: redact secrets out of the persisted body so
        // the ledger does not retain raw prompts forever.
        bodyJson: redactBodyJson(record.bodyJson),
        repeat: opts.series ? "none" : record.repeat,
      };
      // Cancel as a skip keeps the series going; a stop ends it.
      if (!opts.series) this.rollSeries(record);
      // A miss means another process moved the row (claimed or finished it)
      // between our read and this write: re-read and try once more.
      const event: TaskEventInput = {
        kind: "cancelled",
        actor: opts.actor,
        details: { ...opts.details, ...(opts.series ? { series: true } : {}) },
      };
      if (!this.writeIf(record, next, [record.status], event)) continue;
      if (opts.series) this.endSeriesOccurrences(record, opts.actor);
      const resolver = this.resolvers.get(taskId);
      resolver?.reject(new Error(`task ${taskId} cancelled`));
      this.bodies.delete(taskId);
      this.resolvers.delete(taskId);
      return record;
    }
    return this.refreshTask(taskId)!;
  }

  /**
   * Run a pending provider-call task at the next tick (ui v2). A write
   * only: no dispatch happens here, so a process without adapters (the
   * `tidegap ui` server) can call it. The row becomes `scheduled` for now with
   * `intensitySource: "expedited"`, which keeps it out of the Batch API and
   * survives onto the completed row. Throws when the task's state does not
   * allow it (see `taskActions`).
   */
  runNow(taskId: string, opts: ActorOptions = {}): TaskRecord<unknown> {
    const record = this.refreshTask(taskId);
    if (!record) throw new TaskActionError(`runNow: task ${JSON.stringify(taskId)} not found`);
    if (!taskActions(record).runNow) {
      throw new TaskActionError(
        refusal("runNow", record, "only queued or scheduled provider-call tasks can run now"),
      );
    }
    this.clearPendingTimer(taskId);
    const next: TaskRecord<unknown> = {
      ...record,
      status: "scheduled",
      scheduledFor: new Date().toISOString(),
      intensitySource: "expedited",
      notBefore: undefined,
    };
    if (!this.writeIf(record, next, PENDING_STATUSES, { kind: "expedited", actor: opts.actor })) {
      throw new TaskActionError(
        refusal("runNow", record, "only queued or scheduled provider-call tasks can run now"),
      );
    }
    return record;
  }

  /**
   * Move a queued or scheduled provider-call task (ui v2). `{deadline}`
   * re-runs the window picker up to the new deadline; `{at}` pins the exact
   * time; `{dayStart, dayEnd}` picks an hour inside the day. A day beyond
   * the forecast is written at the task's current hour of day, unplanned
   * (no estimate), and `replanSweep` gives it a window once the forecast
   * reaches it. A `quota_reset` task becomes `absolute`. Every write is a
   * compare-and-set on the pending statuses; throws when the task is not
   * movable.
   */
  async rescheduleTask(taskId: string, target: RescheduleTarget, opts: ActorOptions = {}): Promise<TaskRecord<unknown>> {
    return this.moveTask(taskId, target, { kind: "rescheduled", actor: opts.actor });
  }

  /** `rescheduleTask` with the event to record (`rescheduled` or `postponed`). */
  private async moveTask(taskId: string, target: RescheduleTarget, event: TaskEventInput): Promise<TaskRecord<unknown>> {
    const why = "only queued or scheduled provider-call tasks can be rescheduled";
    const shape = rescheduleShape(target);
    const record = this.refreshTask(taskId);
    if (!record) throw new TaskActionError(`reschedule: task ${JSON.stringify(taskId)} not found`);
    if (!taskActions(record).reschedule) throw new TaskActionError(refusal("reschedule", record, why));
    this.clearPendingTimer(taskId);
    const absolute = {
      deadlineKind: "absolute" as const,
      // A quota_reset series keeps its label for the next occurrence.
      quotaProvider: record.repeat === "quota_reset" ? record.quotaProvider : undefined,
      intensitySource: undefined,
    };
    if (shape.kind === "at") {
      const at = parseFutureInstant(shape.at, "at");
      const deadlineMs = Math.max(record.deadline ? Date.parse(record.deadline) : 0, at.getTime());
      const next: TaskRecord<unknown> = {
        ...record,
        ...absolute,
        status: "scheduled",
        scheduledFor: at.toISOString(),
        notBefore: at.toISOString(),
        deadline: new Date(deadlineMs).toISOString(),
        estimatedCarbonGCo2: undefined,
      };
      if (!this.writeIf(record, next, PENDING_STATUSES, event)) {
        throw new TaskActionError(refusal("reschedule", record, why));
      }
      return record;
    }
    let deadline: Date;
    if (shape.kind === "notBefore") {
      const start = parseInstant(shape.notBefore, "notBefore");
      const startMs = Math.max(start.getTime(), Date.now());
      const given = shape.deadline !== undefined ? normalizeDeadline(shape.deadline).getTime() : 0;
      const current = record.deadline ? Date.parse(record.deadline) : 0;
      const fields = startFields(startMs, given || current);
      deadline = new Date(fields.deadline);
      Object.assign(record, absolute, fields, { estimatedCarbonGCo2: undefined });
    } else if (shape.kind === "deadline") {
      deadline = normalizeDeadline(shape.deadline);
      Object.assign(record, absolute, { notBefore: undefined, deadline: deadline.toISOString() });
    } else {
      const dayStart = parseInstant(shape.dayStart, "dayStart");
      deadline = parseFutureInstant(shape.dayEnd, "dayEnd");
      const span = deadline.getTime() - dayStart.getTime();
      if (span < HOUR_MS || span > 25 * HOUR_MS) {
        throw new TaskActionError(`reschedule: a day must span 1 to 25 hours, got ${(span / HOUR_MS).toFixed(1)} h`);
      }
      // Fallback hour when the forecast does not reach the day yet: the
      // task's current time of day, moved into the new day. Day bounds are
      // instants from the client, so no time zone is needed here.
      const current = Date.parse(record.scheduledFor ?? record.deadline ?? "");
      const offset = Number.isFinite(current)
        ? (((current - dayStart.getTime()) % DAY_MS) + DAY_MS) % DAY_MS
        : 12 * HOUR_MS;
      // `scheduledFor === notBefore` marks an exact-time pin, which
      // `replanSweep` and the batch sweep skip. A fallback on the day's
      // first instant (a task now scheduled at that time of day) would read
      // as one and never be planned, so it moves one minute into the day.
      Object.assign(record, absolute, {
        notBefore: dayStart.toISOString(),
        deadline: deadline.toISOString(),
        scheduledFor: new Date(dayStart.getTime() + Math.max(offset, MINUTE_MS)).toISOString(),
      });
    }
    if (!(await this.scheduleProviderCall(taskId, deadline, event))) {
      throw new TaskActionError(refusal("reschedule", record, why));
    }
    // Planning can fail the task (no hour under its carbon budget): report
    // it as refused instead of a successful move.
    if (record.status === "failed") {
      throw new TaskActionError(`reschedule: task ${taskId} failed: ${record.error ?? "no window"}`);
    }
    return record;
  }

  /**
   * "Later" (coherence KTD4): move a queued or scheduled provider-call task
   * so it never runs earlier than its planned start. Resolves the target
   * with {@link resolvePostpone} and writes it through `rescheduleTask`, so
   * the write is the same compare-and-set on the pending statuses. An
   * `after_limit_reset` target uses its own `resetAt` (stored as the hint),
   * else the plugged-in `limitReset` source, else a still-future hint.
   * Throws `TaskActionError` with the refusal reason.
   */
  async postponeTask(taskId: string, target: PostponeTarget, opts: ActorOptions = {}): Promise<TaskRecord<unknown>> {
    const record = this.refreshTask(taskId);
    if (!record) throw new TaskActionError(`later: task ${JSON.stringify(taskId)} not found`);
    const now = new Date();
    const afterReset = "preset" in target && target.preset === "after_limit_reset";
    const givenReset = afterReset ? target.resetAt : undefined;
    const reset = afterReset && givenReset === undefined ? await resolveLimitReset(record, now, this.limitReset, this.store) : null;
    // Resolve against the row as it is after the wait: another process may
    // have moved it meanwhile, and "later" is measured from its current plan.
    const current = this.refreshTask(taskId);
    if (!current) throw new TaskActionError(`later: task ${JSON.stringify(taskId)} not found`);
    const resolved = resolvePostpone(current, target, now, reset);
    if (!resolved.ok) throw new TaskActionError(`later: task ${taskId}: ${resolved.reason}`);
    const moved = await this.moveTask(taskId, resolved.reschedule, {
      kind: "postponed",
      actor: opts.actor,
      details: "preset" in target ? { preset: target.preset } : {},
    });
    if (givenReset !== undefined) writeLimitResetHint(this.store, new Date(givenReset), taskProvider(record));
    return moved;
  }

  /**
   * The Later presets of a task with their resolved times (KTD6), using
   * the plugged-in reset source and the stored hint.
   */
  async postponeOptionsFor(task: string | TaskRecord<unknown>, now: Date = new Date()): Promise<PostponeOption[]> {
    const record = typeof task === "string" ? this.refreshTask(task) : task;
    if (!record) throw new TaskActionError(`later: task ${JSON.stringify(task)} not found`);
    const reset = taskActions(record).later
      ? await resolveLimitReset(record, now, this.limitReset, this.store)
      : null;
    return postponeOptions(record, now, reset);
  }

  /**
   * Reply to a completed provider-call task (ui v2, brainstorm R16/R17):
   * enqueue a child with the parent's conversation as history, the reply as
   * the new user turn, and the parent's provider, model and region. The
   * child runs through the normal window picker (default deadline one hour
   * ahead) and never repeats. Refuses failed and cancelled parents (AE4).
   */
  async replyToTask(
    parentId: string,
    text: string,
    opts: ReplyOptions & ActorOptions = {},
  ): Promise<TaskRecord<unknown>> {
    const parent = this.refreshTask(parentId);
    if (!parent) throw new TaskActionError(`reply: task ${JSON.stringify(parentId)} not found`);
    if (!taskActions(parent).reply) {
      throw new TaskActionError(
        refusal("reply", parent, "only completed provider-call tasks accept a reply"),
      );
    }
    if (typeof text !== "string" || text.trim().length === 0) {
      throw new TaskActionError("reply: text must be a non-empty string");
    }
    const spec = JSON.parse(parent.bodyJson!) as ProviderCallSpec;
    const child: ProviderCallSpec = {
      type: "provider_call",
      provider: spec.provider,
      model: spec.model,
      prompt: text,
      // Oldest turns dropped past HISTORY_MAX_CHARS (see capHistory).
      messages: capHistory(taskHistory(parent)),
      ...(spec.systemPrompt !== undefined ? { systemPrompt: spec.systemPrompt } : {}),
      ...(spec.maxTokens !== undefined ? { maxTokens: spec.maxTokens } : {}),
      ...(spec.temperature !== undefined ? { temperature: spec.temperature } : {}),
      ...(spec.redactInReceipt !== undefined ? { redactInReceipt: spec.redactInReceipt } : {}),
      ...(spec.tools !== undefined ? { tools: spec.tools } : {}),
      // With keepOrigin, the reply runs in the parent's origin session too
      // (with the parent's turns as history), so it keeps the facts the run needs.
      ...(opts.keepOrigin === true && spec.origin !== undefined ? { origin: spec.origin } : {}),
    };
    const created = await this.enqueueProviderCall(child, {
      actor: opts.actor,
      deadline: opts.deadline ?? new Date(Date.now() + HOUR_MS),
      region: parent.region,
      parentTaskId: parent.taskId,
      title: opts.title ?? `Re: ${displayTitle(parent) ?? parent.taskId}`,
      originHost: opts.originHost ?? parent.originHost,
      originCwd: opts.originCwd ?? parent.originCwd,
      originSessionId: opts.originSessionId ?? parent.originSessionId,
    });
    // The child is already committed (with its own `created` event): a
    // failed audit write on the parent must not fail the reply.
    try {
      this.store?.recordEvent(parent.taskId, {
        kind: "replied",
        actor: opts.actor ?? this.actor,
        details: { child_task_id: created.taskId },
      });
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn(`[tidegap/scheduler] task ${parent.taskId}: could not record the replied event: ${String(err)}`);
    }
    return created;
  }

  /**
   * Dispatch a queued/scheduled provider-call task immediately,
   * bypassing the scheduler's chosen window. Receipt records
   * `intensitySource: "expedited"`. Closure-based tasks (from
   * `defer`) are not expediteable; we throw a clear error.
   */
  async expediteTask(
    taskId: string,
    adapters: TickAdapters,
    opts: ActorOptions = {},
  ): Promise<TickResultEntry> {
    const record = this.refreshTask(taskId);
    if (!record) {
      throw new Error(`expediteTask: task ${JSON.stringify(taskId)} not found`);
    }
    if (record.status === "running") {
      throw new Error(`expediteTask: task ${taskId} is already running`);
    }
    if (record.status === "submitted") {
      throw new Error(
        `expediteTask: task ${taskId} is already submitted to the provider's Batch API (batch id ${record.batchId ?? "unknown"}); poll with tick / check_queue_status`,
      );
    }
    if (
      record.status === "completed" ||
      record.status === "failed" ||
      record.status === "cancelled"
    ) {
      throw new Error(`expediteTask: task ${taskId} is already ${record.status}`);
    }
    if (!record.bodyJson) {
      throw new Error(
        `expediteTask: task ${taskId} is a closure-based task; only provider-call tasks can be expedited`,
      );
    }
    if (unservedCommand(record, adapters)) {
      throw new Error(
        `expediteTask: task ${taskId} runs a shell command, which only the tidegap tick runs; use run now instead`,
      );
    }
    this.clearPendingTimer(taskId);
    const next: TaskRecord<unknown> = {
      ...record,
      scheduledFor: new Date().toISOString(),
      status: "scheduled",
      intensitySource: "expedited",
      notBefore: undefined,
    };
    // Same row-level claim `tick` uses: if a concurrent process (e.g. the
    // cron tick) grabbed the row between our read and here, do NOT
    // dispatch a second (double-billed) provider call.
    if (
      !this.writeIf(record, next, PENDING_STATUSES, { kind: "expedited", actor: opts.actor }) ||
      (this.store && !this.store.claimScheduled(taskId))
    ) {
      throw new Error(
        `task ${taskId} was just claimed by another process (racing tick?)`,
      );
    }
    return this.dispatchProviderCall(record, adapters);
  }

  /**
   * Re-score and reschedule a queued/scheduled task against a new
   * deadline. Throws if the task is already running or terminal, or
   * if the new deadline is invalid.
   *
   * `opts.deadlineKind: "absolute"` turns a `quota_reset` task into a plain
   * deadline (a caller-chosen time replaces the quota rule). Omitted, the
   * stored kind is kept, which is what the quota sweep relies on.
   */
  async updateDeadline(
    taskId: string,
    newDeadline: string | Date,
    opts: { deadlineKind?: "absolute" } & ActorOptions = {},
  ): Promise<TaskRecord<unknown>> {
    const record = this.refreshTask(taskId);
    if (!record) {
      throw new Error(`updateDeadline: task ${JSON.stringify(taskId)} not found`);
    }
    if (
      record.status === "running" ||
      record.status === "completed" ||
      record.status === "failed" ||
      record.status === "cancelled"
    ) {
      throw new Error(
        `updateDeadline: task ${taskId} is ${record.status}; can only update queued/scheduled tasks`,
      );
    }
    const parsedDeadline = normalizeDeadline(newDeadline);
    record.deadline = parsedDeadline.toISOString();
    if (opts.deadlineKind === "absolute") {
      record.deadlineKind = "absolute";
      record.quotaProvider = undefined;
    }
    this.clearPendingTimer(taskId);
    if (record.bodyJson) {
      // A new deadline replaces any pinned earliest start.
      record.notBefore = undefined;
      const event: TaskEventInput = { kind: "rescheduled", actor: opts.actor, details: { reason: "deadline" } };
      if (!(await this.scheduleProviderCall(taskId, parsedDeadline, event))) {
        throw new Error(
          `updateDeadline: task ${taskId} is ${record.status}; can only update queued/scheduled tasks`,
        );
      }
    } else if (this.bodies.has(taskId)) {
      await this.schedule(taskId, parsedDeadline);
    }
    return record;
  }

  /**
   * The quota sweep's reschedule (`sweepQuotaDeadlines`). Same window
   * selection as `updateDeadline`, but the ledger write is conditional on
   * the row still being `queued` / `scheduled`: a concurrent ticker may claim,
   * submit or finish the task between the sweep's read and this write.
   * Returns false, writing nothing, when the task is no longer pending.
   * Process-local closure tasks keep the `updateDeadline` path.
   */
  async rescheduleIfPending(taskId: string, newDeadline: Date): Promise<boolean> {
    const record = this.resolveTask(taskId);
    if (!record) return false;
    if (!record.bodyJson) {
      if (record.status !== "queued" && record.status !== "scheduled") return false;
      await this.updateDeadline(taskId, newDeadline);
      return true;
    }
    // Refresh a cached copy: this process may hold a stale status.
    const current = this.store?.get(taskId);
    if (current) Object.assign(record, current);
    if (record.status !== "queued" && record.status !== "scheduled") return false;
    record.deadline = newDeadline.toISOString();
    this.clearPendingTimer(taskId);
    return this.scheduleProviderCall(taskId, newDeadline, {
      kind: "rescheduled",
      actor: "system",
      details: { reason: "quota_sweep" },
    });
  }

  /**
   * Re-dispatch a failed task. Useful when the original failure was a
   * transient provider error (rate-limit, 5xx) and the underlying
   * spec is still valid. Only `failed` tasks are eligible; throws
   * otherwise.
   */
  async retryTask(
    taskId: string,
    adapters: TickAdapters,
    opts: ActorOptions = {},
  ): Promise<TickResultEntry> {
    const record = this.refreshTask(taskId);
    if (!record) {
      throw new Error(`retryTask: task ${JSON.stringify(taskId)} not found`);
    }
    if (record.status !== "failed") {
      throw new Error(
        `retryTask: task ${taskId} has status ${record.status}; retry is only valid on failed tasks`,
      );
    }
    if (!record.bodyJson) {
      throw new Error(
        `retryTask: task ${taskId} is closure-based; only provider-call tasks can be retried`,
      );
    }
    if (record.jobId) {
      // The job sweep already recorded this failure and queued a retry or
      // the next run; a second run of the same slot would go unrecorded.
      throw new TaskActionError(
        `retryTask: task ${taskId} is a run of job ${record.jobId}, which retries failed runs itself; use run now on the job`,
      );
    }
    const next: TaskRecord<unknown> = {
      ...record,
      status: "scheduled",
      scheduledFor: new Date().toISOString(),
      completedAt: undefined,
      error: undefined,
      // A retry re-dispatches synchronously via the due path below — clear
      // any stale batchId from a prior batch attempt so the completed row
      // no longer points at a dead/failed batch.
      batchId: undefined,
    };
    // Row-level claim: don't double-dispatch if a concurrent tick in
    // another process grabbed the freshly re-scheduled row first.
    if (
      !this.writeIf(record, next, ["failed"], { kind: "rescheduled", actor: opts.actor, details: { reason: "retry" } }) ||
      (this.store && !this.store.claimScheduled(taskId))
    ) {
      throw new Error(
        `task ${taskId} was just claimed by another process (racing tick?)`,
      );
    }
    return await this.dispatchProviderCall(record, adapters);
  }

  /**
   * Pure read-only planning helper: compute the scheduled window and
   * carbon receipt that the same call to `enqueueProviderCall` would
   * produce, without persisting anything. Useful for `schedule_task`
   * with `dry_run: true`.
   */
  async previewProviderCall(
    spec: ProviderCallSpec,
    opts: DeferOptions = {},
  ): Promise<{
    scheduledFor: string;
    estimatedCarbonGCo2: number;
    intensityGCo2PerKwh: number;
    band: GridForecastEntry["band"];
    batchEligible: boolean;
    region: string;
    /** The deadline the commit would store (raised by a `notBefore`). */
    deadline: string;
    /**
     * How many near-equal low-carbon windows sat in the cleanest-tolerance
     * band the shared `selectWindow` chose from (§2.1). A committed
     * `enqueueProviderCall` picks randomly within this same set, so the
     * preview's `scheduledFor` may legitimately differ from the eventual
     * commit's — but the candidate SET is identical. Undefined when no
     * in-deadline window existed (the "run now" fallback below).
     */
    cleanBandSize?: number;
    /**
     * Non-binding cross-provider routing preview (ROADMAP item 1) — the
     * scored candidate list + provisional pick this dry_run WOULD persist,
     * scored at the previewed window's intensity. Present only when the spec
     * carried >= 2 candidates. The binding pick is made at schedule time.
     */
    routingPreview?: RoutingPreview;
  }> {
    const requested = normalizeDeadline(opts.deadline);
    // An earliest start (after_limit_reset): same rule as the commit path.
    const notBefore = earliestStart(opts.notBefore);
    const deadline = notBefore
      ? new Date(startFields(notBefore.getTime(), requested.getTime()).deadline)
      : requested;
    const earliestMs = notBefore ? notBefore.getTime() + MINUTE_MS : 0;
    const region = opts.region ?? this.defaultRegion();
    const horizonH = Math.max(
      1,
      Math.min(
        MAX_HORIZON_HOURS,
        Math.ceil((deadline.getTime() - Date.now()) / (60 * 60 * 1000)),
      ),
    );
    const forecast = await this.feed.fetchForecast(region, horizonH);
    const entries = notBefore
      ? forecast.entries.filter((e) => Date.parse(e.datetime) + HOUR_MS > notBefore.getTime())
      : forecast.entries;
    const budgetG = opts.carbonBudgetG;
    const survivors =
      budgetG !== undefined
        ? entries.filter((e) => intensityToGrams(e.carbonIntensityGCo2PerKwh, spec.model) <= budgetG)
        : entries;
    // Shared selection (§2.1): preview and the eventual commit both run
    // `selectWindow` over the same budget survivors, so they agree on the
    // candidate band even though each makes its own random pick within it.
    const selection = selectWindow(survivors, deadline, { rng: this.rng });
    const candidate = selection?.chosen;
    // batchEligible reflects whether the *deadline* is far enough out
    // that Batch API (24h SLA) is still a viable route, not whether the
    // chosen window itself is more than 24h away.
    const batchEligible = deadline.getTime() - Date.now() > 24 * 60 * 60 * 1000;
    if (!candidate) {
      if (budgetG !== undefined && forecast.entries.length > 0) {
        const cheapest = forecast.entries.reduce((a, b) =>
          a.carbonIntensityGCo2PerKwh <= b.carbonIntensityGCo2PerKwh ? a : b,
        );
        const cheapestG = intensityToGrams(cheapest.carbonIntensityGCo2PerKwh, spec.model);
        if (cheapestG > budgetG) {
          throw new CarbonBudgetExceededError(cheapestG, budgetG);
        }
      }
      // No usable window inside the deadline. Mirror what the commit path
      // (`scheduleProviderCall`) does — schedule for "now" — instead of
      // throwing, so dry_run and the real call cannot diverge.
      const head = entries[0] ?? forecast.entries[0];
      if (!head) {
        throw new Error("previewProviderCall: forecast returned no entries");
      }
      // Routing preview at the run-now intensity — same math the commit path's
      // run-now fallback (`scheduleProviderCall`) uses. No-op unless >= 2
      // candidates were supplied.
      const routingPreviewNow = previewRouting(spec.candidates, {
        intensityGCo2PerKwh: head.carbonIntensityGCo2PerKwh,
        weights: spec.routeWeights,
        batchEligible,
        rng: this.rng,
      });
      return {
        scheduledFor: new Date(Math.max(Date.now(), earliestMs)).toISOString(),
        estimatedCarbonGCo2:
          Math.round(intensityToGrams(head.carbonIntensityGCo2PerKwh, spec.model) * 10) / 10,
        intensityGCo2PerKwh: head.carbonIntensityGCo2PerKwh,
        band: head.band,
        batchEligible,
        region,
        deadline: deadline.toISOString(),
        ...(routingPreviewNow ? { routingPreview: routingPreviewNow } : {}),
      };
    }
    // Routing preview at the CHOSEN window's intensity — the block this
    // dry_run would persist. No-op unless >= 2 candidates were supplied.
    const routingPreview = previewRouting(spec.candidates, {
      intensityGCo2PerKwh: candidate.carbonIntensityGCo2PerKwh,
      weights: spec.routeWeights,
      batchEligible,
      rng: this.rng,
    });
    return {
      // A candidate whose hour started in the past is the *current* hour —
      // the commit path dispatches now, so the preview says "now" too.
      scheduledFor:
        earliestMs > new Date(candidate.datetime).getTime()
          ? new Date(earliestMs).toISOString()
          : new Date(candidate.datetime).getTime() <= Date.now()
            ? new Date().toISOString()
            : candidate.datetime,
      estimatedCarbonGCo2: Math.round(intensityToGrams(candidate.carbonIntensityGCo2PerKwh, spec.model) * 10) / 10,
      intensityGCo2PerKwh: candidate.carbonIntensityGCo2PerKwh,
      band: candidate.band,
      batchEligible,
      region,
      deadline: deadline.toISOString(),
      cleanBandSize: selection!.band.length,
      ...(routingPreview ? { routingPreview } : {}),
    };
  }

  /** Snapshot the queue (immutable copy). */
  listTasks(): ReadonlyArray<TaskRecord<unknown>> {
    return Array.from(this.tasks.values());
  }

  /** Runs the dispatch of a row the tick moved to `running`, holding the row until it settles. */
  private async holding(record: TaskRecord<unknown>, dispatch: () => Promise<TickResultEntry>): Promise<TickResultEntry> {
    this.held.set(record.taskId, record);
    try {
      return await dispatch();
    } finally {
      this.held.delete(record.taskId);
    }
  }

  /**
   * A forced stop of the tick (KTD12): fail, as interrupted, every row this
   * scheduler moved to `running` in a tick whose dispatch has not settled.
   * Compare-and-set from `running`, so a row another writer finished first
   * keeps its status; rows another process holds, or a crashed tick
   * stranded, are not touched (the job sweep frees those). Synchronous, for
   * a process about to exit. Returns the ids it failed; a second call fails
   * nothing.
   */
  failHeldRuns(): string[] {
    const failed: string[] = [];
    for (const record of this.held.values()) {
      this.rollSeries(record);
      const details = { reason: "interrupted", ...(record.jobId ? { job_id: record.jobId } : {}) };
      const next = { ...record, status: "failed" as const, completedAt: new Date().toISOString(), error: JOB_INTERRUPTED_ERROR };
      if (this.writeIf(record, next, ["running"], { kind: "failed", details })) failed.push(record.taskId);
    }
    this.held.clear();
    return failed;
  }

  /** Cancel and clean up timers. Mostly for tests. */
  shutdown(): void {
    for (const timer of this.pendingTimers.values()) {
      clearTimeout(timer);
    }
    this.pendingTimers.clear();
    this.store?.close();
  }

  private async schedule(taskId: string, deadline: Date): Promise<void> {
    const record = this.tasks.get(taskId);
    if (!record) return;
    const horizonH = Math.max(
      1,
      Math.min(
        MAX_HORIZON_HOURS,
        Math.ceil((deadline.getTime() - Date.now()) / (60 * 60 * 1000)),
      ),
    );
    const forecast = await this.feed.fetchForecast(record.region, horizonH);
    // Optional carbon-budget filter. If a budget is set, drop entries whose
    // estimated grams exceed it; if zero usable windows remain, fail rather
    // than dispatch into a dirty hour.
    const budgetG = record.carbonBudgetG;
    const survivors =
      budgetG !== undefined
        ? forecast.entries.filter((e) => intensityToGrams(e.carbonIntensityGCo2PerKwh) <= budgetG)
        : forecast.entries;
    // Shared selection: cleanest-tolerance-band tie-break with the
    // scheduler's rng, so committed tasks spread across the clean band
    // instead of all colliding on the single trough hour (§2.1).
    const candidate = selectWindow(survivors, deadline, { rng: this.rng })?.chosen;
    if (!candidate) {
      if (budgetG !== undefined && forecast.entries.length > 0) {
        const cheapest = forecast.entries.reduce((a, b) =>
          a.carbonIntensityGCo2PerKwh <= b.carbonIntensityGCo2PerKwh ? a : b,
        );
        const cheapestG = intensityToGrams(cheapest.carbonIntensityGCo2PerKwh);
        if (cheapestG > budgetG) {
          this.failTask(taskId, new CarbonBudgetExceededError(cheapestG, budgetG));
          return;
        }
      }
      // No usable window inside the deadline — dispatch immediately rather
      // than miss the deadline.
      this.dispatchSafe(taskId, new Date(), undefined);
      return;
    }
    if (new Date(candidate.datetime).getTime() <= Date.now()) {
      // The chosen window is the *current* hour (its start is in the
      // past) — dispatch now, keeping the scored entry for the receipt.
      this.dispatchSafe(taskId, new Date(), candidate);
      return;
    }
    if (
      !this.writeIf(
        record,
        { ...record, status: "scheduled", scheduledFor: candidate.datetime },
        PENDING_STATUSES,
      )
    ) {
      return; // cancelled from another process meanwhile
    }
    const wait = Math.max(0, new Date(candidate.datetime).getTime() - Date.now());
    // Node's setTimeout overflows the signed-32-bit ms range (~24.85 days).
    // Cap each hop at 2_000_000_000 ms (~23.1 days) and re-schedule when
    // the timer fires before the actual window.
    const safeWait = Math.min(wait, 2_000_000_000);
    const timer = setTimeout(() => {
      this.pendingTimers.delete(taskId);
      if (safeWait < wait) {
        // Re-entry after a capped hop. Errors route to failTask so a
        // transient feed failure never becomes an unhandledRejection.
        this.schedule(taskId, deadline).catch((err) => {
          this.failTask(taskId, err instanceof Error ? err : new Error(String(err)));
        });
      } else {
        this.dispatchSafe(taskId, new Date(candidate.datetime), candidate);
      }
    }, safeWait);
    this.pendingTimers.set(taskId, timer);
  }

  /** Fire-and-forget wrapper around `dispatch` that routes any unexpected
   *  rejection to `failTask` instead of an unhandledRejection. */
  private dispatchSafe(
    taskId: string,
    ranAt: Date,
    forecastEntry: GridForecastEntry | undefined,
  ): void {
    this.dispatch(taskId, ranAt, forecastEntry).catch((err) => {
      this.failTask(taskId, err instanceof Error ? err : new Error(String(err)));
    });
  }

  private failTask(taskId: string, err: Error, onlyIfPending = false): boolean {
    const record = this.tasks.get(taskId);
    if (!record) return false;
    // Never overwrite a terminal state (a completed = billed dispatch, or
    // an explicit cancellation) with "failed".
    if (
      record.status === "completed" ||
      record.status === "failed" ||
      record.status === "cancelled"
    ) {
      return false;
    }
    const next: TaskRecord<unknown> = {
      ...record,
      status: "failed",
      completedAt: new Date().toISOString(),
      error: err.message,
    };
    // Compare-and-set: never overwrite a row another process finished or
    // cancelled meanwhile.
    if (!this.writeIf(record, next, onlyIfPending ? PENDING_STATUSES : UNFINISHED_STATUSES)) {
      return false;
    }
    const resolver = this.resolvers.get(taskId);
    resolver?.reject(err);
    this.bodies.delete(taskId);
    this.resolvers.delete(taskId);
    return true;
  }

  private async dispatch(
    taskId: string,
    ranAt: Date,
    forecastEntry: GridForecastEntry | undefined,
  ): Promise<void> {
    const record = this.tasks.get(taskId);
    const body = this.bodies.get(taskId);
    const resolver = this.resolvers.get(taskId);
    if (!record || !body) return;
    if (!this.writeIf(record, { ...record, status: "running" }, PENDING_STATUSES, { kind: "dispatched" })) {
      // Cancelled (possibly from another process) before the window came.
      resolver?.reject(new Error(`task ${taskId} ${record.status}`));
      this.bodies.delete(taskId);
      this.resolvers.delete(taskId);
      return;
    }
    const start = Date.now();
    // The try/catch is deliberately narrow: it covers ONLY the user's task
    // body. Once the body has succeeded, every piece of bookkeeping below
    // (intensity fetch, receipt build/sign, ledger write) is fail-soft —
    // a successful run must never be re-labelled "failed" by its paperwork.
    let result: unknown;
    try {
      result = await body();
    } catch (err) {
      this.writeIf(
        record,
        {
          ...record,
          status: "failed",
          completedAt: new Date().toISOString(),
          error: err instanceof Error ? err.message : String(err),
        },
        ["running"],
      );
      resolver?.reject(err);
      this.bodies.delete(taskId);
      this.resolvers.delete(taskId);
      return;
    }
    const durationMs = Date.now() - start;

    // The task may have been cancelled while the body was running — the
    // resolver was already rejected by cancelTask. Do not overwrite the
    // cancelled ledger row with a completed record + late result.
    // (Widen through a local: TS otherwise keeps `record.status` narrowed
    // to the "running" literal assigned above.)
    const statusAfterRun = record.status as TaskRecord["status"] as string;
    if (statusAfterRun === "cancelled") {
      // eslint-disable-next-line no-console
      console.warn(
        `[tidegap/scheduler] task ${taskId} was cancelled while running; dropping its late result`,
      );
      this.bodies.delete(taskId);
      this.resolvers.delete(taskId);
      return;
    }

    // The scheduler scored `forecastEntry` when it picked the window —
    // that is the estimate. `actual` is the intensity observed when the
    // task actually ran. If we dispatched without a forecast (immediate
    // fallback) there is no separate estimate, so the two coincide.
    let source: "scored" | "current" = "scored";
    let estimatedIntensityG: number | undefined;
    if (forecastEntry) {
      estimatedIntensityG = forecastEntry.carbonIntensityGCo2PerKwh;
    } else {
      source = "current";
    }
    let actualIntensityG: number | undefined;
    let gridSource: GridForecast["source"] | undefined;
    let signalType: GridForecast["signalType"];
    try {
      const current = await this.fetchCurrentIntensity(record.region, ranAt);
      actualIntensityG = current.intensityG;
      gridSource = current.source;
      signalType = current.signalType;
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn(
        `[tidegap/scheduler] intensity fetch for the receipt failed (${describeErr(err)}); receipt falls back to the schedule-time estimate`,
      );
    }
    let receipt: CarbonReceipt | undefined;
    try {
      const intensityForActual = actualIntensityG ?? estimatedIntensityG;
      const actualCarbonGCo2 =
        intensityForActual !== undefined
          ? Math.round(intensityToGrams(intensityForActual) * 10) / 10
          : 0;
      const estimatedCarbonGCo2 =
        estimatedIntensityG !== undefined
          ? Math.round(intensityToGrams(estimatedIntensityG) * 10) / 10
          : actualCarbonGCo2;
      const deltaPct =
        estimatedCarbonGCo2 > 0
          ? Math.round(
              ((actualCarbonGCo2 - estimatedCarbonGCo2) / estimatedCarbonGCo2) * 1000,
            ) / 10
          : 0;
      receipt = this.maybeSign({
        taskId,
        ranAt: ranAt.toISOString(),
        region: record.region,
        estimatedCarbonGCo2,
        actualCarbonGCo2,
        deltaPct,
        durationMs,
        // Provenance: the raw intensity + which feed produced it. Left
        // undefined when the receipt-side fetch failed. Closure tasks
        // have no model, so the energy coefficients are the flat legacy
        // fallback tier.
        intensityGCo2PerKwh: actualIntensityG,
        gridSource,
        signalType,
        energySource: "fallback",
        energyResolution: "default",
      });
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn(
        `[tidegap/scheduler] failed to build the carbon receipt for ${taskId}: ${describeErr(err)}; task stays completed without a receipt`,
      );
    }
    try {
      this.writeIf(
        record,
        {
          ...record,
          status: "completed",
          completedAt: new Date().toISOString(),
          result,
          receipt,
          intensitySource: source,
        },
        ["running"],
      );
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn(
        `[tidegap/scheduler] failed to persist completed task ${taskId}: ${describeErr(err)}`,
      );
    }
    resolver?.resolve(result);
    this.bodies.delete(taskId);
    this.resolvers.delete(taskId);
  }

  /**
   * Pick a carbon window for a provider-call task and write it with a
   * compare-and-set on the pending statuses. Returns false when another
   * process moved the row on meanwhile (nothing written, cache reloaded).
   *
   * A future `notBefore` (a pinned day or a series successor) drops forecast
   * hours that end before it. When the forecast does not reach it yet, the
   * row is written `scheduled` at its current `scheduledFor` clamped into
   * [notBefore, deadline] with no estimate ("unplanned"); `replanSweep`
   * re-scores it once the forecast covers it.
   */
  private async scheduleProviderCall(taskId: string, deadline: Date, event?: TaskEventInput): Promise<boolean> {
    const record = this.tasks.get(taskId);
    if (!record) return false;
    // The stored row before the forecast await: the final write misses when
    // another process changed the row's timing meanwhile (run now, a pin).
    const before = this.store?.get(taskId);
    // Parse the full spec out of the persisted body so the per-model energy
    // coefficients (v0.10) factor into the budget filter + estimated-carbon
    // receipt, and so cross-provider routing (ROADMAP item 1) can see the
    // candidate list. `specModel` drives WINDOW selection (chosen once,
    // before provider scoring); routing may overwrite the model afterward.
    let spec: ProviderCallSpec | undefined;
    let specModel: string | undefined;
    if (record.bodyJson) {
      try {
        spec = JSON.parse(record.bodyJson) as ProviderCallSpec;
        if (typeof spec.model === "string") specModel = spec.model;
      } catch {
        // Corrupt body; downstream dispatch will fail it. Fall back to
        // the legacy flat estimate here.
      }
    }
    const horizonH = Math.max(
      1,
      Math.min(
        MAX_HORIZON_HOURS,
        Math.ceil((deadline.getTime() - Date.now()) / (60 * 60 * 1000)),
      ),
    );
    const forecast = await this.feed.fetchForecast(record.region, horizonH);
    const notBeforeMs = record.notBefore ? Date.parse(record.notBefore) : Number.NaN;
    const pinned = Number.isFinite(notBeforeMs) && notBeforeMs > Date.now();
    let entries = forecast.entries;
    if (pinned) {
      entries = entries.filter((e) => Date.parse(e.datetime) + HOUR_MS > notBeforeMs);
      // Unplanned until the forecast covers the window's first day (or the
      // whole window when shorter); `replanSweep` plans it then. Planning on
      // the first hours alone would fix the run time at the day's start.
      const last = entries[entries.length - 1];
      const coveredTo = last ? Date.parse(last.datetime) + HOUR_MS : Number.NEGATIVE_INFINITY;
      // One hour of slack: forecast hours start on the hour, so a forecast
      // fetched up to the deadline can end just short of it.
      const needEnd = Math.min(deadline.getTime(), notBeforeMs + DAY_MS) - HOUR_MS;
      if (entries.length === 0 || coveredTo < needEnd) {
        record.status = "scheduled";
        record.scheduledFor = clampIso(record.scheduledFor, notBeforeMs, deadline.getTime());
        record.estimatedCarbonGCo2 = undefined;
        return this.persist(record, before, event);
      }
    }
    // One minute past a pinned start: a picked hour that contains it would
    // otherwise give `scheduledFor === notBefore`, which reads as an exact pin.
    const earliest = pinned ? notBeforeMs + MINUTE_MS : Date.now();
    const budgetG = record.carbonBudgetG;
    const survivors =
      budgetG !== undefined
        ? entries.filter((e) => intensityToGrams(e.carbonIntensityGCo2PerKwh, specModel) <= budgetG)
        : entries;
    // Shared selection (§2.1): same cleanest-tolerance-band tie-break as
    // the recommend path, so committed provider-call tasks spread too.
    const candidate = selectWindow(survivors, deadline, { rng: this.rng })?.chosen;
    if (!candidate) {
      if (budgetG !== undefined && entries.length > 0) {
        const cheapest = entries.reduce((a, b) =>
          a.carbonIntensityGCo2PerKwh <= b.carbonIntensityGCo2PerKwh ? a : b,
        );
        const cheapestG = intensityToGrams(cheapest.carbonIntensityGCo2PerKwh, specModel);
        if (cheapestG > budgetG) {
          return this.failTask(taskId, new CarbonBudgetExceededError(cheapestG, budgetG), true);
        }
      }
      // No usable window — schedule for `now` (or the pinned start) so the
      // next due `tick` runs the task rather than miss the deadline. Route
      // (if a candidate list was supplied) against the current-hour intensity.
      const nowIntensity = entries[0]?.carbonIntensityGCo2PerKwh;
      record.status = "scheduled";
      record.scheduledFor = new Date(Math.max(Date.now(), earliest)).toISOString();
      const routedModelNow =
        nowIntensity !== undefined
          ? this.applyRoutingIfNeeded(record, spec, nowIntensity)
          : specModel;
      if (nowIntensity !== undefined) {
        record.estimatedCarbonGCo2 =
          Math.round(intensityToGrams(nowIntensity, routedModelNow) * 10) / 10;
      }
      return this.persist(record, before, event);
    }
    record.status = "scheduled";
    // A candidate whose hour started in the past is the *current* hour —
    // schedule for "now" so the very next tick dispatches immediately. A
    // pinned start inside the chosen hour moves the time up to the pin.
    const at = Math.max(Date.parse(candidate.datetime), earliest);
    record.scheduledFor = at <= Date.now() ? new Date().toISOString() : new Date(at).toISOString();
    // Cross-provider routing (ROADMAP item 1): the window `candidate` was
    // chosen ONCE above; now score the caller's candidates at that window's
    // intensity, overwrite the spec's provider/model with the winner, and
    // record the decision. No-op unless >= 2 candidates were supplied.
    const routedModel = this.applyRoutingIfNeeded(
      record,
      spec,
      candidate.carbonIntensityGCo2PerKwh,
    );
    record.estimatedCarbonGCo2 =
      Math.round(intensityToGrams(candidate.carbonIntensityGCo2PerKwh, routedModel) * 10) / 10;
    return this.persist(record, before, event);
  }

  /**
   * Write a scheduling result with a compare-and-set on the pending
   * statuses and, given `before`, on the timing columns read before the
   * forecast fetch: when another process moved the row on meanwhile, nothing is
   * written, the cached record is reloaded from the ledger, and false is
   * returned.
   */
  private persist(record: TaskRecord<unknown>, before?: TaskRecord<unknown>, event?: TaskEventInput): boolean {
    if (!this.store) return true;
    const ev = event ? this.eventFor(before, record, event) : undefined;
    if (this.store.transitionIf(record, PENDING_STATUSES, before, ev)) return true;
    const current = this.store.get(record.taskId);
    if (current) Object.assign(record, current);
    return false;
  }

  /**
   * Cross-provider routing (ROADMAP item 1). When the spec carries >= 2
   * candidates, score them at `intensityForScoring` (the already-chosen
   * window's intensity), overwrite `spec.provider`/`spec.model` with the
   * winner, re-serialize `record.bodyJson`, and stash the full decision on
   * `record.routingDecision`. Returns the model that should drive the
   * estimated-carbon figure (the routed winner, or the spec's own model when
   * routing did not run). A missing price throws loudly (MissingPriceError)
   * — which fails the task at schedule time, by design.
   */
  private applyRoutingIfNeeded(
    record: TaskRecord<unknown>,
    spec: ProviderCallSpec | undefined,
    intensityForScoring: number,
  ): string | undefined {
    if (!spec) return undefined;
    const specs = spec.candidates;
    if (!Array.isArray(specs) || specs.length < 2) return spec.model;
    const candidates = parseCandidates(specs);
    const batchEligible = record.deadline
      ? new Date(record.deadline).getTime() - Date.now() > 24 * 60 * 60 * 1000
      : false;
    const decision = scoreCandidates({
      candidates,
      intensityGCo2PerKwh: intensityForScoring,
      weights: spec.routeWeights,
      batchEligible,
      rng: this.rng,
    });
    const chosen = decision.considered.find((c) => candidateId(c) === decision.chosen);
    if (chosen) {
      spec.provider = chosen.provider;
      spec.model = chosen.model;
      record.bodyJson = JSON.stringify(spec);
    }
    record.routingDecision = decision;
    return chosen?.model ?? spec.model;
  }

  private async dispatchProviderCall(
    record: TaskRecord<unknown>,
    adapters: TickAdapters,
    deferrals?: Map<string, Date>,
  ): Promise<TickResultEntry> {
    let spec: ProviderCallSpec;
    try {
      spec = JSON.parse(record.bodyJson ?? "null") as ProviderCallSpec;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.failTask(record.taskId, new Error(`tick: corrupt body_json: ${msg}`));
      return { taskId: record.taskId, status: "failed", error: msg };
    }
    if (!spec || spec.type !== "provider_call") {
      const msg = `tick: body is not a provider_call spec`;
      this.failTask(record.taskId, new Error(msg));
      return { taskId: record.taskId, status: "failed", error: msg };
    }
    // Cross-provider routing fallback (ROADMAP item 1): when a routing
    // decision is attached, dispatch the highest-scoring candidate whose
    // adapter is actually configured AND ready (has a key). If the originally
    // chosen candidate is unavailable, fall through to the next-best scored
    // one and record the fallback on the receipt.
    let adapter = adapters[spec.provider];
    const routing = record.routingDecision;
    if (routing) {
      const ordered = [...routing.considered].sort((a, b) => a.score - b.score);
      const picked = ordered.find((c) => {
        const a = adapters[c.provider];
        return a !== undefined && a.ready;
      });
      if (!picked) {
        const msg =
          `tick: no configured/ready adapter for any routing candidate ` +
          `(${routing.considered.map((c) => candidateId(c)).join(", ")})`;
        this.rollSeries(record);
        this.failTask(record.taskId, new Error(msg));
        return { taskId: record.taskId, status: "failed", error: msg };
      }
      const pickedId = candidateId(picked);
      if (pickedId !== routing.chosen) {
        record.routingDecision = {
          ...routing,
          fallbackFrom: routing.chosen,
          chosen: pickedId,
          reasoning: `${routing.reasoning} — dispatch fell back to ${pickedId} (originally ${routing.chosen} unavailable / missing key)`,
        };
        spec.provider = picked.provider;
        spec.model = picked.model;
      }
      adapter = adapters[picked.provider];
    }
    if (!adapter) {
      const msg = `tick: no adapter configured for provider ${spec.provider}`;
      // No rollover: a missing adapter is a skip (OpenClaw restores the row
      // to `scheduled`), and a successor would run beside the occurrence.
      // A retry that completes rolls the series then.
      this.failTask(record.taskId, new Error(msg));
      return { taskId: record.taskId, status: "failed", error: msg };
    }
    const deferKey = deferKeyOf(spec);
    const earlier = deferrals?.get(deferKey);
    if (earlier) {
      return this.deferTask(
        record,
        earlier,
        `${spec.provider}: deferred with an earlier task this tick until ${earlier.toISOString()}`,
      );
    }

    let stillOurs = true;
    try {
      // The row was claimed (`running`) or, without a store, is ours. A
      // cancel that landed after the claim wins: do not make the call.
      stillOurs = this.writeIf(record, { ...record, status: "running" }, ["running", "scheduled"], {
        kind: "dispatched",
        details: { provider: spec.provider, model: spec.model, ...this.sleepDetails() },
      });
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn(
        `[tidegap/scheduler] failed to persist running status for ${record.taskId}: ${describeErr(err)}`,
      );
    }
    if (!stillOurs) {
      return {
        taskId: record.taskId,
        status: "failed",
        error: `task was ${record.status} before dispatch; not sent`,
      };
    }
    const start = Date.now();
    const ranAt = new Date();
    // The try/catch is deliberately narrow: it covers ONLY the (billed)
    // provider call. Everything after a successful call — intensity fetch,
    // receipt build/sign, ledger write, output file — is fail-soft: a paid
    // dispatch must NEVER be re-labelled "failed" (a retry would bill the
    // provider a second time).
    let result: unknown;
    try {
      // Batch routing (deadline > 24h) is handled by the dedicated
      // submit/poll sweeps in tick(); by the time a task reaches this
      // sync due-sweep it is a genuine synchronous call.
      result = await retryWithBackoff(() => adapter.dispatch(spec.model, spec.prompt, {
        temperature: spec.temperature,
        maxTokens: spec.maxTokens,
        system: spec.systemPrompt,
        messages: spec.messages,
        ...(spec.tools !== undefined ? { tools: spec.tools } : {}),
        ...dispatchOrigin(record, spec),
        ...jobDispatchOptions(record, spec),
      }));
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const retryAt = deferRetryAt(err);
      if (retryAt) {
        deferrals?.set(deferKey, retryAt);
        return this.deferTask(record, retryAt, msg);
      }
      this.rollSeries(record);
      const details = runDetails((err as { details?: unknown } | null)?.details);
      this.writeIf(
        record,
        { ...record, status: "failed", completedAt: new Date().toISOString(), error: msg },
        ["running"],
        details ? { kind: "failed", details } : undefined,
      );
      return { taskId: record.taskId, status: "failed", error: msg };
    }
    const durationMs = Date.now() - start;

    // The task may have been cancelled while the provider call was in
    // flight (this process, or another one via the shared store). Keep the
    // cancelled ledger row: do not overwrite it with completed + result.
    let cancelledElsewhere = false;
    try {
      cancelledElsewhere = this.store?.get(record.taskId)?.status === "cancelled";
    } catch {
      // Store read failure — fall back to the in-memory status only.
    }
    const statusAfterCall = record.status as TaskRecord["status"] as string;
    if (statusAfterCall === "cancelled" || cancelledElsewhere) {
      record.status = "cancelled";
      // eslint-disable-next-line no-console
      console.warn(
        `[tidegap/scheduler] task ${record.taskId} was cancelled while running; dropping its late result`,
      );
      return {
        taskId: record.taskId,
        status: "failed",
        error: "task was cancelled while running; late result dropped",
      };
    }

    let intensityG: number | undefined;
    let gridSource: GridForecast["source"] | undefined;
    let signalType: GridForecast["signalType"];
    try {
      const current = await this.fetchCurrentIntensity(record.region, ranAt);
      intensityG = current.intensityG;
      gridSource = current.source;
      signalType = current.signalType;
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn(
        `[tidegap/scheduler] intensity fetch for the receipt failed (${describeErr(err)}); receipt falls back to the schedule-time estimate`,
      );
    }
    // A run-now row keeps its `expedited` marker on the completed record.
    const source: "scored" | "expedited" =
      record.intensitySource === "expedited" ? "expedited" : "scored";
    // `estimatedCarbonGCo2` was projected at schedule time from the
    // forecast entry the scheduler scored; `actual` is billed against
    // the intensity observed when the task actually ran. The delta is
    // the forecast drift between those two moments. For the actual side
    // we re-estimate energy with the real token counts the provider
    // reported (when available) — that turns the receipt from "typical
    // task at this model" into "this specific call at this model".
    const usage = (result as { usage?: { inputTokens?: number; outputTokens?: number; totalTokens?: number } }).usage;
    const inputTokens = typeof usage?.inputTokens === "number" ? usage.inputTokens : undefined;
    const outputTokens = typeof usage?.outputTokens === "number" ? usage.outputTokens : undefined;
    const modelUsage = (result as { modelUsage?: ModelUsage[] }).modelUsage;
    let receipt: CarbonReceipt | undefined;
    try {
      // A run that used two or more models is billed model by model (KTD7);
      // the totals, the dominant model and the weakest tiers come from the
      // bill. Otherwise `usage` is billed under one model, as before.
      const bill = Array.isArray(modelUsage) ? billModelUsage(intensityG, modelUsage) : undefined;
      const actualModel = bill?.model ?? (result as { model?: string }).model ?? spec.model;
      const totalTokens = bill
        ? bill.totalTokens
        : typeof usage?.totalTokens === "number"
          ? usage.totalTokens
          : undefined;
      const actualCarbonGCo2 =
        intensityG !== undefined
          ? Math.round(
              (bill?.carbonGCo2 ??
                gramsForIntensity(intensityG, {
                  model: actualModel,
                  inputTokens,
                  outputTokens,
                })) * 10,
            ) / 10
          : (record.estimatedCarbonGCo2 ?? 0);
      const estimatedCarbonGCo2 = record.estimatedCarbonGCo2 ?? actualCarbonGCo2;
      const deltaPct =
        estimatedCarbonGCo2 > 0
          ? Math.round(
              ((actualCarbonGCo2 - estimatedCarbonGCo2) / estimatedCarbonGCo2) * 1000,
            ) / 10
          : 0;
      receipt = this.maybeSign({
        taskId: record.taskId,
        ranAt: ranAt.toISOString(),
        region: record.region,
        estimatedCarbonGCo2,
        actualCarbonGCo2,
        deltaPct,
        // Record what actually ran (the adapter's DispatchResult), not just
        // what was requested — the OpenClaw runtime bridge may run a
        // different model than spec.model. The batch path has no model.
        provider:
          (result as { provider?: string }).provider ?? spec.provider,
        model: actualModel,
        durationMs,
        prompt: redactPrompt(spec.prompt, spec.redactInReceipt),
        totalTokens,
        // Provenance (v0.12): the raw intensity, which feed produced it
        // ("mock" = synthetic), and the confidence tier of the per-model
        // energy coefficients. Undefined intensity/gridSource means the
        // receipt-side fetch failed and the actual side reuses the
        // schedule-time estimate.
        intensityGCo2PerKwh: intensityG,
        gridSource,
        signalType,
        energySource: bill?.energySource ?? resolveModelEnergy(actualModel).coeffs.source,
        energyResolution: bill?.energyResolution ?? resolveModelEnergy(actualModel).tier,
        // Cross-provider routing provenance (ROADMAP item 1): the scored
        // candidate list, weights, chosen id (+ any dispatch fallbackFrom).
        // Inside the signed payload; omitted when routing was not used.
        routing: record.routingDecision,
        tools: (result as { tools?: string[] }).tools,
        session: (result as { session?: RunSession }).session,
        // Per-model breakdown (KTD5): inside the signed payload; absent for
        // a single-model run, whose receipt is unchanged.
        models: bill?.models,
      });
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn(
        `[tidegap/scheduler] failed to build the carbon receipt for ${record.taskId}: ${describeErr(err)}; task stays completed without a receipt`,
      );
    }
    // Terminal transition: redact secrets out of the persisted body. The
    // original (unredacted) body was needed up to this point so the live
    // dispatch used the caller's exact prompt; the ledger keeps only the
    // redacted form. (Failed tasks intentionally keep the original body —
    // retryTask must re-dispatch the exact prompt.) Compare-and-set on
    // `running`: a cancel written meanwhile by another process wins.
    const completed: TaskRecord<unknown> = {
      ...record,
      status: "completed",
      completedAt: new Date().toISOString(),
      result,
      receipt,
      intensitySource: source,
      bodyJson: redactBodyJson(record.bodyJson),
    };
    this.rollSeries(record);
    const completedDetails = runDetails((result as { details?: unknown }).details);
    try {
      if (!this.writeIf(record, completed, ["running"], completedDetails ? { kind: "completed", details: completedDetails } : undefined)) {
        // eslint-disable-next-line no-console
        console.warn(
          `[tidegap/scheduler] task ${record.taskId} was ${record.status} while running; dropping its late result`,
        );
        return {
          taskId: record.taskId,
          status: "failed",
          error: `task was ${record.status} while running; late result dropped`,
        };
      }
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn(
        `[tidegap/scheduler] failed to persist completed task ${record.taskId}: ${describeErr(err)}`,
      );
    }
    if (spec.outputPath && receipt) {
      await writeOutputFile(spec.outputPath, record.taskId, result, receipt);
    }
    return { taskId: record.taskId, status: "completed" };
  }

  /**
   * Put a running task back in the queue until `retryAt` (KTD7): `scheduled`,
   * `notBefore = retryAt`, one minute later as the fallback time, the
   * deadline raised to at least `retryAt + 2 h`, the estimate cleared so
   * `replanSweep` moves it to the cleanest hour once the forecast covers it.
   * Compare-and-set on `running`: a cancel during the run wins. Past the
   * 8-day cap from `enqueuedAt` the task fails with `message` instead.
   */
  private deferTask(record: TaskRecord<unknown>, retryAt: Date, message: string): TickResultEntry {
    const retryMs = retryAt.getTime();
    const capMs = Date.parse(record.enqueuedAt) + DEFER_CAP_MS;
    if (retryMs + NOT_BEFORE_SPAN_MS > capMs) {
      const error = `${message}; limit did not reset before the 8-day cap`;
      this.rollSeries(record);
      this.writeIf(
        record,
        { ...record, status: "failed", completedAt: new Date().toISOString(), error },
        ["running"],
      );
      return { taskId: record.taskId, status: "failed", error };
    }
    const next: TaskRecord<unknown> = {
      ...record,
      status: "scheduled",
      ...startFields(retryMs, record.deadline ? Date.parse(record.deadline) : 0),
      estimatedCarbonGCo2: undefined,
      intensitySource: undefined,
    };
    const event: TaskEventInput = {
      kind: "deferred",
      details: { retry_at: retryAt.toISOString(), reason: message.split("\n")[0]!.slice(0, 300) },
    };
    if (!this.writeIf(record, next, ["running"], event)) {
      return {
        taskId: record.taskId,
        status: "failed",
        error: `task was ${record.status} while running; deferral dropped`,
      };
    }
    return { taskId: record.taskId, status: "deferred", retryAt: retryAt.toISOString(), error: message };
  }

  /**
   * Submit a batch-eligible task to the provider's Batch API. The row was
   * already claimed (scheduled → running) by the caller. On success the
   * task transitions to "submitted" with the returned batchId persisted —
   * the provider now owns the execution hour (within its 24h SLA), and a
   * later tick's poll sweep completes it. On submit failure → failed
   * (retryTask can re-dispatch sync). No receipt is written here: carbon
   * is scored only when real results (and usage) arrive at poll time.
   */
  private async submitBatch(
    record: TaskRecord<unknown>,
    adapters: TickAdapters,
  ): Promise<TickResultEntry> {
    let spec: ProviderCallSpec;
    try {
      spec = JSON.parse(record.bodyJson ?? "null") as ProviderCallSpec;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.failTask(record.taskId, new Error(`tick: corrupt body_json: ${msg}`));
      return { taskId: record.taskId, status: "failed", error: msg };
    }
    const adapter = adapters[spec.provider];
    const dispatchBatch = adapter?.dispatchBatch;
    if (!adapter || typeof dispatchBatch !== "function") {
      // Should not happen — collectBatchSubmitCandidates already filtered
      // — but stay defensive: fall back to a clear failure.
      const msg = `tick: batch submit selected but adapter/dispatchBatch missing for ${spec.provider}`;
      this.failTask(record.taskId, new Error(msg));
      return { taskId: record.taskId, status: "failed", error: msg };
    }
    try {
      const handle = await retryWithBackoff(() =>
        dispatchBatch.call(adapter, spec.model, [spec.prompt], {
          temperature: spec.temperature,
          maxTokens: spec.maxTokens,
          system: spec.systemPrompt,
          messages: spec.messages,
        }),
      );
      try {
        this.writeIf(
          record,
          { ...record, status: "submitted", batchId: handle.batchId },
          ["running"],
          { kind: "dispatched", details: { batch_id: handle.batchId } },
        );
      } catch (err) {
        // eslint-disable-next-line no-console
        console.warn(
          `[tidegap/scheduler] failed to persist submitted status for ${record.taskId}: ${describeErr(err)}`,
        );
      }
      return { taskId: record.taskId, status: "submitted" };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // Cross-provider routing (ROADMAP item 1): a candidate chosen WITH a
      // batch discount whose batch submission fails falls back to its OWN
      // sync path first (the receipt then records the actual — sync — path),
      // and only then, if the sync adapter is unavailable, to the next-best
      // scored candidate (handled inside dispatchProviderCall). Non-routed
      // batch tasks keep the historical behavior: fail, and let retryTask
      // re-dispatch sync.
      if (record.routingDecision) {
        // eslint-disable-next-line no-console
        console.warn(
          `[tidegap/scheduler] batch submit failed for ${record.taskId} (${msg}); falling back to the synchronous dispatch path for the routed candidate`,
        );
        record.status = "scheduled";
        record.batchId = undefined;
        record.error = undefined;
        return this.dispatchProviderCall(record, adapters);
      }
      this.rollSeries(record);
      this.writeIf(
        record,
        { ...record, status: "failed", completedAt: new Date().toISOString(), error: msg },
        ["running"],
      );
      return { taskId: record.taskId, status: "failed", error: msg };
    }
  }

  /**
   * Poll a "submitted" task's batch. The row was already claimed
   * (submitted → running) by the caller. On:
   *   - in_progress: transition back to "submitted", stay pending.
   *   - completed:   build the full receipt exactly like the sync path
   *                  (real usage tokens + provenance + signing + output
   *                  file) and mark completed.
   *   - failed/expired: mark failed with the provider error (retryTask
   *                  re-dispatches sync via the expedite path).
   */
  private async pollBatch(
    record: TaskRecord<unknown>,
    adapters: TickAdapters,
  ): Promise<TickResultEntry> {
    let spec: ProviderCallSpec;
    try {
      spec = JSON.parse(record.bodyJson ?? "null") as ProviderCallSpec;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.failTask(record.taskId, new Error(`tick: corrupt body_json: ${msg}`));
      return { taskId: record.taskId, status: "failed", error: msg };
    }
    const adapter = adapters[spec.provider];
    if (!adapter || typeof adapter.retrieveBatch !== "function") {
      // No poller available: return the row to "submitted" so a later
      // tick with a capable adapter can pick it up. Do not fail — the
      // batch is genuinely in flight at the provider.
      this.writeIf(record, { ...record, status: "submitted" }, ["running"]);
      // eslint-disable-next-line no-console
      console.warn(
        `[tidegap/scheduler] tick: no retrieveBatch on adapter for ${spec.provider}; leaving ${record.taskId} submitted`,
      );
      return { taskId: record.taskId, status: "submitted" };
    }
    const batchId = record.batchId;
    if (!batchId) {
      const msg = "tick: submitted task has no batchId";
      this.failTask(record.taskId, new Error(msg));
      return { taskId: record.taskId, status: "failed", error: msg };
    }
    const ranAt = new Date();
    let poll: import("./providers/base.js").BatchRetrieveResult;
    try {
      poll = await retryWithBackoff(() => adapter.retrieveBatch!(batchId));
    } catch (err) {
      // A transient poll error must not fail a genuinely in-flight batch:
      // return it to "submitted" and let a later tick retry.
      this.writeIf(record, { ...record, status: "submitted" }, ["running"]);
      // eslint-disable-next-line no-console
      console.warn(
        `[tidegap/scheduler] tick: retrieveBatch failed for ${record.taskId} (${describeErr(err)}); leaving submitted`,
      );
      return { taskId: record.taskId, status: "submitted" };
    }

    if (poll.status === "in_progress") {
      this.writeIf(record, { ...record, status: "submitted" }, ["running"]);
      return { taskId: record.taskId, status: "submitted" };
    }
    if (poll.status === "failed" || poll.status === "expired") {
      const msg = poll.error ?? `batch ${poll.status}`;
      this.rollSeries(record);
      this.writeIf(
        record,
        { ...record, status: "failed", completedAt: new Date().toISOString(), error: msg },
        ["running"],
      );
      return { taskId: record.taskId, status: "failed", error: msg };
    }
    // completed — take the first (single-prompt) result.
    const first = poll.results?.[0];
    if (!first) {
      const msg = "batch completed with no results";
      this.rollSeries(record);
      this.writeIf(
        record,
        { ...record, status: "failed", completedAt: new Date().toISOString(), error: msg },
        ["running"],
      );
      return { taskId: record.taskId, status: "failed", error: msg };
    }
    // Shape a DispatchResult-like object so the receipt path is identical
    // to the sync dispatch.
    const result = {
      text: first.text,
      usage: first.usage,
      model: first.model ?? spec.model,
      provider: spec.provider,
      stopReason: first.stopReason,
      raw: poll,
    };

    let intensityG: number | undefined;
    let gridSource: GridForecast["source"] | undefined;
    let signalType: GridForecast["signalType"];
    try {
      const current = await this.fetchCurrentIntensity(record.region, ranAt);
      intensityG = current.intensityG;
      gridSource = current.source;
      signalType = current.signalType;
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn(
        `[tidegap/scheduler] intensity fetch for the receipt failed (${describeErr(err)}); receipt falls back to the schedule-time estimate`,
      );
    }
    const usage = result.usage;
    const inputTokens = typeof usage?.inputTokens === "number" ? usage.inputTokens : undefined;
    const outputTokens = typeof usage?.outputTokens === "number" ? usage.outputTokens : undefined;
    const actualModel = result.model;
    const totalTokens = typeof usage?.totalTokens === "number" ? usage.totalTokens : undefined;
    let receipt: CarbonReceipt | undefined;
    try {
      const actualCarbonGCo2 =
        intensityG !== undefined
          ? Math.round(
              gramsForIntensity(intensityG, {
                model: actualModel,
                inputTokens,
                outputTokens,
              }) * 10,
            ) / 10
          : (record.estimatedCarbonGCo2 ?? 0);
      const estimatedCarbonGCo2 = record.estimatedCarbonGCo2 ?? actualCarbonGCo2;
      const deltaPct =
        estimatedCarbonGCo2 > 0
          ? Math.round(
              ((actualCarbonGCo2 - estimatedCarbonGCo2) / estimatedCarbonGCo2) * 1000,
            ) / 10
          : 0;
      receipt = this.maybeSign({
        taskId: record.taskId,
        ranAt: ranAt.toISOString(),
        region: record.region,
        estimatedCarbonGCo2,
        actualCarbonGCo2,
        deltaPct,
        provider: result.provider ?? spec.provider,
        model: actualModel,
        prompt: redactPrompt(spec.prompt, spec.redactInReceipt),
        totalTokens,
        intensityGCo2PerKwh: intensityG,
        gridSource,
        signalType,
        energySource: resolveModelEnergy(actualModel).coeffs.source,
        energyResolution: resolveModelEnergy(actualModel).tier,
        // Cross-provider routing provenance (ROADMAP item 1) — see the sync
        // dispatch path. Present only when the task carried >= 2 candidates.
        routing: record.routingDecision,
      });
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn(
        `[tidegap/scheduler] failed to build the carbon receipt for ${record.taskId}: ${describeErr(err)}; task stays completed without a receipt`,
      );
    }
    const completed: TaskRecord<unknown> = {
      ...record,
      status: "completed",
      completedAt: new Date().toISOString(),
      result,
      receipt,
      intensitySource: "scored",
      bodyJson: redactBodyJson(record.bodyJson),
    };
    this.rollSeries(record);
    try {
      if (!this.writeIf(record, completed, ["running"])) {
        return {
          taskId: record.taskId,
          status: "failed",
          error: `task was ${record.status} while its batch ran; result dropped`,
        };
      }
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn(
        `[tidegap/scheduler] failed to persist completed task ${record.taskId}: ${describeErr(err)}`,
      );
    }
    if (spec.outputPath && receipt) {
      await writeOutputFile(spec.outputPath, record.taskId, result, receipt);
    }
    return { taskId: record.taskId, status: "completed" };
  }

  /**
   * Look up the intensity figure (and its feed provenance) used for the
   * actual side of a receipt: re-fetch the forecast and pick the entry
   * closest to the moment the task ran.
   */
  private async fetchCurrentIntensity(
    region: string,
    at: Date,
  ): Promise<{
    intensityG: number;
    source: GridForecast["source"];
    signalType: GridForecast["signalType"];
  }> {
    const forecast = await this.feed.fetchForecast(region, 24);
    const target = at.getTime();
    let best: GridForecastEntry | undefined;
    let bestDelta = Infinity;
    for (const entry of forecast.entries) {
      const d = Math.abs(new Date(entry.datetime).getTime() - target);
      if (d < bestDelta) {
        best = entry;
        bestDelta = d;
      }
    }
    return {
      intensityG: best?.carbonIntensityGCo2PerKwh ?? 400,
      source: forecast.source,
      // Prefer the chosen entry's signal (WattTime sets it per-entry),
      // fall back to the forecast-level marker.
      signalType: best?.signalType ?? forecast.signalType,
    };
  }
}

/**
 * Dispatch options of a job occurrence (KTD8): the caps as a per-call time
 * limit and budget, and for a row with `job_id` its working directory and
 * job id. A `command` body also hands over its shell and summarize steps.
 */
function jobDispatchOptions(record: TaskRecord<unknown>, spec: ProviderCallSpec): Partial<DispatchOptions> {
  const out: Partial<DispatchOptions> = {};
  if (spec.caps) {
    out.timeoutMs = spec.caps.llmTimeoutMs;
    out.maxBudgetUsd = spec.caps.maxBudgetUsd;
  }
  if (record.jobId) {
    out.jobId = record.jobId;
    if (record.originCwd) out.cwd = record.originCwd;
  }
  if (spec.provider === "command") {
    if (spec.command) out.command = spec.command;
    if (spec.summarize) out.summarize = spec.summarize;
    if (spec.caps) out.caps = spec.caps;
  }
  return out;
}

/**
 * The usage limit a dispatch can hit: its provider and model. A command
 * job's limit is its summarize step's, so a limit hit there defers the
 * other calls to that provider this tick, not every command job.
 */
function deferKeyOf(spec: ProviderCallSpec): string {
  if (spec.provider === "command" && spec.summarize) {
    return `${spec.summarize.provider}\u0000${spec.summarize.model ?? spec.model}`;
  }
  return `${spec.provider}\u0000${spec.model}`;
}

/** The known {@link RunDetails} keys of an adapter result or error, or undefined when none is set. */
function runDetails(raw: unknown): Record<string, unknown> | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const d = raw as RunDetails;
  const out: Record<string, unknown> = {};
  if (Array.isArray(d.steps)) out.steps = d.steps.filter((x) => typeof x === "string");
  if (typeof d.stopped_by === "string") out.stopped_by = d.stopped_by;
  if (d.truncated === true) out.truncated = true;
  return Object.keys(out).length > 0 ? out : undefined;
}

/** True for a command-job row when `adapters` has no `command` adapter to run it. */
function unservedCommand(record: TaskRecord<unknown>, adapters: TickAdapters): boolean {
  if (adapters.command || !record.bodyJson) return false;
  try {
    return (JSON.parse(record.bodyJson) as { provider?: unknown }).provider === "command";
  } catch {
    return false;
  }
}

/** True when no adapter serves the row: none for its provider and none for a routing candidate. */
function unserved(record: TaskRecord<unknown>, adapters: TickAdapters): boolean {
  let provider: unknown;
  try {
    provider = (JSON.parse(record.bodyJson ?? "null") as { provider?: unknown } | null)?.provider;
  } catch {
    return false; // a corrupt body fails with its own error
  }
  if (typeof provider === "string" && adapters[provider as ProviderName]) return false;
  return !record.routingDecision?.considered.some((c) => adapters[c.provider] !== undefined);
}

/**
 * The `origin` dispatch option (KTD13): only for a `claude-code` task whose
 * record names a session and a directory and whose spec names the agent.
 * The adapter registered as `anthropic` may be the Claude Code adapter, so
 * the check is on the task's provider, not on the adapter.
 */
function dispatchOrigin(record: TaskRecord<unknown>, spec: ProviderCallSpec): Pick<DispatchOptions, "origin"> {
  // A job occurrence never resumes or forks a session (KD8).
  if (spec.provider !== "claude-code" || !spec.origin || record.jobId) return {};
  if (!record.originSessionId || !record.originCwd) return {};
  return {
    origin: {
      sessionId: record.originSessionId,
      cwd: record.originCwd,
      agent: spec.origin.agent,
      ...(spec.origin.transcriptPath ? { transcriptPath: spec.origin.transcriptPath } : {}),
    },
  };
}

function intensityToGrams(gCo2PerKwh: number, model?: string): number {
  return gramsForIntensity(gCo2PerKwh, { model });
}

/**
 * Convenience: a process-wide scheduler accessed via the top-level
 * `defer()` function. Most users want this; advanced users construct
 * their own `new Scheduler({ ... })`.
 */
let _default: Scheduler | undefined;
function getDefault(): Scheduler {
  _default ??= new Scheduler();
  return _default;
}

export async function defer<T>(
  task: DeferrableTask<T>,
  opts: DeferOptions = {},
): Promise<T> {
  return getDefault().defer(task, opts);
}

/** Validate the v0.17 deadline-kind options; throws on a bad combination. */
function validateDeadlineKind(opts: DeferOptions): void {
  const kind = opts.deadlineKind;
  if (kind !== undefined && kind !== "absolute" && kind !== "quota_reset") {
    throw new Error(
      `Invalid deadlineKind ${JSON.stringify(kind)}: expected "absolute" or "quota_reset"`,
    );
  }
  if (kind === "quota_reset") {
    if (typeof opts.quotaProvider !== "string" || opts.quotaProvider.length === 0) {
      throw new Error(`deadlineKind "quota_reset" requires a quotaProvider label`);
    }
  } else if (opts.quotaProvider !== undefined) {
    throw new Error(`quotaProvider is only valid with deadlineKind "quota_reset"`);
  }
}

const REPEAT_RULES: ReadonlySet<RepeatRule> = new Set([
  "none",
  "daily",
  "weekly",
  "quota_reset",
]);

/**
 * Validate a repeat option (ui v2) and return the effective rule. Omitted
 * means `none` for every task, `quota_reset` deadlines included: repeating
 * is opt-in.
 */
function validateRepeat(repeat: unknown): RepeatRule {
  if (repeat === undefined) return "none";
  if (typeof repeat !== "string" || !REPEAT_RULES.has(repeat as RepeatRule)) {
    throw new Error(
      `Invalid repeat ${JSON.stringify(repeat)}: expected "none", "daily", "weekly" or "quota_reset"`,
    );
  }
  return repeat as RepeatRule;
}

/** The insert-only identity fields of a new task record. */
function identityFields(
  taskId: string,
  opts: DeferOptions,
  title: string | undefined,
): Pick<
  TaskRecord<unknown>,
  | "title"
  | "originHost"
  | "originCwd"
  | "parentTaskId"
  | "deadlineKind"
  | "quotaProvider"
  | "seriesId"
  | "repeat"
  | "originSessionId"
> {
  const repeat = validateRepeat(opts.repeat);
  return {
    title,
    originHost: opts.originHost,
    originCwd: opts.originCwd,
    parentTaskId: opts.parentTaskId,
    deadlineKind: opts.deadlineKind ?? "absolute",
    quotaProvider: opts.deadlineKind === "quota_reset" ? opts.quotaProvider : undefined,
    // A repeating task starts its own series; a one-off belongs to none.
    seriesId: repeat !== "none" ? taskId : undefined,
    repeat: repeat !== "none" ? repeat : undefined,
    originSessionId: opts.originSessionId,
  };
}

const MINUTE_MS = 60_000;
const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;
/** Minimum span between an earliest start and the deadline. */
const NOT_BEFORE_SPAN_MS = 2 * HOUR_MS;
/** A deferred task never moves past `enqueuedAt` plus this. */
const DEFER_CAP_MS = 8 * DAY_MS;

/**
 * The timing columns of a task with an earliest start at `startMs`: the
 * deadline raised to at least `startMs + 2 h`, and the fallback time one
 * minute past the start, because `scheduledFor === notBefore` reads as an
 * exact-time pin, which `replanSweep` and the batch sweep skip.
 */
function startFields(startMs: number, deadlineMs: number): { notBefore: string; scheduledFor: string; deadline: string } {
  return {
    notBefore: new Date(startMs).toISOString(),
    scheduledFor: new Date(startMs + MINUTE_MS).toISOString(),
    deadline: new Date(Math.max(deadlineMs, startMs + NOT_BEFORE_SPAN_MS)).toISOString(),
  };
}

/** A future earliest start, or undefined (absent or past). */
function earliestStart(v: DeferOptions["notBefore"]): Date | undefined {
  if (v === undefined || v === null) return undefined;
  const d = v instanceof Date ? v : new Date(v);
  if (Number.isNaN(d.getTime())) {
    throw new Error(`notBefore is not an ISO-8601 instant: ${JSON.stringify(v)}`);
  }
  return d.getTime() > Date.now() ? d : undefined;
}

/**
 * The next deadline of a period series: `prevMs` plus whole periods until
 * it is at least one hour ahead of `now`.
 */
function nextPeriod(prevMs: number, periodMs: number, now: number): number {
  let next = prevMs + periodMs;
  if (next < now + HOUR_MS) {
    next += Math.ceil((now + HOUR_MS - next) / periodMs) * periodMs;
  }
  return next;
}

/** Occurrence number of a series row: the series id itself is 1, `<id>~n` is n. */
function occurrenceNumber(record: TaskRecord<unknown>): number {
  const prefix = `${record.seriesId}~`;
  if (!record.taskId.startsWith(prefix)) return 1;
  const n = Number.parseInt(record.taskId.slice(prefix.length), 10);
  return Number.isFinite(n) && n > 0 ? n : 1;
}

/** One-line refusal in the shared style: `<action>: task <id> is <status>; <allowed>`. */
/**
 * A task action refused by the task's state or by its input (ui v2): the
 * message is a one-line rule safe to show a user. Any other error from an
 * action is internal.
 */
export class TaskActionError extends Error {
  override name = "TaskActionError";
}

function refusal(action: string, record: TaskRecord<unknown>, allowed: string): string {
  const what = record.bodyJson ? record.status : `${record.status} (closure-based)`;
  return `${action}: task ${record.taskId} is ${what}; ${allowed}`;
}

type RescheduleShape =
  | { kind: "notBefore"; notBefore: string | Date; deadline?: string | Date }
  | { kind: "deadline"; deadline: string | Date }
  | { kind: "at"; at: string | Date }
  | { kind: "day"; dayStart: string | Date; dayEnd: string | Date };

/** Classify a reschedule target; exactly one shape must be given. */
function rescheduleShape(target: RescheduleTarget): RescheduleShape {
  const t = (target ?? {}) as Record<string, unknown>;
  const has = (k: string) => t[k] !== undefined && t[k] !== null;
  if (has("notBefore")) {
    if (has("at") || has("dayStart") || has("dayEnd")) {
      throw new TaskActionError("reschedule: {notBefore} takes only an optional deadline");
    }
    return {
      kind: "notBefore",
      notBefore: t.notBefore as string | Date,
      deadline: has("deadline") ? (t.deadline as string | Date) : undefined,
    };
  }
  const shapes = [has("deadline"), has("at"), has("dayStart") || has("dayEnd")].filter(Boolean);
  if (shapes.length !== 1) {
    throw new TaskActionError(
      "reschedule: pass exactly one of {deadline}, {at}, {dayStart, dayEnd} or {notBefore}",
    );
  }
  if (has("deadline")) return { kind: "deadline", deadline: t.deadline as string | Date };
  if (has("at")) return { kind: "at", at: t.at as string | Date };
  if (!has("dayStart") || !has("dayEnd")) {
    throw new TaskActionError("reschedule: a day target needs both dayStart and dayEnd");
  }
  return {
    kind: "day",
    dayStart: t.dayStart as string | Date,
    dayEnd: t.dayEnd as string | Date,
  };
}

function parseInstant(v: string | Date, name: string): Date {
  const d = v instanceof Date ? v : new Date(v);
  if (Number.isNaN(d.getTime())) {
    throw new TaskActionError(`reschedule: ${name} is not an ISO-8601 instant: ${JSON.stringify(v)}`);
  }
  return d;
}

function parseFutureInstant(v: string | Date, name: string): Date {
  const d = parseInstant(v, name);
  if (d.getTime() < Date.now() - 5_000) {
    throw new TaskActionError(`reschedule: ${name} is in the past: ${d.toISOString()}`);
  }
  return d;
}

/** `iso` clamped into [lo, hi − 1 min] (lo wins when the span is shorter). */
function clampIso(iso: string | undefined, lo: number, hi: number): string {
  const t = iso ? Date.parse(iso) : Number.NaN;
  const base = Number.isFinite(t) ? t : lo;
  return new Date(Math.max(lo, Math.min(base, hi - 60_000))).toISOString();
}

function normalizeDeadline(d: DeferOptions["deadline"]): Date {
  if (d === undefined || d === null) {
    return new Date(Date.now() + 24 * 60 * 60 * 1000);
  }
  const parsed = d instanceof Date ? d : new Date(d);
  if (Number.isNaN(parsed.getTime())) {
    throw new InvalidDeadlineError(d);
  }
  // A deadline in the past is meaningless. Allow a small clock-skew tolerance
  // (5 seconds) so a deadline set "now" by the caller doesn't fail.
  if (parsed.getTime() < Date.now() - 5_000) {
    throw new InvalidDeadlineError(d);
  }
  return parsed;
}

/**
 * @deprecated Strict-minimum window pick, retained for API compat. Every
 * committing scheduler path now uses the shared {@link selectWindow}
 * (randomized cleanest-tolerance-band tie-break) so committed tasks spread
 * across the clean band instead of all colliding on the single trough hour
 * (§2.1). This helper still returns the strict minimum: it delegates to
 * `selectWindow` with an rng pinned to 0, which always picks the first
 * (cheapest) entry in the sorted band. Prefer `selectWindow` for new code.
 */
export function pickBestWindow(
  entries: GridForecastEntry[],
  deadline: Date,
): GridForecastEntry | undefined {
  // rng pinned to 0 → floor(0 * band.length) === 0 → the cheapest entry,
  // reproducing the historical strict-minimum behaviour exactly.
  return selectWindow(entries, deadline, { rng: () => 0 })?.chosen;
}

/**
 * Retry an async function with exponential backoff: up to 4 attempts
 * total (1 initial + 3 retries at 1s, 4s, 16s waits). Retries only on
 * errors that are safe to re-send: 429 rate-limits, 5xx, and network
 * errors raised *before* the request could reach the provider
 * (ECONNREFUSED / ENOTFOUND / EAI_AGAIN). Ambiguous mid-flight errors
 * (ETIMEDOUT, ECONNRESET) are NOT retried — the provider may already
 * have accepted and billed the call. Other 4xx bubble up immediately.
 *
 * This is the single retry policy for Tidegap: provider adapters
 * construct their SDK clients with `maxRetries: 0` so vendor-side
 * retries cannot multiply with this one.
 */
export async function retryWithBackoff<T>(fn: () => Promise<T>): Promise<T> {
  const waits = [1_000, 4_000, 16_000];
  let lastErr: unknown;
  for (let attempt = 0; attempt <= waits.length; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (!isRetryable(err) || attempt === waits.length) {
        throw err;
      }
      // eslint-disable-next-line no-console
      console.warn(
        `[tidegap/scheduler] dispatch attempt ${attempt + 1} failed (${describeErr(err)}); retrying in ${waits[attempt]! / 1000}s`,
      );
      await new Promise((r) => setTimeout(r, waits[attempt]!));
    }
  }
  throw lastErr;
}

function isRetryable(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  // A job's shell step, or a call retrying cannot help (NonRetryableError).
  if ((err as { nonRetryable?: unknown }).nonRetryable === true) return false;
  const e = err as {
    status?: number;
    statusCode?: number;
    code?: string;
    message?: string;
    cause?: { code?: string };
  };
  const status = e.status ?? e.statusCode;
  if (typeof status === "number") {
    if (status === 429) return true;
    if (status >= 500 && status < 600) return true;
    return false;
  }
  // Node fetch / undici errors often wrap the syscall error in `cause`.
  const code = e.code ?? e.cause?.code;
  if (typeof code === "string") {
    // Only pre-connect failures are safely retryable: the request never
    // reached the provider, so re-sending cannot double-bill. ETIMEDOUT /
    // ECONNRESET happen mid-flight — the provider may have accepted the
    // call — so they are deliberately NOT in this list.
    if (["ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN"].includes(code)) {
      return true;
    }
  }
  // Anthropic / OpenAI SDKs typically surface their HTTP status on the
  // error; if absent, assume non-retryable.
  return false;
}

function describeErr(err: unknown): string {
  if (!err) return "unknown error";
  if (typeof err === "object") {
    const e = err as { status?: number; code?: string; message?: string };
    const parts: string[] = [];
    if (e.status) parts.push(`status=${e.status}`);
    if (e.code) parts.push(`code=${e.code}`);
    if (e.message) parts.push(e.message);
    return parts.join(" · ") || JSON.stringify(err);
  }
  return String(err);
}

/**
 * Write { taskId, result, receipt } as JSON to the spec's
 * `outputPath`. Failures are logged but do not fail the task — the
 * SQLite ledger is the source of truth, the file is a convenience.
 */
async function writeOutputFile(
  path: string,
  taskId: string,
  result: unknown,
  receipt: CarbonReceipt,
): Promise<void> {
  try {
    const { mkdir, writeFile } = await import("node:fs/promises");
    const { dirname } = await import("node:path");
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, JSON.stringify({ taskId, result, receipt }, null, 2));
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn(
      `[tidegap/scheduler] failed to write output_path=${path}: ${describeErr(err)}; result is still in the SQLite ledger`,
    );
  }
}
