---
title: "Shaping a model's reply into a notice: cap by code points first, match the status word strictly, treat control whitespace as a space, and refuse language codes by rule rather than by ICU"
date: 2026-11-22
category: logic-errors
module: packages/core-ts/src/channels/notice.ts (structureSummary, cleanLine, stripBidiControls), packages/core-ts/src/channels/format.ts (firstVisibleLine, cleanJobTitle), packages/core-ts/src/notice-language.ts (parseNoticeLanguage)
problem_type: logic_error
component: tooling
symptoms:
  - "A reply that starts `OK-ish result` lost its first word as a status"
  - "A tab, CR or U+0085 in a reply glued two words together (`visits\\t18911` became one word)"
  - "A reply of very many sentences could overflow the stack while it was split into bullets"
  - "`tidegap language set en-u-ca-buddhist` threw a RangeError instead of the refusal sentence"
root_cause: missing_validation
resolution_type: code_fix
severity: medium
tags: [notices, summarize, structure-summary, code-points, bidi, control-characters, bcp-47, intl, icu, redos]
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

- **Cap the input before any regex, in code points.** `structureSummary` reads at most 8,000 code points of the reply and 2,000 of each line (`SUMMARY_INPUT_CHARS`, `SUMMARY_LINE_CHARS`, through `headChars`). `cutPreview` cuts by code points, so an emoji at the edge is kept whole or cut whole, and no lone surrogate is left.
- **A status word needs a real boundary.** `STATUS_WORD` takes `ok` or `attention`, optionally in brackets, followed by a colon, a dash or a period that is followed by a space, or by the end of the line. `OK-ish`, `OKAY` and `Okay,` are words, not a status.
- **Control whitespace becomes a space before invisible characters go.** `CONTROL_SPACE` (`\t \v \f \r U+0085`) is replaced by a space first, and then `INVISIBLE` (`\p{Cc}`, `\p{Cf}` and the blank filler characters) is removed. Lines split on `\n` only, so a lone CR does not start a bullet.
- **Bidirectional controls go from every line shown beside the emoji.** `INVISIBLE` covers them inside the summary. Two paths do not use the summary: the raw first line when there is no summary (`firstVisibleLine` in `format.ts`) and the job title (`cleanJobTitle`). Both call `stripBidiControls`.
- **Stop splitting sentences when the bullets are full.** The loop over parts and sentences breaks once it has more lines than `NOTICE_BULLETS_MAX`. It never spreads all sentences into one call.
- **Refuse language codes by rule, then ask ICU only for the name** (`parseNoticeLanguage` in `packages/core-ts/src/notice-language.ts`). A code is refused when it is longer than 35 characters, has a singleton part (`-u-`, `-t-`, `-x-`; `SINGLETON`), or names no language (`und`, `mul`, `mis`, `zxx`). Then `Intl.getCanonicalLocales` and `DisplayNames` give the code and its English name. The `try` stays as a backstop. A stored value that fails is reported as ignored with its reason (`loadNoticeLanguage`), and it never throws.

## Why This Works

The caps bound the work of every regex and split, whatever the reply holds. The strict status word and the space rule keep the reply's words as they were written. The language rules accept the same set on every Node build, because no accepted code depends on which tags ICU can name.

## Prevention

Tests (keep the adversarial cases when the rules change):

- `packages/core-ts/test/channels-notice.test.ts`: "status word of …" (`OK-ish`, `OKAY`, `Attention-grabbing`), "bidirectional and zero-width characters are removed" (tab, CR, bidi, blank fillers, flags), "caps count code points…", and "adversarial sizes stay fast and within the caps…" (200,000 spaces, 100,000 `[`, 200,000 sentences, under 2 s).
- `packages/core-ts/test/notice-language.test.ts`: "refuses %j" (`en-u-ca-buddhist`, a long private-use tag, eight variants, `und`, `zxx`, `mul`, `en_US`) and the ignored stored value.
- `packages/core-ts/test/channels-format.test.ts`: the acceptance texts as exact strings.

A new cleaning rule for model text goes into `cleanLine` with a case in the test above. A new input path that shows text beside the status emoji calls `stripBidiControls`.

## Related

- `../best-practices/derived-text-beside-the-raw-result.md` (the summary beside the raw output, verdict-first notices)
- `../best-practices/channels-url-policy-and-child-process-rules.md` ("Bound the cost of one line" for progress lines)
- `../best-practices/user-regex-in-a-bounded-vm.md` (a user's regex, bounded in time)
