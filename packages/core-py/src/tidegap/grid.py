"""Grid carbon-intensity feeds.

Built-in sources (ported 1:1 from ``packages/core-ts/src/grid.ts``):

- :func:`mock_grid_feed` — deterministic synthetic curve, zero-config.
- :func:`electricity_maps_feed` — Electricity Maps free-tier API (key
  required).
- :func:`uk_carbon_intensity_feed` — National Grid ESO Carbon Intensity
  API (GB only, no auth, real forecast, paginated up to 96h).
- :func:`eia_feed` — US EIA fuel-mix data for the major ISO/RTOs (key
  required; realised data served as a persistence forecast).
- :func:`entsoe_feed` — ENTSO-E realised generation for EU bidding zones
  (token required; realised data served as a persistence forecast).
- :func:`watttime_feed` — WattTime v3 marginal (co2_moer) forecasts for US
  ISO/RTO zones (username+password required; a real MARGINAL forecast,
  disclosed via signal_type="marginal").
- :func:`multi_source_grid_feed` — routes per zone across the feeds above.
- :func:`build_default_grid_feed` — best free feed per zone, mock fallback.

Feeds that return a genuine forward-looking series carry
``kind="forecast"``; feeds that project realised observations forward
(EIA, ENTSO-E) carry ``kind="persistence"`` so downstream surfaces can
disclose that they are not a meteorologically-aware forecast — matching
the TS port exactly.
"""

from __future__ import annotations

import logging
import math
import os
import re
from abc import ABC, abstractmethod
from collections.abc import Iterator
from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta
from typing import Final
from urllib.parse import quote

import httpx

from ._data import (
    BAND_THRESHOLDS,
    DEFAULT_BAND,
    DEFAULT_REGION_FLOOR,
    REGION_FLOORS,
    REGION_UTC_OFFSETS,
    SYNTHETIC_AMPLITUDE,
)
from ._env import env_value
from .types import Band, GridForecast, GridForecastEntry, GridSource

_log = logging.getLogger(__name__)

# Synthetic-curve params come from the JSON SSOT (regions.json / bands.json)
# via the generated ``_data`` module, shared byte-for-byte with the TS port.
_REGION_FLOOR: Final[dict[str, int]] = REGION_FLOORS
_DEFAULT_FLOOR: Final[int] = DEFAULT_REGION_FLOOR
_AMPLITUDE: Final[int] = SYNTHETIC_AMPLITUDE

_ELECTRICITY_MAPS_ENDPOINT: Final[str] = (
    "https://api.electricitymap.org/v3/carbon-intensity/forecast"
)
_FETCH_TIMEOUT_S: Final[float] = 5.0


def _classify(g: float) -> Band:
    """Bucket a gCO2/kWh value into a coarse band.

    Thresholds come from the JSON SSOT (bands.json) shared with the TS
    port, so JSON output round-trips.
    """
    for max_exclusive, band in BAND_THRESHOLDS:
        if g < max_exclusive:
            return band  # type: ignore[return-value]
    return DEFAULT_BAND  # type: ignore[return-value]


def _synthetic_intensity_for_hour(dt: datetime, region: str) -> int:
    """Build a synthetic intraday carbon curve.

    Real grid intensity in the US typically dips overnight (lots of
    base-load nuclear and hydro, plus wind) and peaks late afternoon
    (residential AC, gas peaker plants). We mimic that shape with a
    sinusoid whose trough sits at ~05:00 *local* time, using each
    region's UTC offset from the SSOT so the trough lands on a distinct
    UTC hour per region (matches the TS port exactly).
    """
    floor = _REGION_FLOOR.get(region, _DEFAULT_FLOOR)
    offset_h = REGION_UTC_OFFSETS.get(region, 0)
    utc_hour = dt.astimezone(UTC).hour
    local_hour = (utc_hour + offset_h) % 24
    phase = (local_hour - 17) * (math.pi / 12)
    value = floor + _AMPLITUDE * math.cos(phase)
    return max(0, round(value))


def _iso_utc(dt: datetime) -> str:
    """Render a datetime as a TS-compatible ISO-8601 string in UTC.

    Matches JavaScript's ``Date.prototype.toISOString`` output:
    millisecond precision, trailing ``Z``.
    """
    aware = dt.astimezone(UTC) if dt.tzinfo else dt.replace(tzinfo=UTC)
    # Truncate to milliseconds, like Date.prototype.toISOString.
    ms = aware.microsecond // 1000
    return aware.strftime("%Y-%m-%dT%H:%M:%S") + f".{ms:03d}Z"


def _now_utc() -> datetime:
    """Wall clock in UTC. Exposed for monkey-patching in tests."""
    return datetime.now(UTC)


def _round_half_up(x: float) -> int:
    """Round halves toward +inf, matching JavaScript ``Math.round`` (and
    the TS core). Python's builtin ``round`` is half-to-even, which
    diverges at exact ``.5`` boundaries; feed intensities must match the
    TS port byte-for-byte so a shared queue.db round-trips.
    """
    return math.floor(x + 0.5)


def _parse_iso(s: str) -> datetime | None:
    """Parse an ISO-8601 string; return ``None`` if unparseable.

    Accepts the JS-style trailing ``Z``. Naive strings are treated as
    UTC. Mirrors the ``new Date(...)`` parsing the TS feeds rely on.
    """
    try:
        if s.endswith("Z"):
            s = s[:-1] + "+00:00"
        dt = datetime.fromisoformat(s)
    except (ValueError, TypeError):
        return None
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=UTC)
    return dt


class GridFeed(ABC):
    """A source of carbon-intensity forecasts for a region."""

    source: GridSource

    @abstractmethod
    async def fetch_forecast(self, region: str, hours: int) -> GridForecast:
        """Return up to ``hours`` hourly buckets for ``region``."""


class _MockGridFeed(GridFeed):
    """Deterministic synthetic feed for dev and tests."""

    source: GridSource = "mock"

    async def fetch_forecast(self, region: str, hours: int) -> GridForecast:
        now = _now_utc().replace(minute=0, second=0, microsecond=0)
        entries: list[GridForecastEntry] = []
        for i in range(hours):
            t = now + timedelta(hours=i)
            g = _synthetic_intensity_for_hour(t, region)
            entries.append(
                GridForecastEntry(
                    datetime=_iso_utc(t),
                    carbon_intensity_g_co2_per_kwh=g,
                    band=_classify(g),
                )
            )
        return GridForecast(
            region=region,
            source="mock",
            generated_at=_iso_utc(_now_utc()),
            entries=entries,
            kind="forecast",
        )


