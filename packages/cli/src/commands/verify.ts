/**
 * `tidegap verify <task-id | --file path>` — verify the Ed25519 signature
 * on a carbon receipt.
 *
 *   - From the local ledger:   `tidegap verify <task_id>` (looks up
 *     `~/.tidegap/queue.db`, or `--db` if set).
 *   - From a JSON receipt:     `tidegap verify --file ./receipt.json`.
 *
 * Exit code reflects the outcome so CI / batch jobs can branch:
 *   0 = valid; 1 = tampered; 2 = legacy-unsigned; 3 = key-mismatch;
 *   4 = not-found / parse error.
 */

import { readFileSync } from "node:fs";

import { TaskStore, verifyReceipt } from "@tidegap/core";
import type { CarbonReceipt, TaskRecord } from "@tidegap/core";

import { defaultDbPath } from "./tick.js";

export interface VerifyOptions {
  taskId?: string;
  file?: string;
  db?: string;
  trustedPublicKey?: string;
  json?: boolean;
}

export interface VerifyResult {
  exitCode: number;
  rendered: string;
  /** Structured payload returned when `--json` is set. */
  payload: {
    taskId?: string;
    outcome: string;
    signerPublicKey?: string;
    reason: string;
  };
}

/**
 * The words for a receipt's `tokenCounts` (batch 27, KTD1); undefined when
 * every count was reported, so the surface prints no line.
 */
export function tokenCountsText(value: unknown): string | undefined {
  if (value === "partial") return "partial (a token count was not reported; billed at the typical count)";
  if (value === "typical") return "typical (no token count reported; billed as a typical call)";
  return undefined;
}

export async function runVerify(opts: VerifyOptions): Promise<VerifyResult> {
  const loaded = loadReceipt(opts);
  if (!loaded) {
    const reason = opts.file
      ? `verify: file ${opts.file} did not contain a valid CarbonReceipt JSON object`
      : `verify: no receipt found for task ${opts.taskId ?? "<missing>"} in ${opts.db ?? defaultDbPath()}`;
    return {
      exitCode: 4,
      rendered: reason,
      payload: { taskId: opts.taskId, outcome: "not-found", reason },
    };
  }

  const { receipt, signed } = loaded;
  const res = verifyReceipt(signed, {
    trustedPublicKey: opts.trustedPublicKey,
  });

  const exitCode =
    res.outcome === "valid"
      ? 0
      : res.outcome === "tampered"
        ? 1
        : res.outcome === "legacy-unsigned"
          ? 2
          : /* key-mismatch */ 3;

  const payload = {
    taskId: receipt.taskId,
    outcome: res.outcome,
    signerPublicKey: res.signerPublicKey,
    reason: res.reason,
  };

  if (opts.json) {
    return {
      exitCode,
      rendered: JSON.stringify(payload, null, 2),
      payload,
    };
  }

  // The same test as `loadReceipt`: an empty `--file` reads the ledger.
  const rendered = renderHuman(receipt, res, Boolean(opts.file));
  return { exitCode, rendered, payload };
}

/**
 * The receipt to show and the receipt to verify. From the ledger they
 * differ: the store renames a Python receipt's snake_case keys for
 * display, but the signature is checked on the stored bytes (a Python
 * receipt signed by v0.11 or older verifies only against its own keys).
 */
function loadReceipt(opts: VerifyOptions): { receipt: CarbonReceipt; signed: Record<string, unknown> } | undefined {
  if (opts.file) {
    try {
      const raw = readFileSync(opts.file, "utf8");
      const parsed = JSON.parse(raw);
      // Accept either a bare receipt or a wrapper {receipt: ...} shape
      // (matches what `writeOutputFile` emits in the scheduler).
      const receipt: CarbonReceipt | undefined =
        parsed && typeof parsed === "object" && "receipt" in parsed
          ? (parsed.receipt as CarbonReceipt)
          : (parsed as CarbonReceipt);
      if (!receipt || typeof receipt.taskId !== "string") return undefined;
      return { receipt, signed: receipt as unknown as Record<string, unknown> };
    } catch {
      return undefined;
    }
  }
  if (!opts.taskId) return undefined;
  const store = new TaskStore({ dbPath: opts.db ?? defaultDbPath() });
  try {
    const receipt = (store.get(opts.taskId) as TaskRecord<unknown> | undefined)?.receipt;
    const signed = store.storedReceipt(opts.taskId);
    return receipt && signed ? { receipt, signed } : undefined;
  } finally {
    store.close();
  }
}

function renderHuman(receipt: CarbonReceipt, res: ReturnType<typeof verifyReceipt>, fromFile: boolean): string {
  const status =
    res.outcome === "valid"
      ? "✓ VALID"
      : res.outcome === "tampered"
        ? "✗ TAMPERED"
        : res.outcome === "key-mismatch"
          ? "✗ KEY MISMATCH"
          : "○ LEGACY UNSIGNED";

  const lines: string[] = [
    status,
  ];
  if (receipt.gridSource === "mock") {
    lines.push("!! MOCK DATA — grid intensity is synthetic, not from a real feed");
  }
  lines.push(
    "",
    `task_id           ${receipt.taskId}`,
    `region            ${receipt.region}`,
    `ran_at            ${receipt.ranAt}`,
  );
  if (receipt.actualCarbonGCo2 !== undefined) {
    lines.push(`actual_g_co2      ${receipt.actualCarbonGCo2}`);
  }
  if (receipt.estimatedCarbonGCo2 !== undefined) {
    lines.push(`estimated_g_co2   ${receipt.estimatedCarbonGCo2}`);
  }
  if (receipt.deltaPct !== undefined) {
    lines.push(`delta_pct         ${receipt.deltaPct >= 0 ? "+" : ""}${receipt.deltaPct}`);
  }
  if (receipt.intensityGCo2PerKwh !== undefined) {
    lines.push(`intensity_g_kwh   ${receipt.intensityGCo2PerKwh}`);
  }
  if (receipt.gridSource !== undefined) {
    const mock = receipt.gridSource === "mock";
    const marginal =
      receipt.signalType === "marginal"
        ? "   (marginal-emissions signal — not an average-grid figure)"
        : "";
    lines.push(
      `grid_source       ${receipt.gridSource}${mock ? "   !! MOCK DATA (synthetic — carbon is illustrative, not measured)" : ""}${marginal}`,
    );
  }
  if (receipt.energySource !== undefined) {
    lines.push(`energy_source     ${receipt.energySource}`);
  }
  if (receipt.energyResolution !== undefined) {
    lines.push(`energy_resolution ${receipt.energyResolution}`);
  }
  const tokenCounts = tokenCountsText(receipt.tokenCounts);
  if (tokenCounts) lines.push(`token_counts      ${tokenCounts}`);
  if (receipt.model) lines.push(`model             ${receipt.model}`);
  if (receipt.provider) lines.push(`provider          ${receipt.provider}`);
  if (res.signerPublicKey) {
    lines.push("", `signer_public_key ${res.signerPublicKey}`);
  }
  if (receipt.signedAt) lines.push(`signed_at         ${receipt.signedAt}`);
  lines.push("", res.reason);
  // A file is the reader's renamed copy; the ledger keeps the signed bytes
  // (KTD5). A Python receipt signed by v0.11 or older verifies only there.
  if (fromFile && res.outcome === "tampered") {
    lines.push(
      `Exported from a ledger? \`tidegap verify ${receipt.taskId}\` checks the stored bytes. A Python receipt signed by v0.11 or older verifies only that way.`,
    );
  }
  return lines.join("\n");
}
