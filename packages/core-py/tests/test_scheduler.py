"""Scheduler tests.

Mirrors ``packages/core-ts/test/scheduler.test.ts`` 1:1 plus extra
coverage for the Python-only persistence layer.
"""

from __future__ import annotations

import asyncio
import re
import uuid
from datetime import UTC, datetime, timedelta
from pathlib import Path
from types import SimpleNamespace
from typing import Any
from unittest.mock import AsyncMock

import pytest

from tidegap import (
    CarbonBudgetExceededError,
    DeferOptions,
    InvalidDeadlineError,
    ProviderCallSpec,
    Scheduler,
    mock_grid_feed,
    pick_best_window,
)
from tidegap.providers import AnthropicAdapter
from tidegap.types import GridForecastEntry


def _in_hours(h: float) -> datetime:
    return datetime.now(UTC) + timedelta(hours=h)


# --------------------------------------------------------------------- #
# pick_best_window — pure function


def test_pick_best_window_returns_none_when_past() -> None:
    # Two hours ago is outside even the current-hour candidacy window
    # (entries up to 1h old are valid "run now" candidates since §1.7).
    past = [
        GridForecastEntry(
            datetime=(datetime.now(UTC) - timedelta(hours=2)).isoformat(),
            carbon_intensity_g_co2_per_kwh=100,
            band="clean",
        )
    ]
    assert pick_best_window(past, _in_hours(1)) is None


def test_pick_best_window_picks_minimum() -> None:
    entries = [
        GridForecastEntry(
            datetime=_in_hours(1).isoformat(),
            carbon_intensity_g_co2_per_kwh=400,
            band="average",
        ),
        GridForecastEntry(
            datetime=_in_hours(2).isoformat(),
            carbon_intensity_g_co2_per_kwh=120,
            band="clean",
        ),
        GridForecastEntry(
            datetime=_in_hours(3).isoformat(),
            carbon_intensity_g_co2_per_kwh=220,
            band="clean",
        ),
    ]
    best = pick_best_window(entries, _in_hours(4))
    assert best is not None
    assert best.carbon_intensity_g_co2_per_kwh == 120


def test_pick_best_window_filters_by_deadline() -> None:
    """An entry after the deadline must not be picked even if it is the
    cleanest of the bunch — that's the whole point of the deadline.
    """
    entries = [
        GridForecastEntry(
            datetime=_in_hours(1).isoformat(),
            carbon_intensity_g_co2_per_kwh=400,
            band="average",
        ),
        GridForecastEntry(
            datetime=_in_hours(10).isoformat(),
            carbon_intensity_g_co2_per_kwh=50,
            band="very_clean",
        ),
    ]
    best = pick_best_window(entries, _in_hours(2))
    assert best is not None
    assert best.carbon_intensity_g_co2_per_kwh == 400


# --------------------------------------------------------------------- #
# enqueue — sync accounting


@pytest.mark.asyncio
async def test_enqueue_creates_queued_record() -> None:
    s = Scheduler(feed=mock_grid_feed())
    try:
        record = s.enqueue(
            lambda: "ok",
            DeferOptions(deadline=_in_hours(1).isoformat(), region="US-CAL-CISO"),
        )
        assert record.status == "queued"
        assert record.region == "US-CAL-CISO"
        assert len(s.list_tasks()) == 1
    finally:
        await s.shutdown()


@pytest.mark.asyncio
async def test_enqueue_uses_default_region() -> None:
    s = Scheduler(feed=mock_grid_feed())
    try:
        record = s.enqueue(lambda: "ok")
        assert record.region == "US-CAL-CISO"
    finally:
        await s.shutdown()


@pytest.mark.asyncio
async def test_enqueue_assigns_uuid_shaped_id() -> None:
    s = Scheduler(feed=mock_grid_feed())
    try:
        r1 = s.enqueue(lambda: "a")
        r2 = s.enqueue(lambda: "b")
        assert r1.task_id != r2.task_id
        assert re.match(r"^t-[0-9a-f-]{36}$", r1.task_id)
        # The id portion is a valid UUID.
        uuid.UUID(r1.task_id.removeprefix("t-"))
    finally:
        await s.shutdown()


@pytest.mark.asyncio
async def test_enqueue_rejects_empty_task_id() -> None:
    s = Scheduler(feed=mock_grid_feed())
    try:
        with pytest.raises(ValueError):
            s.enqueue(lambda: "x", DeferOptions(task_id=""))
    finally:
        await s.shutdown()


@pytest.mark.asyncio
async def test_enqueue_rejects_duplicate_task_id() -> None:
    s = Scheduler(feed=mock_grid_feed())
    try:
        s.enqueue(lambda: "a", DeferOptions(task_id="user:foo"))
        with pytest.raises(ValueError):
            s.enqueue(lambda: "b", DeferOptions(task_id="user:foo"))
    finally:
        await s.shutdown()


