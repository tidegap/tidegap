/**
 * Ed25519 receipt signing (v0.11+).
 *
 * Every dispatched task ships a `CarbonReceipt`. Starting in v0.11 the
 * scheduler signs each receipt with a per-installation Ed25519 keypair
 * so any consumer can verify, offline and asynchronously, that:
 *
 *   1. The receipt was produced by an `tidegap` installation holding
 *      the matching private key (cryptographic origin authentication).
 *   2. None of the receipt's fields have been tampered with since the
 *      moment of signing (integrity). As of v0.12 this includes
 *      `signedAt` — only `signature` and `signerPublicKey` (the proof
 *      itself) sit outside the signed payload.
 *
 * Replay defence: the signature makes `signedAt` immutable, but it does
 * NOT make a receipt unique — a holder can present the same validly
 * signed receipt twice. Consumers that care about replay must enforce
 * uniqueness ledger-side (e.g. a unique index on `taskId`, or pinning
 * each `(signerPublicKey, taskId)` pair on first sight).
 *
 * Key lifecycle is local-first by design:
 *
 *   - Keys live at `~/.tidegap/signing.key` (private, 0600) +
 *     `signing.key.pub` (public, 0644).
 *   - The pair is generated lazily on the first call to
 *     `loadOrCreateSigningKey()`. There is no opt-in flow — the goal
 *     is that every receipt is signable by default.
 *   - The keys are NEVER sent anywhere by Tidegap itself. Verification
 *     consumers bundle the receipt's `signerPublicKey` along with the
 *     receipt; downstream ESG-export pipelines can pin the key on
 *     first sight.
 *
 * Cross-language canonical form (audit §0.3): there is exactly ONE
 * canonical signing payload shared by the TS and Python ports — the
 * camelCase wire rendering of the receipt, canonicalized by
 * `canonicalize()` (recursive key sort, no whitespace, ECMAScript /
 * RFC 8785-style number formatting — which `JSON.stringify` already
 * produces natively here). The Python port converts its snake_case
 * receipt dict to camelCase before canonicalizing, so a receipt signed
 * by either port verifies in both. `verifyReceipt` additionally accepts
 * a receipt in EITHER key rendering (snake_case rows read straight from
 * the shared SQLite ledger included) by normalizing keys before
 * canonicalization, and falls back to the legacy v0.11 canonical form
 * (payload without `signedAt`) for receipts signed by older releases.
 *
 * The shared fixture `test/fixtures/cross-lang-receipt-vectors.json`
 * pins the canonical bytes; both language test suites assert against
 * it byte-for-byte.
 *
 * Node ships Ed25519 in the `crypto` stdlib (since v16); there are no
 * native deps.
 */

import {
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  KeyObject,
  sign as nodeSign,
  verify as nodeVerify,
} from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";

import { resolveTidegapHome } from "./paths.js";
import type { CarbonReceipt } from "./types.js";

/** Override the keypair location (mainly for tests). */
export interface SigningKeyOptions {
  /** Absolute path to the private key (PEM). Defaults to `~/.tidegap/signing.key`. */
  privateKeyPath?: string;
}

export interface SigningKeyPair {
  privateKey: KeyObject;
  publicKey: KeyObject;
  /** Base64-encoded raw 32-byte public key bytes. Suitable for embedding on a receipt. */
  publicKeyBase64: string;
  /** Filesystem path the private key lives at. */
  privateKeyPath: string;
}

/** Default location of the local signing private key. */
export function defaultSigningKeyPath(): string {
  return join(resolveTidegapHome(), "signing.key");
}

/**
 * Write a file atomically: write to a same-directory temp file, then
 * `rename(2)` over the destination. Readers never observe a partial
 * file; concurrent writers converge on one winner.
 */
function writeFileAtomic(path: string, data: string, mode: number): void {
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, data, { mode });
  try {
    renameSync(tmp, path);
  } catch (err) {
    try { rmSync(tmp, { force: true }); } catch { /* best-effort cleanup */ }
    throw err;
  }
}

