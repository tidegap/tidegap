---
id: receipts
label: Receipts & carbon
---

<!-- source: apps/web/src/app/docs/page.tsx (v2 receipts and energy sections), docs/claims.md rows 21, 22, 31 -->
Every task that runs gets a carbon receipt, signed with a key that stays on your machine. Anyone can check a receipt offline.

### Signed receipts {#signing}

- The keys are `~/.tidegap/signing.key` (private, mode `0600`) and `signing.key.pub`. The first dispatch creates them.
- The receipt carries `signerPublicKey`, so a consumer can pin the key the first time it sees it.
- The verifier returns `valid`, `tampered`, `legacy-unsigned` (a receipt from before signing existed) or `key-mismatch`. The CLI exit codes are 0, 1, 2 and 3.

### Verify a receipt {#verify}

```bash
# A task in the local ledger
tidegap verify t-ef2354ee-eff0-431c-b11e-6edfcb8299b0

# A receipt file, pinned to the signer you expect
tidegap verify --file ./receipt.json --trusted-public-key <base64 key>
```

From code:

```ts
import { loadOrCreateSigningKey, signReceipt, verifyReceipt } from "@tidegap/core";

const signed = signReceipt(receipt, loadOrCreateSigningKey());
verifyReceipt(signed); // { outcome: "valid" | "tampered" | "legacy-unsigned" | "key-mismatch", ... }
```

```python
# pip install "tidegap[signing]"
from tidegap import load_or_create_signing_key, sign_receipt, verify_receipt

signed = sign_receipt(receipt_dict, load_or_create_signing_key())
verify_receipt(signed)  # VerifyResult(outcome='valid', ...)
```

### A real run {#example}

One run on GB, 2026-09-30, with the live National Grid ESO feed and a local Ollama `llama3.2:1b`. The forecast peak was 183 gCO2/kWh. For a 72 h deadline the recommended window was 88 gCO2/kWh. At dispatch the live feed measured 158 gCO2/kWh, and the receipt records that value. Raw output and the reproducer: [docs/examples/2026-09-30-GB-tick](https://github.com/tidegap/tidegap/tree/main/docs/examples/2026-09-30-GB-tick).

### Energy per model {#energy}

A receipt's grams come from the grid intensity times an energy estimate for the model. The coefficients come from Patterson et al. 2021 (arXiv:2104.10350), Luccioni, Jernite and Strubell 2024, "Power Hungry Processing" (arXiv:2311.16863), and the Hugging Face AI Energy Score.

<!-- embed:energy -->

\* Typical call: 500 input and 500 output tokens, times `DEFAULT_PUE` = 1.15. Closed-model coefficients are inferred from public parameter counts and the Luccioni scaling curve, and may be off by ±50%. Each coefficient has a `source` of `measured`, `estimated` or `fallback`.

### What the numbers mean {#caveats}

- **Grid intensity** is measured when a live feed covers the region. Without an API key, regions other than GB use a deterministic mock curve, and the receipt names the feed in `grid_source`.
- **Savings** depend on the region, the hour and the deadline. A short deadline leaves little room to move.
- **Batch pricing** is the provider's published list price for its Batch API (projected), not a measured bill.