# --------------------------------------------------------------------- #
# Deadline validation


@pytest.mark.asyncio
async def test_deadline_unparseable_string_raises() -> None:
    s = Scheduler(feed=mock_grid_feed())
    try:
        with pytest.raises(InvalidDeadlineError):
            s.enqueue(lambda: "ok", DeferOptions(deadline="not-a-date"))
    finally:
        await s.shutdown()


@pytest.mark.asyncio
async def test_deadline_in_past_raises() -> None:
    s = Scheduler(feed=mock_grid_feed())
    try:
        with pytest.raises(InvalidDeadlineError):
            s.enqueue(
                lambda: "ok",
                DeferOptions(deadline="2020-01-01T00:00:00Z"),
            )
    finally:
        await s.shutdown()


@pytest.mark.asyncio
async def test_deadline_accepts_datetime_instance() -> None:
    s = Scheduler(feed=mock_grid_feed())
    try:
        record = s.enqueue(
            lambda: "ok",
            DeferOptions(deadline=(datetime.now(UTC) + timedelta(hours=1)).isoformat()),
        )
        assert record.status == "queued"
    finally:
        await s.shutdown()


# --------------------------------------------------------------------- #
# Carbon-budget enforcement


@pytest.mark.asyncio
async def test_carbon_budget_rejects_when_no_window_qualifies() -> None:
    """US-MIDW-MISO floor is 460 → grams ~= 0.0015 * 460 = 0.69g.
    A 0.1g budget is impossibly tight; the scheduler must fail.
    """
    s = Scheduler(feed=mock_grid_feed())
    try:
        with pytest.raises(CarbonBudgetExceededError):
            await s.defer(
                lambda: "should never run",
                DeferOptions(
                    deadline=(datetime.now(UTC) + timedelta(milliseconds=300)).isoformat(),
                    region="US-MIDW-MISO",
                    carbon_budget_g=0.1,
                ),
            )
    finally:
        await s.shutdown()


@pytest.mark.asyncio
async def test_carbon_budget_carries_structured_fields() -> None:
    s = Scheduler(feed=mock_grid_feed())
    try:
        try:
            await s.defer(
                lambda: 1,
                DeferOptions(
                    deadline=(datetime.now(UTC) + timedelta(milliseconds=300)).isoformat(),
                    region="US-MIDW-MISO",
                    carbon_budget_g=0.1,
                ),
            )
        except CarbonBudgetExceededError as err:
            assert err.budget_g_co2 == 0.1
            assert err.minimum_g_co2 > err.budget_g_co2
        else:
            pytest.fail("expected CarbonBudgetExceededError")
    finally:
        await s.shutdown()


# --------------------------------------------------------------------- #
# defer — end-to-end


@pytest.mark.asyncio
async def test_defer_dispatches_and_returns_result() -> None:
    s = Scheduler(feed=mock_grid_feed())
    try:
        result = await s.defer(
            lambda: 42,
            DeferOptions(
                deadline=(datetime.now(UTC) + timedelta(milliseconds=300)).isoformat()
            ),
        )
        assert result == 42
        tasks = s.list_tasks()
        assert tasks[0].status == "completed"
        assert tasks[0].receipt is not None
        assert tasks[0].receipt.estimated_carbon_g_co2 > 0
    finally:
        await s.shutdown()


@pytest.mark.asyncio
async def test_defer_propagates_errors_from_body() -> None:
    s = Scheduler(feed=mock_grid_feed())
    try:

        def boom() -> None:
            raise RuntimeError("boom")

        with pytest.raises(RuntimeError, match="boom"):
            await s.defer(
                boom,
                DeferOptions(
                    deadline=(datetime.now(UTC) + timedelta(milliseconds=300)).isoformat()
                ),
            )
    finally:
        await s.shutdown()


@pytest.mark.asyncio
async def test_defer_handles_async_callable() -> None:
    s = Scheduler(feed=mock_grid_feed())
    try:

        async def body() -> str:
            await asyncio.sleep(0)
            return "async-ok"

        result = await s.defer(
            body,
            DeferOptions(
                deadline=(datetime.now(UTC) + timedelta(milliseconds=300)).isoformat()
            ),
        )
        assert result == "async-ok"
    finally:
        await s.shutdown()


@pytest.mark.asyncio
async def test_receipt_records_intensity_source() -> None:
    s = Scheduler(feed=mock_grid_feed())
    try:
        await s.defer(
            lambda: "ok",
            DeferOptions(
                deadline=(datetime.now(UTC) + timedelta(milliseconds=300)).isoformat()
            ),
        )
        rec = s.list_tasks()[0]
        assert rec.intensity_source in ("scored", "current")
        assert rec.receipt is not None
        assert rec.receipt.duration_ms is not None
        assert rec.receipt.duration_ms >= 0
    finally:
        await s.shutdown()


