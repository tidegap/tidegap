---
title: "A receipt that carries one signed field under two key names is tampered: a normalizing verifier must reject key collisions"
date: 2026-10-28
category: best-practices
module: packages/core-ts/src/sign.ts (duplicateRendering), packages/core-py/src/tidegap/sign.py (_duplicate_rendering), packages/core-py/src/tidegap/types.py (CarbonReceipt.from_dict)
problem_type: security_issue
component: tooling
symptoms:
  - "A receipt with an edited actualCarbonGCo2 and the signed value under actual_carbon_gCo2 verified valid"
  - "The same edit inside a models entry changed per-model grams and still verified valid"
  - "Python verify_receipt(receipt.to_dict()) said valid while receipt.actual_carbon_g_co2 showed the edited value"
root_cause: missing_validation
resolution_type: code_fix
severity: high
tags: [security, signing, receipts, verify, key-normalization, cwe-347, parser-differential, core-py]
---

# One signed field under two key names: tampered

## Problem

Both verifiers convert receipt keys from snake_case to camelCase before they build the canonical bytes, and when two keys of one object convert to the same name, the last one wins. A person who can edit a ledger row or a receipt file, but has no signing key, could put an edited value under one rendering and leave the signed value under another. A reader showed the edited value; the verifier checked the signed one and returned `valid` (CWE-347). Found by the #191 review (P1) and fixed in #191.

## Symptoms

Before the fix, as the #191 review reproduced it:

- On the signed `models` vector, `actualCarbonGCo2` set to 0.5 g and the signed 5.4 g moved to `actual_carbon_gCo2` verified `valid` in both cores.
- The same edit inside a `models` entry (`carbonGCo2` next to `carbon_gCo2`) changed one model's grams and still verified `valid`.
- On the Python ledger path, `receipt.actual_carbon_g_co2` (what the Python budget reads) showed the edited value, and `verify_receipt(receipt.to_dict())` returned `valid`. `tidegap verify --file` printed VALID next to the edited value.

## What Didn't Work

- **The gap was older than #191, but nothing reached it on the Python path.** Both verifiers kept the last of two renderings long before #191. Before #191 the Python reader dropped every key it did not model, so a second rendering never reached the verifier, and the same edited row verified `tampered`. #191 made `from_dict` keep unknown keys, which a Node receipt needs to verify after a Python read (`signed-receipt-additive-fields.md`, rule 6). That change exposed the gap.
- **A precedence rule cannot fix it.** The readers do not agree on which key wins: `from_dict` reads the snake key first, normalization keeps the last key in insertion order, and Node code reads the camel property. Any fixed precedence leaves some reader that shows a value the signature does not cover.
- **Dropping the second rendering in `from_dict` does not fix it.** Then a Python round trip verifies a cleaned copy, not the stored receipt, and the verdict depends on which key Python happened to read.

## Solution

- **Both verifiers reject a collision.** `duplicateRendering` in `packages/core-ts/src/sign.ts` and `_duplicate_rendering` in `packages/core-py/src/tidegap/sign.py` walk the raw receipt at every depth. When two keys of one object convert to the same camelCase name (null values do not count, because normalization drops them), verification returns `tampered` with the reason "receipt carries two renderings of `<name>`". The check runs after the unsigned check and before the trusted-key check, so a second rendering of `signerPublicKey` is `tampered` too, not `key-mismatch`.
- **`from_dict` keeps a second rendering in `extra_fields`.** Verification then sees the bytes that were stored.
- **No compatibility cost.** No signer writes two renderings of one field, so every receipt that Tidegap signed verifies as before. The receipts page `{#signing}` and the CHANGELOG `### Security` entry state the rule.

## Why This Works

The conversion is many-to-one, not two-to-one: `actualCarbonGCo2`, `actual_carbon_g_co2`, `actual_carbon_gCo2` and `actual_carbonGCo2` all become `actualCarbonGCo2`. A many-to-one step before signature verification lets the verified bytes and the displayed bytes come from different keys. Refusing every collision makes the mapping one-to-one on every receipt that verifies, so each reader and the verifier see the same value.

## Prevention

- A verifier that normalizes its input before it checks a signature must reject input that normalization would lose: two keys that become one, at any depth. The same holds for any canonical form that drops or merges data (case folding, Unicode normalization, duplicate JSON keys).
- A reader that round-trips signed data keeps the keys it does not model. The verifier, not the reader, decides what is valid.
- Tests in each core (`packages/core-ts/test/receipt-models.test.ts`, `packages/core-py/tests/test_receipt_models.py`): a second rendering at the top level and inside a `models` entry is `tampered` on the raw receipt; in Python, a top-level one is also `tampered` after a ledger read, through `to_dict()` and `to_camel_dict()`.
- Residual (#191 review): the signing key lives next to the ledger, so a local editor can usually sign again. The check matters most for a receipt handed to a third party that pins the signer key, and for a Python caller that verifies a receipt read through `from_dict`.

## Related Issues

- `signed-receipt-additive-fields.md`: why unknown keys are kept, and how a new field enters the signed payload.
- `loopback-web-ui-hardening.md`, `telegram-channel-security.md`: other security learnings.
