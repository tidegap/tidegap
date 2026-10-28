"""The signed ``models`` list of a multi-model receipt (KTD5, KTD6, KTD10).

The signed vector lives in the shared fixture
``packages/core-ts/test/fixtures/cross-lang-receipt-vectors.json``, which
``test_sign_vectors.py`` and the TS suites also read.
"""

from __future__ import annotations

import base64
import copy
import json
from dataclasses import fields
from pathlib import Path
from typing import Any

import pytest

from tidegap.sign import canonical_receipt_payload, is_signing_available, verify_receipt
from tidegap.types import CarbonReceipt

pytestmark = pytest.mark.skipif(
    not is_signing_available(),
    reason="tidegap[signing] extras not installed",
)

FIXTURE_PATH = (
    Path(__file__).resolve().parents[2]
    / "core-ts"
    / "test"
    / "fixtures"
    / "cross-lang-receipt-vectors.json"
)
FIXTURE = json.loads(FIXTURE_PATH.read_text(encoding="utf-8"))
MODELS_VECTOR: dict[str, Any] = next(
    v for v in FIXTURE["vectors"] if isinstance(v["signedReceipt"].get("models"), list)
)


def _signed() -> dict[str, Any]:
    return copy.deepcopy(MODELS_VECTOR["signedReceipt"])


def _sign_with_fixture_key(canonical: str) -> str:
    from cryptography.hazmat.primitives import serialization

    key = serialization.load_pem_private_key(
        MODELS_VECTOR["privateKeyPem"].encode("ascii"), password=None
    )
    return base64.b64encode(key.sign(canonical.encode("utf-8"))).decode("ascii")


def _python_receipt() -> CarbonReceipt:
    """The shared vector's claims as a Python receipt: ``tools`` and
    ``session`` are keys the Python core does not model."""
    r = MODELS_VECTOR["receipt"]
    return CarbonReceipt(
        task_id=r["taskId"],
        ran_at=r["ranAt"],
        region=r["region"],
        estimated_carbon_g_co2=r["estimatedCarbonGCo2"],
        actual_carbon_g_co2=r["actualCarbonGCo2"],
        delta_pct=r["deltaPct"],
        provider=r["provider"],
        model=r["model"],
        duration_ms=r["durationMs"],
        total_tokens=r["totalTokens"],
        intensity_g_co2_per_kwh=r["intensityGCo2PerKwh"],
        energy_source=r["energySource"],
        energy_resolution=r["energyResolution"],
        models=copy.deepcopy(r["models"]),
        extra_fields={"tools": list(r["tools"]), "session": dict(r["session"])},
    )


# --------------------------------------------------------------------- #
# The shared vector (U6)


def test_the_shared_multi_model_vector_verifies() -> None:
    assert verify_receipt(MODELS_VECTOR["signedReceipt"]).outcome == "valid"


def test_changing_one_entrys_grams_is_tampering() -> None:
    signed = _signed()
    signed["models"][1]["carbonGCo2"] = 0.08
    assert verify_receipt(signed).outcome == "tampered"


def test_changing_one_entrys_tokens_is_tampering() -> None:
    signed = _signed()
    signed["models"][1]["inputTokens"] += 1
    assert verify_receipt(signed).outcome == "tampered"


def test_a_second_rendering_of_a_field_is_tampering() -> None:
    # Normalization keeps the last of two renderings, so without the check
    # the receipt shows the edited value and verifies against the other.
    top = _signed()
    top["actual_carbon_gCo2"] = top["actualCarbonGCo2"]
    top["actualCarbonGCo2"] = 0.5
    entry = _signed()
    entry["models"][0]["carbon_gCo2"] = entry["models"][0]["carbonGCo2"]
    entry["models"][0]["carbonGCo2"] = 0.01
    for receipt in (top, entry):
        result = verify_receipt(receipt)
        assert result.outcome == "tampered"
        assert "two renderings" in result.reason


def test_swapping_two_entries_is_tampering() -> None:
    signed = _signed()
    signed["models"] = [signed["models"][1], signed["models"][0]]
    assert verify_receipt(signed).outcome == "tampered"


def test_deleting_the_list_is_tampering() -> None:
    signed = _signed()
    del signed["models"]
    assert verify_receipt(signed).outcome == "tampered"


def test_a_python_receipt_with_models_and_unmapped_keys_signs_like_the_shared_vector() -> None:
    """Python's snake rendering, with ``models`` and the keys it does not
    model, has the shared vector's canonical bytes, so the fixture key
    signs it to the vector's signature, which the TS suite verifies."""
    receipt = _python_receipt()
    snake = receipt.to_dict()
    assert snake["tools"] == ["WebSearch", "WebFetch"]
    assert "extra_fields" not in snake
    canonical = canonical_receipt_payload({**snake, "signedAt": MODELS_VECTOR["signedAt"]})
    assert canonical == MODELS_VECTOR["expectedCanonical"]
    signature = _sign_with_fixture_key(canonical)
    assert signature == MODELS_VECTOR["signedReceipt"]["signature"]
    signed_snake = {
        **snake,
        "signature": signature,
        "signer_public_key": FIXTURE["signerPublicKeyBase64"],
        "signed_at": MODELS_VECTOR["signedAt"],
    }
    assert verify_receipt(signed_snake).outcome == "valid"
    signed_camel = {
        **receipt.to_camel_dict(),
        "signature": signature,
        "signerPublicKey": FIXTURE["signerPublicKeyBase64"],
        "signedAt": MODELS_VECTOR["signedAt"],
    }
    assert verify_receipt(signed_camel).outcome == "valid"


def test_a_receipt_without_models_keeps_its_dict_shape() -> None:
    """No ``models`` and an empty map: ``to_dict`` writes exactly the keys
    it wrote before this field existed, so canonical bytes do not move."""
    receipt = CarbonReceipt(
        task_id="t",
        ran_at="2026-10-28T00:00:00+00:00",
        region="FR",
        estimated_carbon_g_co2=0.5,
    )
    modeled = {f.name for f in fields(CarbonReceipt)} - {"models", "extra_fields"}
    assert set(receipt.to_dict()) == modeled
    assert "models" not in receipt.to_camel_dict()
