---
title: "Shaping a model's reply into a notice: cap by code points first, match the status word strictly, treat control whitespace as a space, and refuse language codes by rule rather than by ICU"
date: 2026-11-22
last_updated: 2026-11-24
category: logic-errors
module: packages/core-ts/src/channels/notice.ts (structureSummary, cleanLine, stripBidiControls, headWithin, cutPreview), packages/core-ts/src/channels/format.ts (firstVisibleLine, cleanJobTitle, splitMessage), packages/core-ts/src/channels/kinds/shared.ts (clipEscaped), packages/core-ts/src/channels/kinds/ntfy.ts (clipBytes), packages/cli/src/channels/emit.ts (capPayload), packages/core-ts/src/notice-language.ts (parseNoticeLanguage)
problem_type: logic_error
component: tooling
symptoms:
  - "A reply that starts `OK-ish result` lost its first word as a status"
  - "A tab, CR or U+0085 in a reply glued two words together (`visits\\t18911` became one word)"
  - "A reply of very many sentences could overflow the stack while it was split into bullets"
  - "`tidegap language set en-u-ca-buddhist` threw a RangeError instead of the refusal sentence"
  - "A cap cut an emoji with a ZWJ or a skin tone, a flag or an accented letter in half, and a cut verdict left the first bullet starting inside that cluster (#278 review, P3)"
  - "The invisible-character strip removed every ZWNJ and ZWJ, which breaks Persian and Indic words and emoji sequences (#278 review, P3)"
root_cause: missing_validation
resolution_type: code_fix
severity: medium
tags: [notices, summarize, structure-summary, code-points, bidi, control-characters, bcp-47, intl, icu, redos, grapheme, intl-segmenter, utf-16, zwj, zwnj, provider-limits]
---

# Shaping a model's reply into a notice

## Problem

Since #278, `structureSummary` turns any summarize reply into a status word, a verdict and at most four bullets. The reply comes from a model and the command output it read, so its shape cannot be trusted. The review found inputs that broke the first version. `parseNoticeLanguage` had the same problem with user input.

## Symptoms

