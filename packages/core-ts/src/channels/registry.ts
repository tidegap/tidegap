/**
 * Channel kind descriptors (KTD1): each registry kind as data (fields,
 * where-to-get-it steps, default events, docs anchor) plus a pure
 * `format(payload, values) → DeliverySpec`. The host page renders a card
 * from a descriptor without `format`; the host driver performs the spec.
 */

import type { NotificationPayload } from "./payload.js";
import type { EventKind, RegistryKind } from "./types.js";

/** How a card renders a field. */
export type FieldInput = "text" | "password" | "url" | "select" | "number" | "textarea";

export interface FieldOption {
  value: string;
  label: string;
}

/** One input of a kind. */
export interface KindField {
  name: string;
  label: string;
  input: FieldInput;
  required?: boolean;
  /** Stored in the host's secrets file, never in the ledger or an API answer. */
  secret?: boolean;
  default?: string | number;
  placeholder?: string;
  /** Regular expression source the whole value must match. */
  pattern?: string;
  /** `select` only: the allowed values. */
  options?: readonly FieldOption[];
  help?: string;
  /** Shown under a collapsed disclosure on the card. */
  advanced?: boolean;
  /** `number` only: inclusive range. */
  min?: number;
  max?: number;
  /** Overrides the default length cap of the input type. */
  maxLength?: number;
  /** `textarea` only: most non-empty lines. */
  maxLines?: number;
  /** The sentence shown when the value fails `pattern` or its type check (default: a generic one). */
  invalid?: string;
  /**
   * Secret fields only: the field this secret belongs to (the ntfy token to
   * its server, a webhook's signing secret to its URL). An empty input reuses
   * the stored secret only while that field's origin is unchanged, so a
   * secret never follows a new address the user typed.
   */
  keepWith?: string;
}

/** A named set of field values (email providers). */
export interface KindPreset {
  id: string;
  label: string;
  values: Readonly<Record<string, string | number>>;
  note?: string;
}

/** One "where to get this" step: text plus an optional provider link. */
export interface KindStep {
  text: string;
  link?: string;
}

/** What a host driver sends. */
export type DeliverySpec =
  | {
      type: "http";
      method: "POST";
      url: string;
      headers: Record<string, string>;
      body: string;
      /** Sign the body with HMAC-SHA256 (webhook, KTD13); the driver adds the timestamp and signature headers. */
      sign?: { secret: string };
    }
  | { type: "smtp"; subject: string; text: string }
  | { type: "shortcut"; input: string };

/** Field values after validation: non-secret and secret together, as `format` reads them. */
export type FieldValues = Readonly<Record<string, string | number>>;

export interface KindDescriptor {
  kind: RegistryKind;
  label: string;
  /** One line under the card title. */
  description: string;
  /** `process.platform` values the kind works on; absent = every platform. */
  platforms?: readonly string[];
  /** False while the kind's stream has not landed: the page and CLI hide it. */
  ready: boolean;
  fields: readonly KindField[];
  presets?: readonly KindPreset[];
  /** At most four. */
  steps: readonly KindStep[];
  defaultEvents: readonly EventKind[];
  /** `notify-<kind>`, the anchor of the kind's docs section. */
  docsAnchor: string;
  /** Services the kind also covers (the webhook's Teams, Google Chat…). */
  worksWith?: string;
  /** Absent for Telegram, which sends through `TelegramClient` (KTD3), and for kinds not ready yet. */
  format?: (payload: NotificationPayload, values: FieldValues) => DeliverySpec;
  /**
   * The card's one-line target ("#alerts", "you@example.com"). It must hold
   * no secret value; `hints` are the secret fields' masked hints. Absent: the
   * host derives one from the first URL hint or the first non-secret value.
   */
  target?: (values: FieldValues, hints: Readonly<Record<string, string>>) => string;
  /**
   * Kind-specific sentences for delivery codes (`http_404`, `auth`…), each one
   * sentence with the fix, and the field it is about. Absent codes take the
   * host's generic sentence.
   */
  errors?: Readonly<Record<string, KindErrorText>>;
  /**
   * Checks across or inside fields that a pattern cannot express (the
   * webhook's header lines). Runs after {@link validateFields} on the merged
   * values; the answer names the field and one sentence with the fix.
   */
  validate?: (values: FieldValues) => KindErrorText & { field: string } | undefined;
}

