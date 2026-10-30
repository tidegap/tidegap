import { sign as nodeSign } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  canonicalize,
  loadOrCreateSigningKey,
  signReceipt,
  TaskStore,
  type CarbonReceipt,
} from "@tidegap/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { runVerify } from "../src/commands/verify.js";

const baseReceipt: CarbonReceipt = {
  taskId: "cli-verify-1",
  ranAt: "2026-06-01T12:00:00.000Z",
  region: "US-CAL-CISO",
  estimatedCarbonGCo2: 2.0,
  actualCarbonGCo2: 2.1,
  deltaPct: 5,
  model: "claude-sonnet-4-5",
};

describe("runVerify --file", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "tidegap-verify-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("exit 0 + 'VALID' for a signed receipt", async () => {
    const kp = loadOrCreateSigningKey({ privateKeyPath: join(dir, "k") });
    const signed = signReceipt(baseReceipt, kp);
    const path = join(dir, "ok.json");
    writeFileSync(path, JSON.stringify(signed));

    const res = await runVerify({ file: path });
    expect(res.exitCode).toBe(0);
    expect(res.rendered).toMatch(/VALID/);
    expect(res.payload.outcome).toBe("valid");
  });

  it("exit 1 + 'TAMPERED' when actualCarbonGCo2 is changed", async () => {
    const kp = loadOrCreateSigningKey({ privateKeyPath: join(dir, "k") });
    const signed = signReceipt(baseReceipt, kp);
    const tampered = { ...signed, actualCarbonGCo2: 0.01 };
    const path = join(dir, "bad.json");
    writeFileSync(path, JSON.stringify(tampered));

    const res = await runVerify({ file: path });
    expect(res.exitCode).toBe(1);
    expect(res.payload.outcome).toBe("tampered");
  });

  it("exit 2 + 'LEGACY UNSIGNED' for a pre-v0.11 receipt", async () => {
    const path = join(dir, "legacy.json");
    writeFileSync(path, JSON.stringify(baseReceipt));

    const res = await runVerify({ file: path });
    expect(res.exitCode).toBe(2);
    expect(res.payload.outcome).toBe("legacy-unsigned");
  });

  it("exit 3 + 'KEY MISMATCH' when --trusted-public-key disagrees", async () => {
    const kp = loadOrCreateSigningKey({ privateKeyPath: join(dir, "k") });
    const signed = signReceipt(baseReceipt, kp);
    const path = join(dir, "ok.json");
    writeFileSync(path, JSON.stringify(signed));

    const fake = Buffer.alloc(32, 9).toString("base64");
    const res = await runVerify({ file: path, trustedPublicKey: fake });
    expect(res.exitCode).toBe(3);
    expect(res.payload.outcome).toBe("key-mismatch");
  });

  it("exit 4 for a missing file", async () => {
    const res = await runVerify({ file: join(dir, "nope.json") });
    expect(res.exitCode).toBe(4);
    expect(res.payload.outcome).toBe("not-found");
  });

  it("accepts wrapper {taskId, result, receipt} shape (writeOutputFile format)", async () => {
    const kp = loadOrCreateSigningKey({ privateKeyPath: join(dir, "k") });
    const signed = signReceipt(baseReceipt, kp);
    const wrapper = { taskId: signed.taskId, result: "x", receipt: signed };
    const path = join(dir, "wrap.json");
    writeFileSync(path, JSON.stringify(wrapper));

    const res = await runVerify({ file: path });
    expect(res.exitCode).toBe(0);
    expect(res.payload.outcome).toBe("valid");
  });

  it("--json emits structured payload", async () => {
    const kp = loadOrCreateSigningKey({ privateKeyPath: join(dir, "k") });
    const signed = signReceipt(baseReceipt, kp);
    const path = join(dir, "ok.json");
    writeFileSync(path, JSON.stringify(signed));

    const res = await runVerify({ file: path, json: true });
    expect(JSON.parse(res.rendered).outcome).toBe("valid");
  });

  it("renders provenance fields (intensity, grid_source, energy_source)", async () => {
    const kp = loadOrCreateSigningKey({ privateKeyPath: join(dir, "k") });
    const receipt: CarbonReceipt = {
      ...baseReceipt,
      intensityGCo2PerKwh: 210,
      gridSource: "electricityMaps",
      energySource: "estimated",
    };
    const signed = signReceipt(receipt, kp);
    const path = join(dir, "prov.json");
    writeFileSync(path, JSON.stringify(signed));

    const res = await runVerify({ file: path });
    expect(res.rendered).toContain("intensity_g_kwh   210");
    expect(res.rendered).toContain("grid_source       electricityMaps");
    expect(res.rendered).toContain("energy_source     estimated");
    expect(res.rendered).not.toContain("MOCK DATA");
  });

  it("names the token-count marker in words, and prints no line for a fully reported receipt (batch 27)", async () => {
    const kp = loadOrCreateSigningKey({ privateKeyPath: join(dir, "k") });
    const render = async (receipt: CarbonReceipt, name: string) => {
      const path = join(dir, name);
      writeFileSync(path, JSON.stringify(signReceipt(receipt, kp)));
      return (await runVerify({ file: path })).rendered;
    };
    const partial = await render({ ...baseReceipt, energySource: "estimated", tokenCounts: "partial" }, "partial.json");
    expect(partial).toMatch(/VALID/);
    expect(partial).toContain("token_counts      partial (a token count was not reported; billed at the typical count)");
    const typical = await render({ ...baseReceipt, tokenCounts: "typical" }, "typical.json");
    expect(typical).toContain("token_counts      typical (no token count reported; billed as a typical call)");
    expect(await render(baseReceipt, "full.json")).not.toContain("token_counts");
  });

  it("--json keeps its payload keys for a receipt with the marker", async () => {
    const kp = loadOrCreateSigningKey({ privateKeyPath: join(dir, "k") });
    const path = join(dir, "partial.json");
    writeFileSync(path, JSON.stringify(signReceipt({ ...baseReceipt, tokenCounts: "partial" }, kp)));
    const res = await runVerify({ file: path, json: true });
    expect(Object.keys(JSON.parse(res.rendered)).sort()).toEqual(["outcome", "reason", "signerPublicKey", "taskId"]);
  });

  it("a tampered file names `tidegap verify <task-id>`; a valid file does not (KTD5)", async () => {
    const kp = loadOrCreateSigningKey({ privateKeyPath: join(dir, "k") });
    const signed = signReceipt(baseReceipt, kp);
    const bad = join(dir, "bad.json");
    writeFileSync(bad, JSON.stringify({ ...signed, actualCarbonGCo2: 0.01 }));
    const tampered = await runVerify({ file: bad });
    expect(tampered.payload.outcome).toBe("tampered");
    expect(tampered.rendered).toContain("`tidegap verify cli-verify-1` checks the stored bytes");
    expect(tampered.rendered).toContain("v0.11 or older verifies only that way");
    const json = await runVerify({ file: bad, json: true });
    expect(json.rendered).not.toContain("tidegap verify cli-verify-1");
    const ok = join(dir, "ok.json");
    writeFileSync(ok, JSON.stringify(signed));
    expect((await runVerify({ file: ok })).rendered).not.toContain("checks the stored bytes");
  });

  it("loudly marks a MOCK-derived receipt", async () => {
    const kp = loadOrCreateSigningKey({ privateKeyPath: join(dir, "k") });
    const receipt: CarbonReceipt = {
      ...baseReceipt,
      intensityGCo2PerKwh: 400,
      gridSource: "mock",
      energySource: "fallback",
    };
    const signed = signReceipt(receipt, kp);
    const path = join(dir, "mock.json");
    writeFileSync(path, JSON.stringify(signed));

    const res = await runVerify({ file: path });
    expect(res.rendered).toContain("MOCK DATA");
    expect(res.rendered).toContain("grid_source       mock");
  });
});

