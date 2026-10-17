"""Fixture-level regression tests for the ported grid feeds (§ROADMAP 5).

Ports ``packages/core-ts/test/grid-feeds-fixtures.test.ts`` 1:1 against the
SAME shared fixtures under ``packages/core-ts/test/fixtures/`` so both
language cores parse identical payloads to identical forecasts:

  - entsoe-a75-de.xml          ENTSO-E realised generation (A75) with a
                               consumption TimeSeries (outBiddingZone), a
                               multi-Period TimeSeries, and a Point-position
                               gap (curveType A03).
  - entsoe-acknowledgement.xml ENTSO-E "no data" error envelope.
  - eia-fuel-mix-lagged.json   EIA hourly fuel mix whose last observation is
                               4h behind the test's faked "now" — the
                               phase-rotation regression fixture.
  - uk-fw48h-page1/2.json      Two UK Carbon Intensity /fw48h pages with a
                               misaligned leading half-period and an
                               overlapping boundary period.
"""

from __future__ import annotations

import json
import time
from collections.abc import Callable
from datetime import UTC, datetime, timedelta
from math import floor
from pathlib import Path

import httpx
import pytest

from tidegap.grid import (
    EntsoeTimeSeries,
    GridFeed,
    eia_feed,
    entsoe_feed,
    parse_entsoe_xml,
    uk_carbon_intensity_feed,
    watttime_feed,
)
from tidegap.types import GridForecast, GridForecastEntry

_FIXTURES = Path(__file__).resolve().parents[2] / "core-ts" / "test" / "fixtures"


def _fixture(name: str) -> str:
    return (_FIXTURES / name).read_text()


def _patch_client(
    monkeypatch: pytest.MonkeyPatch,
    handler: Callable[[httpx.Request], httpx.Response],
) -> None:
    """Route every AsyncClient request in ``tidegap.grid`` through a
    MockTransport, mirroring the TS tests' ``globalThis.fetch`` stub.
    """
    real_client = httpx.AsyncClient

    class _Patched(real_client):  # type: ignore[misc, valid-type]
        def __init__(self, *args: object, **kwargs: object) -> None:
            kwargs["transport"] = httpx.MockTransport(handler)
            super().__init__(*args, **kwargs)

    monkeypatch.setattr("tidegap.grid.httpx.AsyncClient", _Patched)


def _freeze_now(monkeypatch: pytest.MonkeyPatch, iso: str) -> None:
    dt = datetime.fromisoformat(iso.replace("Z", "+00:00"))
    monkeypatch.setattr("tidegap.grid._now_utc", lambda: dt)


# ---------------------------------------------------------------------------
# ENTSO-E A75 XML
# ---------------------------------------------------------------------------


def test_parse_entsoe_skips_consumption_series() -> None:
    series = parse_entsoe_xml(_fixture("entsoe-a75-de.xml"))
    # Fixture has 3 TimeSeries; the B11 pumped-storage-pumping one is
    # marked with outBiddingZone_Domain.mRID and must be excluded.
    assert [s.psr_type for s in series] == ["B14", "B05"]


def test_parse_entsoe_multi_period() -> None:
    series = parse_entsoe_xml(_fixture("entsoe-a75-de.xml"))
    nuclear = next(s for s in series if s.psr_type == "B14")
    assert len(nuclear.periods) == 2
    assert nuclear.periods[0].start == "2026-05-13T10:00Z"
    assert nuclear.periods[1].start == "2026-05-13T22:00Z"
    assert len(nuclear.periods[0].points) == 12
    assert len(nuclear.periods[1].points) == 12


def test_parse_entsoe_position_gap_stays_hole() -> None:
    series = parse_entsoe_xml(_fixture("entsoe-a75-de.xml"))
    coal = next(s for s in series if s.psr_type == "B05")
    positions = [pos for pos, _q in coal.periods[0].points]
    assert 3 not in positions
    assert 4 in positions
    assert len(positions) == 23