# --------------------------------------------------------------------- #
# Persistence (Python-only feature)


@pytest.mark.asyncio
async def test_sqlite_round_trip(tmp_path: Path) -> None:
    db = tmp_path / "queue.sqlite"
    s = Scheduler(feed=mock_grid_feed(), db_path=str(db))
    await s.connect()
    try:
        result = await s.defer(
            lambda: {"answer": 42},
            DeferOptions(
                deadline=(datetime.now(UTC) + timedelta(milliseconds=300)).isoformat(),
                task_id="persist:test",
            ),
        )
        assert result == {"answer": 42}
        loaded = await s.load_persisted_task("persist:test")
        assert loaded is not None
        assert loaded.status == "completed"
        assert loaded.result == {"answer": 42}
        assert loaded.receipt is not None
        assert loaded.receipt.estimated_carbon_g_co2 > 0
    finally:
        await s.shutdown()


@pytest.mark.asyncio
async def test_sqlite_list_all_after_shutdown(tmp_path: Path) -> None:
    """Tasks survive scheduler shutdown — that's the entire point of
    persistence. Open a second scheduler at the same path and recover.
    """
    db = tmp_path / "queue.sqlite"
    s1 = Scheduler(feed=mock_grid_feed(), db_path=str(db))
    await s1.connect()
    await s1.defer(
        lambda: "first",
        DeferOptions(
            deadline=(datetime.now(UTC) + timedelta(milliseconds=300)).isoformat(),
            task_id="t:1",
        ),
    )
    await s1.defer(
        lambda: "second",
        DeferOptions(
            deadline=(datetime.now(UTC) + timedelta(milliseconds=300)).isoformat(),
            task_id="t:2",
        ),
    )
    await s1.shutdown()

    s2 = Scheduler(feed=mock_grid_feed(), db_path=str(db))
    await s2.connect()
    try:
        records = await s2.list_persisted_tasks()
        ids = {r.task_id for r in records}
        assert ids == {"t:1", "t:2"}
        assert all(r.status == "completed" for r in records)
    finally:
        await s2.shutdown()


@pytest.mark.asyncio
async def test_sqlite_context_manager(tmp_path: Path) -> None:
    db = tmp_path / "queue.sqlite"
    async with Scheduler(feed=mock_grid_feed(), db_path=str(db)) as s:
        await s.defer(
            lambda: 7,
            DeferOptions(
                deadline=(datetime.now(UTC) + timedelta(milliseconds=300)).isoformat(),
                task_id="ctx:1",
            ),
        )
        loaded = await s.load_persisted_task("ctx:1")
        assert loaded is not None
        assert loaded.result == 7


# --------------------------------------------------------------------- #
# Horizon clamping


@pytest.mark.asyncio
async def test_horizon_capped_at_72_hours() -> None:
    """A 10-day deadline should not request a 240-hour forecast."""
    requested: list[int] = []

    class _RecordingFeed:
        source = "mock"

        async def fetch_forecast(self, region: str, hours: int):  # type: ignore[no-untyped-def]
            requested.append(hours)
            return await mock_grid_feed().fetch_forecast(region, hours)

    s = Scheduler(feed=_RecordingFeed())  # type: ignore[arg-type]
    try:
        s.enqueue(
            lambda: "ok",
            DeferOptions(
                deadline=(datetime.now(UTC) + timedelta(days=10)).isoformat(),
            ),
        )
        # Give the schedule task a chance to run the forecast fetch.
        await asyncio.sleep(0.05)
        assert requested, "expected feed.fetch_forecast to have been called"
        assert requested[0] <= 72
    finally:
        await s.shutdown()


# --------------------------------------------------------------------- #
# Provider-call max_tokens reaches the adapter unchanged (the Anthropic
# adapter applies its own 16000 default; the scheduler must not substitute
# 1024 first).


def _recording_anthropic_client() -> Any:
    message = SimpleNamespace(
        model="claude-sonnet-5",
        content=[SimpleNamespace(type="text", text="ok")],
        usage=SimpleNamespace(input_tokens=1, output_tokens=1),
        stop_reason="end_turn",
        stop_details=None,
    )
    client = SimpleNamespace()
    client.messages = SimpleNamespace(
        create=AsyncMock(return_value=message),
        batches=SimpleNamespace(
            create=AsyncMock(return_value=SimpleNamespace(id="msgbatch_1")),
            retrieve=AsyncMock(
                return_value=SimpleNamespace(processing_status="in_progress")
            ),
        ),
    )
    return client


