/**
 * Secret redaction for prompts and persisted provider-call bodies.
 *
 * Used by the scheduler at terminal transitions (receipt prompt, body_json)
 * and at enqueue for task titles, so every stored copy of user text goes
 * through one set of patterns.
 */

import type { ProviderCallSpec } from "./types.js";

/**
 * Default redaction patterns — applied unless the spec passes its
 * own `redactInReceipt` array. Vendor-shaped credential patterns only:
 * a previous generic `[A-Z]{2,3}_[A-Z0-9]{6,}` catch-all mangled
 * legitimate prose (DB_PASSWORD, US-MIDA-PJM-style codes, ISO_8601)
 * while missing every real vendor key shape below.
 */
export const DEFAULT_REDACTION_PATTERNS: ReadonlyArray<RegExp> = [
  /sk-(?:ant-)?[A-Za-z0-9_\-]{20,}/g,               // Anthropic / OpenAI legacy
  /sk-proj-[A-Za-z0-9_\-]{20,}/g,                   // OpenAI project keys
  /\bBearer\s+[A-Za-z0-9_\-.]{20,}/gi,              // OAuth bearer tokens
  /\bAKIA[0-9A-Z]{16}\b/g,                          // AWS access key id
  /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{36}\b/g,   // GitHub tokens
  /\bgithub_pat_[A-Za-z0-9_]{22,}\b/g,              // GitHub fine-grained PAT
  /\bAIza[0-9A-Za-z_\-]{35}\b/g,                    // Google API key
  /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g,              // Slack tokens
  /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, // JWT
];

/**
 * Apply the spec's redaction patterns (or the default set) to the
 * prompt before storing it on the receipt. Original prompt is left
 * untouched on the live dispatch.
 */
export function redactPrompt(prompt: string, patterns: string[] | undefined): string {
  let out = prompt;
  const apply = (p: RegExp) => {
    out = out.replace(p, "[REDACTED]");
  };
  if (patterns === undefined) {
    for (const p of DEFAULT_REDACTION_PATTERNS) apply(p);
  } else if (patterns.length > 0) {
    for (const raw of patterns) {
      try {
        apply(new RegExp(raw, "g"));
      } catch {
        // ignore malformed user regexes
      }
    }
  }
  return out;
}

/**
 * Redact secrets out of a persisted provider-call body. Applied when a
 * task reaches "completed" or "cancelled" — the live dispatch always
 * uses the original body, and only the final ledger write is rewritten.
 *
 * Deliberately NOT applied on "failed": `retryTask` re-dispatches the
 * persisted body, so a failed task must retain the caller's original
 * prompt until it either succeeds (redacted then) or is cancelled.
 */
export function redactBodyJson(bodyJson: string | undefined): string | undefined {
  if (!bodyJson) return bodyJson;
  try {
    const spec = JSON.parse(bodyJson) as Partial<ProviderCallSpec>;
    if (!spec || spec.type !== "provider_call") return bodyJson;
    if (typeof spec.prompt === "string") {
      spec.prompt = redactPrompt(spec.prompt, spec.redactInReceipt);
    }
    if (typeof spec.systemPrompt === "string") {
      spec.systemPrompt = redactPrompt(spec.systemPrompt, spec.redactInReceipt);
    }
    // Prior conversation turns (v0.17) carry the same kind of secrets as
    // the prompt, so they follow the same rule.
    if (Array.isArray(spec.messages)) {
      spec.messages = spec.messages.map((m) =>
        m && typeof m === "object" && typeof m.content === "string"
          ? { ...m, content: redactPrompt(m.content, spec.redactInReceipt) }
          : m,
      );
    }
    return JSON.stringify(spec);
  } catch {
    // Corrupt body — leave it untouched rather than destroy evidence.
    return bodyJson;
  }
}

/** Shortest secret value {@link scrubValues} replaces; shorter ones would mangle ordinary text. */
export const SCRUB_MIN_LENGTH = 4;

/**
 * Replace every exact occurrence of each value with `[redacted]` (job
 * secrets, KTD12). Longest value first, so a value that contains another is
 * replaced whole. Values shorter than {@link SCRUB_MIN_LENGTH} are left
 * alone. Literal matching only: no regex is built from a value. Transformed
 * forms (base64, URL-encoding) are not caught.
 */
export function scrubValues(text: string, values: readonly string[]): string {
  const sorted = [...new Set(values)].filter((v) => v.length >= SCRUB_MIN_LENGTH).sort((a, b) => b.length - a.length);
  let out = text;
  for (const v of sorted) out = out.split(v).join("[redacted]");
  return out;
}

/**
 * Scrub the edges of a text that was cut by bytes (an output cap, a tail
 * window). A cut can leave the head of a secret value at the end of the
 * text, or its tail at the start, which {@link scrubValues} cannot match.
 * At each cut edge the longest such fragment, of any length, becomes
 * `[redacted]`; the U+FFFD left by a cut inside a UTF-8 sequence goes with
 * it. Call it after `scrubValues`, and only for an edge that was cut.
 */
export function scrubCutEdges(text: string, values: readonly string[], cut: { start?: boolean; end?: boolean }): string {
  const vals = [...new Set(values)].filter((v) => v.length >= SCRUB_MIN_LENGTH);
  let out = text;
  if (cut.end) {
    // A loop, not a `+$` regex: that is quadratic on a long run of U+FFFD.
    let end = out.length;
    while (end > 0 && out.charCodeAt(end - 1) === 0xfffd) end--;
    const body = out.slice(0, end);
    let longest = 0;
    for (const v of vals) {
      for (let n = Math.min(v.length - 1, body.length); n > longest; n--) {
        if (body.endsWith(v.slice(0, n))) {
          longest = n;
          break;
        }
      }
    }
    if (longest > 0) out = `${body.slice(0, body.length - longest)}[redacted]`;
  }
  if (cut.start) {
    let start = 0;
    while (start < out.length && out.charCodeAt(start) === 0xfffd) start++;
    const body = out.slice(start);
    let longest = 0;
    for (const v of vals) {
      for (let n = Math.min(v.length - 1, body.length); n > longest; n--) {
        if (body.startsWith(v.slice(v.length - n))) {
          longest = n;
          break;
        }
      }
    }
    if (longest > 0) out = `[redacted]${body.slice(longest)}`;
  }
  return out;
}