def mock_grid_feed() -> GridFeed:
    """Construct a deterministic mock grid feed.

    The returned feed is stateless and safe to share across schedulers
    and threads.
    """
    return _MockGridFeed()


class _ElectricityMapsFeed(GridFeed):
    """Electricity Maps free-tier API client.

    Docs: https://www.electricitymaps.com/free-tier-api
    Endpoint: ``GET /v3/carbon-intensity/forecast?zone=<region>``
    Header: ``auth-token: <key>``

    Falls back to the mock feed (and logs) if the API key is missing,
    the request fails, or the response shape is unexpected.
    """

    source: GridSource = "electricityMaps"

    def __init__(self, api_key: str, *, timeout_s: float = _FETCH_TIMEOUT_S) -> None:
        self._key = api_key
        self._timeout_s = timeout_s
        self._mock = _MockGridFeed()

    async def fetch_forecast(self, region: str, hours: int) -> GridForecast:
        url = f"{_ELECTRICITY_MAPS_ENDPOINT}?zone={quote(region, safe='')}"
        try:
            async with httpx.AsyncClient(timeout=httpx.Timeout(self._timeout_s)) as client:
                res = await client.get(url, headers={"auth-token": self._key})
            if res.status_code != httpx.codes.OK:
                raise RuntimeError(f"Electricity Maps returned {res.status_code}")
            payload = res.json()
            if not isinstance(payload, dict):
                raise RuntimeError("Electricity Maps response was not a JSON object")
            raw = payload.get("forecast") or []
            if not isinstance(raw, list):
                raise RuntimeError("Electricity Maps response.forecast was not a list")
            raw = raw[:hours]
            if not raw:
                raise RuntimeError("Electricity Maps returned empty forecast")
            entries: list[GridForecastEntry] = []
            for e in raw:
                if not isinstance(e, dict):
                    raise RuntimeError("Electricity Maps entry was not an object")
                dt_str = e.get("datetime")
                intensity = e.get("carbonIntensity")
                if dt_str is None or intensity is None:
                    raise RuntimeError("Electricity Maps entry missing fields")
                entries.append(
                    GridForecastEntry(
                        datetime=str(dt_str),
                        carbon_intensity_g_co2_per_kwh=round(float(intensity)),
                        band=_classify(float(intensity)),
                    )
                )
            return GridForecast(
                region=region,
                source="electricityMaps",
                generated_at=_iso_utc(_now_utc()),
                entries=entries,
                kind="forecast",
            )
        except (httpx.HTTPError, RuntimeError, ValueError) as err:
            _log.warning(
                "[tidegap/grid] electricity-maps fetch failed (%s); falling back to mock",
                err,
            )
            return await self._mock.fetch_forecast(region, hours)


class _MockWithWarning(GridFeed):
    """Mock feed that warns once that no API key was configured.

    Wrapped so that the user still sees ``source = "mock"`` and the
    fallback is explicit. Matches the TS implementation's behavior.
    """

    source: GridSource = "mock"

    def __init__(
        self,
        message: str = (
            "[tidegap/grid] no TIDEGAP_ELECTRICITY_MAPS_API_KEY set — using mock data"
        ),
    ) -> None:
        self._mock = _MockGridFeed()
        self._warned = False
        self._message = message

    async def fetch_forecast(self, region: str, hours: int) -> GridForecast:
        if not self._warned:
            _log.warning(self._message)
            self._warned = True
        return await self._mock.fetch_forecast(region, hours)


def electricity_maps_feed(
    api_key: str | None = None,
    *,
    timeout_s: float = _FETCH_TIMEOUT_S,
) -> GridFeed:
    """Construct an Electricity Maps feed.

    Reads the API key from the ``TIDEGAP_ELECTRICITY_MAPS_API_KEY``
    environment variable if not passed explicitly. If no key is found,
    returns a mock-backed feed that warns once on first use — matching
    the TS implementation's deliberate fallback so the stack still runs
    end-to-end for developers who haven't signed up.

    Parameters
    ----------
    api_key:
        Electricity Maps API key. Optional; falls back to env.
    timeout_s:
        Hard per-request timeout, in seconds. Defaults to 5s — without
        one a degraded Electricity Maps edge can hang the scheduler
        indefinitely.
    """
    key = api_key or env_value("ELECTRICITY_MAPS_API_KEY")
    if not key:
        return _MockWithWarning()
    return _ElectricityMapsFeed(key, timeout_s=timeout_s)


# --------------------------------------------------------------------------- #
# UK National Grid ESO Carbon Intensity API — ``api.carbonintensity.org.uk``.
#
# Pros: free, no auth, no rate-limit registration, real forward forecast.
# Cons: GB only. Other zones fall back to the synthetic mock so this feed
# is safe to use as the default zone-agnostic feed. Ported 1:1 from the TS
# ``ukCarbonIntensityFeed``.


_UK_FETCH_TIMEOUT_S: Final[float] = 5.0


