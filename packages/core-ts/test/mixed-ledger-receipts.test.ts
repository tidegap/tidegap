/**
 * One ledger, two writers (KTD1, KTD2): the Node core reads a receipt the
 * Python core stored (snake_case keys, null for an absent field) with the
 * same values as its own. The budget numbers come from the shared fixture
 * `fixtures/mixed-ledger-receipts.json`, which
 * `packages/core-py/tests/test_mixed_ledger_receipts.py` also reads.
 */
import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  loadOrCreateSigningKey,
  mockGridFeed,
  Scheduler,
  signReceipt,
  TaskStore,
  verifyReceipt,
  type CarbonBudgetWindowKind,
  type CarbonReceipt,
} from "../src/index.js";
import { canonicalReceiptPayload } from "../src/sign.js";

interface Fixture {
  at: string;
  rows: Array<{ taskId: string; receipt: Record<string, unknown> }>;
  expected: Record<"daily" | "weekly", { windowStart: string; usedG: number; taskCount: number }>;
}

const fixture = JSON.parse(
  readFileSync(new URL("./fixtures/mixed-ledger-receipts.json", import.meta.url), "utf8"),
) as Fixture;

const requireFn = createRequire(import.meta.url);

interface RawDb {
  exec(sql: string): void;
  prepare(sql: string): { run(...p: unknown[]): unknown; get(...p: unknown[]): Record<string, unknown> | undefined };
  close(): void;
}

/** A raw SQLite handle, same backend order as TaskStore (CI's Node 20 leg has no node:sqlite). */
function openRawDb(path: string): RawDb {
  try {
    const { DatabaseSync } = requireFn("node:sqlite") as { DatabaseSync: new (p: string) => RawDb };
    return new DatabaseSync(path);
  } catch {
    return new (requireFn("better-sqlite3") as new (p: string) => RawDb)(path);
  }
}

/** Python's `json.dumps` separators: the stored bytes differ from `JSON.stringify`. */
function pythonJson(value: Record<string, unknown>): string {
  return `{${Object.entries(value).map(([k, v]) => `${JSON.stringify(k)}: ${JSON.stringify(v)}`).join(", ")}}`;
}