/**
 * Load the local signing keypair, generating + persisting one on first
 * call. Idempotent and safe under concurrent access (file write is
 * atomic via write-temp-then-rename — single writer wins, both readers
 * converge).
 */
export function loadOrCreateSigningKey(
  opts: SigningKeyOptions = {},
): SigningKeyPair {
  const privateKeyPath = opts.privateKeyPath ?? defaultSigningKeyPath();
  const publicKeyPath = `${privateKeyPath}.pub`;

  if (existsSync(privateKeyPath)) {
    const privatePem = readFileSync(privateKeyPath, "utf8");
    const privateKey = createPrivateKey({ key: privatePem, format: "pem" });
    const publicKey = createPublicKey(privateKey);
    return {
      privateKey,
      publicKey,
      publicKeyBase64: rawPublicKeyBase64(publicKey),
      privateKeyPath,
    };
  }

  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const privatePem = privateKey.export({ type: "pkcs8", format: "pem" }) as string;
  const publicPem = publicKey.export({ type: "spki", format: "pem" }) as string;

  mkdirSync(dirname(privateKeyPath), { recursive: true });
  writeFileAtomic(privateKeyPath, privatePem, 0o600);
  writeFileAtomic(publicKeyPath, publicPem, 0o644);
  // Defensive re-chmod in case umask interfered.
  try { chmodSync(privateKeyPath, 0o600); } catch { /* best-effort */ }

  return {
    privateKey,
    publicKey,
    publicKeyBase64: rawPublicKeyBase64(publicKey),
    privateKeyPath,
  };
}

/**
 * Deterministic JSON canonicalization. Recursively sorts object keys;
 * stringifies numbers via `JSON.stringify` (which already produces the
 * shortest round-trip, RFC 8785 / JCS-compatible representation for
 * finite floats); rejects non-finite numbers and `undefined` so the
 * canonical form is total.
 */