describe("runVerify <task-id>", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "tidegap-verify-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("a Python v0.11 snake-signed receipt in the ledger verifies valid by task id", async () => {
    // Python v0.11 and older signed its snake_case dict as is: no key
    // renaming, no signed_at in the payload.
    const kp = loadOrCreateSigningKey({ privateKeyPath: join(dir, "k") });
    const claims = {
      task_id: "py-legacy-1",
      ran_at: "2026-05-01T00:00:00+00:00",
      region: "DE",
      estimated_carbon_g_co2: 3.2,
      actual_carbon_g_co2: 3.4,
      delta_pct: 6.3,
      model: "claude-haiku-4-5",
    };
    const sig = nodeSign(null, Buffer.from(canonicalize(claims), "utf8"), kp.privateKey);
    const receipt = {
      ...claims,
      grid_source: null,
      signature: sig.toString("base64"),
      signer_public_key: kp.publicKeyBase64,
      signed_at: "2026-05-01T00:00:01+00:00",
    };
    const db = join(dir, "queue.db");
    const store = new TaskStore({ dbPath: db });
    store.upsert({
      taskId: "py-legacy-1",
      status: "completed",
      enqueuedAt: "2026-05-01T00:00:00+00:00",
      region: "DE",
      receipt: receipt as unknown as CarbonReceipt,
    });
    store.close();

    const res = await runVerify({ taskId: "py-legacy-1", db });
    expect(res.payload.outcome).toBe("valid");
    expect(res.exitCode).toBe(0);
    expect(res.payload.taskId).toBe("py-legacy-1");
    expect(res.rendered).toContain("actual_g_co2      3.4");
  });
});