- `OK-ish result` and `Attention-grabbing drop` were read as a status word plus a verdict.
- Tab, CR, VT, FF and U+0085 are control characters, so the invisible-character strip removed them and joined the words on each side.
- A reply of 200,000 short sentences went through a per-sentence split with no bound (per the #278 review).
- `Intl.DisplayNames#of` throws a RangeError for some valid BCP 47 tags (extensions such as `-u-ca-buddhist`, long private-use parts). The set of tags that throw depends on the ICU build of the Node binary.

## What Didn't Work

- Relying on the output caps alone. The verdict (120) and bullet (200) caps apply after the regexes have run on the whole reply. CodeQL flagged `js/polynomial-redos` on the line regexes in #278.
- Calling ICU and catching the error. That made the accepted set depend on the Node build, so a code could pass on one machine and fail on another.

## Solution

All in `packages/core-ts/src/channels/notice.ts` unless named:

- **Cap the input before any regex, in code points.** `structureSummary` reads at most 8,000 code points of the reply and 2,000 of each line (`SUMMARY_INPUT_CHARS`, `SUMMARY_LINE_CHARS`, through `headChars`). Since #291 every cut falls between grapheme clusters, in the unit the target counts (next section).
- **A status word needs a real boundary.** `STATUS_WORD` takes `ok` or `attention`, optionally in brackets, followed by a colon, a dash or a period that is followed by a space, or by the end of the line. `OK-ish`, `OKAY` and `Okay,` are words, not a status.
- **Control whitespace becomes a space before invisible characters go.** `CONTROL_SPACE` (`\t \v \f \r U+0085`) is replaced by a space first, and then `INVISIBLE` (`\p{Cc}`, `\p{Cf}` and the blank filler characters) is removed. ZWNJ and ZWJ are the exception since #291 (`JOINERS`): one between two visible characters stays, because Persian and Indic words and emoji sequences need it. At a line edge, beside a space, and as the extra copies in a run, they go. Lines split on `\n` only, so a lone CR does not start a bullet.
- **Bidirectional controls go from every line shown beside the emoji.** `INVISIBLE` covers them inside the summary. Two paths do not use the summary: the raw first line when there is no summary (`firstVisibleLine` in `format.ts`) and the job title (`cleanJobTitle`). Both call `stripBidiControls`.
- **Stop splitting sentences when the bullets are full.** The loop over parts and sentences breaks once it has more lines than `NOTICE_BULLETS_MAX`. It never spreads all sentences into one call.
- **Refuse language codes by rule, then ask ICU only for the name** (`parseNoticeLanguage` in `packages/core-ts/src/notice-language.ts`). A code is refused when it is longer than 35 characters, has a singleton part (`-u-`, `-t-`, `-x-`; `SINGLETON`), or names no language (`und`, `mul`, `mis`, `zxx`). Then `Intl.getCanonicalLocales` and `DisplayNames` give the code and its English name. The `try` stays as a backstop. A stored value that fails is reported as ignored with its reason (`loadNoticeLanguage`), and it never throws.

## Cuts fall between grapheme clusters, in the target's unit (#291)

The first version cut by code points. That keeps a surrogate pair whole, but it cuts an emoji with a ZWJ or a skin tone, a flag or a letter with its accent in half. A grapheme cut alone is not enough either: each target counts its limit in its own unit.

- **One helper cuts every head.** `headWithin(text, max, utf16)` in `notice.ts` returns the longest head that ends between two grapheme clusters (`Intl.Segmenter`). `max` counts code points, or UTF-16 units with `utf16 = true`. Without `Intl.Segmenter`, or when one cluster is longer than `max`, it cuts between code points, and it never leaves half of a surrogate pair.
- **The unit comes from the target, not from the helper:**

| Target | Unit of the limit | Cut |
| --- | --- | --- |
| Telegram message (`splitMessage`, 4096) | UTF-16 units | `headWithin(…, true)`, a line break first |
| Slack and Discord text (`clipEscaped`) | UTF-16 units | `headWithin(…, true)`, never in half an escape |
| Registry payload title and text (`capPayload` in `packages/cli/src/channels/emit.ts`) | UTF-16 units | `headWithin(…, true)` |
| Pushover message and title (`cutPreview`) | code points | `headWithin` |
| Notice verdict and bullets (`cutPreview`), `clip` in `packages/core-ts/src/notify.ts` | code points | `headWithin` |
| ntfy body (`clipBytes` in `packages/core-ts/src/channels/kinds/ntfy.ts`) | UTF-8 bytes | between code points |

- **Decision:** the notice caps count code points. The chat limits count UTF-16 units, the larger count, so the text fits however the provider counts it.
- **A cut verdict hands its cluster to the first bullet.** `structureSummary` takes the rest of the verdict line from where the cut head ends (`verdict.length - 1`, before the "…"), so a cluster at the cut opens the first bullet whole. A rest taken from a code-point index can start the bullet inside a cluster, for example with a skin-tone modifier alone.
- **A cut must always make progress.** With one cluster longer than `max`, or a cap under 2, `splitMessage` cuts between code points and takes at least one code point per part. Without that fallback it loops forever.
- **The first `/result` message leaves room for its title** in UTF-16 units (100, or the title length plus 2 when that is more), so a title of many emoji keeps the message within 4096.
- **Open: the ntfy byte cut.** `clipBytes` counts UTF-8 bytes and cuts between code points, not between clusters, so an emoji sequence at the 4000-byte edge can lose its end. #291 did not change `clipBytes`. A fix would measure each grapheme cluster in bytes, as `headWithin` measures one in code points or UTF-16 units.

Rule: a new cap names its target's unit and calls `headWithin` with it. A unit that `headWithin` does not count (bytes) needs a cluster-aware loop of its own.

## Why This Works

The caps bound the work of every regex and split, whatever the reply holds. The strict status word and the space rule keep the reply's words as they were written. The language rules accept the same set on every Node build, because no accepted code depends on which tags ICU can name.

## Prevention

Tests (keep the adversarial cases when the rules change):

- `packages/core-ts/test/channels-notice.test.ts`: "status word of …" (`OK-ish`, `OKAY`, `Attention-grabbing`), "bidirectional and zero-width characters are removed" (tab, CR, bidi, blank fillers, flags), "caps count code points…", and "adversarial sizes stay fast and within the caps…" (200,000 spaces, 100,000 `[`, 200,000 sentences, under 2 s).
- `packages/core-ts/test/notice-language.test.ts`: "refuses %j" (`en-u-ca-buddhist`, a long private-use tag, eight variants, `und`, `zxx`, `mul`, `en_US`) and the ignored stored value.
- `packages/core-ts/test/channels-format.test.ts`: the acceptance texts as exact strings.
- Grapheme cuts (#291): `channels-notice.test.ts`, "caps cut between grapheme clusters: %s at the edge is kept whole or cut whole, and a cut one opens the first bullet whole" (ZWJ family, skin tone, flag, accent), "without Intl.Segmenter" (code points, no half surrogate pair) and "ZWNJ and ZWJ stay inside a word…"; `channels-format.test.ts`, "splitMessage cuts between grapheme clusters…", "/result keeps the first message within 4096 UTF-16 units under a title of 80 emoji" and "clipEscaped (Slack, Discord) cuts between grapheme clusters…"; `packages/cli/test/channels-emit.test.ts`, "a title over 256 characters is cut to 256 with an ellipsis, never inside an emoji…".

A new cleaning rule for model text goes into `cleanLine` with a case in the test above. A new input path that shows text beside the status emoji calls `stripBidiControls`.

## Related

- `../best-practices/derived-text-beside-the-raw-result.md` (the summary beside the raw output, verdict-first notices)
- `../best-practices/channels-url-policy-and-child-process-rules.md` ("Bound the cost of one line" for progress lines)
- `../best-practices/user-regex-in-a-bounded-vm.md` (a user's regex, bounded in time)
