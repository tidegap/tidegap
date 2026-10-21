/**
 * Every delivery code a host driver can report, besides the open families
 * `http_<status>` and `smtp_<reply>`. The CLI's `DeliveryError` accepts only
 * these, so a new code fails the type check until it is listed here; the
 * docs-drift check (K13) reads this list for the codes the docs may quote.
 */
export const DELIVERY_CODES = [
  // HTTP transport
  "auth",
  "rate_limited",
  "redirect",
  "timeout",
  "network",
  "tls",
  // URL policy
  "invalid_url",
  "scheme",
  "userinfo",
  "blocked_address",
  "ui_port",
  // host checks before a send
  "not_configured",
  "not_ready",
  "invalid_config",
  "invalid_spec",
  "error",
  // SMTP
  "auth_required",
  "auth_unsupported",
  "cleartext",
  "smtp_policy",
  "smtp_protocol",
  "smtp_recipient",
  "smtp_sender",
  "starttls_unsupported",
  // Command and Shortcuts
  "command_failed",
  "no_shortcuts",
  "not_executable",
  "not_found",
  "shortcut_failed",
  "unsafe_path",
  // kind drivers that read the answer body
  "ntfy_token_needed",
  "pushover_token",
  "pushover_user",
  "slack_action_prohibited",
  "slack_channel_archived",
  "slack_channel_not_found",
  "slack_payload",
  "slack_webhook_gone",
] as const;

export type DeliveryCode = (typeof DELIVERY_CODES)[number] | `http_${number}` | `smtp_${number}`;
