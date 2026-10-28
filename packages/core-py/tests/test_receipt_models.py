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
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any

import pytest

from tidegap import DeferOptions, ProviderCallSpec, Scheduler
from tidegap.grid import GridFeed
from tidegap.providers.base import (
    DispatchOptions,
    DispatchResult,
    ModelUsage,
    ProviderAdapter,
)
from tidegap.sign import canonical_receipt_payload, is_signing_available, verify_receipt
from tidegap.types import CarbonReceipt, GridForecast, GridForecastEntry

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


# --------------------------------------------------------------------- #
# A multi-model dispatch (U7)


class _FlatFeed(GridFeed):
    """One intensity every hour; calls after ``fail_after_calls`` raise."""

    source: str = "mock"  # type: ignore[assignment]

    def __init__(self, intensity: float, fail_after_calls: int | None = None) -> None:
        self._intensity = intensity
        self._fail_after = fail_after_calls
        self._calls = 0

    async def fetch_forecast(self, region: str, hours: int) -> GridForecast:
        self._calls += 1
        if self._fail_after is not None and self._calls > self._fail_after:
            raise RuntimeError("feed down")
        now = datetime.now(UTC)
        return GridForecast(
            region=region,
            source="mock",
            generated_at=now.isoformat(),
            entries=[
                GridForecastEntry(
                    datetime=(now + timedelta(hours=h)).isoformat(),
                    carbon_intensity_g_co2_per_kwh=self._intensity,
                    band="clean",
                )
                for h in range(6)
            ],
        )


class _Reporting(ProviderAdapter):
    """Reports fixed token counts and an optional per-model list."""

    name = "anthropic"

    def __init__(
        self,
        input_tokens: int,
        output_tokens: int,
        model_usage: list[ModelUsage] | None = None,
    ) -> None:
        self._input = input_tokens
        self._output = output_tokens
        self._model_usage = model_usage

    async def dispatch(
        self, model: str, prompt: str, options: DispatchOptions | None = None
    ) -> DispatchResult:
        return DispatchResult(
            text="ok",
            model=model,
            provider=self.name,
            input_tokens=self._input,
            output_tokens=self._output,
            model_usage=self._model_usage,
        )


_OPUS_AND_HAIKU = [
    ModelUsage(model="claude-haiku-5-5", input_tokens=500, output_tokens=120),
    ModelUsage(model="claude-opus-5-5", input_tokens=4030, output_tokens=900),
]


async def _dispatch_one(s: Scheduler, adapter: ProviderAdapter, task_id: str) -> CarbonReceipt:
    """Enqueue a provider call (no job), make it due, tick once, return the receipt."""
    rec = await s.enqueue_provider_call(
        ProviderCallSpec(provider="anthropic", model="claude-opus-5-5", prompt="hi"),
        DeferOptions(
            deadline=(datetime.now(UTC) + timedelta(hours=1)).isoformat(),
            region="FR",
            task_id=task_id,
        ),
    )
    rec.scheduled_for = (datetime.now(UTC) - timedelta(seconds=1)).isoformat()
    await s.tick({"anthropic": adapter})
    done = s.get_task(task_id)
    assert done is not None and done.status == "completed" and done.receipt is not None
    return done.receipt


@pytest.mark.asyncio
async def test_a_multi_model_dispatch_bills_every_model_and_signs_the_list() -> None:
    async with Scheduler(feed=_FlatFeed(180)) as s:
        receipt = await _dispatch_one(s, _Reporting(4530, 1020, _OPUS_AND_HAIKU), "mm:two")
    # opus 4030 x 0.003 + 900 x 0.015 Wh, haiku (family) 500 x 0.0003 + 120 x 0.0015 Wh;
    # x 1.15 / 1000 x 180 gCO2/kWh.
    assert receipt.actual_carbon_g_co2 == 5.4
    assert receipt.total_tokens == 5550
    assert receipt.model == "claude-opus-5-5"
    assert receipt.energy_source == "estimated"
    assert receipt.energy_resolution == "family-fallback"
    assert receipt.models == [
        {
            "model": "claude-opus-5-5",
            "inputTokens": 4030,
            "outputTokens": 900,
            "carbonGCo2": 5.3,
            "energySource": "estimated",
            "energyResolution": "exact",
        },
        {
            "model": "claude-haiku-5-5",
            "inputTokens": 500,
            "outputTokens": 120,
            "carbonGCo2": 0.07,
            "energySource": "estimated",
            "energyResolution": "family-fallback",
        },
    ]
    assert receipt.signature is not None
    assert verify_receipt(receipt.to_dict()).outcome == "valid"
    assert verify_receipt(receipt.to_camel_dict()).outcome == "valid"


@pytest.mark.asyncio
async def test_one_billed_model_in_the_list_gives_the_single_model_receipt() -> None:
    one = [
        ModelUsage(model="claude-opus-5-5", input_tokens=4030, output_tokens=900),
        ModelUsage(model="claude-haiku-5-5", input_tokens=0, output_tokens=0),
    ]
    async with Scheduler(feed=_FlatFeed(180), signing=False) as s:
        listed = await _dispatch_one(s, _Reporting(4030, 900, one), "mm:listed")
        plain = await _dispatch_one(s, _Reporting(4030, 900), "mm:plain")

    def billed(r: CarbonReceipt) -> tuple[Any, ...]:
        return (
            r.actual_carbon_g_co2,
            r.total_tokens,
            r.model,
            r.energy_source,
            r.energy_resolution,
        )

    assert listed.models is None
    assert billed(listed) == billed(plain) == (5.3, 4930, "claude-opus-5-5", "estimated", "exact")


@pytest.mark.asyncio
async def test_without_the_receipt_side_intensity_entries_carry_no_grams() -> None:
    async with Scheduler(feed=_FlatFeed(180, fail_after_calls=1)) as s:
        receipt = await _dispatch_one(s, _Reporting(4530, 1020, _OPUS_AND_HAIKU), "mm:nofeed")
    assert receipt.intensity_g_co2_per_kwh is None
    assert receipt.actual_carbon_g_co2 == receipt.estimated_carbon_g_co2
    assert receipt.models is not None
    assert [m["model"] for m in receipt.models] == ["claude-opus-5-5", "claude-haiku-5-5"]
    assert all("carbonGCo2" not in m for m in receipt.models)
    assert verify_receipt(receipt.to_dict()).outcome == "valid"