class _UkCarbonIntensityFeed(GridFeed):
    """UK National Grid ESO Carbon Intensity feed (GB only).

    Each ``/fw48h`` page covers 48 hours; when more than 48 hours are
    requested (the scheduler's MAX_HORIZON is 72h) a second page is
    fetched at ``from + 48h`` and the two are merged, extending coverage
    to 96h.

    The upstream API returns 30-minute settlement periods; we average
    each consecutive pair into the hourly buckets Tidegap uses elsewhere.
    The API's first settlement period can start *before* the requested
    top-of-hour (e.g. a request at 12:00 returns a period starting
    11:30), so leading periods are dropped until one starts at :00 — that
    keeps every hourly bucket aligned to ``[HH:00, HH+1:00)``. Actual
    intensity is preferred over forecast where the backfilled ``actual``
    field is populated.

    Docs: https://carbon-intensity.github.io/api-definitions/#carbon-intensity
    """

    source: GridSource = "ukCarbonIntensity"

    def __init__(self, *, timeout_s: float = _UK_FETCH_TIMEOUT_S) -> None:
        self._timeout_s = timeout_s
        self._mock = _MockGridFeed()

    async def _fetch_page(self, from_dt: datetime) -> list[dict]:
        # API wants YYYY-MM-DDTHH:MMZ (no seconds), matching the TS
        # ``from.toISOString().slice(0, 16) + "Z"``.
        from_str = from_dt.astimezone(UTC).strftime("%Y-%m-%dT%H:%M") + "Z"
        url = f"https://api.carbonintensity.org.uk/intensity/{from_str}/fw48h"
        async with httpx.AsyncClient(timeout=httpx.Timeout(self._timeout_s)) as client:
            res = await client.get(url, headers={"Accept": "application/json"})
        if not res.is_success:
            raise RuntimeError(f"UK Carbon Intensity API returned {res.status_code}")
        payload = res.json()
        if not isinstance(payload, dict):
            raise RuntimeError("UK Carbon Intensity response was not a JSON object")
        data = payload.get("data") or []
        if not isinstance(data, list):
            raise RuntimeError("UK Carbon Intensity response.data was not a list")
        return data

    async def fetch_forecast(self, region: str, hours: int) -> GridForecast:
        if region != "GB":
            _log.warning(
                '[tidegap/grid] ukCarbonIntensityFeed only supports zone "GB" '
                '(got "%s") — using mock',
                region,
            )
            return await self._mock.fetch_forecast(region, hours)
        try:
            now = _now_utc().replace(minute=0, second=0, microsecond=0)

            # Each page covers 48h. For horizons beyond 48h fetch a
            # second page at from+48h; the two pages can share a boundary
            # period, so merge by ``from`` timestamp before pairing.
            pages = [await self._fetch_page(now)]
            if hours > 48:
                pages.append(await self._fetch_page(now + timedelta(hours=48)))
            by_from: dict[int, dict] = {}
            for page in pages:
                for p in page:
                    if not isinstance(p, dict):
                        continue
                    t = _parse_iso(str(p.get("from")))
                    if t is None:
                        continue
                    key = int(t.timestamp() * 1000)
                    if key not in by_from:
                        by_from[key] = p
            raw = [by_from[k] for k in sorted(by_from)]
            if not raw:
                raise RuntimeError("UK Carbon Intensity API returned empty forecast")

            # The first settlement period can start before the requested
            # top-of-hour. Drop leading half-periods so consecutive-pair
            # averaging yields buckets aligned to ``[HH:00, HH+1:00)``.
            first_aligned = -1
            for i, p in enumerate(raw):
                t = _parse_iso(str(p.get("from")))
                if t is not None and t.minute == 0:
                    first_aligned = i
                    break
            if first_aligned < 0:
                raise RuntimeError(
                    "UK Carbon Intensity API returned no top-of-hour-aligned periods"
                )

            hourly: list[GridForecastEntry] = []
            i = first_aligned
            while i + 1 < len(raw) and len(hourly) < hours:
                a = raw[i]
                b = raw[i + 1]
                ai = a.get("intensity") if isinstance(a.get("intensity"), dict) else {}
                bi = b.get("intensity") if isinstance(b.get("intensity"), dict) else {}
                va = ai.get("actual")
                if va is None:
                    va = ai.get("forecast")
                vb = bi.get("actual")
                if vb is None:
                    vb = bi.get("forecast")
                if va is None or vb is None:
                    i += 2
                    continue
                avg = _round_half_up((float(va) + float(vb)) / 2)
                a_from = _parse_iso(str(a.get("from")))
                hourly.append(
                    GridForecastEntry(
                        datetime=_iso_utc(a_from) if a_from else str(a.get("from")),
                        carbon_intensity_g_co2_per_kwh=avg,
                        band=_classify(avg),
                    )
                )
                i += 2
            if not hourly:
                raise RuntimeError(
                    "UK Carbon Intensity API returned no usable hourly entries"
                )
            return GridForecast(
                region=region,
                source="ukCarbonIntensity",
                generated_at=_iso_utc(_now_utc()),
                # A genuine forward forecast published by NG ESO.
                kind="forecast",
                entries=hourly,
            )
        except (httpx.HTTPError, RuntimeError, ValueError) as err:
            _log.warning(
                "[tidegap/grid] uk-carbon-intensity fetch failed (%s); "
                "falling back to mock",
                err,
            )
            return await self._mock.fetch_forecast(region, hours)


def uk_carbon_intensity_feed(*, timeout_s: float = _UK_FETCH_TIMEOUT_S) -> GridFeed:
    """Construct a UK Carbon Intensity feed (GB only, no auth).

    Non-GB zones and any request failure degrade to the synthetic mock,
    so this feed is safe to use as a zone-agnostic default fallback.
    """
    return _UkCarbonIntensityFeed(timeout_s=timeout_s)


# --------------------------------------------------------------------------- #
# Lifecycle emission factors (grams CO2-equivalent per kWh).
#
# Sourced from IPCC AR5 WG III Annex III (median lifecycle values), with
# Schlömer et al. (2014) as the canonical reference. Used by the EIA and
# ENTSO-E adapters to convert generation-mix data into a single
# carbon-intensity number per hour. Values match the TS
# ``EMISSION_FACTORS_G_CO2_PER_KWH`` exactly.


_EMISSION_FACTORS_G_CO2_PER_KWH: Final[dict[str, int]] = {
    "coal": 820,
    "coal_lignite": 1050,
    "gas": 490,
    "oil": 740,
    "oil_shale": 1000,
    "peat": 1000,
    "nuclear": 12,
    "solar": 48,
    "wind_onshore": 11,
    "wind_offshore": 12,
    "hydro": 24,
    "geothermal": 38,
    "biomass": 230,
    "waste": 700,
    "marine": 50,
    "other": 700,
}


# --------------------------------------------------------------------------- #
# EIA Open Data API — ``api.eia.gov``.
#
# Returns *historical* fuel-mix data only; served as a *persistence*
# forecast (``kind="persistence"``): each future hour H gets the most
# recent realized observation whose UTC hour-of-day matches H, keyed by
# the observation's own timestamp. This keeps the diurnal curve in phase
# even when EIA publishes with a lag. Ported 1:1 from the TS ``eiaFeed``.


#: EIA respondent codes by zone.
EIA_RESPONDENT_BY_ZONE: Final[dict[str, str]] = {
    "US-CAL-CISO": "CISO",
    "US-TEX-ERCO": "ERCO",
    "US-NE-ISNE": "ISNE",
    "US-MIDA-PJM": "PJM",
    "US-NY-NYIS": "NYIS",
    "US-MIDW-MISO": "MISO",
}

#: EIA fuel-type codes → emission-factor key.
_EIA_FUEL_FACTORS: Final[dict[str, int]] = {
    "COL": _EMISSION_FACTORS_G_CO2_PER_KWH["coal"],
    "NG": _EMISSION_FACTORS_G_CO2_PER_KWH["gas"],
    "OIL": _EMISSION_FACTORS_G_CO2_PER_KWH["oil"],
    "NUC": _EMISSION_FACTORS_G_CO2_PER_KWH["nuclear"],
    "SUN": _EMISSION_FACTORS_G_CO2_PER_KWH["solar"],
    "WND": _EMISSION_FACTORS_G_CO2_PER_KWH["wind_onshore"],
    "WAT": _EMISSION_FACTORS_G_CO2_PER_KWH["hydro"],
    "OTH": _EMISSION_FACTORS_G_CO2_PER_KWH["other"],
}

