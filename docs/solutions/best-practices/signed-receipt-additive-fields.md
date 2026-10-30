---
title: "A new receipt field goes inside the signed payload, optional, with a shared vector for every shape it can take"
date: 2026-10-28
last_updated: 2026-10-30
category: best-practices
module: packages/core-ts/src/sign.ts, packages/core-py/src/tidegap/sign.py, packages/core-py/src/tidegap/types.py (CarbonReceipt), packages/core-ts/test/fixtures/cross-lang-receipt-vectors.json, packages/core-ts/src/storage/sqlite.ts (readerReceipt, storedReceipt)
problem_type: best_practice
component: tooling
severity: high
applies_when:
  - "Adding a field to the carbon receipt (routing, tools, session and models came in this way)"
  - "Deciding whether a receipt field is covered by the signature"
  - "Adding a list or a map to the receipt"
  - "A core reads receipts that the other core wrote"
  - "A reader renames or reshapes stored receipt keys for display"
tags: [receipts, signing, canonical-form, parity, fixtures, backward-compatibility, core-py, core-ts, shared-ledger, reader-rename, stored-bytes]
---

# A new receipt field: signed, optional, proven by shared vectors

## Context

#191 added `models`, a per-model breakdown, to the carbon receipt. Every receipt signed before it had to verify with the same outcome in both cores, and a new receipt had to verify `valid` in both cores and in the verifiers already released. `routing`, `tools` and `session` came in the same way earlier. The billing rules behind `models`: `../logic-errors/multi-model-receipt-billing.md`.

## Guidance

1. **Sign the new field and keep it optional.** Signature coverage is a deny-list: every field except `signature` and `signerPublicKey` is signed, nested keys included (`SIGNATURE_FIELDS` in `packages/core-ts/src/sign.ts`). Null and undefined fields drop out of the canonical form (`normalizeReceiptKeys`, and `_normalize_keys` in `packages/core-py/src/tidegap/sign.py`). It follows that:
   - A receipt without the field has the same canonical bytes as before, so old receipts verify as before.
   - A receipt with the field verifies in a released verifier too, because a verifier checks whatever fields are present (plan KTD5: every verifier from v0.12 on).
   - The opposite choice breaks things. To keep a field outside the signature, both cores must add it to the deny-list. Every released verifier would still put it in the canonical form and report each new receipt as `tampered`. The numbers that explain the signed total would also stay unsigned.
