"""Per-model inference energy estimation (Python mirror of ``energy.ts``).

Replaces the v0.1-v0.5 flat ``ENERGY_KWH_PER_TASK = 0.0015`` placeholder
with cited per-model Wh/token coefficients drawn from public research.

The flat constant is preserved as the backwards-compatible fallback for
callers that have no model information (closure-based ``defer``, pre-v0.6
telemetry replays, etc.). Callers that pass a model name plus optional
input/output token counts get calibrated math.

Sources
-------
* **Patterson et al. 2021.** "Carbon Emissions and Large Neural Network
  Training." arXiv:2104.10350.
* **Luccioni, Jernite, Strubell 2024.** "Power Hungry Processing: Watts
  Driving the Cost of AI Deployment." FAccT 2024. arXiv:2311.16863.
* **Hugging Face AI Energy Score** (2024-).
  https://huggingface.co/AIEnergyScore

See ``packages/core-ts/src/energy.ts`` for the full design rationale and
closed-model caveat.
"""

from __future__ import annotations

import math
import re
from collections.abc import Sequence
from dataclasses import dataclass
from typing import TYPE_CHECKING, Any, Literal, TypeGuard

from . import _data

if TYPE_CHECKING:
    from .providers.base import ModelUsage

EnergySourceTier = Literal["measured", "estimated", "fallback"]

#: How a coefficient was resolved for a given model id (v0.13+). Orthogonal
#: to :data:`EnergySourceTier` (the number's confidence). ``exact`` — the id
#: matched a table key verbatim; ``normalized`` — matched after stripping
#: dated / provider / word-order variance; ``family-fallback`` — unknown id,
#: known family, representative coefficients used; ``default`` — fully
#: unrecognized, flat legacy constant.
EnergyResolutionTier = Literal["exact", "normalized", "family-fallback", "default"]

#: Lifecycle flag on a coefficient row (``None`` = current). ``retired`` —
#: shut down, kept so past receipts still resolve, never priced;
#: ``deprecated`` — shutdown announced, still callable and priced.
ModelLifecycleStatus = Literal["retired", "deprecated"]


@dataclass(frozen=True, slots=True)
class ModelEnergyCoefficients:
    """Per-model inference energy coefficients (chip-level Wh, no PUE)."""

    wh_per_input_token: float
    wh_per_output_token: float
    source: EnergySourceTier
    params_b: float | None = None
    status: ModelLifecycleStatus | None = None


@dataclass(frozen=True, slots=True)
class ResolvedModelEnergy:
    """Coefficients plus the provenance tier describing how they matched."""

    coeffs: ModelEnergyCoefficients
    tier: EnergyResolutionTier


#: Industry-average Power Usage Effectiveness for hyperscaler data centres.
DEFAULT_PUE: float = _data.DEFAULT_PUE

#: Backwards-compatible flat estimate. Used when no model is provided.
LEGACY_KWH_PER_TASK: float = _data.LEGACY_KWH_PER_TASK

_TYPICAL_INPUT_TOKENS: int = _data.TYPICAL_INPUT_TOKENS
_TYPICAL_OUTPUT_TOKENS: int = _data.TYPICAL_OUTPUT_TOKENS

_FALLBACK = ModelEnergyCoefficients(
    wh_per_input_token=LEGACY_KWH_PER_TASK
    * 1000
    / (_TYPICAL_INPUT_TOKENS + _TYPICAL_OUTPUT_TOKENS),
    wh_per_output_token=LEGACY_KWH_PER_TASK
    * 1000
    / (_TYPICAL_INPUT_TOKENS + _TYPICAL_OUTPUT_TOKENS),
    source="fallback",
)


#: Per-model coefficient table. Keys are canonical lowercase names (no
#: dated suffixes; see ``normalize_model_name``). Built from the JSON SSOT
#: via the generated ``_data`` module.
MODEL_ENERGY_COEFFICIENTS: dict[str, ModelEnergyCoefficients] = {
    name: ModelEnergyCoefficients(
        wh_per_input_token=c["wh_per_input_token"],
        wh_per_output_token=c["wh_per_output_token"],
        source=c["source"],
        params_b=c["params_b"],
        status=c["status"],
    )
    for name, c in _data.COEFFICIENTS.items()
}

#: Ordered family-fallback rules (from the JSON SSOT).
MODEL_FAMILIES: list[dict[str, object]] = _data.FAMILIES

#: Citation metadata for the coefficient table.
ENERGY_SOURCES: dict[str, dict[str, str]] = _data.ENERGY_SOURCES


_DATED_SUFFIX = re.compile(r"-\d{4}-?\d{2}-?\d{2}$")
_LATEST_PREVIEW = re.compile(r"-(latest|preview)$")
_VERSION_SUFFIX = re.compile(r"-v\d+$")
_NUMERIC_SUFFIX = re.compile(r"-\d{3,4}$")
_PROVIDER_DOTTED = re.compile(
    r"^(?:(?:us|eu|apac|global)\.)?(?:anthropic|meta|amazon|cohere|mistral|ai21|stability)\."
)
_BEDROCK_TAG = re.compile(r":\d+$")
_CLAUDE_REORDER = re.compile(r"^claude-(\d+(?:-\d+)*)-(opus|sonnet|haiku|fable|mythos)(-.*)?$")