_EIA_FETCH_TIMEOUT_S: Final[float] = 8.0


# How far back the EIA request reaches. EIA-930 fuel-type data is published
# with a lag of up to a day (19h observed on 2026-10-17), and the feed needs
# all 24 hours-of-day, so the window must be 24h plus the worst lag. A 30h
# window left 11-15 hours-of-day and sent every US ISO to the mock.
_EIA_HISTORY_HOURS = 72


class _EiaFeed(GridFeed):
    """Carbon-intensity feed backed by the US EIA v2 Open Data API.

    Returns a synthesized hourly persistence forecast from the last ~30
    hours of realized fuel mix. Requires full 24h-of-day coverage — a
    short tail throws, so the caller degrades to the mock loudly.
    """

    source: GridSource = "eia"

    def __init__(self, api_key: str, *, timeout_s: float = _EIA_FETCH_TIMEOUT_S) -> None:
        self._key = api_key
        self._timeout_s = timeout_s
        self._mock = _MockGridFeed()

    async def fetch_forecast(self, region: str, hours: int) -> GridForecast:
        respondent = EIA_RESPONDENT_BY_ZONE.get(region)
        if respondent is None:
            _log.warning(
                '[tidegap/grid] eiaFeed does not cover zone "%s" — using mock',
                region,
            )
            return await self._mock.fetch_forecast(region, hours)
        try:
            # EIA timestamps are UTC; the "period" field is "YYYY-MM-DDTHH".
            now = _now_utc()
            end_hour = now.replace(minute=0, second=0, microsecond=0)
            start_hour = end_hour - timedelta(hours=_EIA_HISTORY_HOURS)

            def _fmt(d: datetime) -> str:
                return d.astimezone(UTC).strftime("%Y-%m-%dT%H")

            params: list[tuple[str, str]] = [
                ("api_key", self._key),
                ("frequency", "hourly"),
                ("data[0]", "value"),
                ("facets[respondent][]", respondent),
                ("start", _fmt(start_hour)),
                ("end", _fmt(end_hour)),
                ("sort[0][column]", "period"),
                ("sort[0][direction]", "asc"),
                ("length", "5000"),
            ]
            # Multiple fueltype facets need to be appended individually.
            for code in _EIA_FUEL_FACTORS:
                params.append(("facets[fueltype][]", code))
            url = "https://api.eia.gov/v2/electricity/rto/fuel-type-data/data/"

            async with httpx.AsyncClient(
                timeout=httpx.Timeout(self._timeout_s)
            ) as client:
                res = await client.get(url, params=params)
            if not res.is_success:
                raise RuntimeError(f"EIA API returned {res.status_code}")
            payload = res.json()
            rows = (
                payload.get("response", {}).get("data", [])
                if isinstance(payload, dict)
                else []
            )
            if not rows:
                raise RuntimeError("EIA API returned no rows")

            # Group by period, compute weighted-average intensity per hour.
            by_period: dict[str, dict[str, float]] = {}
            for row in rows:
                if not isinstance(row, dict):
                    continue
                factor = _EIA_FUEL_FACTORS.get(row.get("fueltype"))
                if factor is None:
                    continue
                raw_v = row.get("value")
                try:
                    v = float(raw_v) if raw_v is not None else None
                except (TypeError, ValueError):
                    continue
                if v is None or not math.isfinite(v) or v < 0:
                    continue
                period = row.get("period")
                if not isinstance(period, str):
                    continue
                cell = by_period.setdefault(period, {"num": 0.0, "den": 0.0})
                cell["num"] += v * factor
                cell["den"] += v

            # Index realized intensities by UTC hour-of-day, taken from
            # each observation's own timestamp. Ascending iteration means
            # later observations overwrite earlier ones, so each slot
            # holds the most recent value for that hour-of-day.
            by_hour_of_day: dict[int, int] = {}
            for period in sorted(by_period):
                cell = by_period[period]
                if cell["den"] == 0:
                    continue
                try:
                    hour_of_day = int(period[11:13])
                except ValueError:
                    continue
                if hour_of_day < 0 or hour_of_day > 23:
                    continue
                by_hour_of_day[hour_of_day] = _round_half_up(cell["num"] / cell["den"])
            if not by_hour_of_day:
                raise RuntimeError("EIA API returned no usable fuel-mix rows")
            # Require full diurnal coverage — tiling a short tail would
            # misassign hours.
            if len(by_hour_of_day) < 24:
                raise RuntimeError(
                    f"EIA history covers only {len(by_hour_of_day)}/24 "
                    "hours-of-day — refusing to synthesise a persistence forecast"
                )

            # Persistence forecast: future hour H gets the most recent
            # realized observation whose UTC hour-of-day matches H.
            start_ts = now.replace(minute=0, second=0, microsecond=0)
            entries: list[GridForecastEntry] = []
            for i in range(hours):
                t = start_ts + timedelta(hours=i)
                g = by_hour_of_day[t.hour]
                entries.append(
                    GridForecastEntry(
                        datetime=_iso_utc(t),
                        carbon_intensity_g_co2_per_kwh=g,
                        band=_classify(g),
                    )
                )
            return GridForecast(
                region=region,
                source="eia",
                generated_at=_iso_utc(_now_utc()),
                # Realized data projected forward — not a real forecast.
                kind="persistence",
                entries=entries,
            )
        except (httpx.HTTPError, RuntimeError, ValueError, KeyError) as err:
            _log.warning(
                "[tidegap/grid] eia fetch failed (%s); falling back to mock",
                err,
            )
            return await self._mock.fetch_forecast(region, hours)


def eia_feed(
    api_key: str | None = None, *, timeout_s: float = _EIA_FETCH_TIMEOUT_S
) -> GridFeed:
    """Construct an EIA fuel-mix persistence feed for US ISO/RTO zones.

    Reads the key from ``TIDEGAP_EIA_API_KEY`` when not passed. With no key,
    returns a mock-backed feed that warns once — matching the TS port's
    deliberate fallback so the stack still runs end-to-end.
    """
    key = api_key or env_value("EIA_API_KEY")
    if not key:
        return _MockWithWarning(
            "[tidegap/grid] no TIDEGAP_EIA_API_KEY set — "
            "using mock data for EIA-eligible zones"
        )
    return _EiaFeed(key, timeout_s=timeout_s)