@pytest.mark.asyncio
@pytest.mark.parametrize(("max_tokens", "expected"), [(None, 16000), (512, 512)])
async def test_provider_call_max_tokens_reaches_anthropic_sync(
    max_tokens: int | None, expected: int
) -> None:
    client = _recording_anthropic_client()
    async with Scheduler(feed=mock_grid_feed()) as s:
        rec = await s.enqueue_provider_call(
            ProviderCallSpec(
                provider="anthropic",
                model="claude-sonnet-5",
                prompt="hi",
                max_tokens=max_tokens,
            ),
            DeferOptions(deadline=_in_hours(0.001).isoformat()),
        )
        rec.scheduled_for = (datetime.now(UTC) - timedelta(seconds=1)).isoformat()
        s._tasks[rec.task_id] = rec  # type: ignore[index]
        result = await s.tick({"anthropic": AnthropicAdapter(client=client)})
        assert result.dispatched == 1
    assert client.messages.create.await_args.kwargs["max_tokens"] == expected


@pytest.mark.asyncio
@pytest.mark.parametrize(("max_tokens", "expected"), [(None, 16000), (512, 512)])
async def test_provider_call_max_tokens_reaches_anthropic_batch(
    max_tokens: int | None, expected: int
) -> None:
    client = _recording_anthropic_client()
    async with Scheduler(feed=mock_grid_feed()) as s:
        await s.enqueue_provider_call(
            ProviderCallSpec(
                provider="anthropic",
                model="claude-sonnet-5",
                prompt="hi",
                max_tokens=max_tokens,
                prefer_batch=True,
            ),
            DeferOptions(deadline=_in_hours(72).isoformat()),
        )
        result = await s.tick({"anthropic": AnthropicAdapter(client=client)})
        assert result.batch_submitted == 1
    requests = client.messages.batches.create.await_args.kwargs["requests"]
    assert requests[0]["params"]["max_tokens"] == expected


@pytest.mark.asyncio
async def test_provider_call_refusal_fails_the_task() -> None:
    client = _recording_anthropic_client()
    client.messages.create = AsyncMock(
        return_value=SimpleNamespace(
            model="claude-opus-5",
            content=[],
            usage=SimpleNamespace(input_tokens=1, output_tokens=0),
            stop_reason="refusal",
            stop_details=SimpleNamespace(type="refusal", category="cyber"),
        )
    )
    async with Scheduler(feed=mock_grid_feed()) as s:
        rec = await s.enqueue_provider_call(
            ProviderCallSpec(provider="anthropic", model="claude-opus-5", prompt="hi"),
            DeferOptions(deadline=_in_hours(0.001).isoformat()),
        )
        rec.scheduled_for = (datetime.now(UTC) - timedelta(seconds=1)).isoformat()
        s._tasks[rec.task_id] = rec  # type: ignore[index]
        result = await s.tick({"anthropic": AnthropicAdapter(client=client)})
        assert result.failed == 1
        assert result.dispatched == 0
        task = s.get_task(rec.task_id)
        assert task.status == "failed"
        assert "cyber" in (task.error or "")
    # A refusal is not transient: exactly one provider call, no retry.
    assert client.messages.create.await_count == 1


# --------------------------------------------------------------------- #
# _is_retryable: SDK-wrapped transport errors


def _wrapped(cause: BaseException) -> BaseException:
    """An SDK wrapper raised ``from`` a transport error, like anthropic's
    ``APIConnectionError``."""
    try:
        try:
            raise cause
        except BaseException as err:
            raise RuntimeError("Connection error.") from err
    except RuntimeError as wrapper:
        return wrapper


def test_is_retryable_follows_cause_to_pre_connect_error() -> None:
    import httpx

    from tidegap.scheduler import _is_retryable

    assert _is_retryable(_wrapped(httpx.ConnectError("refused")))
    assert _is_retryable(_wrapped(httpx.ConnectTimeout("slow dns")))
    assert not _is_retryable(_wrapped(httpx.ReadTimeout("mid-flight")))
    assert not _is_retryable(RuntimeError("Connection error."))


def test_is_retryable_anthropic_connection_error() -> None:
    anthropic = pytest.importorskip("anthropic")
    httpx2 = pytest.importorskip("httpx2")
    from tidegap.scheduler import _is_retryable

    request = httpx2.Request("POST", "https://api.anthropic.com/v1/messages")

    def wrap(cause: BaseException, cls: type[BaseException]) -> BaseException:
        try:
            try:
                raise cause
            except BaseException as err:
                raise cls(request=request) from err  # type: ignore[call-arg]
        except BaseException as wrapper:
            return wrapper

    pre = wrap(httpx2.ConnectError("refused"), anthropic.APIConnectionError)
    mid = wrap(httpx2.ReadTimeout("mid-flight"), anthropic.APITimeoutError)
    assert _is_retryable(pre)
    assert not _is_retryable(mid)