def normalize_model_name(model: str) -> str:
    """Strip provider prefixes, version-date suffixes and normalise
    punctuation and word order.

    Callers can pass ``"claude-sonnet-4-5-20251022"``,
    ``"anthropic/claude-3.5-sonnet"``, ``"gpt-4o-2024-11-20"`` or
    ``"us.anthropic.claude-opus-4-7-v1:0"`` and still hit the canonical entry.
    """
    name = model.strip().lower()
    if "/" in name:
        name = name.rsplit("/", 1)[1]
    name = _PROVIDER_DOTTED.sub("", name)
    name = _BEDROCK_TAG.sub("", name)
    name = name.replace(".", "-")
    name = _DATED_SUFFIX.sub("", name)
    name = _LATEST_PREVIEW.sub("", name)
    name = _VERSION_SUFFIX.sub("", name)
    name = _NUMERIC_SUFFIX.sub("", name)
    m = _CLAUDE_REORDER.match(name)
    if m:
        name = f"claude-{m.group(2)}-{m.group(1)}{m.group(3) or ''}"
    return name


def _family_representative(normalized: str) -> ModelEnergyCoefficients | None:
    """Coefficients of the first family rule that matches, else ``None``."""
    for fam in MODEL_FAMILIES:
        prefix = fam.get("prefix")
        if prefix is not None and not normalized.startswith(prefix):
            continue
        contains = fam.get("contains")
        if contains is not None and not all(t in normalized for t in contains):
            continue
        regex = fam.get("regex")
        if regex is not None and re.search(regex, normalized) is None:
            continue
        return MODEL_ENERGY_COEFFICIENTS[fam["representative"]]
    return None


def resolve_model_energy(model: str | None = None) -> ResolvedModelEnergy:
    """Resolve a (possibly messy) model id to coefficients + provenance tier.

    See :data:`EnergyResolutionTier`.
    """
    if not model:
        return ResolvedModelEnergy(_FALLBACK, "default")
    exact = MODEL_ENERGY_COEFFICIENTS.get(model.strip().lower())
    if exact is not None:
        return ResolvedModelEnergy(exact, "exact")
    normalized = normalize_model_name(model)
    norm = MODEL_ENERGY_COEFFICIENTS.get(normalized)
    if norm is not None:
        return ResolvedModelEnergy(norm, "normalized")
    family = _family_representative(normalized)
    if family is not None:
        return ResolvedModelEnergy(family, "family-fallback")
    return ResolvedModelEnergy(_FALLBACK, "default")


def lookup_model_energy(model: str | None = None) -> ModelEnergyCoefficients:
    """Look up coefficients for a (possibly suffixed) model name."""
    return resolve_model_energy(model).coeffs


def estimate_energy_kwh(
    *,
    model: str | None = None,
    input_tokens: int | None = None,
    output_tokens: int | None = None,
    pue: float = DEFAULT_PUE,
) -> float:
    """Estimate grid-level energy (kWh) for an inference call.

    Resolution order:
        1. No arguments → :data:`LEGACY_KWH_PER_TASK` (0.0015 kWh).
           Backwards-compatible behaviour for closure-based ``defer``.
        2. Unknown model name (no tokens) → same fallback.
        3. Known model, no token counts → typical-task estimate
           (500 + 500 tokens) times the model's coefficients, times PUE.
        4. Known model + token counts → exact per-token math, times PUE.
    """
    if model is None and input_tokens is None and output_tokens is None:
        return LEGACY_KWH_PER_TASK

    resolved = resolve_model_energy(model)
    coeffs = resolved.coeffs

    # Only fully-unrecognized models with no token counts fall back to the
    # flat legacy constant. A family-recognized unknown (tier
    # ``family-fallback``) instead uses the family representative's
    # coefficients — the §1.8 family fallback.
    if (
        resolved.tier == "default"
        and input_tokens is None
        and output_tokens is None
    ):
        return LEGACY_KWH_PER_TASK

    ins = input_tokens if input_tokens is not None else _TYPICAL_INPUT_TOKENS
    outs = output_tokens if output_tokens is not None else _TYPICAL_OUTPUT_TOKENS

    chip_wh = ins * coeffs.wh_per_input_token + outs * coeffs.wh_per_output_token
    grid_wh = chip_wh * pue
    return grid_wh / 1000.0


def grams_for_intensity(
    g_co2_per_kwh: float,
    *,
    model: str | None = None,
    input_tokens: int | None = None,
    output_tokens: int | None = None,
    pue: float = DEFAULT_PUE,
) -> float:
    """Grams CO2-equivalent for one inference call at a given grid intensity."""
    kwh = estimate_energy_kwh(
        model=model,
        input_tokens=input_tokens,
        output_tokens=output_tokens,
        pue=pue,
    )
    return kwh * g_co2_per_kwh