# --------------------------------------------------------------------------- #
# ENTSO-E Transparency Platform — ``web-api.tp.entsoe.eu``.
#
# Free (with a security-token registration), covers every European
# bidding zone. XML response parsed with a small regex-based reader
# scoped to the shape ENTSO-E returns (documentType A75, realised
# generation per type), served as a persistence forecast. Ported 1:1
# from the TS ``entsoeFeed`` / ``parseEntsoeXml``.


#: ENTSO-E bidding-zone EIC codes by region.
ENTSOE_BIDDING_ZONE_BY_REGION: Final[dict[str, str]] = {
    "FR": "10YFR-RTE------C",
    "DE": "10Y1001A1001A82H",
    "ES": "10YES-REE------0",
    "IT": "10YIT-GRTN-----B",
    "NL": "10YNL----------L",
}

#: ENTSO-E psrType codes → emission factor.
_ENTSOE_PSR_FACTORS: Final[dict[str, int]] = {
    "B01": _EMISSION_FACTORS_G_CO2_PER_KWH["biomass"],
    "B02": _EMISSION_FACTORS_G_CO2_PER_KWH["coal_lignite"],
    "B03": _EMISSION_FACTORS_G_CO2_PER_KWH["gas"],
    "B04": _EMISSION_FACTORS_G_CO2_PER_KWH["gas"],
    "B05": _EMISSION_FACTORS_G_CO2_PER_KWH["coal"],
    "B06": _EMISSION_FACTORS_G_CO2_PER_KWH["oil"],
    "B07": _EMISSION_FACTORS_G_CO2_PER_KWH["oil_shale"],
    "B08": _EMISSION_FACTORS_G_CO2_PER_KWH["peat"],
    "B09": _EMISSION_FACTORS_G_CO2_PER_KWH["geothermal"],
    "B10": _EMISSION_FACTORS_G_CO2_PER_KWH["hydro"],
    "B11": _EMISSION_FACTORS_G_CO2_PER_KWH["hydro"],
    "B12": _EMISSION_FACTORS_G_CO2_PER_KWH["hydro"],
    "B13": _EMISSION_FACTORS_G_CO2_PER_KWH["marine"],
    "B14": _EMISSION_FACTORS_G_CO2_PER_KWH["nuclear"],
    "B15": _EMISSION_FACTORS_G_CO2_PER_KWH["biomass"],
    "B16": _EMISSION_FACTORS_G_CO2_PER_KWH["solar"],
    "B17": _EMISSION_FACTORS_G_CO2_PER_KWH["waste"],
    "B18": _EMISSION_FACTORS_G_CO2_PER_KWH["wind_offshore"],
    "B19": _EMISSION_FACTORS_G_CO2_PER_KWH["wind_onshore"],
    "B20": _EMISSION_FACTORS_G_CO2_PER_KWH["other"],
}

_ENTSOE_FETCH_TIMEOUT_S: Final[float] = 10.0

# Regexes scoped to the stable ENTSO-E response shape. Blocks
# (``<text>``, ``<TimeSeries>``, ``<Period>``) are cut by ``_blocks`` instead.
_ENTSOE_ACK_RE = re.compile(r"<Acknowledgement_MarketDocument[\s>]")
_ENTSOE_OUT_ZONE_RE = re.compile(r"<outBiddingZone_Domain\.mRID[\s>]")
_ENTSOE_PSR_RE = re.compile(r"<psrType>([A-Z0-9]+)</psrType>")
_ENTSOE_START_RE = re.compile(r"<start>([0-9TZ:+-]+)</start>")
_ENTSOE_RES_RE = re.compile(r"<resolution>PT(\d+)M</resolution>")
_ENTSOE_POINT_RE = re.compile(
    r"<Point>\s*<position>(\d+)</position>\s*"
    r"<quantity>([\d.]+)</quantity>\s*</Point>"
)


@dataclass(slots=True)
class EntsoePeriod:
    """One ``<Period>`` inside an ENTSO-E TimeSeries."""

    #: ISO-8601 start of the period's time interval.
    start: str
    resolution_min: int
    #: Points keyed by their ``<position>`` (1-based within the period).
    points: list[tuple[int, float]] = field(default_factory=list)


@dataclass(slots=True)
class EntsoeTimeSeries:
    """One generation ``<TimeSeries>`` from an ENTSO-E A75 document."""

    psr_type: str
    periods: list[EntsoePeriod] = field(default_factory=list)


def _blocks(xml: str, tag: str) -> Iterator[str]:
    """Yield the inner text of each ``<tag>...</tag>`` in order.

    Pairs every open with the nearest close after it -- what
    ``<tag>(.*?)</tag>`` with ``re.DOTALL`` matches, in linear time. When
    one open has no close, no later open has one either, so the scan stops.
    """
    open_tag = f"<{tag}>"
    close_tag = f"</{tag}>"
    pos = 0
    while True:
        start = xml.find(open_tag, pos)
        if start == -1:
            return
        end = xml.find(close_tag, start + len(open_tag))
        if end == -1:
            return
        yield xml[start + len(open_tag) : end]
        pos = end + len(close_tag)


