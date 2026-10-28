---
title: "A new receipt field goes inside the signed payload, optional, with a shared vector for every shape it can take"
date: 2026-10-28
category: best-practices
module: packages/core-ts/src/sign.ts, packages/core-py/src/tidegap/sign.py, packages/core-py/src/tidegap/types.py (CarbonReceipt), packages/core-ts/test/fixtures/cross-lang-receipt-vectors.json
problem_type: best_practice
component: tooling
severity: high
applies_when:
  - "Adding a field to the carbon receipt (routing, tools, session and models came in this way)"
  - "Deciding whether a receipt field is covered by the signature"
  - "Adding a list or a map to the receipt"
  - "A core reads receipts that the other core wrote"
tags: [receipts, signing, canonical-form, parity, fixtures, backward-compatibility, core-py, core-ts]
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
4. **Write the field only when it applies.** A single-model run writes no `models`, so its receipt is byte-identical to one from before #191. Python's `CarbonReceipt.to_dict()` drops `models` when it is `None` and writes nothing for an empty `extra_fields`.
5. **Prove it with the shared vector file.** Both suites read `packages/core-ts/test/fixtures/cross-lang-receipt-vectors.json`: each vector's canonical bytes must equal its `expectedCanonical`, and its signature must verify.
   - The diff of the file removes 0 lines. A changed old vector is a broken promise, not a fixture update.
   - Each new field gets a vector, signed with the fixture's existing throwaway key (no new key material).
   - One vector per field is not enough. The first `models` vector had grams on every entry, no zero counts and no integral floats; for those shapes each core was checked only against its own output (#191 review, testing gap). A second vector adds no intensity (no entry has `carbonGCo2`), zero counts, the integral floats `2.0` and `0.0` (Python reads them as floats and must print `2` and `0`, as JavaScript does), and entry keys in unsorted order.
6. **A reader of the other core's receipts keeps the keys it does not model.** The Node core writes camelCase; the Python ledger writes snake_case. `CarbonReceipt.from_dict` reads each field from either rendering and keeps every other key in `extra_fields`, which `to_dict()` and `to_camel_dict()` write back at the top level. A reader that drops a signed key it does not know makes the receipt `tampered` at the next verification. Before #191 the Python reader could not read a Node receipt at all: it raised `KeyError` on `task_id`. Keeping every key has a security edge, covered in `signed-receipt-two-renderings-of-one-field.md`.

## Why This Matters

A receipt is the product's proof: users verify it with `tidegap verify` and can hand it to a third party that pins the signer key. A field change that turns old receipts into `tampered`, or new ones into `tampered` for released verifiers, breaks every receipt already given out. The canonical form is the contract, and only the shared vectors test it across both cores.

## When to Apply

- Any new receipt field, nested object or list.
- Any change to canonicalization, key normalization or number formatting.
- Any new reader of `receipt_json` in either core.

## Related

- `cross-language-select-window-parity.md`: the same one-fixture, two-suites pattern.
- `shared-sqlite-ledger-migrations.md`: both cores open one ledger.
- Public contract: `apps/web/content/docs/08-receipts.md`, sections `{#signing}` and `{#receipt-models}`.
