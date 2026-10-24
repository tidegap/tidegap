/**
 * Change feed for `tidegap ui` (KTD10). Polls `PRAGMA data_version`, which moves
 * when another connection commits (the tick, the MCP server). On a move it
 * re-lists the ledger and reports the ids whose status, read marker or
 * scheduled time changed. The server's own writes do not move
 * `data_version`, so the server calls `emit` itself after a mark-read.
 */

import type { TaskStore } from "@tidegap/core";

/** `ids`: tasks whose state changed; `jobs`: a job row changed (jobs U7). */
export type TaskChangeListener = (ids: string[], jobs?: boolean) => void;

export class TaskEvents {
  private readonly listeners = new Set<TaskChangeListener>();
  private fingerprints: Map<string, string>;
  private jobPrints: string;
  private version: number;
  private timer: NodeJS.Timeout | undefined;

  constructor(
    private readonly store: TaskStore,
    private readonly intervalMs = 2_000,
  ) {
    this.version = store.dataVersion();
    this.fingerprints = this.snapshot();
    this.jobPrints = this.jobSnapshot();
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => this.poll(), this.intervalMs);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    this.listeners.clear();
  }

  subscribe(fn: TaskChangeListener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** Push a change the poller cannot see (the server's own write). */
  emit(ids: string[], jobs = false): void {
    // Fingerprints stay as they are: re-reading them here could absorb a
    // tick commit that landed between the write and the next poll. The next
    // external commit may report these ids once more, which is harmless.
    for (const fn of this.listeners) fn(ids, jobs || undefined);
  }

  /** One poll step; public so tests need not wait on the timer. */
  poll(): void {
    let v: number;
    try {
      v = this.store.dataVersion();
    } catch {
      return;
    }
    if (v === this.version) return;
    let next: Map<string, string>;
    let jobPrints: string;
    try {
      next = this.snapshot();
      jobPrints = this.jobSnapshot();
    } catch {
      // A busy or locked ledger: keep the old version so the next poll retries.
      return;
    }
    this.version = v;
    const changed: string[] = [];
    for (const [id, fp] of next) if (this.fingerprints.get(id) !== fp) changed.push(id);
    for (const id of this.fingerprints.keys()) if (!next.has(id)) changed.push(id);
    this.fingerprints = next;
    const jobs = jobPrints !== this.jobPrints;
    this.jobPrints = jobPrints;
    if (changed.length > 0 || jobs) for (const fn of this.listeners) fn(changed, jobs || undefined);
  }

  /** Every job row's id and revision (each job write adds one to it), removed jobs included. */
  private jobSnapshot(): string {
    return this.store
      .listJobs()
      .map((j) => `${j.jobId}:${j.revision}`)
      .join(",");
  }

  private snapshot(): Map<string, string> {
    const out = new Map<string, string>();
    for (const r of this.store.list()) {
      out.set(
        r.taskId,
        `${r.status}|${r.readAt ?? ""}|${r.scheduledFor ?? ""}|${r.deadline ?? ""}|${r.repeat ?? ""}`,
      );
    }
    return out;
  }
}
