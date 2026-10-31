"""Per-model billing of a multi-model run (KTD7), the single-model count rule
and the ``token_counts`` marker (batch 27, KTD1-KTD3), Python side.

The vectors live in the TS package —
``packages/core-ts/test/fixtures/model-usage-billing-vectors.json`` — and
are read by this suite and by ``packages/core-ts/test/receipt-models.test.ts``:
both cores must produce the same numbers for the same input.
"""

from __future__ import annotations

import json
import math
from pathlib import Path
from types import SimpleNamespace
from typing import Any

import pytest

from tidegap.energy import bill_model_usage, grams_for_intensity, single_model_counts
from tidegap.providers.base import ModelUsage

# parents[2] == <repo>/packages, then down into core-ts/test/fixtures.
FIXTURE_PATH = (
    Path(__file__).resolve().parents[2]
    / "core-ts"
    / "test"
    / "fixtures"
    / "model-usage-billing-vectors.json"
)

FIXTURE: dict[str, Any] = json.loads(FIXTURE_PATH.read_text(encoding="utf-8"))
VECTORS: list[dict[str, Any]] = FIXTURE["vectors"]
VECTOR_IDS = [v["description"][:48] for v in VECTORS]
SINGLE: list[dict[str, Any]] = FIXTURE["singleModel"]
SINGLE_IDS = [v["description"][:48] for v in SINGLE]


def _count(value: Any) -> Any:
    """The fixture spells non-finite counts as strings, as JSON has no NaN or
    Infinity; any other value (an absent count is ``None``) stands for itself."""
    if isinstance(value, str):
        return {"NaN": math.nan, "Infinity": math.inf}.get(value, value)
    return value


def _usage(vector: dict[str, Any]) -> list[ModelUsage]:
    return [
        ModelUsage(
            model=u["model"],
            input_tokens=_count(u.get("inputTokens")),
            output_tokens=_count(u.get("outputTokens")),
            partial_input_tokens=_count(u.get("partialInputTokens")),
        )
        for u in vector["modelUsage"]
    ]


def test_fixture_has_a_vector_for_every_rule() -> None:
    assert len(VECTORS) >= 14


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
    assert bill.token_counts == expected["tokenCounts"]
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


def test_fixture_has_a_single_model_vector_for_every_rule() -> None:
    assert len(SINGLE) >= 11


@pytest.mark.parametrize("vector", SINGLE, ids=SINGLE_IDS)
def test_single_model_counts_match_the_shared_vector(vector: dict[str, Any]) -> None:
    usage = {k: _count(v) for k, v in vector["usage"].items()}
    counts = single_model_counts(
        usage.get("inputTokens"),
        usage.get("outputTokens"),
        total_tokens=usage.get("totalTokens"),
        partial_input_tokens=usage.get("partialInputTokens"),
    )
    expected = vector["expected"]
    assert counts.total_tokens == expected["totalTokens"]
    assert counts.token_counts == expected["tokenCounts"]
    grams = grams_for_intensity(
        vector["intensityGCo2PerKwh"],
        model=vector["model"],
        input_tokens=counts.input_tokens,
        output_tokens=counts.output_tokens,
    )
    assert math.isfinite(grams)
    assert grams == pytest.approx(expected["carbonGCo2"], abs=1e-9)


def test_a_count_beyond_a_double_is_unreported() -> None:
    """``math.isfinite(10**400)`` raises ``OverflowError``; the count rule
    treats the value as unreported instead, as JSON gives TS ``Infinity``."""
    counts = single_model_counts(10**400, 50)
    assert counts.input_tokens is None
    assert counts.output_tokens == 50
    assert counts.token_counts == "partial"
    bill = bill_model_usage(
        300,
        [
            ModelUsage(model="claude-sonnet-5", input_tokens=10**400, output_tokens=10),
            ModelUsage(model="claude-haiku-5-5", input_tokens=5, output_tokens=10**400),
        ],
    )
    assert bill is not None
    assert bill.total_tokens == 15
    assert bill.token_counts == "partial"


def test_a_total_that_overflows_is_left_out() -> None:
    """Two finite counts can sum to ``inf``, which signing refuses: the
    count rule applies to the total too, on both paths."""
    counts = single_model_counts(1e308, 1e308)
    assert counts.total_tokens is None
    assert counts.token_counts is None
    bill = bill_model_usage(
        300,
        [
            ModelUsage(model="claude-sonnet-5", input_tokens=0, output_tokens=1e308),
            ModelUsage(model="claude-haiku-5-5", input_tokens=0, output_tokens=1e308),
        ],
    )
    assert bill is not None
    assert bill.total_tokens is None
    assert bill.token_counts is None
    assert bill.carbon_g_co2 is not None and math.isfinite(bill.carbon_g_co2)


def test_an_entry_without_partial_input_tokens_still_bills() -> None:
    """An adapter's own entry type may predate ``partial_input_tokens``;
    the bill reads it with ``getattr`` and does not raise."""
    bill = bill_model_usage(
        300,
        [
            SimpleNamespace(model="claude-sonnet-5", input_tokens=40, output_tokens=60),
            SimpleNamespace(model="claude-haiku-5-5", input_tokens=10, output_tokens=25),
        ],
    )
    assert bill is not None
    assert bill.total_tokens == 135
    assert bill.token_counts is None


def test_a_run_without_a_total_shows_input_plus_output() -> None:
    """The Python core sums the two counts when the run gives no total; the
    TS core then shows none (the source of the total is not unified)."""
    assert single_model_counts(1200, 300).total_tokens == 1500
    assert single_model_counts(1200, None).total_tokens is None