describe("a ledger that both cores wrote", () => {
  let dir: string;
  let dbPath: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "tidegap-mixed-"));
    dbPath = join(dir, "queue.db");
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  /** Store a completed row whose receipt_json is `text`, exactly as given. */
  function insertRaw(taskId: string, text: string): void {
    new TaskStore({ dbPath }).close();
    const raw = openRawDb(dbPath);
    try {
      raw
        .prepare(`INSERT INTO tasks (task_id, status, enqueued_at, completed_at, region, receipt_json) VALUES (?, 'completed', ?, ?, 'FR', ?)`)
        .run(taskId, "2026-10-28T09:00:00.000Z", "2026-10-28T09:00:00.000Z", text);
    } finally {
      raw.close();
    }
  }

  function storedText(taskId: string): string {
    const raw = openRawDb(dbPath);
    try {
      return raw.prepare(`SELECT receipt_json FROM tasks WHERE task_id = ?`).get(taskId)!.receipt_json as string;
    } finally {
      raw.close();
    }
  }

  for (const windowKind of ["daily", "weekly"] as CarbonBudgetWindowKind[]) {
    it(`budget status over the shared mixed-ledger fixture matches the expected ${windowKind} usage`, () => {
      for (const row of fixture.rows) insertRaw(row.taskId, pythonJson(row.receipt));
      const s = new Scheduler({ dbPath, feed: mockGridFeed(), signing: false, carbonBudget: { windowKind, thresholdG: 1_000_000 } });
      try {
        const status = s.getCarbonBudgetStatus(new Date(fixture.at))!;
        const expected = fixture.expected[windowKind as "daily" | "weekly"];
        expect(status.windowStart).toBe(expected.windowStart);
        expect(status.taskCount).toBe(expected.taskCount);
        expect(status.usedG).toBeCloseTo(expected.usedG, 6);
      } finally {
        s.shutdown();
      }
    });
  }

  it("a Python-rendered signed receipt verifies valid after the read", () => {
    const kp = loadOrCreateSigningKey({ privateKeyPath: join(dir, "signing.key") });
    const snake = { task_id: "py-signed", ran_at: "2026-10-28T11:30:00+00:00", region: "FR", estimated_carbon_g_co2: 0.6, actual_carbon_g_co2: 2.0 };
    const signed = signReceipt(snake as unknown as CarbonReceipt, kp);
    const python = { ...snake, delta_pct: null, signature: signed.signature, signer_public_key: signed.signerPublicKey, signed_at: signed.signedAt };
    insertRaw("py-signed", pythonJson(python));
    const store = new TaskStore({ dbPath });
    try {
      const receipt = store.get("py-signed")!.receipt!;
      expect(receipt).toMatchObject({ taskId: "py-signed", actualCarbonGCo2: 2.0, signerPublicKey: kp.publicKeyBase64 });
      expect(verifyReceipt(receipt).outcome).toBe("valid");
    } finally {
      store.close();
    }
  });

  it("a receipt with two renderings of one field stays tampered after the read", () => {
    const kp = loadOrCreateSigningKey({ privateKeyPath: join(dir, "signing.key") });
    const signed = signReceipt({ taskId: "two", ranAt: "2026-10-28T11:30:00.000Z", region: "FR", estimatedCarbonGCo2: 2.0, actualCarbonGCo2: 2.0 }, kp);
    insertRaw("two", JSON.stringify({ ...signed, actual_carbon_g_co2: 0.1 }));
    const store = new TaskStore({ dbPath });
    try {
      const res = verifyReceipt(store.get("two")!.receipt!);
      expect(res.outcome).toBe("tampered");
      expect(res.reason).toContain("two renderings of `actualCarbonGCo2`");
    } finally {
      store.close();
    }
  });

  it("the read copy and the stored receipt normalize and verify the same", () => {
    const kp = loadOrCreateSigningKey({ privateKeyPath: join(dir, "signing.key") });
    const snake = { task_id: "agree", ran_at: "2026-10-28T11:30:00+00:00", region: "FR", estimated_carbon_g_co2: 0.6, actual_carbon_g_co2: 2.0 };
    const signed = signReceipt(snake as unknown as CarbonReceipt, kp);
    const python = { ...snake, delta_pct: null, signature: signed.signature, signer_public_key: signed.signerPublicKey, signed_at: signed.signedAt };
    // Each stored receipt with the outcome both renderings must give.
    const cases: Array<[string, Record<string, unknown>, string]> = [
      ["python", python, "valid"],
      ["null-twin", { ...python, actualCarbonGCo2: null }, "valid"],
      ["snake-and-camel", { ...python, actualCarbonGCo2: 0.1 }, "tampered"],
      // Both rename to `actualCarbonGCo2`; a rename that kept only the
      // last one would show 2.0 and verify valid.
      ["two-snake", { actualCarbon_g_co2: 0.1, ...python }, "tampered"],
      // `x__1` renames to `x_1`, which renames again to `x1`.
      ["renames-twice", { ...python, x__1: 1, x1: 2 }, "tampered"],
    ];
    for (const [id, receipt] of cases) insertRaw(id, pythonJson(receipt));
    const store = new TaskStore({ dbPath });
    try {
      for (const [id, , outcome] of cases) {
        const copy = store.get(id)!.receipt as unknown as Record<string, unknown>;
        const stored = store.storedReceipt(id)!;
        expect(canonicalReceiptPayload(copy), id).toBe(canonicalReceiptPayload(stored));
        expect(verifyReceipt(copy), id).toEqual(verifyReceipt(stored));
        expect(verifyReceipt(stored).outcome, id).toBe(outcome);
      }
    } finally {
      store.close();
    }
  });

  it("null top-level fields of a Python receipt are absent after the read", () => {
    const python = fixture.rows.find((r) => r.taskId === "py-today-nulls")!;
    insertRaw(python.taskId, pythonJson(python.receipt));
    const store = new TaskStore({ dbPath });
    try {
      const receipt = store.get(python.taskId)!.receipt as unknown as Record<string, unknown>;
      expect(receipt).toEqual({
        taskId: "py-today-nulls",
        ranAt: "2026-10-28T11:30:00+00:00",
        region: "FR",
        estimatedCarbonGCo2: 1.0,
        actualCarbonGCo2: 1.25,
        provider: "anthropic",
        model: "claude-sonnet-4-5",
      });
      expect("deltaPct" in receipt).toBe(false);
    } finally {
      store.close();
    }
  });

  it("a Node receipt reads unchanged", () => {
    const node: CarbonReceipt = {
      taskId: "node-1",
      ranAt: "2026-10-28T09:00:00.000Z",
      region: "FR",
      estimatedCarbonGCo2: 1.5,
      actualCarbonGCo2: 2.5,
      deltaPct: 66.7,
      routing: { chosen: { provider: "anthropic", model: "m" }, candidates: [] } as unknown as CarbonReceipt["routing"],
    };
    const store = new TaskStore({ dbPath });
    try {
      store.upsert({ taskId: "node-1", status: "completed", enqueuedAt: node.ranAt, region: "FR", receipt: node });
      expect(store.get("node-1")!.receipt).toEqual(node);
    } finally {
      store.close();
    }
  });

  it("a Node write of a record read from a Python row keeps the stored receipt bytes", () => {
    const python = fixture.rows.find((r) => r.taskId === "py-today-nulls")!;
    const text = pythonJson(python.receipt);
    insertRaw(python.taskId, text);
    const store = new TaskStore({ dbPath });
    try {
      const record = store.get(python.taskId)!;
      store.upsert(record);
      expect(store.transitionIf({ ...record, error: "noted" }, ["completed"])).toBe(true);
      expect(storedText(python.taskId)).toBe(text);
      // A changed receipt is written as it is.
      record.receipt!.region = "SE";
      store.upsert(record);
      expect(JSON.parse(storedText(python.taskId))).toMatchObject({ taskId: "py-today-nulls", region: "SE" });
    } finally {
      store.close();
    }
  });
});
