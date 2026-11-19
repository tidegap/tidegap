/**
 * The status of a job notice and the shape of its summary. The status
 * emoji comes from one fixed map, never from model output: a summary's
 * status is a word from a closed set, and pictographs a model writes at the
 * start of a line are removed. `structureSummary` takes whatever the model
 * returned (a paragraph, markdown, a numbered list, the requested shape) and
 * gives one shape: a verdict and at most four short lines. Pure: the
 * run-level helpers (`runSummary`, `noticeStatus`) live in `format.ts`.
 */

/** The status a job notice shows: judged fine, judged to need a look, completed without a judgment, failed, or ended. */
export type NoticeStatus = "ok" | "attention" | "done" | "failed" | "ended";

/** The emoji line 1 of a job notice starts with, per status. */
export const NOTICE_EMOJI: Readonly<Record<NoticeStatus, string>> = {
  ok: "✅",
  attention: "⚠️",
  done: "☑️",
  failed: "❌",
  ended: "🏁",
};

/** Most characters (code points) of a summary's verdict. */
export const NOTICE_VERDICT_CHARS = 120;

/** Most lines below the verdict. */
export const NOTICE_BULLETS_MAX = 4;

/** Most characters (code points) of one line below the verdict. */
export const NOTICE_BULLET_CHARS = 200;

/** A summary in the notice shape. `status` only when the reply led with a status word. */
export interface StructuredSummary {
  status?: "ok" | "attention";
  /** "" when the reply had no usable text: the notice then shows the raw output. */
  verdict: string;
  bullets: string[];
}

/** `text` cut to `maxChars - 1` code points plus "…" when longer, so it never exceeds `maxChars` (KTD6). */
export function cutPreview(text: string, maxChars: number): string {
  const chars = Array.from(text);
  return chars.length > maxChars ? `${chars.slice(0, maxChars - 1).join("")}…` : text;
}

/** Most characters (code points) of a reply `structureSummary` reads, and of one line of it: the caps need far less, and the regexes stay linear in practice. */
const SUMMARY_INPUT_CHARS = 8000;
const SUMMARY_LINE_CHARS = 2000;

/** Bidirectional controls: they can reorder the rest of a line on screen. */
const BIDI_CONTROLS = /[\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069]/g;
/** Whitespace that is a control character: a space, so words stay apart. */
const CONTROL_SPACE = /[\t\v\f\r\u0085]/g;
/** Control and format characters, and the blank fillers (Hangul, braille) that look like nothing. */
const INVISIBLE = /[\p{Cc}\p{Cf}\u115F\u1160\u2800\u3164\uFFA0]/gu;
const LEADING_PICTOGRAPHS = /^(?:[\p{Extended_Pictographic}\p{Emoji_Modifier}\p{Regional_Indicator}⃣︎️]|\s)+/u;
const FENCE = /^\s*(```|~~~)/;
const RULE = /^\s*([-*_]\s*){3,}$/;
const TABLE_RULE = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/;
const HEADING = /^\s*#{1,6}(\s+|$)/;
const LIST_MARK = /^\s*(?:[-*•–]|\d{1,3}[.)])(?:\s+|$)/;
// A hyphen or a period after the word needs a space after it: `OK-ish` and `Attention-grabbing` are words, not a status.
const STATUS_WORD = /^\[?(ok|attention)\]?(?:\s*[:—–]|\s*[-.](?=\s|$)|\s*$)\s*/i;
const SENTENCE_END = /(?<=[.!?…])\s+|(?<=[。！？])/;

/** `text` without bidirectional controls, for a line shown beside the status emoji. */
export function stripBidiControls(text: string): string {
  return text.replace(BIDI_CONTROLS, "");
}

/** The first `max` code points of `text`, without an ellipsis. */
function headChars(text: string, max: number): string {
  return text.length <= max ? text : Array.from(text.slice(0, max * 2)).slice(0, max).join("");
}

/** One line without control and format characters, markdown emphasis, quote marks or leading pictographs; links as `text (url)`. */
function cleanLine(line: string): string {
  return line
    .replace(CONTROL_SPACE, " ")
    .replace(INVISIBLE, "")
    .replace(/\*\*|__|`/g, "")
    .replace(/^\s*(>\s*)+/, "")
    .replace(/\[([^\]\n]+)\]\(([^)\s]+)\)/g, "$1 ($2)")
    .replace(LEADING_PICTOGRAPHS, "")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * A summary in the notice shape. Never fails and never trusts the shape:
 * the first line with text is the verdict, a leading `OK` or `ATTENTION`
 * is its status word, later marked lines are bullets (an unmarked line
 * joins the bullet before it), and a paragraph without marks gives one
 * bullet per sentence. The verdict is cut at {@link NOTICE_VERDICT_CHARS}
 * and the rest of its line becomes the first bullet; bullets are cut at
 * {@link NOTICE_BULLET_CHARS}, and past {@link NOTICE_BULLETS_MAX} the last
 * line kept is `…`.
 */
export function structureSummary(text: string): StructuredSummary {
  let status: StructuredSummary["status"];
  let verdictLine: string | undefined;
  let statusSeen = false;
  const parts: { text: string; marked: boolean }[] = [];
  let open: { text: string; marked: boolean } | undefined;
  for (const full of headChars(text, SUMMARY_INPUT_CHARS).split(/\r?\n/)) {
    const raw = headChars(full, SUMMARY_LINE_CHARS);
    if (FENCE.test(raw) || TABLE_RULE.test(raw) || RULE.test(raw)) continue;
    const heading = HEADING.test(raw);
    if (heading && verdictLine !== undefined) continue;
    let line = cleanLine(raw.replace(HEADING, ""));
    if (!line) {
      open = undefined;
      continue;
    }
    const marked = LIST_MARK.test(line);
    if (marked) line = cleanLine(line.replace(LIST_MARK, ""));
    if (!line) continue;
    if (verdictLine === undefined) {
      const word = statusSeen ? null : STATUS_WORD.exec(line);
      if (word) {
        statusSeen = true;
        status = word[1]!.toLowerCase() as "ok" | "attention";
        line = cleanLine(line.slice(word[0].length));
        if (!line) continue;
      }
      verdictLine = line;
      continue;
    }
    if (marked || !open) {
      open = { text: line, marked };
      parts.push(open);
    } else {
      open.text = `${open.text} ${line}`;
    }
  }
  if (verdictLine === undefined) return { verdict: "", bullets: [] };
  const verdictChars = Array.from(verdictLine);
  const verdict = cutPreview(verdictLine, NOTICE_VERDICT_CHARS);
  const lines: string[] = [];
  if (verdictChars.length > NOTICE_VERDICT_CHARS) lines.push(verdictChars.slice(NOTICE_VERDICT_CHARS - 1).join("").trim());
  for (const part of parts) {
    if (lines.length > NOTICE_BULLETS_MAX) break;
    if (part.marked) lines.push(part.text);
    else for (const sentence of part.text.split(SENTENCE_END)) if (sentence.trim()) lines.push(sentence.trim());
  }
  const bullets = lines.map((l) => cutPreview(l, NOTICE_BULLET_CHARS));
  if (bullets.length > NOTICE_BULLETS_MAX) bullets.splice(NOTICE_BULLETS_MAX - 1, Infinity, "…");
  return { ...(status ? { status } : {}), verdict, bullets };
}