def parse_entsoe_xml(xml: str) -> list[EntsoeTimeSeries]:
    """Minimal ENTSO-E XML extractor — port of the TS ``parseEntsoeXml``.

    Returns, for each *generation* TimeSeries block, the psrType plus
    every ``<Period>`` (each with its own start/resolution) and each
    Point's ``<position>`` and ``<quantity>``.

    Semantics handled here:
      - ``<Acknowledgement_MarketDocument>`` (ENTSO-E's error envelope,
        e.g. "no data") raises — an empty result must not masquerade as
        data.
      - TimeSeries carrying ``outBiddingZone_Domain.mRID`` are
        CONSUMPTION series (e.g. pumped-storage pumping) and are skipped;
        only generation series (inBiddingZone) are returned.
      - Multi-``<Period>`` TimeSeries are parsed per-Period, since each
        Period has its own start and resolution.
      - ``<position>`` is captured so curveType A03 gaps do not shift
        subsequent points; callers must compute each point's timestamp as
        ``periodStart + (position - 1) * resolution``.
    """
    if _ENTSOE_ACK_RE.search(xml):
        text = next(_blocks(xml, "text"), None)
        reason = text.strip() if text is not None else "no reason text in document"
        raise RuntimeError(
            f"ENTSO-E returned an Acknowledgement document: {reason}"
        )
    out: list[EntsoeTimeSeries] = []
    for block in _blocks(xml, "TimeSeries"):
        # outBiddingZone_Domain.mRID marks a consumption series (energy
        # taken OFF the grid, e.g. pumped-storage pumping). Counting it as
        # generation would systematically drag intensity down.
        if _ENTSOE_OUT_ZONE_RE.search(block):
            continue
        psr_m = _ENTSOE_PSR_RE.search(block)
        if not psr_m:
            continue
        periods: list[EntsoePeriod] = []
        for p_block in _blocks(block, "Period"):
            start_m = _ENTSOE_START_RE.search(p_block)
            res_m = _ENTSOE_RES_RE.search(p_block)
            if not start_m or not res_m:
                continue
            points: list[tuple[int, float]] = []
            for pt_m in _ENTSOE_POINT_RE.finditer(p_block):
                position = int(pt_m.group(1))
                quantity = float(pt_m.group(2))
                if not math.isfinite(quantity):
                    continue
                points.append((position, quantity))
            if not points:
                continue
            periods.append(
                EntsoePeriod(
                    start=start_m.group(1),
                    resolution_min=int(res_m.group(1)),
                    points=points,
                )
            )
        if not periods:
            continue
        out.append(EntsoeTimeSeries(psr_type=psr_m.group(1), periods=periods))
    return out


class _EntsoeFeed(GridFeed):
    """Carbon-intensity feed backed by ENTSO-E realised generation (A75).

    Returns up to ``hours`` hourly entries computed from the per-fuel
    generation breakdown, served as a persistence forecast anchored by
    UTC hour-of-day — see :class:`_EiaFeed` for the phase-correctness
    rationale.
    """

    source: GridSource = "entsoe"

    def __init__(
        self, security_token: str, *, timeout_s: float = _ENTSOE_FETCH_TIMEOUT_S
    ) -> None:
        self._token = security_token
        self._timeout_s = timeout_s
        self._mock = _MockGridFeed()

    async def fetch_forecast(self, region: str, hours: int) -> GridForecast:
        zone = ENTSOE_BIDDING_ZONE_BY_REGION.get(region)
        if zone is None:
            _log.warning(
                '[tidegap/grid] entsoeFeed does not cover zone "%s" — using mock',
                region,
            )
            return await self._mock.fetch_forecast(region, hours)
        try:
            # Realised generation per type (A75) — most recent hour with
            # data. ENTSO-E expects period in YYYYMMDDhhmm UTC.
            now = _now_utc()
            end_hour = now.replace(minute=0, second=0, microsecond=0)
            start_hour = end_hour - timedelta(hours=24)

            def _fmt(d: datetime) -> str:
                return d.astimezone(UTC).strftime("%Y%m%d%H%M")

            params = {
                "securityToken": self._token,
                "documentType": "A75",
                "processType": "A16",
                "in_Domain": zone,
                "periodStart": _fmt(start_hour),
                "periodEnd": _fmt(end_hour),
            }
            url = "https://web-api.tp.entsoe.eu/api"
            async with httpx.AsyncClient(
                timeout=httpx.Timeout(self._timeout_s)
            ) as client:
                res = await client.get(
                    url, params=params, headers={"Accept": "application/xml"}
                )
            if not res.is_success:
                raise RuntimeError(f"ENTSO-E API returned {res.status_code}")
            series = parse_entsoe_xml(res.text)
            if not series:
                raise RuntimeError("ENTSO-E returned no TimeSeries blocks")

            # Bucket every generation point into UTC hours and accumulate
            # weighted-average numerator/denominator per hour. Each
            # point's timestamp comes from its Period start + (position -
            # 1) * resolution, so curveType A03 gaps leave a hole instead
            # of shifting subsequent points.
            by_hour: dict[datetime, dict[str, float]] = {}
            for ts in series:
                factor = _ENTSOE_PSR_FACTORS.get(ts.psr_type)
                if factor is None:
                    continue
                for period in ts.periods:
                    period_start = _parse_iso(period.start)
                    if period_start is None:
                        continue
                    for position, quantity in period.points:
                        if not math.isfinite(quantity) or quantity < 0:
                            continue
                        t = period_start + timedelta(
                            minutes=(position - 1) * period.resolution_min
                        )
                        # Snap to the start of the hour containing t.
                        hr = t.replace(minute=0, second=0, microsecond=0)
                        # Weight by how much of an hour this point covers.
                        weight = period.resolution_min / 60
                        cell = by_hour.setdefault(hr, {"num": 0.0, "den": 0.0})
                        cell["num"] += quantity * weight * factor
                        cell["den"] += quantity * weight

            # Index realized hourly intensities by UTC hour-of-day.
            # Ascending iteration means the most recent observation wins
            # each hour-of-day slot.
            by_hour_of_day: dict[int, int] = {}
            for hr in sorted(by_hour):
                cell = by_hour[hr]
                if cell["den"] == 0:
                    continue
                by_hour_of_day[hr.hour] = _round_half_up(cell["num"] / cell["den"])
            if not by_hour_of_day:
                raise RuntimeError("ENTSO-E returned no usable hourly buckets")
            if len(by_hour_of_day) < 24:
                raise RuntimeError(
                    f"ENTSO-E history covers only {len(by_hour_of_day)}/24 "
                    "hours-of-day — refusing to synthesise a persistence forecast"
                )

            start_ts = now.replace(minute=0, second=0, microsecond=0)
            entries: list[GridForecastEntry] = []
            for i in range(hours):
                t = start_ts + timedelta(hours=i)
                g = by_hour_of_day[t.hour]
                entries.append(
                    GridForecastEntry(
                        datetime=_iso_utc(t),
                        carbon_intensity_g_co2_per_kwh=g,
                        band=_classify(g),
                    )
                )
            return GridForecast(
                region=region,
                source="entsoe",
                generated_at=_iso_utc(_now_utc()),
                # Realised A75 data projected forward — not a real forecast.
                kind="persistence",
                entries=entries,
            )
        except (httpx.HTTPError, RuntimeError, ValueError, KeyError) as err:
            _log.warning(
                "[tidegap/grid] entsoe fetch failed (%s); falling back to mock",
                err,
            )
            return await self._mock.fetch_forecast(region, hours)