2. **A value that varies goes in a value, never in a key.** Normalization converts every key from snake_case to camelCase at any depth (`_x` becomes `X`). A map keyed by model id would have an id such as `gpt_4o` rewritten to `gpt4o`. `models` is an array of objects with the id in `model`.
3. **Fix the order, because the order is signed.** An array keeps its order in the canonical form, so both cores sort the entries by one rule: the Order rule in `../logic-errors/multi-model-receipt-billing.md`, which also lists the tie-break edge between the cores. Swapping two entries makes the receipt `tampered` (a test in each core).
4. **Write the field only when it applies.** A single-model run writes no `models`, so its receipt is byte-identical to one from before #191. `tokenCounts` (batch 27) is written only when a count was not reported in full; the TS builders spread it in only when set, so a fully reported receipt has no key at all. Python's `CarbonReceipt.to_dict()` drops `models` and `token_counts` when they are `None` and writes nothing for an empty `extra_fields`.
5. **Prove it with the shared vector file.** Both suites read `packages/core-ts/test/fixtures/cross-lang-receipt-vectors.json`: each vector's canonical bytes must equal its `expectedCanonical`, and its signature must verify.
   - The diff of the file removes 0 lines. A changed old vector is a broken promise, not a fixture update.
   - Each new field gets a vector, signed with the fixture's existing throwaway key (no new key material).
   - One vector per field is not enough. The first `models` vector had grams on every entry, no zero counts and no integral floats; for those shapes each core was checked only against its own output (#191 review, testing gap). A second vector adds no intensity (no entry has `carbonGCo2`), zero counts, the integral floats `2.0` and `0.0` (Python reads them as floats and must print `2` and `0`, as JavaScript does), and entry keys in unsorted order.
6. **A reader of the other core's receipts keeps the keys it does not model.** The Node core writes camelCase; the Python ledger writes snake_case. `CarbonReceipt.from_dict` reads each field from either rendering and keeps every other key in `extra_fields`, which `to_dict()` and `to_camel_dict()` write back at the top level. A reader that drops a signed key it does not know makes the receipt `tampered` at the next verification. Before #191 the Python reader could not read a Node receipt at all: it raised `KeyError` on `task_id`. Keeping every key has a security edge, covered in `signed-receipt-two-renderings-of-one-field.md`.
7. **A reader renames for display; the verifier gets the stored bytes (#195).** The Node store parsed `receipt_json` as stored. A Python receipt has snake_case keys, so budget status, `tidegap stats`, the page and MCP found no `ranAt` and skipped every Python-run task on a shared ledger. `rowToRecord` in `packages/core-ts/src/storage/sqlite.ts` now hands readers a copy with top-level nulls dropped and top-level keys renamed to camelCase. Four rules keep the copy honest:
   - **Rename on read, never on write.** A Python receipt signed by v0.11 or older verifies only through the legacy form over its original key names (`legacyRawCanonical` in `packages/core-ts/src/sign.ts`). A migration that rewrote the stored keys, or a verifier given the renamed copy, would make those receipts `tampered`. `TaskStore.storedReceipt(id)` returns the receipt as stored; `tidegap verify <task-id>` verifies it and shows the copy. A Node write of an unchanged copy puts the stored text back, so a status write never rewrites a Python receipt.
   - **One rename function for the reader and the verifier.** The reader uses `snakeToCamelKey`, exported from `sign.ts` for this (not from the package index), which is the rule `verifyReceipt` normalizes with. A reader with its own rename could merge two keys that the verifier keeps apart, or the reverse. The copy would then show one value while the signature covers another: the gap in `signed-receipt-two-renderings-of-one-field.md`, moved into the reader.
   - **Rename a key only when the result is unambiguous.** A key keeps its stored name when another non-null key renames to the same name, or when its new name would rename again (`x__1` becomes `x_1`, which becomes `x1`). The copy then carries two renderings exactly when the stored receipt does, so the copy and the stored receipt get the same verdict. `packages/core-ts/test/mixed-ledger-receipts.test.ts` asserts equal canonical bytes and equal verdicts for a plain Python row, a null twin, snake plus camel, two snake renderings and a key that renames twice.
   - **Prove the reader with one fixture in both cores.** `packages/core-ts/test/fixtures/mixed-ledger-receipts.json` holds Node and Python rows and the expected daily and weekly usage; a TS test and a Python test load it into a fresh ledger and compare budget status. Nested values are not renamed: Python already stores `routing` and `models` in camelCase.

   - **Exports keep the copy; the verifier names the ledger (batch 27).** A surface that hands out the read copy as JSON (`taskDetail` in `packages/cli/src/ui/api.ts`, `queue show --json`) gives a v0.11-or-older Python receipt in camelCase, and `tidegap verify --file` reports that copy `tampered`. Its human output then adds one line naming `tidegap verify <task-id>`, which reads the stored bytes; the JSON payload does not change. Exporting the stored bytes was rejected: it changes the receipt shape every reader gets, for v0.11 Python receipts only. Renaming keys back for the legacy check in `verify --file` was rejected: it widens what verifies `valid` on the signing surface.

## Why This Matters

A receipt is the product's proof: users verify it with `tidegap verify` and can hand it to a third party that pins the signer key. A field change that turns old receipts into `tampered`, or new ones into `tampered` for released verifiers, breaks every receipt already given out. The canonical form is the contract, and only the shared vectors test it across both cores.

## When to Apply

- Any new receipt field, nested object or list.
- Any change to canonicalization, key normalization or number formatting.
- Any new reader of `receipt_json` in either core, and any surface that exports a receipt read from the ledger.

## Related

- `cross-language-select-window-parity.md`: the same one-fixture, two-suites pattern.
- `shared-sqlite-ledger-migrations.md`: both cores open one ledger.
- Public contract: `apps/web/content/docs/08-receipts.md`, sections `{#signing}` and `{#receipt-models}`.