@dataclass(frozen=True, slots=True)
class ModelUsageBill:
    """The bill of a run with two or more billed models (KTD7)."""

    models: list[dict[str, Any]]
    """The billed entries in the camelCase receipt shape (like ``routing``):
    reported output tokens descending (an unreported output counts as 0),
    then model id ascending. An entry leaves out a count its model did not
    report."""
    model: str
    """The first entry's model: the one with the most reported output tokens."""
    total_tokens: int | None
    """The reported input and output tokens over every entry; ``None`` when
    no entry reported a count, as the single-model path leaves it out."""
    energy_source: EnergySourceTier
    """The weakest ``energySource`` across the entries."""
    energy_resolution: EnergyResolutionTier
    """The weakest ``energyResolution`` across the entries."""
    carbon_g_co2: float | None = None
    """Unrounded grams over every entry; ``None`` without an intensity."""


# Strongest last, so a lower index is weaker.
_SOURCE_RANK: tuple[EnergySourceTier, ...] = ("fallback", "estimated", "measured")
_RESOLUTION_RANK: tuple[EnergyResolutionTier, ...] = (
    "default",
    "family-fallback",
    "normalized",
    "exact",
)


def _is_count(n: object) -> TypeGuard[float]:
    """A token count the bill can use: canonicalization refuses non-finite numbers."""
    return (
        isinstance(n, (int, float))
        and not isinstance(n, bool)
        and math.isfinite(n)
        and n >= 0
    )


def _reported(n: object) -> float | None:
    """The count when the model reported a usable one; otherwise ``None``,
    an unreported count."""
    return n if _is_count(n) else None


def bill_model_usage(
    g_co2_per_kwh: float | None,
    usage: Sequence[ModelUsage],
) -> ModelUsageBill | None:
    """Bill each model of a run with its own coefficients at one intensity.

    Mirrors ``billModelUsage`` in ``packages/core-ts/src/energy.ts``. A
    count that is absent, not a number, negative or not finite is
    unreported: it is billed at the typical count, as
    :func:`estimate_energy_kwh` does on the single-model path, and the entry
    and ``total_tokens`` leave it out. When no entry reports a count,
    ``total_tokens`` is ``None``. An entry that reports both counts as 0 is
    not billed. Returns ``None`` when fewer than two entries are left: the
    caller then bills the run as one model. Each entry's grams are rounded
    half up to 0.01 g (``Math.round`` parity); the total stays unrounded and
    is summed left to right, as the TS core does.
    """
    counted = [(u.model, _reported(u.input_tokens), _reported(u.output_tokens)) for u in usage]
    billed = sorted(
        (c for c in counted if not (c[1] == 0 and c[2] == 0)),
        key=lambda c: (-(c[2] or 0), c[0]),
    )
    if len(billed) < 2:
        return None
    total: float | None = None
    total_tokens: int | None = None
    weakest_source = len(_SOURCE_RANK) - 1
    weakest_resolution = len(_RESOLUTION_RANK) - 1
    models: list[dict[str, Any]] = []
    for model, input_tokens, output_tokens in billed:
        resolved = resolve_model_energy(model)
        if input_tokens is not None or output_tokens is not None:
            total_tokens = (total_tokens or 0) + (input_tokens or 0) + (output_tokens or 0)
        weakest_source = min(weakest_source, _SOURCE_RANK.index(resolved.coeffs.source))
        weakest_resolution = min(weakest_resolution, _RESOLUTION_RANK.index(resolved.tier))
        entry: dict[str, Any] = {"model": model}
        if input_tokens is not None:
            entry["inputTokens"] = input_tokens
        if output_tokens is not None:
            entry["outputTokens"] = output_tokens
        if g_co2_per_kwh is not None:
            grams = grams_for_intensity(
                g_co2_per_kwh,
                model=model,
                input_tokens=input_tokens,
                output_tokens=output_tokens,
            )
            # Plain left-to-right addition: ``sum()`` compensates float error
            # on Python 3.12+, which would drift from the TS total.
            total = grams if total is None else total + grams
            entry["carbonGCo2"] = math.floor(grams * 100 + 0.5) / 100
        entry["energySource"] = resolved.coeffs.source
        entry["energyResolution"] = resolved.tier
        models.append(entry)
    return ModelUsageBill(
        models=models,
        model=billed[0][0],
        total_tokens=total_tokens,
        energy_source=_SOURCE_RANK[weakest_source],
        energy_resolution=_RESOLUTION_RANK[weakest_resolution],
        carbon_g_co2=total,
    )


__all__ = [
    "DEFAULT_PUE",
    "ENERGY_SOURCES",
    "LEGACY_KWH_PER_TASK",
    "MODEL_ENERGY_COEFFICIENTS",
    "MODEL_FAMILIES",
    "EnergyResolutionTier",
    "EnergySourceTier",
    "ModelEnergyCoefficients",
    "ModelUsageBill",
    "ResolvedModelEnergy",
    "bill_model_usage",
    "estimate_energy_kwh",
    "grams_for_intensity",
    "lookup_model_energy",
    "normalize_model_name",
    "resolve_model_energy",
]
