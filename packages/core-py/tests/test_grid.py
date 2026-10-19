"""Grid-feed tests.

Mirrors the TS test cases in ``packages/core-ts/test/scheduler.test.ts``
plus extra coverage for the Electricity Maps adapter and its fallback
behavior.
"""

from __future__ import annotations

import httpx
import pytest

from tidegap import electricity_maps_feed, mock_grid_feed
from tidegap.grid import _classify
from tidegap.grid import electricity_maps_feed as feed_factory


@pytest.mark.asyncio
async def test_mock_returns_requested_hours() -> None:
    feed = mock_grid_feed()
    forecast = await feed.fetch_forecast("US-CAL-CISO", 12)
    assert len(forecast.entries) == 12
    assert forecast.source == "mock"
    assert forecast.region == "US-CAL-CISO"


@pytest.mark.asyncio
async def test_mock_intraday_swing() -> None:
    feed = mock_grid_feed()
    forecast = await feed.fetch_forecast("US-CAL-CISO", 48)
    values = [e.carbon_intensity_g_co2_per_kwh for e in forecast.entries]
    assert max(values) - min(values) > 50


@pytest.mark.asyncio
async def test_mock_band_classification() -> None:
    feed = mock_grid_feed()
    forecast = await feed.fetch_forecast("FR", 6)
    for e in forecast.entries:
        if e.carbon_intensity_g_co2_per_kwh < 100:
            assert e.band == "very_clean"
        if e.carbon_intensity_g_co2_per_kwh >= 700:
            assert e.band == "very_dirty"


@pytest.mark.asyncio
async def test_mock_72_hour_horizon() -> None:
    feed = mock_grid_feed()
    forecast = await feed.fetch_forecast("US-MIDA-PJM", 72)
    assert len(forecast.entries) == 72


@pytest.mark.asyncio
async def test_mock_is_deterministic_within_hour() -> None:
    """Two fetches inside the same wall-clock hour return the same values
    (modulo the changing ``generated_at`` field).
    """
    feed = mock_grid_feed()
    a = await feed.fetch_forecast("DE", 6)
    b = await feed.fetch_forecast("DE", 6)
    assert [e.carbon_intensity_g_co2_per_kwh for e in a.entries] == [
        e.carbon_intensity_g_co2_per_kwh for e in b.entries
    ]


def test_classify_thresholds() -> None:
    assert _classify(0) == "very_clean"
    assert _classify(99) == "very_clean"
    assert _classify(100) == "clean"
    assert _classify(249) == "clean"
    assert _classify(250) == "average"
    assert _classify(449) == "average"
    assert _classify(450) == "dirty"
    assert _classify(699) == "dirty"
    assert _classify(700) == "very_dirty"
    assert _classify(2000) == "very_dirty"


@pytest.mark.asyncio
async def test_electricity_maps_without_key_falls_back_to_mock(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.delenv("TIDEGAP_ELECTRICITY_MAPS_API_KEY", raising=False)
    feed = electricity_maps_feed()
    # The wrapper reports "mock" source because the fallback is the
    # mock feed — same behavior the TS port has.
    assert feed.source == "mock"
    forecast = await feed.fetch_forecast("US-CAL-CISO", 4)
    assert len(forecast.entries) == 4


@pytest.mark.asyncio
async def test_electricity_maps_fetch_falls_back_on_http_error(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """If the API returns a 500, we silently fall back to mock data
    rather than crashing the scheduler. Match the TS implementation.
    """

    def transport_handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(503, json={"error": "service unavailable"})

    feed = feed_factory("fake-key")

    # Monkey-patch httpx.AsyncClient to use a MockTransport.
    real_client = httpx.AsyncClient

    class _Patched(real_client):  # type: ignore[misc, valid-type]
        def __init__(self, *args: object, **kwargs: object) -> None:
            kwargs["transport"] = httpx.MockTransport(transport_handler)
            super().__init__(*args, **kwargs)

    monkeypatch.setattr("tidegap.grid.httpx.AsyncClient", _Patched)
    forecast = await feed.fetch_forecast("US-CAL-CISO", 3)
    assert forecast.source == "mock"
    assert len(forecast.entries) == 3


@pytest.mark.asyncio
async def test_electricity_maps_fetch_success(monkeypatch: pytest.MonkeyPatch) -> None:
    """Happy-path: a well-formed API response is converted to our type."""

    def transport_handler(request: httpx.Request) -> httpx.Response:
        assert request.headers.get("auth-token") == "fake-key"
        assert "zone=US-CAL-CISO" in str(request.url)
        return httpx.Response(
            200,
            json={
                "zone": "US-CAL-CISO",
                "forecast": [
                    {"datetime": "2026-05-12T00:00:00Z", "carbonIntensity": 120.4},
                    {"datetime": "2026-05-12T01:00:00Z", "carbonIntensity": 95.2},
                    {"datetime": "2026-05-12T02:00:00Z", "carbonIntensity": 80.0},
                ],
            },
        )

    feed = feed_factory("fake-key")
    real_client = httpx.AsyncClient

    class _Patched(real_client):  # type: ignore[misc, valid-type]
        def __init__(self, *args: object, **kwargs: object) -> None:
            kwargs["transport"] = httpx.MockTransport(transport_handler)
            super().__init__(*args, **kwargs)

    monkeypatch.setattr("tidegap.grid.httpx.AsyncClient", _Patched)
    forecast = await feed.fetch_forecast("US-CAL-CISO", 3)
    assert forecast.source == "electricityMaps"
    assert len(forecast.entries) == 3
    assert forecast.entries[0].carbon_intensity_g_co2_per_kwh == 120
    assert forecast.entries[1].band == "very_clean"


def test_region_catalog_mirrors_the_floor_zones() -> None:
    from tidegap._data import REGION_CATALOG, REGION_FLOORS

    assert list(REGION_CATALOG) == list(REGION_FLOORS)
    assert len(REGION_CATALOG) == 31
    assert REGION_CATALOG["PL"] == {
        "name": "Poland",
        "country": "PL",
        "country_name": "Poland",
        "operator": "PSE",
    }