export function canonicalize(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new Error(`canonicalize: refusing to serialize non-finite number ${value}`);
    }
    return JSON.stringify(value);
  }
  if (typeof value === "string") return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map(canonicalize).join(",")}]`;
  }
  if (typeof value === "object") {
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj).filter((k) => obj[k] !== undefined).sort();
    const parts = keys.map((k) => `${JSON.stringify(k)}:${canonicalize(obj[k])}`);
    return `{${parts.join(",")}}`;
  }
  throw new Error(`canonicalize: unsupported value of type ${typeof value}`);
}

/**
 * Fields excluded from the signed payload — they are the proof itself.
 * Note `signedAt` is NOT here: since v0.12 it is covered by the
 * signature (audit §0.8 — a free-floating `signedAt` was trivially
 * rewritable despite being documented as replay defence).
 */
const SIGNATURE_FIELDS = new Set(["signature", "signerPublicKey"]);

/** Every signature-machinery key, in both wire renderings. */
const SIGNATURE_FIELDS_ANY_RENDERING = new Set([
  "signature",
  "signerPublicKey",
  "signer_public_key",
  "signedAt",
  "signed_at",
]);

/** `snake_case` → `camelCase`; already-camel keys pass through unchanged. */
function snakeToCamelKey(key: string): string {
  return key.replace(/_([a-z0-9])/g, (_m, c: string) => c.toUpperCase());
}

/**
 * Normalize a receipt-shaped value to the canonical camelCase wire
 * rendering: keys are converted snake→camel algorithmically (so future
 * receipt fields are covered automatically) and `null` / `undefined`
 * valued object keys are dropped (Python's `None` and TS's `undefined`
 * both mean "field absent" on a receipt). Arrays keep `null` elements.
 */
function normalizeReceiptKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalizeReceiptKeys);
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (v === undefined || v === null) continue;
      out[snakeToCamelKey(k)] = normalizeReceiptKeys(v);
    }
    return out;
  }
  return value;
}

/**
 * The camelCase name that two keys of one object normalize to, at any
 * depth, or undefined. No signer writes two renderings of one field
 * (`actualCarbonGCo2` and `actual_carbon_g_co2`), and normalization keeps
 * only the last of them, so a receipt that carries both could show one
 * value and verify against the other. Null and undefined values do not
 * count: normalization drops them.
 */
function duplicateRendering(value: unknown): string | undefined {
  if (Array.isArray(value)) {
    for (const v of value) {
      const name = duplicateRendering(v);
      if (name !== undefined) return name;
    }
    return undefined;
  }
  if (value === null || typeof value !== "object") return undefined;
  const seen = new Set<string>();
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (v === undefined || v === null) continue;
    const name = snakeToCamelKey(k);
    if (seen.has(name)) return name;
    seen.add(name);
    const nested = duplicateRendering(v);
    if (nested !== undefined) return nested;
  }
  return undefined;
}

/**
 * The exact canonical byte string a receipt's signature covers:
 * camelCase-normalized payload minus `signature`/`signerPublicKey`,
 * canonicalized. Pass `excludeSignedAt` to reproduce the legacy v0.11
 * form (payloads signed before `signedAt` entered the signature).
 *
 * Exported so tests (and external verifiers) can pin canonical bytes;
 * shared cross-language test vectors assert this byte-for-byte against
 * the Python port.
 */
export function canonicalReceiptPayload(
  receipt: Record<string, unknown>,
  opts: { excludeSignedAt?: boolean } = {},
): string {
  const normalized = normalizeReceiptKeys(receipt) as Record<string, unknown>;
  const payload: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(normalized)) {
    if (SIGNATURE_FIELDS.has(k)) continue;
    if (opts.excludeSignedAt && k === "signedAt") continue;
    payload[k] = v;
  }
  return canonicalize(payload);
}

/**
 * Legacy v0.11 canonical form of the receipt's ORIGINAL key rendering
 * (no snake→camel normalization, no `signedAt`). Python ≤v0.11 signed
 * its snake_case dict directly; this lets those ledger rows keep
 * verifying.
 */
function legacyRawCanonical(receipt: Record<string, unknown>): string {
  const payload: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(receipt)) {
    if (SIGNATURE_FIELDS_ANY_RENDERING.has(k)) continue;
    if (v === undefined || v === null) continue;
    payload[k] = v;
  }
  return canonicalize(payload);
}

/**
 * Sign a receipt in-place-style: returns a new receipt with the three
 * signature fields populated. The original receipt is not mutated.
 *
 * `signedAt` is computed first and INCLUDED in the signed payload —
 * only `signature` and `signerPublicKey` are excluded.
 */
export function signReceipt(
  receipt: CarbonReceipt,
  keyPair: SigningKeyPair,
  now: () => Date = () => new Date(),
): CarbonReceipt {
  const signedAt = now().toISOString();
  const claims: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(receipt)) {
    if (SIGNATURE_FIELDS_ANY_RENDERING.has(k)) continue;
    claims[k] = v;
  }
  const canonical = canonicalReceiptPayload({ ...claims, signedAt });
  const sig = nodeSign(null, Buffer.from(canonical, "utf8"), keyPair.privateKey);
  return {
    ...receipt,
    signature: sig.toString("base64"),
    signerPublicKey: keyPair.publicKeyBase64,
    signedAt,
  };
}

export type VerifyOutcome = "valid" | "tampered" | "legacy-unsigned" | "key-mismatch";

export interface VerifyResult {
  outcome: VerifyOutcome;
  /** Public key bytes that signed the receipt (base64). undefined for legacy-unsigned. */
  signerPublicKey?: string;
  /** Reason text suitable for CLI / API surfacing. */
  reason: string;
}

/**
 * Verify a (possibly signed) receipt. Accepts the receipt in EITHER key
 * rendering — camelCase (TS wire shape) or snake_case (Python ledger
 * rows) — keys are normalized algorithmically before canonicalization.
 *
 *   - `valid`           — signature matches the canonical payload
 *                         (v0.12 form with `signedAt` covered, or the
 *                         legacy v0.11 form — the reason says which).
 *   - `tampered`        — receipt is signed but the signature matches
 *                         none of the canonical forms of its fields, or
 *                         it carries two renderings of one field.
 *   - `key-mismatch`    — caller supplied a `trustedPublicKey` that
 *                         differs from the one bundled on the receipt.
 *   - `legacy-unsigned` — pre-v0.11 receipt (no signature). The
 *                         consumer must decide whether to accept it.
 */
export function verifyReceipt(
  receipt: CarbonReceipt | Record<string, unknown>,
  opts: { trustedPublicKey?: string } = {},
): VerifyResult {
  const raw = receipt as Record<string, unknown>;
  const normalized = normalizeReceiptKeys(raw) as Record<string, unknown>;
  const signature = normalized.signature as string | undefined;
  const signerPublicKey = normalized.signerPublicKey as string | undefined;
  if (!signature || !signerPublicKey) {
    return {
      outcome: "legacy-unsigned",
      reason: "receipt has no `signature` / `signerPublicKey` fields (pre-v0.11 or unsigned by configuration)",
    };
  }
  const duplicate = duplicateRendering(raw);
  if (duplicate !== undefined) {
    return {
      outcome: "tampered",
      signerPublicKey,
      reason: `receipt carries two renderings of \`${duplicate}\`; no signer writes both, so one was added after signing`,
    };
  }
  if (opts.trustedPublicKey && opts.trustedPublicKey !== signerPublicKey) {
    return {
      outcome: "key-mismatch",
      signerPublicKey,
      reason: `expected signer public key ${opts.trustedPublicKey}, receipt was signed by ${signerPublicKey}`,
    };
  }
  const publicKey = publicKeyFromBase64Raw(signerPublicKey);
  const sigBytes = Buffer.from(signature, "base64");
  const matches = (canonical: string): boolean =>
    nodeVerify(null, Buffer.from(canonical, "utf8"), publicKey, sigBytes);

  // Verification order (audit §0.3): (a) v0.12 canonical form — camelCase
  // payload WITH signedAt covered; (b) legacy v0.11 form — signedAt
  // excluded; (c) legacy v0.11 snake_case rendering (Python ≤v0.11 signed
  // its snake dict as-is). Only after every form fails → tampered.
  const attempts: Array<{ canonical: string; legacy: boolean }> = [];
  const pushUnique = (canonical: string, legacy: boolean): void => {
    if (!attempts.some((a) => a.canonical === canonical)) attempts.push({ canonical, legacy });
  };
  pushUnique(canonicalReceiptPayload(raw), false);
  pushUnique(canonicalReceiptPayload(raw, { excludeSignedAt: true }), true);
  pushUnique(legacyRawCanonical(raw), true);

  for (const attempt of attempts) {
    if (!matches(attempt.canonical)) continue;
    return {
      outcome: "valid",
      signerPublicKey,
      reason: attempt.legacy
        ? `Ed25519 signature verified against legacy v0.11 canonical form (signedAt not covered; ${attempt.canonical.length} bytes)`
        : `Ed25519 signature verified against canonical payload (${attempt.canonical.length} bytes)`,
    };
  }
  return {
    outcome: "tampered",
    signerPublicKey,
    reason: "Ed25519 signature does not match the canonical payload — receipt was modified after signing",
  };
}

// --------------------------------------------------------------------------- //
// Helpers

function rawPublicKeyBase64(publicKey: KeyObject): string {
  // Node 16+ exposes a 'raw' jwk-ish format via the JWK export.
  const jwk = publicKey.export({ format: "jwk" }) as { x?: string };
  if (!jwk.x) {
    throw new Error("loadOrCreateSigningKey: failed to extract raw Ed25519 public key bytes");
  }
  // JWK encodes `x` as base64url; normalize to base64 so the receipt is
  // self-consistent with `Buffer.from(sig, "base64")` on the verify side.
  return Buffer.from(jwk.x, "base64url").toString("base64");
}

function publicKeyFromBase64Raw(b64: string): KeyObject {
  const raw = Buffer.from(b64, "base64");
  if (raw.length !== 32) {
    throw new Error(`verifyReceipt: signerPublicKey must be 32 bytes (got ${raw.length})`);
  }
  return createPublicKey({
    key: { kty: "OKP", crv: "Ed25519", x: raw.toString("base64url") },
    format: "jwk",
  });
}