/** A kind's sentence for one delivery code. */
export interface KindErrorText {
  text: string;
  field?: string;
}

/** A descriptor as the page receives it: data only, no functions and no host error texts. */
export type KindDescriptorData = Omit<KindDescriptor, "format" | "target" | "errors" | "validate">;

export function descriptorData(descriptor: KindDescriptor): KindDescriptorData {
  const { format: _format, target: _target, errors: _errors, validate: _validate, ...data } = descriptor;
  return data;
}

export type FieldErrorCode = "required" | "invalid" | "too_long";

export type FieldValidation =
  | { ok: true; values: Record<string, string | number>; secrets: Record<string, string> }
  | { ok: false; field: string; code: FieldErrorCode };

/** Default length caps per input type. */
const MAX_LENGTH: Record<FieldInput, number> = { url: 2048, text: 256, password: 256, select: 256, number: 32, textarea: 4096 };

/** Lines of a textarea field when it sets no `maxLines`. */
const DEFAULT_MAX_LINES = 10;

/** C0, DEL, C1 and the Unicode line and paragraph separators: none may reach a header, subject or log line. */
const CONTROL = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/;
const CONTROL_BUT_NEWLINE = /[\u0000-\u0009\u000b-\u001f\u007f-\u009f\u2028\u2029]/;

/** Plain decimal numbers only: no hex, binary or exponent forms. */
const DECIMAL = /^-?\d+(?:\.\d+)?$/;

/** A string or number input as trimmed text (CRLF → LF in a textarea); anything else unchanged. */
function normalize(field: KindField, raw: unknown): unknown {
  if (typeof raw === "number") return String(raw);
  if (typeof raw !== "string") return raw;
  return (field.input === "textarea" ? raw.replace(/\r\n/g, "\n") : raw).trim();
}

function checkField(field: KindField, raw: unknown): { value?: string | number; code?: FieldErrorCode } {
  const given = normalize(field, raw);
  if (given === undefined || given === null || given === "") {
    if (field.default !== undefined) return { value: field.default };
    return field.required ? { code: "required" } : {};
  }
  if (typeof given !== "string") return { code: "invalid" };
  if (given.length > (field.maxLength ?? MAX_LENGTH[field.input])) return { code: "too_long" };
  if ((field.input === "textarea" ? CONTROL_BUT_NEWLINE : CONTROL).test(given)) return { code: "invalid" };
  if (field.pattern && !new RegExp(`^(?:${field.pattern})$`).test(given)) return { code: "invalid" };
  switch (field.input) {
    case "select":
      return field.options?.some((o) => o.value === given) ? { value: given } : { code: "invalid" };
    case "number": {
      const n = DECIMAL.test(given) ? Number(given) : NaN;
      if (!Number.isFinite(n) || (field.min !== undefined && n < field.min) || (field.max !== undefined && n > field.max)) return { code: "invalid" };
      return { value: n };
    }
    case "url":
      return URL.canParse(given) ? { value: given } : { code: "invalid" };
    case "textarea":
      return given.split("\n").filter((l) => l.trim()).length > (field.maxLines ?? DEFAULT_MAX_LINES) ? { code: "too_long" } : { value: given };
    default:
      return { value: given };
  }
}

/**
 * Check `input` against a descriptor's fields, in field order; the first
 * failing field is the answer. Unknown keys are ignored, an empty value
 * takes the field's default, and secret fields come back in `secrets` only.
 */
export function validateFields(descriptor: KindDescriptor, input: Readonly<Record<string, unknown>>): FieldValidation {
  const values: Record<string, string | number> = {};
  const secrets: Record<string, string> = {};
  for (const field of descriptor.fields) {
    const { value, code } = checkField(field, Object.hasOwn(input, field.name) ? input[field.name] : undefined);
    if (code) return { ok: false, field: field.name, code };
    if (value === undefined) continue;
    if (field.secret) secrets[field.name] = String(value);
    else values[field.name] = value;
  }
  return { ok: true, values, secrets };
}