def entsoe_feed(
    security_token: str | None = None,
    *,
    timeout_s: float = _ENTSOE_FETCH_TIMEOUT_S,
) -> GridFeed:
    """Construct an ENTSO-E realised-generation persistence feed for EU zones.

    Reads the token from ``TIDEGAP_ENTSOE_SECURITY_TOKEN`` when not passed.
    With no token, returns a mock-backed feed that warns once — matching
    the TS port's deliberate fallback so the stack still runs end-to-end.
    """
    token = security_token or env_value("ENTSOE_SECURITY_TOKEN")
    if not token:
        return _MockWithWarning(
            "[tidegap/grid] no TIDEGAP_ENTSOE_SECURITY_TOKEN set — "
            "using mock data for EU zones"
        )
    return _EntsoeFeed(token, timeout_s=timeout_s)


# --------------------------------------------------------------------------- #
# WattTime API v3 — ``api.watttime.org``.
#
# Marginal operating emissions rate (MOER, signal_type=co2_moer) FORECASTS
# for US ISO/RTO zones. Unlike every other feed (which report the grid's
# blended AVERAGE intensity), WattTime reports the emissions rate of the
# generator that responds to a marginal change in load — the signal a
# deferral decision actually moves. Because it is a genuine forward
# forecast, it takes precedence over the EIA persistence heuristic for the
# US zones it covers when credentials are configured. Ported 1:1 from the
# TS ``wattTimeFeed``.
#
# Auth: HTTP Basic to ``GET /login`` (WATTTIME_USERNAME / WATTTIME_PASSWORD)
# returns a short-lived bearer token, cached in-process on the instance. On
# a 401/403 we re-login ONCE and retry; any further failure falls through
# to the next feed in the chain (EIA → mock).
#
# Forecast: ``GET /v3/forecast?region=<R>&signal_type=co2_moer`` returns
# sub-hourly (typically 5-minute) MOER points in **lbs CO2 / MWh**. We
# average the points in each UTC hour and convert to gCO2/kWh
# (x 453.592 / 1000). Marginal intensity routinely exceeds average — the
# band classifier is intensity-based and signal-agnostic, so that is
# expected.
#
# Zone → WattTime v3 region mapping. WattTime v3 does NOT expose clean
# ISO-level codes; its regions are granular grid-balancing sub-regions.
# Only ``CAISO_NORTH`` is VERIFIED against WattTime's live public v3 docs
# (the free-tier default region in every official example). The remaining
# five are the long-standing WattTime BA abbreviations but could NOT be
# confirmed against the auth-gated /v3/my-access + /maps endpoints — they
# are marked UNVERIFIED-AGAINST-LIVE-API. A wrong region code simply 404s
# and falls through to EIA, so an unverified guess degrades safely.
#
# Docs: https://docs.watttime.org/


#: Electricity-Maps-style zone → WattTime v3 region code.
WATTTIME_REGION_BY_ZONE: Final[dict[str, str]] = {
    # VERIFIED (WattTime v3 public docs, 2026-07): free-tier default region.
    "US-CAL-CISO": "CAISO_NORTH",
    # UNVERIFIED-AGAINST-LIVE-API — believed-correct WattTime BA
    # abbreviations; confirm against /v3/my-access with real credentials.
    # Bad codes 404 and fall through to EIA.
    "US-TEX-ERCO": "ERCOT_EASTTX",  # UNVERIFIED
    "US-NE-ISNE": "ISONE_WCMA",  # UNVERIFIED
    "US-NY-NYIS": "NYISO_NYC",  # UNVERIFIED
    "US-MIDA-PJM": "PJM_ROTO",  # UNVERIFIED
    "US-MIDW-MISO": "MISO_INDIANAPOLIS",  # UNVERIFIED
}

#: lbs CO2 / MWh → g CO2 / kWh: 453.592 g per lb, 1000 kWh per MWh.
_WATTTIME_LBS_PER_MWH_TO_G_PER_KWH: Final[float] = 453.592 / 1000
_WATTTIME_FETCH_TIMEOUT_S: Final[float] = 8.0
_WATTTIME_LOGIN_URL: Final[str] = "https://api.watttime.org/login"
_WATTTIME_FORECAST_URL: Final[str] = "https://api.watttime.org/v3/forecast"


class _WattTimeFeed(GridFeed):
    """WattTime v3 marginal (co2_moer) forecast feed for US ISO/RTO zones.

    Caches the bearer token on the instance and re-logs in once on a
    401/403; any other failure (network, bad region, empty body) falls
    through to ``fallback``.
    """

    source: GridSource = "wattTime"

    def __init__(
        self,
        username: str,
        password: str,
        *,
        fallback: GridFeed,
        timeout_s: float = _WATTTIME_FETCH_TIMEOUT_S,
    ) -> None:
        self._username = username
        self._password = password
        self._fallback = fallback
        self._timeout_s = timeout_s
        self._token: str | None = None

    async def _login(self, client: httpx.AsyncClient) -> str:
        res = await client.get(
            _WATTTIME_LOGIN_URL, auth=(self._username, self._password)
        )
        if not res.is_success:
            raise RuntimeError(f"WattTime login returned {res.status_code}")
        payload = res.json()
        token = payload.get("token") if isinstance(payload, dict) else None
        if not token:
            raise RuntimeError("WattTime login returned no token")
        return str(token)

    async def _fetch_forecast_res(
        self, client: httpx.AsyncClient, region: str, bearer: str
    ) -> httpx.Response:
        return await client.get(
            _WATTTIME_FORECAST_URL,
            params={"region": region, "signal_type": "co2_moer"},
            headers={"Authorization": f"Bearer {bearer}"},
        )

    async def fetch_forecast(self, region: str, hours: int) -> GridForecast:
        wt_region = WATTTIME_REGION_BY_ZONE.get(region)
        if wt_region is None:
            # Zone WattTime doesn't cover — fall through the existing chain.
            return await self._fallback.fetch_forecast(region, hours)
        try:
            async with httpx.AsyncClient(
                timeout=httpx.Timeout(self._timeout_s)
            ) as client:
                if self._token is None:
                    self._token = await self._login(client)
                res = await self._fetch_forecast_res(client, wt_region, self._token)
                if res.status_code in (401, 403):
                    # Token expired or revoked — re-login ONCE and retry.
                    self._token = await self._login(client)
                    res = await self._fetch_forecast_res(
                        client, wt_region, self._token
                    )
                if not res.is_success:
                    raise RuntimeError(
                        f"WattTime forecast returned {res.status_code}"
                    )
                payload = res.json()
            points = (
                payload.get("data") or [] if isinstance(payload, dict) else []
            )
            if not points:
                raise RuntimeError("WattTime returned an empty forecast")

            # co2_moer forecasts are sub-hourly (typically 5-minute). Average
            # every point into the UTC hour that contains it, then convert
            # lbs CO2/MWh → gCO2/kWh.
            by_hour: dict[datetime, dict[str, float]] = {}
            for p in points:
                if not isinstance(p, dict):
                    continue
                t = _parse_iso(str(p.get("point_time")))
                val = p.get("value")
                if t is None or not isinstance(val, (int, float)):
                    continue
                fval = float(val)
                if not math.isfinite(fval):
                    continue
                hr = t.replace(minute=0, second=0, microsecond=0)
                cell = by_hour.setdefault(hr, {"sum": 0.0, "n": 0.0})
                cell["sum"] += fval
                cell["n"] += 1

            entries: list[GridForecastEntry] = []
            for hr in sorted(by_hour):
                if len(entries) >= hours:
                    break
                cell = by_hour[hr]
                lbs_per_mwh = cell["sum"] / cell["n"]
                g = _round_half_up(
                    lbs_per_mwh * _WATTTIME_LBS_PER_MWH_TO_G_PER_KWH
                )
                entries.append(
                    GridForecastEntry(
                        datetime=_iso_utc(hr),
                        carbon_intensity_g_co2_per_kwh=g,
                        band=_classify(g),
                        signal_type="marginal",
                    )
                )
            if not entries:
                raise RuntimeError("WattTime returned no usable forecast points")
            return GridForecast(
                region=region,
                source="wattTime",
                generated_at=_iso_utc(_now_utc()),
                # A genuine forward MOER forecast, not realised/persistence data.
                kind="forecast",
                signal_type="marginal",
                entries=entries,
            )
        except (httpx.HTTPError, RuntimeError, ValueError, KeyError) as err:
            _log.warning(
                "[tidegap/grid] watttime fetch failed (%s); falling through to %s",
                err,
                self._fallback.source,
            )
            return await self._fallback.fetch_forecast(region, hours)