def test_parse_entsoe_acknowledgement_raises() -> None:
    with pytest.raises(RuntimeError, match=r"Acknowledgement.*No matching data found"):
        parse_entsoe_xml(_fixture("entsoe-acknowledgement.xml"))


# The feed text is external input: unclosed tags must not make the block
# scan quadratic. Same inputs as the TS parseEntsoeXml tests.
_N = 100_000


def _elapsed(fn: Callable[[], object]) -> float:
    t0 = time.perf_counter()
    fn()
    return time.perf_counter() - t0


def test_parse_entsoe_unclosed_text_is_linear() -> None:
    xml = "<Acknowledgement_MarketDocument>" + "<text>" * _N

    def run() -> None:
        with pytest.raises(RuntimeError, match="no reason text in document"):
            parse_entsoe_xml(xml)

    assert _elapsed(run) < 1.0


def test_parse_entsoe_unclosed_timeseries_is_linear() -> None:
    xml = "<TimeSeries>" * _N
    assert _elapsed(lambda: parse_entsoe_xml(xml)) < 1.0
    assert parse_entsoe_xml(xml) == []


def test_parse_entsoe_unclosed_period_is_linear() -> None:
    xml = "<TimeSeries><psrType>B01</psrType>" + "<Period>" * _N + "</TimeSeries>"
    assert _elapsed(lambda: parse_entsoe_xml(xml)) < 1.0
    assert parse_entsoe_xml(xml) == []


def _period(start: str, qty: int) -> str:
    return (
        f"<Period><timeInterval><start>{start}</start></timeInterval>"
        "<resolution>PT60M</resolution>"
        f"<Point><position>1</position><quantity>{qty}</quantity></Point></Period>"
    )


def _summary(
    series: list[EntsoeTimeSeries],
) -> list[tuple[str, list[tuple[str, int, list[tuple[int, float]]]]]]:
    return [
        (s.psr_type, [(p.start, p.resolution_min, p.points) for p in s.periods]) for s in series
    ]


def test_parse_entsoe_stray_unclosed_period_drops_only_itself() -> None:
    xml = (
        f"<TimeSeries><psrType>B14</psrType>{_period('2026-05-13T10:00Z', 5)}"
        "<Period>stray</TimeSeries>"
        f"<TimeSeries><psrType>B05</psrType>{_period('2026-05-13T11:00Z', 7)}</TimeSeries>"
    )
    assert _summary(parse_entsoe_xml(xml)) == [
        ("B14", [("2026-05-13T10:00Z", 60, [(1, 5.0)])]),
        ("B05", [("2026-05-13T11:00Z", 60, [(1, 7.0)])]),
    ]


# Pins the lazy-regex semantics the scan replaced: each open pairs with
# the nearest close after it, and the first match wins. Same cases as TS.
def test_parse_entsoe_unclosed_timeseries_pairs_with_next_close() -> None:
    xml = (
        "<TimeSeries><psrType>B01</psrType>"
        f"<TimeSeries><psrType>B14</psrType>{_period('2026-05-13T10:00Z', 5)}</TimeSeries>"
    )
    assert _summary(parse_entsoe_xml(xml)) == [
        ("B01", [("2026-05-13T10:00Z", 60, [(1, 5.0)])]),
    ]


def test_parse_entsoe_unclosed_period_merges_into_next() -> None:
    xml = (
        "<TimeSeries><psrType>B14</psrType>"
        f"<Period>stray{_period('2026-05-13T10:00Z', 5)}</TimeSeries>"
    )
    assert _summary(parse_entsoe_xml(xml)) == [
        ("B14", [("2026-05-13T10:00Z", 60, [(1, 5.0)])]),
    ]


def test_parse_entsoe_acknowledgement_reports_first_text() -> None:
    def ack(body: str) -> str:
        return f"<Acknowledgement_MarketDocument><Reason>{body}</Reason>"

    with pytest.raises(RuntimeError, match=r"Acknowledgement document: first$"):
        parse_entsoe_xml(ack("<text> first </text><text>second</text>"))
    with pytest.raises(RuntimeError, match=r"Acknowledgement document: $"):
        parse_entsoe_xml(ack("<text></text><text>second</text>"))


