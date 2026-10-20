/** Helpers the chat kinds share: the loopback URL the test sinks use, escaping of untrusted text (KTD2). */

/**
 * Pattern source of a loopback http(s) URL. Kinds with a fixed official host
 * (Slack, Discord) also accept it, so the fake sinks of the tests and the QA
 * harness can stand in for the provider (KTD8).
 */
export const LOOPBACK_URL = String.raw`https?://(?:127\.0\.0\.1|localhost|\[::1\])(?::\d{1,5})?/\S*`;

/** `&`, `<` and `>` as entities: Slack mrkdwn and the plain `{"text"}` receivers read `<…>` as links and mentions. */
export function escapeAngle(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** A zero-width space after `@` in the group mentions of Slack, Discord, Teams, Mattermost and Matrix, so none of them pings. */
export function defuseMentions(text: string): string {
  return text.replace(/@(channel|all|here|everyone|room)\b/gi, "@​$1");
}

/** A backslash before every character in `specials`. */
export function escapeChars(text: string, specials: string): string {
  return text.replace(new RegExp(`[${specials.replace(/[\\\]^-]/g, "\\$&")}]`, "g"), "\\$&");
}

/** At most `max` characters, the last one an ellipsis when cut; never ends in half an escape (`\`). */
export function clipEscaped(text: string, max: number): string {
  if (text.length <= max) return text;
  let cut = text.slice(0, max - 1);
  // An odd run of trailing backslashes would escape the ellipsis.
  const run = /\\+$/.exec(cut)?.[0].length ?? 0;
  if (run % 2 === 1) cut = cut.slice(0, -1);
  return `${cut}…`;
}

/** Hex color per level for embeds and cards. */
export const LEVEL_COLOR = { success: 0x2e7d32, error: 0xc62828, warning: 0xf9a825, info: 0x1565c0 } as const;
