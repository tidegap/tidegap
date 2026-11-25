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

/** Grapheme clusters, where the runtime has `Intl.Segmenter`; cuts fall back to code points where it has not. */
const GRAPHEMES = typeof Intl.Segmenter === "function" ? new Intl.Segmenter(undefined, { granularity: "grapheme" }) : undefined;

function codePoints(text: string): number {
  let n = 0;
  for (const _ of text) n++;
  return n;
}

/**
 * The longest head of `text` that is at most `max` long and ends between two
 * grapheme clusters, so an emoji with a ZWJ or a skin tone, a flag or a
 * letter with its accent is kept whole or cut whole. `max` counts code
 * points, or UTF-16 units with `utf16` (the length the chat APIs limit).
 * Without `Intl.Segmenter`, and for one cluster longer than `max`, the head
 * ends between code points. Never leaves half of a surrogate pair.
 */
export function headWithin(text: string, max: number, utf16 = false): string {
  if (text.length <= max) return text;
  // Only a window that measures more than `max` is segmented. Its clusters are those of the whole text except the last,
  // which may go on past the window and so never fits unless the window is the whole text. The window ends on a whole
  // code point: half of a surrogate pair would read as a cluster boundary that is not one.
  let end = utf16 ? max + 1 : 2 * max + 2;
  const last = text.charCodeAt(end - 1);
  if (last >= 0xd800 && last <= 0xdbff) end++;
  const window = text.slice(0, end);
  const fit = (pieces: Iterable<string>): number => {
    let kept = 0;
    let size = 0;
    for (const piece of pieces) {
      size += utf16 ? piece.length : codePoints(piece);
      if (size > max) break;
      kept += piece.length;
    }
    return kept;
  };
  const clusters = GRAPHEMES ? Array.from(GRAPHEMES.segment(window), (s) => s.segment) : window;
  return text.slice(0, fit(clusters) || fit(window));
}

/** `text` cut to `maxChars - 1` code points plus "…" when longer, so it never exceeds `maxChars` (KTD6); the cut falls between grapheme clusters ({@link headWithin}). */
export function cutPreview(text: string, maxChars: number): string {
  return headWithin(text, maxChars).length === text.length ? text : `${headWithin(text, maxChars - 1)}…`;
}

/** Most characters (code points) of a reply `structureSummary` reads, and of one line of it: the caps need far less, and the regexes stay linear in practice. */
const SUMMARY_INPUT_CHARS = 8000;
const SUMMARY_LINE_CHARS = 2000;

