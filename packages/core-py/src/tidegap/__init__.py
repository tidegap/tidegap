"""Tidegap — carbon-aware scheduling for agentic AI workflows.

Python port of ``@tidegap/core``. Public surface mirrors the
TypeScript package so the two stay in sync.

Quick start
-----------

>>> import asyncio
>>> from tidegap import defer
>>> async def main():
...     return await defer(
...         lambda: 42,
...         deadline="2099-01-01T00:00:00Z",
...         carbon_budget_g=5,
...         region="US-CAL-CISO",
...     )
>>> asyncio.run(main())
42

The default scheduler runs in-memory. For durable receipts and
crash-recovery, instantiate a :class:`Scheduler` with a SQLite
``db_path``:

>>> from tidegap import Scheduler
>>> scheduler = Scheduler(db_path="/var/lib/tidegap/queue.sqlite")

See ``packages/core-py/README.md`` for the full API reference.
"""

from __future__ import annotations

from importlib.metadata import PackageNotFoundError
from importlib.metadata import version as _pkg_version

from .budget import (
    CarbonAlert,
    CarbonBudgetConfig,
    CarbonBudgetStatus,
    CarbonBudgetUsage,
    CarbonBudgetWindowKind,
    carbon_budget_config_path,
    carbon_budget_status,
    carbon_budget_usage,
    load_carbon_budget_config,
    receipt_carbon_g,
    window_bounds,
)
from .energy import (
    DEFAULT_PUE,
    ENERGY_SOURCES,
    LEGACY_KWH_PER_TASK,
    MODEL_ENERGY_COEFFICIENTS,
    MODEL_FAMILIES,
    EnergyResolutionTier,
    EnergySourceTier,
    ModelEnergyCoefficients,
    ResolvedModelEnergy,
    estimate_energy_kwh,
    grams_for_intensity,
    lookup_model_energy,
    normalize_model_name,
    resolve_model_energy,
)
from .errors import (
    CarbonBudgetExceededError,
    InvalidDeadlineError,
    SchedulerShutdownError,
    TaskCancelledError,
)
from .grid import (
    EntsoePeriod,
    EntsoeTimeSeries,
    GridFeed,
    build_default_grid_feed,
    eia_feed,
    electricity_maps_feed,
    entsoe_feed,
    mock_grid_feed,
    multi_source_grid_feed,
    parse_entsoe_xml,
    uk_carbon_intensity_feed,
    watttime_feed,
)
from .recommend import (
    RecommendAlternative,
    RecommendResult,
    recommend_window,
)
from .scheduler import (
    DEFAULT_REGION,
    ENERGY_KWH_PER_TASK,
    MAX_HORIZON_HOURS,
    TOLERANCE_FLOOR_G,
    TOLERANCE_FRACTION,
    DeferrableTask,
    Scheduler,
    SelectWindowResult,
    defer,
    normalize_deadline,
    pick_best_window,
    select_window,
)
from .sign import (
    SigningKeyPair,
    SigningNotInstalled,
    VerifyOutcome,
    VerifyResult,
    default_signing_key_path,
    is_signing_available,
    load_or_create_signing_key,
    sign_receipt,
    verify_receipt,
)
from .types import (
    Band,
    CarbonReceipt,
    DeferOptions,
    EnergyResolution,
    EnergySource,
    ForecastKind,
    GridForecast,
    GridForecastEntry,
    GridSignalType,
    GridSource,
    IntensitySource,
    Provider,
    ProviderCallSpec,
    TaskRecord,
    TaskStatus,
    TickResult,
    TickResultEntry,
    TokenCounts,
)

# The package version is declared once, in pyproject.toml. Read it back from
# the installed metadata rather than hard-coding a second copy here.
try:
    __version__ = _pkg_version("tidegap")
except PackageNotFoundError:  # pragma: no cover - source tree without install
    __version__ = "0+unknown"

__all__ = [
    "DEFAULT_PUE",
    "DEFAULT_REGION",
    "ENERGY_KWH_PER_TASK",
    "ENERGY_SOURCES",
    "LEGACY_KWH_PER_TASK",
    "MAX_HORIZON_HOURS",
    "MODEL_ENERGY_COEFFICIENTS",
    "MODEL_FAMILIES",
    "TOLERANCE_FLOOR_G",
    "TOLERANCE_FRACTION",
    "Band",
    "CarbonAlert",
    "CarbonBudgetConfig",
    "CarbonBudgetExceededError",
    "CarbonBudgetStatus",
    "CarbonBudgetUsage",
    "CarbonBudgetWindowKind",
    "CarbonReceipt",
    "DeferOptions",
    "DeferrableTask",
    "EnergyResolution",
    "EnergyResolutionTier",
    "EnergySource",
    "EnergySourceTier",
    "EntsoePeriod",
    "EntsoeTimeSeries",
    "ForecastKind",
    "GridFeed",
    "GridForecast",
    "GridForecastEntry",
    "GridSignalType",
    "GridSource",
    "IntensitySource",
    "InvalidDeadlineError",
    "ModelEnergyCoefficients",
    "Provider",
    "ProviderCallSpec",
    "RecommendAlternative",
    "RecommendResult",
    "ResolvedModelEnergy",
    "Scheduler",
    "SchedulerShutdownError",
    "SelectWindowResult",
    "SigningKeyPair",
    "SigningNotInstalled",
    "TaskCancelledError",
    "TaskRecord",
    "TaskStatus",
    "TickResult",
    "TickResultEntry",
    "TokenCounts",
    "VerifyOutcome",
    "VerifyResult",
    "__version__",
    "build_default_grid_feed",
    "carbon_budget_config_path",
    "carbon_budget_status",
    "carbon_budget_usage",
    "default_signing_key_path",
    "defer",
    "eia_feed",
    "electricity_maps_feed",
    "entsoe_feed",
    "estimate_energy_kwh",
    "grams_for_intensity",
    "is_signing_available",
    "load_carbon_budget_config",
    "load_or_create_signing_key",
    "lookup_model_energy",
    "mock_grid_feed",
    "multi_source_grid_feed",
    "normalize_deadline",
    "normalize_model_name",
    "parse_entsoe_xml",
    "pick_best_window",
    "receipt_carbon_g",
    "recommend_window",
    "resolve_model_energy",
    "select_window",
    "sign_receipt",
    "uk_carbon_intensity_feed",
    "verify_receipt",
    "watttime_feed",
    "window_bounds",
]