def _entsoe_expected(hour_of_day: int) -> int:
    # Fixture mix per hour: nuclear 1000 MW (12 g) + coal 1000 MW (820 g)
    # -> (12 + 820) / 2 = 416 g — EXCEPT the coal gap hour (position 3 ->
    # period start 10:00Z + 2h = 12:00Z), which is nuclear-only -> 12 g.
    return 12 if hour_of_day == 12 else 416


@pytest.mark.asyncio
async def test_entsoe_excludes_consumption_and_keeps_gap(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    def handler(_req: httpx.Request) -> httpx.Response:
        return httpx.Response(200, content=_fixture("entsoe-a75-de.xml").encode())

    _patch_client(monkeypatch, handler)
    fc = await entsoe_feed("test-token").fetch_forecast("DE", 24)
    assert fc.source == "entsoe"
    assert fc.kind == "persistence"
    assert len(fc.entries) == 24
    for e in fc.entries:
        hod = datetime.fromisoformat(e.datetime.replace("Z", "+00:00")).hour
        assert e.carbon_intensity_g_co2_per_kwh == _entsoe_expected(hod), e.datetime

    def _at(hod: int) -> int:
        e = next(
            e
            for e in fc.entries
            if datetime.fromisoformat(e.datetime.replace("Z", "+00:00")).hour == hod
        )
        return e.carbon_intensity_g_co2_per_kwh

    # Regression pin for the index-based bucketing bug: ignoring <position>
    # shifted every post-gap coal hour one hour earlier.
    assert _at(12) == 12
    assert _at(9) == 416


@pytest.mark.asyncio
async def test_entsoe_falls_back_on_acknowledgement(
    monkeypatch: pytest.MonkeyPatch,
    caplog: pytest.LogCaptureFixture,
) -> None:
    def handler(_req: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200, content=_fixture("entsoe-acknowledgement.xml").encode()
        )

    _patch_client(monkeypatch, handler)
    with caplog.at_level("WARNING"):
        fc = await entsoe_feed("test-token").fetch_forecast("DE", 6)
    assert fc.source == "mock"
    assert len(fc.entries) == 6
    assert any("Acknowledgement" in r.getMessage() for r in caplog.records)


# ---------------------------------------------------------------------------
# EIA fuel mix — publication-lag phase regression
# ---------------------------------------------------------------------------


def _eia_expected(hour_of_day: int) -> int:
    # Fixture: COL = hod MW, NUC = (24 - hod) MW, so each observation's
    # intensity uniquely encodes its hour-of-day.
    return floor((hour_of_day * 820 + (24 - hour_of_day) * 12) / 24 + 0.5)


@pytest.mark.asyncio
async def test_eia_serves_by_hour_of_day_despite_lag(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    # "Now" is 4h after the last observation (2026-05-14T21).
    _freeze_now(monkeypatch, "2026-05-15T01:20:00Z")

    def handler(_req: httpx.Request) -> httpx.Response:
        return httpx.Response(200, content=_fixture("eia-fuel-mix-lagged.json").encode())

    _patch_client(monkeypatch, handler)
    fc = await eia_feed("test-key").fetch_forecast("US-CAL-CISO", 72)
    assert fc.source == "eia"
    assert fc.kind == "persistence"
    assert len(fc.entries) == 72
    assert fc.entries[0].datetime == "2026-05-15T01:00:00.000Z"
    for e in fc.entries:
        hod = datetime.fromisoformat(e.datetime.replace("Z", "+00:00")).hour
        assert e.carbon_intensity_g_co2_per_kwh == _eia_expected(hod), e.datetime
    # Phase pin: the old tiling anchored the last-24 tail at wall-clock
    # "now", so the 01:00 slot got the 4h-stale 22:00 observation.
    assert fc.entries[0].carbon_intensity_g_co2_per_kwh == _eia_expected(1)  # 46
    assert fc.entries[0].carbon_intensity_g_co2_per_kwh != _eia_expected(22)  # 753


@pytest.mark.asyncio
async def test_eia_serves_when_last_19_hours_unpublished(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    # Production 2026-10-17: EIA's newest row was 19h old, so a 30h window
    # held only 11 hours-of-day and every US ISO fell back to the mock.
    # The 72h window then holds 2+ observations per hour-of-day: older
    # hours are all coal (820), the newest 24 all gas (490). Newest wins.
    _freeze_now(monkeypatch, "2026-10-17T22:19:00Z")
    last_published = datetime(2026, 10, 17, 3, tzinfo=UTC)
    newest_day = last_published - timedelta(hours=23)
    starts: list[str] = []

    def handler(req: httpx.Request) -> httpx.Response:
        starts.append(req.url.params["start"])
        start = datetime.fromisoformat(req.url.params["start"] + ":00:00+00:00")
        data = []
        t = start
        while t <= last_published:
            period = t.strftime("%Y-%m-%dT%H")
            fueltype = "NG" if t >= newest_day else "COL"
            data.append({"period": period, "respondent": "CISO", "fueltype": fueltype, "value": 100})
            t += timedelta(hours=1)
        return httpx.Response(200, content=json.dumps({"response": {"data": data}}).encode())

    _patch_client(monkeypatch, handler)
    fc = await eia_feed("test-key").fetch_forecast("US-CAL-CISO", 24)
    assert starts == ["2026-10-14T22"]
    assert fc.source == "eia"
    assert len(fc.entries) == 24
    for e in fc.entries:
        assert e.carbon_intensity_g_co2_per_kwh == 490, e.datetime


@pytest.mark.asyncio
async def test_eia_degrades_when_fewer_than_24_hours(
    monkeypatch: pytest.MonkeyPatch,
    caplog: pytest.LogCaptureFixture,
) -> None:
    full = json.loads(_fixture("eia-fuel-mix-lagged.json"))
    # Keep only the first 10 hours (2 rows per hour) — a short tail must
    # not be tiled onto a 24h diurnal cycle.
    full["response"]["data"] = full["response"]["data"][:20]

    def handler(_req: httpx.Request) -> httpx.Response:
        return httpx.Response(200, content=json.dumps(full).encode())

    _patch_client(monkeypatch, handler)
    with caplog.at_level("WARNING"):
        fc = await eia_feed("test-key").fetch_forecast("US-CAL-CISO", 24)
    assert fc.source == "mock"
    assert any("hours-of-day" in r.getMessage() for r in caplog.records)


# ---------------------------------------------------------------------------
# UK Carbon Intensity — 72h pagination + top-of-hour alignment
# ---------------------------------------------------------------------------


def _uk_handler(calls: list[str]) -> Callable[[httpx.Request], httpx.Response]:
    def handler(req: httpx.Request) -> httpx.Response:
        url = str(req.url)
        calls.append(url)
        if "/intensity/2026-05-14T12:00Z/fw48h" in url:
            return httpx.Response(200, content=_fixture("uk-fw48h-page1.json").encode())
        if "/intensity/2026-05-16T12:00Z/fw48h" in url:
            return httpx.Response(200, content=_fixture("uk-fw48h-page2.json").encode())
        return httpx.Response(404, json={"error": f"unexpected URL: {url}"})

    return handler


@pytest.mark.asyncio
async def test_uk_two_page_72h_aligned(monkeypatch: pytest.MonkeyPatch) -> None:
    _freeze_now(monkeypatch, "2026-05-14T12:05:00Z")
    calls: list[str] = []
    _patch_client(monkeypatch, _uk_handler(calls))

    fc = await uk_carbon_intensity_feed().fetch_forecast("GB", 72)
    assert len(calls) == 2
    assert "/intensity/2026-05-16T12:00Z/fw48h" in calls[1]

    assert fc.source == "ukCarbonIntensity"
    assert fc.kind == "forecast"
    assert len(fc.entries) == 72
    base = datetime(2026, 5, 14, 12, tzinfo=UTC)
    for i, e in enumerate(fc.entries):
        t = datetime.fromisoformat(e.datetime.replace("Z", "+00:00"))
        # Buckets must be aligned to [HH:00, HH+1:00) and hourly-contiguous.
        assert t.minute == 0, e.datetime
        want = base + timedelta(hours=i)
        assert e.datetime == want.strftime("%Y-%m-%dT%H:%M:%S") + ".000Z"
        assert e.carbon_intensity_g_co2_per_kwh == 20 * i + 5, e.datetime
    assert fc.entries[71].datetime == "2026-05-17T11:00:00.000Z"
    assert fc.entries[71].carbon_intensity_g_co2_per_kwh == 1425


@pytest.mark.asyncio
async def test_uk_drops_misaligned_leading_half_period(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _freeze_now(monkeypatch, "2026-05-14T12:05:00Z")
    _patch_client(monkeypatch, _uk_handler([]))

    fc = await uk_carbon_intensity_feed().fetch_forecast("GB", 72)
    # If the 11:30 period (9999) were paired in, bucket 0 would be
    # avg(9999, 0) ~= 5000 at 11:30 instead of avg(0, 10) = 5 at 12:00.
    assert fc.entries[0].datetime == "2026-05-14T12:00:00.000Z"
    assert fc.entries[0].carbon_intensity_g_co2_per_kwh == 5


@pytest.mark.asyncio
async def test_uk_single_page_within_48h(monkeypatch: pytest.MonkeyPatch) -> None:
    _freeze_now(monkeypatch, "2026-05-14T12:05:00Z")
    calls: list[str] = []
    _patch_client(monkeypatch, _uk_handler(calls))

    fc = await uk_carbon_intensity_feed().fetch_forecast("GB", 48)
    assert len(calls) == 1
    assert len(fc.entries) == 48
    assert fc.entries[0].carbon_intensity_g_co2_per_kwh == 5


# ---------------------------------------------------------------------------
# WattTime v3 — marginal (co2_moer) forecast, unit conversion, auth refresh,
# fallthrough + precedence-over-EIA routing (ROADMAP item 2). Ports the TS
# wattTimeFeed fixture tests 1:1 against the same shared fixtures.
# ---------------------------------------------------------------------------

_LOGIN_URL = "https://api.watttime.org/login"
_FORECAST_HOST = "api.watttime.org"


class _MarkerFallback(GridFeed):
    """A stub fallback feed with a distinguishable source, for fallthrough."""

    def __init__(self, source: str = "eia") -> None:
        self.source = source  # type: ignore[assignment]
        self.calls: list[tuple[str, int]] = []

    async def fetch_forecast(self, region: str, hours: int) -> GridForecast:
        self.calls.append((region, hours))
        return GridForecast(
            region=region,
            source=self.source,
            generated_at="2026-05-14T12:00:00.000Z",
            kind="persistence",
            entries=[
                GridForecastEntry(
                    datetime=f"2026-05-14T{12 + i:02d}:00:00.000Z",
                    carbon_intensity_g_co2_per_kwh=111,
                    band="clean",
                )
                for i in range(hours)
            ],
        )


def _watttime_handler(
    login_calls: list[int],
    *,
    forecast_status: list[int] | None = None,
) -> Callable[[httpx.Request], httpx.Response]:
    """MockTransport handler: /login returns the token fixture; /v3/forecast
    returns the CAISO fixture (or a queued status code per call).
    """
    fc_calls = {"n": 0}

    def handler(request: httpx.Request) -> httpx.Response:
        url = str(request.url)
        if url.startswith(_LOGIN_URL):
            login_calls.append(1)
            return httpx.Response(200, text=_fixture("watttime-login.json"))
        # forecast
        fc_calls["n"] += 1
        if forecast_status is not None:
            idx = min(fc_calls["n"] - 1, len(forecast_status) - 1)
            status = forecast_status[idx]
            if status != 200:
                return httpx.Response(status, text="err")
        assert "signal_type=co2_moer" in url
        return httpx.Response(200, text=_fixture("watttime-forecast-caiso.json"))

    return handler


@pytest.mark.asyncio
async def test_watttime_converts_lbs_to_g_into_hourly_buckets(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    login: list[int] = []
    _patch_client(monkeypatch, _watttime_handler(login))

    fc = await watttime_feed("u", "p").fetch_forecast("US-CAL-CISO", 24)
    assert fc.source == "wattTime"
    assert fc.kind == "forecast"
    assert fc.signal_type == "marginal"
    assert len(fc.entries) == 2
    # 12:00Z bucket avg(900,1100)=1000 lbs/MWh x 453.592/1000 = 453.592 -> 454.
    assert fc.entries[0].datetime == "2026-05-14T12:00:00.000Z"
    assert fc.entries[0].carbon_intensity_g_co2_per_kwh == 454
    assert fc.entries[0].signal_type == "marginal"
    # 13:00Z bucket avg(600,400)=500 lbs/MWh x 453.592/1000 = 226.796 -> 227.
    assert fc.entries[1].carbon_intensity_g_co2_per_kwh == 227
    assert len(login) == 1


@pytest.mark.asyncio
async def test_watttime_caches_bearer_token(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    login: list[int] = []
    _patch_client(monkeypatch, _watttime_handler(login))

    feed = watttime_feed("u", "p")
    await feed.fetch_forecast("US-CAL-CISO", 24)
    await feed.fetch_forecast("US-CAL-CISO", 24)
    assert len(login) == 1


@pytest.mark.asyncio
async def test_watttime_relogin_once_on_401(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    login: list[int] = []
    # First forecast attempt 401, second 200.
    _patch_client(
        monkeypatch, _watttime_handler(login, forecast_status=[401, 200])
    )

    fc = await watttime_feed("u", "p").fetch_forecast("US-CAL-CISO", 24)
    assert fc.source == "wattTime"
    assert fc.entries[0].carbon_intensity_g_co2_per_kwh == 454
    # One initial login + one refresh after the 401 = 2.
    assert len(login) == 2


@pytest.mark.asyncio
async def test_watttime_falls_through_on_error(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    login: list[int] = []
    # 500 is not 401/403, so no refresh — straight to fallthrough.
    _patch_client(monkeypatch, _watttime_handler(login, forecast_status=[500]))

    fallback = _MarkerFallback("eia")
    fc = await watttime_feed("u", "p", fallback=fallback).fetch_forecast(
        "US-CAL-CISO", 24
    )
    assert fc.source == "eia"
    assert fc.entries[0].carbon_intensity_g_co2_per_kwh == 111
    assert fallback.calls == [("US-CAL-CISO", 24)]


@pytest.mark.asyncio
async def test_watttime_uncovered_zone_uses_fallback(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    login: list[int] = []
    _patch_client(monkeypatch, _watttime_handler(login))

    fallback = _MarkerFallback("entsoe")
    fc = await watttime_feed("u", "p", fallback=fallback).fetch_forecast(
        "FR", 24
    )
    assert fc.source == "entsoe"
    assert len(login) == 0


@pytest.mark.asyncio
async def test_watttime_no_creds_is_fallback() -> None:
    fallback = _MarkerFallback("eia")
    # No username/password, no env — must collapse to the fallback so
    # build_default_grid_feed's watttime_feed(fallback=eia_feed()) == eia_feed().
    feed = watttime_feed(fallback=fallback)
    assert feed is fallback
    fc = await feed.fetch_forecast("US-CAL-CISO", 24)
    assert fc.source == "eia"


@pytest.mark.asyncio
async def test_watttime_precedence_over_eia_when_credentialed(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    login: list[int] = []
    _patch_client(monkeypatch, _watttime_handler(login))

    eia = _MarkerFallback("eia")
    fc = await watttime_feed("u", "p", fallback=eia).fetch_forecast(
        "US-CAL-CISO", 24
    )
    assert fc.source == "wattTime"
    assert fc.signal_type == "marginal"
    # EIA fallback must NOT have been consulted when WattTime succeeds.
    assert eia.calls == []