def watttime_feed(
    username: str | None = None,
    password: str | None = None,
    *,
    fallback: GridFeed | None = None,
    timeout_s: float = _WATTTIME_FETCH_TIMEOUT_S,
) -> GridFeed:
    """Construct a WattTime v3 marginal (co2_moer) forecast feed.

    Reads WATTTIME_USERNAME / WATTTIME_PASSWORD from the environment when
    not passed. With no credentials the returned feed *is* ``fallback``
    (transparent pass-through) so wiring ``watttime_feed(fallback=eia_feed())``
    into the router is a no-op for users who never configured WattTime —
    the existing chain and its reported ``source`` are unchanged. Mirrors
    the TS ``wattTimeFeed``.
    """
    user = username or os.environ.get("WATTTIME_USERNAME")
    pw = password or os.environ.get("WATTTIME_PASSWORD")
    fb = fallback if fallback is not None else mock_grid_feed()
    if not user or not pw:
        return fb
    return _WattTimeFeed(user, pw, fallback=fb, timeout_s=timeout_s)


# --------------------------------------------------------------------------- #
# Composition


class _MultiSourceGridFeed(GridFeed):
    """Compose multiple feeds with per-zone routing.

    Zones not in ``feeds`` are routed to ``fallback``. Each leaf feed
    reports its own ``source`` on the returned forecast — the wrapper is
    a router, not a source itself. Mirrors the TS ``multiSourceGridFeed``.
    """

    # The router has no single source; report "mock" for the (rare)
    # callers that read ``feed.source`` without inspecting the forecast.
    source: GridSource = "mock"

    def __init__(
        self, feeds: dict[str, GridFeed], fallback: GridFeed
    ) -> None:
        self._feeds = feeds
        self._fallback = fallback

    async def fetch_forecast(self, region: str, hours: int) -> GridForecast:
        feed = self._feeds.get(region, self._fallback)
        return await feed.fetch_forecast(region, hours)


def multi_source_grid_feed(
    *,
    feeds: dict[str, GridFeed] | None = None,
    fallback: GridFeed | None = None,
) -> GridFeed:
    """Route per-zone across the supplied feeds, falling back for the rest.

    Zones not in ``feeds`` are routed to ``fallback`` (default:
    :func:`mock_grid_feed`).
    """
    return _MultiSourceGridFeed(
        feeds=feeds or {},
        fallback=fallback if fallback is not None else mock_grid_feed(),
    )


def build_default_grid_feed() -> GridFeed:
    """Auto-build the best free grid feed for every supported zone.

    Selection logic (per zone):
      - ``"GB"`` → UK Carbon Intensity (free, no key)
      - EIA-eligible US zones → WattTime marginal FORECAST when
        WATTTIME_USERNAME/PASSWORD are set (a real marginal forecast beats
        an hour-of-day EIA persistence heuristic), else EIA when
        ``TIDEGAP_EIA_API_KEY`` is set
      - EU zones → ENTSO-E when ``TIDEGAP_ENTSOE_SECURITY_TOKEN`` is set
      - everything else → Electricity Maps when
        ``TIDEGAP_ELECTRICITY_MAPS_API_KEY`` is set
      - any zone without a configured key → deterministic mock curve

    Each leaf feed already falls back to the mock on its own when its key
    is missing or the request fails; the returned forecast's ``source``
    field reports the actual origin. Mirrors the TS ``buildDefaultGridFeed``.
    """
    feeds: dict[str, GridFeed] = {"GB": uk_carbon_intensity_feed()}
    # US ISO/RTO zones: WattTime marginal FORECAST takes precedence when its
    # credentials are set; watttime_feed falls through to EIA (which in turn
    # falls through to the mock) otherwise. With no WattTime creds the
    # wrapper collapses to eia_feed(), so behaviour is unchanged.
    for zone in EIA_RESPONDENT_BY_ZONE:
        feeds[zone] = watttime_feed(fallback=eia_feed())
    for zone in ENTSOE_BIDDING_ZONE_BY_REGION:
        feeds[zone] = entsoe_feed()
    return multi_source_grid_feed(feeds=feeds, fallback=electricity_maps_feed())


__all__ = [
    "EIA_RESPONDENT_BY_ZONE",
    "ENTSOE_BIDDING_ZONE_BY_REGION",
    "WATTTIME_REGION_BY_ZONE",
    "EntsoePeriod",
    "EntsoeTimeSeries",
    "GridFeed",
    "build_default_grid_feed",
    "eia_feed",
    "electricity_maps_feed",
    "entsoe_feed",
    "mock_grid_feed",
    "multi_source_grid_feed",
    "parse_entsoe_xml",
    "uk_carbon_intensity_feed",
    "watttime_feed",
]
