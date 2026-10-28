"""Per-model billing of a multi-model run (KTD7), Python side.

The vectors live in the TS package —
``packages/core-ts/test/fixtures/model-usage-billing-vectors.json`` — and
are read by this suite and by ``packages/core-ts/test/receipt-models.test.ts``:
both cores must produce the same numbers for the same input.
"""

from __future__ import annotations

import json
import math
from pathlib import Path
from typing import Any

import pytest

from tidegap.energy import bill_model_usage
from tidegap.providers.base import ModelUsage

# parents[2] == <repo>/packages, then down into core-ts/test/fixtures.
FIXTURE_PATH = (
    Path(__file__).resolve().parents[2]
    / "core-ts"
    / "test"
    / "fixtures"
    / "model-usage-billing-vectors.json"
)

VECTORS: list[dict[str, Any]] = json.loads(FIXTURE_PATH.read_text(encoding="utf-8"))["vectors"]
VECTOR_IDS = [v["description"][:48] for v in VECTORS]


def _count(value: Any) -> Any:
    """The fixture spells non-finite counts as strings; JSON has no NaN or Infinity."""
    if isinstance(value, str):
        return {"NaN": math.nan, "Infinity": math.inf}[value]
    return value


def _usage(vector: dict[str, Any]) -> list[ModelUsage]:
    return [
        ModelUsage(
            model=u["model"],
            input_tokens=_count(u["inputTokens"]),
            output_tokens=_count(u["outputTokens"]),
        )
        for u in vector["modelUsage"]
    ]


def test_fixture_has_a_vector_for_every_rule() -> None:
    assert len(VECTORS) >= 8


@pytest.mark.parametrize("vector", VECTORS, ids=VECTOR_IDS)
def test_billing_matches_the_shared_vector(vector: dict[str, Any]) -> None:
    bill = bill_model_usage(vector["intensityGCo2PerKwh"], _usage(vector))
    expected = vector["expected"]
    if expected is None:
        assert bill is None
        return
    assert bill is not None
    assert bill.models == expected["models"]
    assert bill.model == expected["model"]
    assert bill.total_tokens == expected["totalTokens"]
    assert bill.energy_source == expected["energySource"]
    assert bill.energy_resolution == expected["energyResolution"]
    if expected["carbonGCo2"] is None:
        assert bill.carbon_g_co2 is None
    else:
        assert bill.carbon_g_co2 == pytest.approx(expected["carbonGCo2"], abs=1e-9)


def test_billing_does_not_reorder_the_callers_list() -> None:
    usage = [
        ModelUsage(model="claude-sonnet-5", input_tokens=1, output_tokens=1),
        ModelUsage(model="claude-opus-5-5", input_tokens=1, output_tokens=9),
    ]
    bill_model_usage(400, usage)
    assert [u.model for u in usage] == ["claude-sonnet-5", "claude-opus-5-5"]
