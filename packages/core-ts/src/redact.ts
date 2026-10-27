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
 * The token prefixes {@link DEFAULT_REDACTION_PATTERNS} match, each with the
 * characters its key body is made of (KTD13). {@link scrubCutEdges} drops a
 * token that starts with one of them at a cut end: the cut key is too short
 * for its full pattern. `prefix` is a regex source (`Bearer` takes any
 * whitespace after it). `boundary` is true where the pattern starts at a word
 * boundary; `sk-` has none, so it is found inside a word too. A new pattern
 * adds its prefix here.
 */
export const VENDOR_KEY_PREFIXES: ReadonlyArray<{ prefix: string; body: string; boundary: boolean; ignoreCase?: boolean }> = [
  { prefix: "sk-", body: "A-Za-z0-9_\\-", boundary: false },
  { prefix: "Bearer\\s+", body: "A-Za-z0-9_\\-.", boundary: true, ignoreCase: true },
  { prefix: "AKIA", body: "0-9A-Z", boundary: true },
  { prefix: "gh[pousr]_", body: "A-Za-z0-9", boundary: true },
  { prefix: "github_pat_", body: "A-Za-z0-9_", boundary: true },
  { prefix: "AIza", body: "0-9A-Za-z_\\-", boundary: true },
  { prefix: "xox", body: "A-Za-z0-9-", boundary: true },
  { prefix: "eyJ", body: "A-Za-z0-9_\\-.", boundary: true },
];

/** One regex per prefix: the prefix and at least one body character, up to the end of the text. */
const TRAILING_KEY: ReadonlyArray<RegExp> = VENDOR_KEY_PREFIXES.map(
  ({ prefix, body, boundary, ignoreCase }) =>
    new RegExp(`${boundary ? "(?<![A-Za-z0-9_])" : ""}${prefix}[${body}]+$`, ignoreCase ? "i" : ""),
);

/** The end of a cut text the trailing-key search reads; no key shape is longer. */
const TRAILING_WINDOW = 8 * 1024;

/** A leading token this long at a cut start may be the tail of a key; it is dropped. */
const LEADING_TOKEN = /^[A-Za-z0-9_\-.]{16,}/;

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
 * it. Vendor key shapes are cut too, which the redaction patterns cannot
 * match (KTD13): at a cut end, a trailing token that starts with a prefix of
 * {@link VENDOR_KEY_PREFIXES}; at a cut start, a leading token of 16 or
 * more token characters, or the value fragment when that is longer. Part of an ordinary word at
 * a cut may go with them. Call it after `scrubValues`, and only for an edge
 * that was cut.
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
    // A window keeps the search linear on a long run of prefixes ("sk-sk-...").
    const tail = body.slice(-TRAILING_WINDOW);
    for (const re of TRAILING_KEY) {
      const m = re.exec(tail);
      if (m) longest = Math.max(longest, m[0].length);
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
    // A long leading token may be a key's tail, whatever value fragment it starts with.
    longest = Math.max(longest, LEADING_TOKEN.exec(body)?.[0].length ?? 0);
    if (longest > 0) out = `[redacted]${body.slice(longest)}`;
  }
  return out;
}