/** Bidirectional controls: they can reorder the rest of a line on screen. */
const BIDI_CONTROLS = /[\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069]/g;
/** Whitespace that is a control character: a space, so words stay apart. */
const CONTROL_SPACE = /[\t\v\f\r\u0085]/g;
/** Control and format characters, and the blank fillers (Hangul, braille) that look like nothing; ZWNJ and ZWJ go by {@link JOINERS}. */
const INVISIBLE = /(?![\u200C\u200D])[\p{Cc}\p{Cf}\u115F\u1160\u2800\u3164\uFFA0]/gu;
/** ZWNJ and ZWJ: Persian and Indic words and emoji sequences need one between two characters, nowhere else. */
const JOINERS = /[\u200C\u200D]+/g;
/** Leading pictographs, but not the list marks ✔ and ▪ (pictographs too) before a space. */
const LEADING_PICTOGRAPHS = /^(?:(?![✔▪]\uFE0F?(?:\s|$))[\p{Extended_Pictographic}\p{Emoji_Modifier}\p{Regional_Indicator}⃣︎️\u200C\u200D]|\s)+/u;
const FENCE = /^\s*(```|~~~)/;
const RULE = /^\s*([-*_]\s*){3,}$/;
const TABLE_RULE = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/;
const HEADING = /^\s*#{1,6}(\s+|$)/;
/** A list mark at a line start: a dash, a bullet glyph (an emoji form too) or a number with `.` or `)`. */
const LIST_MARK = /^\s*(?:[-*+•–●■▪◦‣✓✔]\uFE0F?|\d{1,3}[.)])(?:\s+|$)/u;
// A hyphen or a period after the word needs a space after it: `OK-ish` and `Attention-grabbing` are words, not a status.
const STATUS_WORD = /^\[?(ok|attention)\]?(?:\s*[:—–]|\s*[-.](?=\s|$)|\s*$)\s*/i;
/** Before an abbreviation: the line start or a character that is no letter or digit. */
const WORD_EDGE = String.raw`(?:^|[^\p{L}\p{N}])`;
/**
 * A space after `.`, `!`, `?` or `…` ends a sentence; `。！？` end one with no space. A decimal or a version has no
 * space after its period. An abbreviation ends no sentence: never `e.g.`, `i.e.`, `vs.`, `Dr.`, `т.е.` and `напр.`
 * (`т. е.` and `т. д.` with a space too), `No.` before a number, and `etc.` and `т.д.` before a word with no capital.
 */
const SENTENCE_END = new RegExp(
  [
    String.raw`(?<=[.!?…])`,
    String.raw`(?<!${WORD_EDGE}(?:[Ee]\.g|[Ii]\.e|[Vv]s|Dr|[Тт]\.\s?е|[Нн]апр)\.)(?!(?<=${WORD_EDGE}[Тт]\.)\s+[ед]\.)`,
    String.raw`(?!(?<=${WORD_EDGE}No\.)\s+\p{N})(?!(?<=${WORD_EDGE}(?:[Ee]tc|[Тт]\.\s?д)\.)\s+(?![\s\p{Lu}]))`,
    String.raw`\s+|(?<=[。！？])`,
  ].join(""),
  "u",
);

/** `text` without bidirectional controls, for a line shown beside the status emoji. */
export function stripBidiControls(text: string): string {
  return text.replace(BIDI_CONTROLS, "");
}

/** The first `max` code points of `text`, without an ellipsis. */
function headChars(text: string, max: number): string {
  return text.length <= max ? text : Array.from(text.slice(0, max * 2)).slice(0, max).join("");
}

/** One line without control and format characters (one ZWNJ or ZWJ inside a word stays), markdown emphasis, quote marks or leading pictographs; links as `text (url)`. */
function cleanLine(line: string): string {
  return line
    .replace(CONTROL_SPACE, " ")
    .replace(INVISIBLE, "")
    .replace(/\*\*|__|`/g, "")
    .replace(/^\s*(>\s*)+/, "")
    .replace(/\[([^\]\n]+)\]\(([^)\s]+)\)/g, "$1 ($2)")
    .replace(LEADING_PICTOGRAPHS, "")
    .replace(JOINERS, (run: string, at: number, whole: string) => (/\S/.test(whole[at - 1] ?? " ") && /\S/.test(whole[at + run.length] ?? " ") ? run[0]! : ""))
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
  const verdict = cutPreview(verdictLine, NOTICE_VERDICT_CHARS);
  const lines: string[] = [];
  // The rest starts where the cut verdict ends (before its "…"), so a cluster at the cut goes whole into the first bullet.
  if (verdict !== verdictLine) lines.push(verdictLine.slice(verdict.length - 1).trim());
  for (const part of parts) {
    if (lines.length > NOTICE_BULLETS_MAX) break;
    if (part.marked) lines.push(part.text);
    else for (const sentence of part.text.split(SENTENCE_END)) if (sentence.trim()) lines.push(sentence.trim());
  }
  const bullets = lines.map((l) => cutPreview(l, NOTICE_BULLET_CHARS));
  if (bullets.length > NOTICE_BULLETS_MAX) bullets.splice(NOTICE_BULLETS_MAX - 1, Infinity, "…");
  return { ...(status ? { status } : {}), verdict, bullets };
}
