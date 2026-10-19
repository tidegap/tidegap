"""Tests for the 2026-07-07 audit correctness pack (Python parity).

Mirrors ``packages/core-ts/test/audit-2026-07.test.ts`` plus the
Python-specific findings: receipt provenance (§0.2/§1.6/§1.8), paid call
never failed (§0.5-PY), multi-process safety (§1.1-1.4), cancellation
semantics (TaskCancelledError), retry/backoff (P10), shutdown settling
awaiters (P11), re-entry keeping the committed window (V20), enqueue
no-loop (P12), _schedules pruning (P13), current-hour candidacy (§1.7),
output_path (V21), and body redaction + ledger permissions (§0.8).
"""

from __future__ import annotations

import asyncio
import contextlib
import json
import os
import sqlite3
import stat
from datetime import UTC, datetime, timedelta
from pathlib import Path
from types import SimpleNamespace
from typing import Any

import httpx
import pytest

import tidegap.scheduler as scheduler_mod
from tidegap import (
    DeferOptions,
    ProviderCallSpec,
    Scheduler,
    SchedulerShutdownError,
    TaskCancelledError,
    mock_grid_feed,
    pick_best_window,
    recommend_window,
)
from tidegap.providers.base import (
    BatchHandle,
    DispatchOptions,
    DispatchResult,
    ProviderAdapter,
)
from tidegap.providers.openai import OpenAIAdapter
from tidegap.types import GridForecast, GridForecastEntry

# --------------------------------------------------------------------- #
# Helpers


def _iso(dt: datetime) -> str:
    return scheduler_mod._iso_utc(dt)


def _in_hours(h: float) -> str:
    return (datetime.now(UTC) + timedelta(hours=h)).isoformat()


def _classify(g: float) -> str:
    if g < 100:
        return "very_clean"
    if g < 250:
        return "clean"
    if g < 450:
        return "average"
    if g < 700:
        return "dirty"
    return "very_dirty"


class StaticFeed:
    """Feed built from (offset_seconds, intensity) pairs, frozen at init.

    ``fail_when(hours)`` can make specific fetches raise — e.g. only the
    receipt-side 24h fetch, or every fetch after the first.
    """

    def __init__(
        self,
        points: list[tuple[float, float]],
        *,
        source: str = "mock",
    ) -> None:
        now = datetime.now(UTC)
        self.source = source
        self.calls = 0
        self.fail_predicate = None  # (call_index, hours) -> bool
        self._entries = [
            GridForecastEntry(
                datetime=_iso(now + timedelta(seconds=offset)),
                carbon_intensity_g_co2_per_kwh=intensity,
                band=_classify(intensity),  # type: ignore[arg-type]
            )
            for offset, intensity in points
        ]

    async def fetch_forecast(self, region: str, hours: int) -> GridForecast:
        self.calls += 1
        if self.fail_predicate is not None and self.fail_predicate(self.calls, hours):
            raise RuntimeError("synthetic feed outage")
        return GridForecast(
            region=region,
            source=self.source,  # type: ignore[arg-type]
            generated_at=_iso(datetime.now(UTC)),
            entries=list(self._entries),
            kind="forecast",
        )


class FakeAdapter(ProviderAdapter):
    """Deterministic adapter; scriptable failures via ``raise_queue``."""

    name = "anthropic"

    def __init__(self, *, echo_model: str | None = None) -> None:
        self.dispatch_calls: list[tuple[str, str]] = []
        self.batch_calls: list[tuple[str, list[str]]] = []
        self.raise_queue: list[Exception] = []
        self.echo_model = echo_model
        self.started = asyncio.Event()
        self.proceed: asyncio.Event | None = None

    async def dispatch(
        self,
        model: str,
        prompt: str,
        options: DispatchOptions | None = None,
    ) -> DispatchResult:
        self.dispatch_calls.append((model, prompt))
        self.started.set()
        if self.proceed is not None:
            await self.proceed.wait()
        if self.raise_queue:
            raise self.raise_queue.pop(0)
        return DispatchResult(
            text=f"ok:{prompt}",
            model=self.echo_model or model,
            provider=self.name,
            input_tokens=10,
            output_tokens=5,
        )

    async def dispatch_batch(
        self,
        model: str,
        prompts: list[str],
        options: DispatchOptions | None = None,
    ) -> BatchHandle:
        self.batch_calls.append((model, prompts))
        return BatchHandle(
            batch_id="batch-1",
            provider=self.name,
            model=model,
            prompt_count=len(prompts),
        )


async def _force_due(s: Scheduler, task_id: str) -> None:
    """Rewind a task's scheduled_for into the past so tick sees it as due."""
    rec = s.get_task(task_id)
    assert rec is not None
    rec.scheduled_for = _iso(datetime.now(UTC) - timedelta(seconds=1))
    s._tasks[task_id] = rec
    if s._store is not None and s._connected:
        await s._store.upsert(rec)


# --------------------------------------------------------------------- #
# Task 1 — receipt provenance (§0.2, §1.6, §1.8)


async def test_provider_receipt_records_provenance(tmp_path: Path) -> None:
    db = tmp_path / "queue.sqlite"
    async with Scheduler(feed=mock_grid_feed(), db_path=str(db)) as s:
        await s.enqueue_provider_call(
            ProviderCallSpec(
                provider="anthropic", model="claude-sonnet-4-5", prompt="hi"
            ),
            DeferOptions(deadline=_in_hours(1), task_id="prov:1"),
        )
        await _force_due(s, "prov:1")
        await s.tick({"anthropic": FakeAdapter()})
        loaded = await s.load_persisted_task("prov:1")
        assert loaded is not None and loaded.status == "completed"
        receipt = loaded.receipt
        assert receipt is not None
        assert receipt.intensity_g_co2_per_kwh is not None
        assert receipt.intensity_g_co2_per_kwh > 0
        assert receipt.grid_source == "mock"
        assert receipt.energy_source == "estimated"
        # claude-sonnet-4-5 is an exact table hit (§1.8 resolution tier).
        assert receipt.energy_resolution == "exact"
        # The camelCase (cross-language) rendering carries the new keys.
        camel = receipt.to_camel_dict()
        assert camel["gridSource"] == "mock"
        assert camel["energySource"] == "estimated"
        assert camel["energyResolution"] == "exact"
        assert camel["intensityGCo2PerKwh"] == receipt.intensity_g_co2_per_kwh


async def test_unknown_model_receipt_gets_fallback_energy_tier() -> None:
    async with Scheduler(feed=mock_grid_feed()) as s:
        await s.enqueue_provider_call(
            ProviderCallSpec(
                provider="anthropic", model="mystery-model-9000", prompt="hi"
            ),
            DeferOptions(deadline=_in_hours(1), task_id="prov:2"),
        )
        await _force_due(s, "prov:2")
        await s.tick({"anthropic": FakeAdapter()})
        rec = s.get_task("prov:2")
        assert rec is not None and rec.receipt is not None
        assert rec.receipt.energy_source == "fallback"
        assert rec.receipt.energy_resolution == "default"


async def test_family_fallback_receipt_is_honest() -> None:
    # An unknown Sonnet-family id resolves to the sonnet representative's
    # (estimated) coefficients and the receipt discloses the family fallback.
    async with Scheduler(feed=mock_grid_feed()) as s:
        await s.enqueue_provider_call(
            ProviderCallSpec(
                provider="anthropic", model="claude-sonnet-9", prompt="hi"
            ),
            DeferOptions(deadline=_in_hours(1), task_id="prov:fam"),
        )
        await _force_due(s, "prov:fam")
        await s.tick({"anthropic": FakeAdapter()})
        rec = s.get_task("prov:fam")
        assert rec is not None and rec.receipt is not None
        assert rec.receipt.energy_source == "estimated"
        assert rec.receipt.energy_resolution == "family-fallback"


async def test_closure_receipt_records_provenance() -> None:
    async with Scheduler(feed=mock_grid_feed()) as s:
        await s.defer(
            lambda: "ok",
            DeferOptions(
                deadline=(datetime.now(UTC) + timedelta(milliseconds=300)).isoformat()
            ),
        )
        rec = s.list_tasks()[0]
        assert rec.receipt is not None
        assert rec.receipt.grid_source == "mock"
        assert rec.receipt.energy_source == "fallback"
        assert rec.receipt.energy_resolution == "default"
        assert rec.receipt.intensity_g_co2_per_kwh is not None


async def test_receipt_provenance_round_trips_sqlite(tmp_path: Path) -> None:
    db = tmp_path / "queue.sqlite"
    async with Scheduler(feed=mock_grid_feed(), db_path=str(db)) as s:
        await s.enqueue_provider_call(
            ProviderCallSpec(provider="anthropic", model="claude-x", prompt="hi"),
            DeferOptions(deadline=_in_hours(1), task_id="prov:rt"),
        )
        await _force_due(s, "prov:rt")
        await s.tick({"anthropic": FakeAdapter()})
    # Fresh scheduler, fresh process semantics: row must rehydrate the
    # provenance fields through _row_to_record.
    async with Scheduler(feed=mock_grid_feed(), db_path=str(db)) as s2:
        loaded = await s2.load_persisted_task("prov:rt")
        assert loaded is not None and loaded.receipt is not None
        assert loaded.receipt.grid_source == "mock"
        assert loaded.receipt.intensity_g_co2_per_kwh is not None
        assert loaded.receipt.energy_source is not None


async def test_mock_forecast_declares_kind_forecast() -> None:
    forecast = await mock_grid_feed().fetch_forecast("US-CAL-CISO", 4)
    assert forecast.kind == "forecast"
    assert forecast.to_dict()["kind"] == "forecast"


async def test_recommend_reports_grid_source_and_synthetic_prefix() -> None:
    res = await recommend_window(
        deadline=_in_hours(6),
        region="US-CAL-CISO",
    )
    assert res.grid_source == "mock"
    assert res.reasoning.startswith("SYNTHETIC (mock) grid data — ")
    assert res.to_dict()["grid_source"] == "mock"

    live_feed = StaticFeed([(1800, 100), (5400, 300)], source="electricityMaps")
    res_live = await recommend_window(
        deadline=_in_hours(6),
        region="US-CAL-CISO",
        feed=live_feed,  # type: ignore[arg-type]
    )
    assert res_live.grid_source == "electricityMaps"
    assert not res_live.reasoning.startswith("SYNTHETIC")


# --------------------------------------------------------------------- #
# Task 2 — paid call never failed (§0.5-PY)


async def test_provider_call_stays_completed_when_receipt_fetch_fails(
    tmp_path: Path,
) -> None:
    db = tmp_path / "queue.sqlite"
    feed = StaticFeed([(600, 100), (4200, 400)])
    # Only the receipt-side fetch (a fixed 24h horizon) fails.
    feed.fail_predicate = lambda _call, hours: hours == 24
    async with Scheduler(feed=feed, db_path=str(db)) as s:  # type: ignore[arg-type]
        await s.enqueue_provider_call(
            ProviderCallSpec(provider="anthropic", model="claude-x", prompt="hi"),
            DeferOptions(deadline=_in_hours(2), task_id="paid:1"),
        )
        await _force_due(s, "paid:1")
        adapter = FakeAdapter()
        result = await s.tick({"anthropic": adapter})  # must not raise
        assert result.failed == 0
        assert result.dispatched == 1
        assert len(adapter.dispatch_calls) == 1
        loaded = await s.load_persisted_task("paid:1")
        assert loaded is not None
        assert loaded.status == "completed"  # never a zombie "running"
        assert loaded.result is not None
        # Receipt fell back to the schedule-time estimate; no provenance
        # intensity because the fetch failed.
        assert loaded.receipt is not None
        assert loaded.receipt.intensity_g_co2_per_kwh is None
        assert loaded.receipt.grid_source is None


async def test_closure_awaiter_resolves_when_receipt_fetch_fails() -> None:
    feed = StaticFeed([(0.05, 100)])
    feed.fail_predicate = lambda _call, hours: hours == 24
    async with Scheduler(feed=feed) as s:  # type: ignore[arg-type]
        result = await asyncio.wait_for(
            s.defer(
                lambda: 42,
                DeferOptions(
                    deadline=(
                        datetime.now(UTC) + timedelta(milliseconds=400)
                    ).isoformat()
                ),
            ),
            timeout=5,
        )
        assert result == 42
        rec = s.list_tasks()[0]
        assert rec.status == "completed"
        assert rec.receipt is not None
        assert rec.receipt.grid_source is None


async def test_fail_never_flips_a_terminal_record() -> None:
    async with Scheduler(feed=mock_grid_feed()) as s:
        await s.defer(
            lambda: "done",
            DeferOptions(
                deadline=(datetime.now(UTC) + timedelta(milliseconds=200)).isoformat(),
                task_id="term:1",
            ),
        )
        rec = s.get_task("term:1")
        assert rec is not None and rec.status == "completed"
        await s._fail("term:1", RuntimeError("late paperwork error"))
        assert rec.status == "completed"
        assert rec.error is None


# --------------------------------------------------------------------- #
# Task 3 — multi-process pack (§1.1-1.4)


async def test_duplicate_task_id_rejected_against_store(tmp_path: Path) -> None:
    db = tmp_path / "queue.sqlite"
    async with Scheduler(feed=mock_grid_feed(), db_path=str(db)) as s1:
        await s1.enqueue_provider_call(
            ProviderCallSpec(provider="anthropic", model="claude-x", prompt="original"),
            DeferOptions(deadline=_in_hours(6), task_id="dup:1"),
        )
        await s1.expedite_task("dup:1", {"anthropic": FakeAdapter()})
        rec = s1.get_task("dup:1")
        assert rec is not None and rec.status == "completed"

    # A fresh process (empty in-memory map) must not overwrite the
    # persisted, completed + signed ledger row.
    async with Scheduler(feed=mock_grid_feed(), db_path=str(db)) as s2:
        with pytest.raises(ValueError, match="already in the queue"):
            await s2.enqueue_provider_call(
                ProviderCallSpec(
                    provider="anthropic", model="claude-x", prompt="attacker overwrite"
                ),
                DeferOptions(deadline=_in_hours(6), task_id="dup:1"),
            )
        with pytest.raises(ValueError, match="already in the queue"):
            s2.enqueue(lambda: "x", DeferOptions(deadline=_in_hours(1), task_id="dup:1"))
        row = await s2.load_persisted_task("dup:1")
        assert row is not None
        assert row.status == "completed"
        assert row.receipt is not None
        assert "ok:" in json.dumps(row.result)


async def test_expedite_raises_when_another_process_claimed(tmp_path: Path) -> None:
    db = tmp_path / "queue.sqlite"
    async with Scheduler(feed=mock_grid_feed(), db_path=str(db)) as s:
        await s.enqueue_provider_call(
            ProviderCallSpec(provider="anthropic", model="m", prompt="p"),
            DeferOptions(deadline=_in_hours(6), task_id="claim:1"),
        )

        async def lose_claim(task_id: str) -> bool:
            return False

        s._store.claim_scheduled = lose_claim  # type: ignore[union-attr, method-assign]
        adapter = FakeAdapter()
        with pytest.raises(RuntimeError, match="just claimed by another process"):
            await s.expedite_task("claim:1", {"anthropic": adapter})
        assert len(adapter.dispatch_calls) == 0


async def test_retry_raises_when_another_process_claimed(tmp_path: Path) -> None:
    db = tmp_path / "queue.sqlite"
    async with Scheduler(feed=mock_grid_feed(), db_path=str(db)) as s:
        await s.enqueue_provider_call(
            ProviderCallSpec(provider="anthropic", model="m", prompt="p"),
            DeferOptions(deadline=_in_hours(6), task_id="claim:2"),
        )
        failing = FakeAdapter()
        failing.raise_queue.append(RuntimeError("bad request"))
        rec = await s.expedite_task("claim:2", {"anthropic": failing})
        assert rec.status == "failed"

        async def lose_claim(task_id: str) -> bool:
            return False

        s._store.claim_scheduled = lose_claim  # type: ignore[union-attr, method-assign]
        adapter = FakeAdapter()
        with pytest.raises(RuntimeError, match="just claimed by another process"):
            await s.retry_task("claim:2", {"anthropic": adapter})
        assert len(adapter.dispatch_calls) == 0


async def test_tick_survives_claim_exception(tmp_path: Path) -> None:
    db = tmp_path / "queue.sqlite"
    async with Scheduler(feed=mock_grid_feed(), db_path=str(db)) as s:
        await s.enqueue_provider_call(
            ProviderCallSpec(provider="anthropic", model="m", prompt="p"),
            DeferOptions(deadline=_in_hours(1), task_id="busy:1"),
        )
        await _force_due(s, "busy:1")

        async def throwing_claim(task_id: str) -> bool:
            raise sqlite3.OperationalError("database is locked")

        s._store.claim_scheduled = throwing_claim  # type: ignore[union-attr, method-assign]
        result = await s.tick({"anthropic": FakeAdapter()})  # must not raise
        assert result.inspected == 0
        assert result.failed == 0


async def test_cancel_mid_flight_keeps_cancelled_row_provider(
    tmp_path: Path,
) -> None:
    db = tmp_path / "queue.sqlite"
    async with Scheduler(feed=mock_grid_feed(), db_path=str(db)) as s:
        await s.enqueue_provider_call(
            ProviderCallSpec(provider="anthropic", model="m", prompt="p"),
            DeferOptions(deadline=_in_hours(1), task_id="cxl:1"),
        )
        await _force_due(s, "cxl:1")
        adapter = FakeAdapter()
        adapter.proceed = asyncio.Event()
        tick_task = asyncio.create_task(s.tick({"anthropic": adapter}))
        await asyncio.wait_for(adapter.started.wait(), timeout=5)
        # Cancel while the provider call is in flight...
        await s.cancel_task("cxl:1")
        adapter.proceed.set()
        result = await asyncio.wait_for(tick_task, timeout=5)
        # ...the late result is dropped, the cancelled row survives.
        assert result.results[0].status == "failed"
        assert "cancelled while running" in (result.results[0].error or "")
        loaded = await s.load_persisted_task("cxl:1")
        assert loaded is not None
        assert loaded.status == "cancelled"
        assert loaded.result is None


async def test_cancel_mid_flight_drops_late_closure_result() -> None:
    async with Scheduler(feed=mock_grid_feed()) as s:
        record_holder: dict[str, Any] = {}

        def body() -> str:
            # Simulate a concurrent cancellation landing while the body
            # runs (e.g. another coroutine flipping the shared record).
            record_holder["rec"].status = "cancelled"
            return "late"

        rec = s.enqueue(
            body,
            DeferOptions(
                deadline=(datetime.now(UTC) + timedelta(milliseconds=200)).isoformat(),
                task_id="cxl:2",
            ),
        )
        record_holder["rec"] = rec
        await asyncio.sleep(1.0)
        assert rec.status == "cancelled"
        assert rec.result is None


async def test_busy_timeout_is_5000(tmp_path: Path) -> None:
    db = tmp_path / "queue.sqlite"
    async with Scheduler(feed=mock_grid_feed(), db_path=str(db)) as s:
        conn = s._store._conn  # type: ignore[union-attr]
        assert conn is not None
        async with conn.execute("PRAGMA busy_timeout") as cur:
            row = await cur.fetchone()
        assert row is not None and row[0] == 5000


async def test_deadline_persisted_on_record_and_column(tmp_path: Path) -> None:
    db = tmp_path / "queue.sqlite"
    deadline = _in_hours(6)
    async with Scheduler(feed=mock_grid_feed(), db_path=str(db)) as s:
        rec = await s.enqueue_provider_call(
            ProviderCallSpec(provider="anthropic", model="m", prompt="p"),
            DeferOptions(deadline=deadline, task_id="dl:1"),
        )
        assert rec.deadline is not None
        closure_rec = s.enqueue(
            lambda: 1, DeferOptions(deadline=deadline, task_id="dl:2")
        )
        assert closure_rec.deadline is not None
        # update_deadline refreshes the persisted deadline.
        updated = await s.update_deadline("dl:1", _in_hours(12))
        assert updated.deadline is not None
        updated_at = scheduler_mod._parse_iso(updated.deadline)
        assert updated_at is not None
        assert updated_at > datetime.now(UTC) + timedelta(hours=11)
    # The column name MUST be `deadline` — the DB is shared with the TS
    # port, whose reader selects that exact name.
    with contextlib.closing(sqlite3.connect(str(db))) as conn, conn:
        cols = {r[1] for r in conn.execute("PRAGMA table_info(tasks)")}
        assert "deadline" in cols
        row = conn.execute(
            "SELECT deadline FROM tasks WHERE task_id = 'dl:1'"
        ).fetchone()
        assert row is not None and row[0] is not None
    # A fresh scheduler rehydrates the deadline from the row.
    async with Scheduler(feed=mock_grid_feed(), db_path=str(db)) as s2:
        loaded = await s2.load_persisted_task("dl:1")
        assert loaded is not None and loaded.deadline is not None


# --------------------------------------------------------------------- #
# Task 4 — cancellation semantics (TaskCancelledError)


async def test_cancel_rejects_awaiter_with_catchable_exception() -> None:
    # A guaranteed-future window keeps the task pending regardless of the
    # wall-clock hour (the mock curve could make "now" the trough).
    feed = StaticFeed([(0, 500), (7200, 100)])
    async with Scheduler(feed=feed) as s:  # type: ignore[arg-type]
        defer_task = asyncio.create_task(
            s.defer(
                lambda: "never",
                DeferOptions(deadline=_in_hours(10), task_id="cancelerr:1"),
            )
        )
        await asyncio.sleep(0.05)
        await s.cancel_task("cancelerr:1")
        with pytest.raises(TaskCancelledError) as exc_info:
            await defer_task
        # A plain Exception (catchable by `except Exception`), NOT
        # asyncio.CancelledError — and the caller's task is not marked
        # cancelled.
        assert isinstance(exc_info.value, Exception)
        assert not isinstance(exc_info.value, asyncio.CancelledError)
        assert exc_info.value.task_id == "cancelerr:1"
        assert not defer_task.cancelled()


async def test_cancelled_defer_is_catchable_inside_taskgroup() -> None:
    feed = StaticFeed([(0, 500), (7200, 100)])
    async with Scheduler(feed=feed) as s:  # type: ignore[arg-type]
        caught: list[Exception] = []

        async def deferred() -> None:
            try:
                await s.defer(
                    lambda: "never",
                    DeferOptions(deadline=_in_hours(10), task_id="tg:1"),
                )
            except TaskCancelledError as err:
                caught.append(err)

        async def canceller() -> None:
            await asyncio.sleep(0.05)
            await s.cancel_task("tg:1")

        # Must not unwind the TaskGroup.
        async with asyncio.TaskGroup() as tg:
            tg.create_task(deferred())
            tg.create_task(canceller())
        assert len(caught) == 1


# --------------------------------------------------------------------- #
# Task 5 — retry with backoff (P10)


class _StatusError(Exception):
    def __init__(self, status: int) -> None:
        super().__init__(f"http {status}")
        self.status = status


async def test_retry_429_then_success(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(scheduler_mod, "_RETRY_WAITS_S", (0.0, 0.0, 0.0))
    async with Scheduler(feed=mock_grid_feed()) as s:
        await s.enqueue_provider_call(
            ProviderCallSpec(provider="anthropic", model="m", prompt="p"),
            DeferOptions(deadline=_in_hours(1), task_id="retry:429"),
        )
        await _force_due(s, "retry:429")
        adapter = FakeAdapter()
        adapter.raise_queue.append(_StatusError(429))
        result = await s.tick({"anthropic": adapter})
        assert result.dispatched == 1
        assert len(adapter.dispatch_calls) == 2
        rec = s.get_task("retry:429")
        assert rec is not None and rec.status == "completed"


async def test_read_timeout_fails_fast_no_retry(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(scheduler_mod, "_RETRY_WAITS_S", (0.0, 0.0, 0.0))
    async with Scheduler(feed=mock_grid_feed()) as s:
        await s.enqueue_provider_call(
            ProviderCallSpec(provider="anthropic", model="m", prompt="p"),
            DeferOptions(deadline=_in_hours(1), task_id="retry:timeout"),
        )
        await _force_due(s, "retry:timeout")
        adapter = FakeAdapter()
        # Read timeouts are ambiguous (may already be billed) — one
        # attempt only, then failed.
        adapter.raise_queue.append(httpx.ReadTimeout("read timed out"))
        result = await s.tick({"anthropic": adapter})
        assert result.failed == 1
        assert len(adapter.dispatch_calls) == 1


async def test_connect_error_is_retried(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(scheduler_mod, "_RETRY_WAITS_S", (0.0, 0.0, 0.0))
    async with Scheduler(feed=mock_grid_feed()) as s:
        await s.enqueue_provider_call(
            ProviderCallSpec(provider="anthropic", model="m", prompt="p"),
            DeferOptions(deadline=_in_hours(1), task_id="retry:conn"),
        )
        await _force_due(s, "retry:conn")
        adapter = FakeAdapter()
        adapter.raise_queue.append(httpx.ConnectError("refused"))
        result = await s.tick({"anthropic": adapter})
        assert result.dispatched == 1
        assert len(adapter.dispatch_calls) == 2


async def test_plain_400_not_retried(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(scheduler_mod, "_RETRY_WAITS_S", (0.0, 0.0, 0.0))
    async with Scheduler(feed=mock_grid_feed()) as s:
        await s.enqueue_provider_call(
            ProviderCallSpec(provider="anthropic", model="m", prompt="p"),
            DeferOptions(deadline=_in_hours(1), task_id="retry:400"),
        )
        await _force_due(s, "retry:400")
        adapter = FakeAdapter()
        adapter.raise_queue.append(_StatusError(400))
        result = await s.tick({"anthropic": adapter})
        assert result.failed == 1
        assert len(adapter.dispatch_calls) == 1


# --------------------------------------------------------------------- #
# Task 6 — shutdown settles awaiters (P11)


async def test_shutdown_rejects_pending_defer_awaiters() -> None:
    feed = StaticFeed([(0, 500), (7200, 100)])  # window 2h out — stays pending
    s = Scheduler(feed=feed)  # type: ignore[arg-type]
    defer_task = asyncio.create_task(
        s.defer(lambda: "never", DeferOptions(deadline=_in_hours(3), task_id="shut:1"))
    )
    await asyncio.sleep(0.05)
    assert not defer_task.done()
    await s.shutdown()
    with pytest.raises(SchedulerShutdownError) as exc_info:
        await asyncio.wait_for(defer_task, timeout=1)
    assert exc_info.value.task_id == "shut:1"
    # Bodies were dropped with the resolvers.
    assert s._bodies == {}
    assert s._resolvers == {}


async def test_async_with_scheduler_cannot_deadlock_pending_defer() -> None:
    feed = StaticFeed([(0, 500), (7200, 100)])
    async with Scheduler(feed=feed) as s:  # type: ignore[arg-type]
        defer_task = asyncio.create_task(
            s.defer(
                lambda: "never", DeferOptions(deadline=_in_hours(3), task_id="shut:2")
            )
        )
        await asyncio.sleep(0.05)
    with pytest.raises(SchedulerShutdownError):
        await asyncio.wait_for(defer_task, timeout=1)


# --------------------------------------------------------------------- #
# Task 7 — re-entry keeps the committed window (V20)


async def test_reentry_feed_failure_keeps_window(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    # Shrink the nap chunk so the hourly re-entry happens within the test.
    monkeypatch.setattr(scheduler_mod, "_SLEEP_CHUNK_S", 0.05)
    window_offset_s = 0.4
    feed = StaticFeed([(0, 500), (window_offset_s, 100)])
    window_at = scheduler_mod._parse_iso(feed._entries[1].datetime)
    assert window_at is not None
    # Every fetch after the first (including re-entries and the
    # receipt-side fetch) fails.
    feed.fail_predicate = lambda call, _hours: call > 1

    async with Scheduler(feed=feed) as s:  # type: ignore[arg-type]
        completed_at: dict[str, datetime] = {}

        def body() -> str:
            completed_at["at"] = datetime.now(UTC)
            return "ran"

        result = await asyncio.wait_for(
            s.defer(body, DeferOptions(deadline=_in_hours(1), task_id="reentry:1")),
            timeout=10,
        )
        assert result == "ran"
        rec = s.get_task("reentry:1")
        assert rec is not None and rec.status == "completed"
        # The committed window was honored: the task did NOT dispatch
        # immediately when the re-entry fetch failed. Allow a small
        # scheduling epsilon.
        assert completed_at["at"] >= window_at - timedelta(milliseconds=50)
        # More than one fetch happened (i.e. re-entry actually retried).
        assert feed.calls > 1


async def test_first_schedule_feed_failure_still_dispatches_now() -> None:
    feed = StaticFeed([(0, 100)])
    feed.fail_predicate = lambda call, hours: hours != 24  # scheduling fetch fails
    async with Scheduler(feed=feed) as s:  # type: ignore[arg-type]
        result = await asyncio.wait_for(
            s.defer(lambda: "fallback", DeferOptions(deadline=_in_hours(1))),
            timeout=5,
        )
        assert result == "fallback"


# --------------------------------------------------------------------- #
# Task 8 — enqueue without a running loop (P12)


def test_enqueue_outside_event_loop_raises_cleanly() -> None:
    s = Scheduler(feed=mock_grid_feed())
    with pytest.raises(RuntimeError, match="running event loop"):
        s.enqueue(lambda: 1, DeferOptions(deadline=_in_hours(1), task_id="noloop:1"))
    # No phantom queued record; the id stays reusable.
    assert s.list_tasks() == []

    async def use_id_again() -> str:
        result = await s.defer(
            lambda: "ok",
            DeferOptions(
                deadline=(datetime.now(UTC) + timedelta(milliseconds=200)).isoformat(),
                task_id="noloop:1",
            ),
        )
        await s.shutdown()
        return result

    assert asyncio.run(use_id_again()) == "ok"


# --------------------------------------------------------------------- #
# Task 9 — _schedules pruning (P13)


async def test_schedules_map_pruned_after_completion() -> None:
    async with Scheduler(feed=mock_grid_feed()) as s:
        await s.defer(
            lambda: "ok",
            DeferOptions(
                deadline=(datetime.now(UTC) + timedelta(milliseconds=200)).isoformat(),
                task_id="prune:1",
            ),
        )
        # Done-callbacks run on the next loop pass.
        await asyncio.sleep(0)
        assert "prune:1" not in s._schedules


# --------------------------------------------------------------------- #
# Task 10 — current-hour candidacy (§1.7)


def test_pick_best_window_accepts_current_hour() -> None:
    now = datetime.now(UTC)
    entries = [
        GridForecastEntry(
            datetime=_iso(now - timedelta(minutes=30)),
            carbon_intensity_g_co2_per_kwh=100,
            band="clean",
        ),
        GridForecastEntry(
            datetime=_iso(now + timedelta(hours=1)),
            carbon_intensity_g_co2_per_kwh=400,
            band="average",
        ),
    ]
    best = pick_best_window(entries, now + timedelta(hours=2))
    assert best is not None
    assert best.carbon_intensity_g_co2_per_kwh == 100


async def test_provider_current_hour_schedules_for_now(tmp_path: Path) -> None:
    feed = StaticFeed([(-1800, 100), (3600, 400)])
    async with Scheduler(feed=feed, db_path=str(tmp_path / "q.sqlite")) as s:  # type: ignore[arg-type]
        rec = await s.enqueue_provider_call(
            ProviderCallSpec(provider="anthropic", model="m", prompt="p"),
            DeferOptions(deadline=_in_hours(2), task_id="cur:1"),
        )
        assert rec.status == "scheduled"
        assert rec.scheduled_for is not None
        scheduled_at = scheduler_mod._parse_iso(rec.scheduled_for)
        assert scheduled_at is not None
        # Scheduled for "now" (not the past hour-start), so the very next
        # tick dispatches immediately.
        assert scheduled_at <= datetime.now(UTC)
        result = await s.tick({"anthropic": FakeAdapter()})
        assert result.dispatched == 1


async def test_closure_current_hour_dispatches_immediately() -> None:
    feed = StaticFeed([(-1800, 100), (3600, 400)])
    async with Scheduler(feed=feed) as s:  # type: ignore[arg-type]
        result = await asyncio.wait_for(
            s.defer(lambda: "now", DeferOptions(deadline=_in_hours(2))),
            timeout=2,
        )
        assert result == "now"
        rec = s.list_tasks()[0]
        # Dispatched with the scored current-hour entry.
        assert rec.intensity_source == "scored"


async def test_recommend_can_recommend_current_hour() -> None:
    feed = StaticFeed([(-1800, 100), (3600, 400)])
    res = await recommend_window(
        deadline=_in_hours(2),
        region="US-CAL-CISO",
        feed=feed,  # type: ignore[arg-type]
    )
    assert res.intensity_g_co2_per_kwh == 100
    assert res.estimated_savings_vs_now_pct == 0


# --------------------------------------------------------------------- #
# Task 11 — output_path (V21)


def test_provider_call_spec_accepts_camel_output_path() -> None:
    spec = ProviderCallSpec.from_dict(
        {
            "type": "provider_call",
            "provider": "anthropic",
            "model": "m",
            "prompt": "p",
            "outputPath": "/tmp/out.json",
        }
    )
    assert spec.output_path == "/tmp/out.json"
    assert ProviderCallSpec.from_dict(
        {"type": "provider_call", "provider": "anthropic", "model": "m", "prompt": "p", "output_path": "/x"}
    ).output_path == "/x"


async def test_output_path_written_on_success(tmp_path: Path) -> None:
    out = tmp_path / "inbox" / "result.json"
    async with Scheduler(feed=mock_grid_feed()) as s:
        await s.enqueue_provider_call(
            ProviderCallSpec(
                provider="anthropic",
                model="claude-x",
                prompt="hi",
                output_path=str(out),
            ),
            DeferOptions(deadline=_in_hours(1), task_id="out:1"),
        )
        await s.expedite_task("out:1", {"anthropic": FakeAdapter()})
    assert out.exists()
    payload = json.loads(out.read_text())
    assert payload["taskId"] == "out:1"
    assert payload["result"]["text"] == "ok:hi"
    # Receipt is serialized with camelCase (TS-compatible) keys.
    assert "estimatedCarbonGCo2" in payload["receipt"]
    assert payload["receipt"]["taskId"] == "out:1"


# --------------------------------------------------------------------- #
# Task 12 — body redaction + ledger permissions (§0.8)

_SECRET = "sk-ant-abcdefghijklmnopqrstuvwx123456"
_GH_TOKEN = "ghp_" + "a" * 36
_PROSE = "set DB_PASSWORD and AWS_REGION1 per ISO_8601 in US-MIDA-PJM"


async def test_body_json_redacted_on_completion(tmp_path: Path) -> None:
    db = tmp_path / "queue.sqlite"
    prompt = f"{_PROSE} secret={_SECRET} token={_GH_TOKEN}"
    async with Scheduler(feed=mock_grid_feed(), db_path=str(db)) as s:
        await s.enqueue_provider_call(
            ProviderCallSpec(provider="anthropic", model="m", prompt=prompt),
            DeferOptions(deadline=_in_hours(1), task_id="redact:1"),
        )
        adapter = FakeAdapter()
        await s.expedite_task("redact:1", {"anthropic": adapter})
        # The live dispatch used the caller's original prompt...
        assert adapter.dispatch_calls[0][1] == prompt
        loaded = await s.load_persisted_task("redact:1")
        assert loaded is not None and loaded.body_json is not None
        # ...but the terminal ledger row keeps only the redacted form.
        assert _SECRET not in loaded.body_json
        assert _GH_TOKEN not in loaded.body_json
        assert "[REDACTED]" in loaded.body_json
        # Legitimate prose survives (the old generic uppercase pattern
        # mangled these).
        assert "DB_PASSWORD" in loaded.body_json
        assert "AWS_REGION1" in loaded.body_json
        assert "ISO_8601" in loaded.body_json
        # The receipt prompt is redacted the same way.
        assert loaded.receipt is not None and loaded.receipt.prompt is not None
        assert _SECRET not in loaded.receipt.prompt
        assert "DB_PASSWORD" in loaded.receipt.prompt


async def test_body_json_redacted_on_cancel_but_kept_on_failure(
    tmp_path: Path,
) -> None:
    db = tmp_path / "queue.sqlite"
    prompt = f"payload {_SECRET}"
    async with Scheduler(feed=mock_grid_feed(), db_path=str(db)) as s:
        # Failed task keeps the original body so retry re-dispatches the
        # exact prompt.
        await s.enqueue_provider_call(
            ProviderCallSpec(provider="anthropic", model="m", prompt=prompt),
            DeferOptions(deadline=_in_hours(1), task_id="redact:fail"),
        )
        failing = FakeAdapter()
        failing.raise_queue.append(RuntimeError("provider 500"))
        await s.expedite_task("redact:fail", {"anthropic": failing})
        failed = await s.load_persisted_task("redact:fail")
        assert failed is not None and failed.status == "failed"
        assert failed.body_json is not None and _SECRET in failed.body_json

        # Cancelled task is a terminal transition: redacted.
        await s.enqueue_provider_call(
            ProviderCallSpec(provider="anthropic", model="m", prompt=prompt),
            DeferOptions(deadline=_in_hours(6), task_id="redact:cancel"),
        )
        await s.cancel_task("redact:cancel")
        cancelled = await s.load_persisted_task("redact:cancel")
        assert cancelled is not None and cancelled.status == "cancelled"
        assert cancelled.body_json is not None
        assert _SECRET not in cancelled.body_json
        assert "[REDACTED]" in cancelled.body_json


def test_default_patterns_are_vendor_shaped() -> None:
    redact = scheduler_mod._redact_prompt
    assert redact(f"key {_SECRET} end", None) == "key [REDACTED] end"
    assert "[REDACTED]" in redact(f"gh {_GH_TOKEN}", None)
    assert "[REDACTED]" in redact("aws AKIAIOSFODNN7EXAMPLE", None)
    assert "[REDACTED]" in redact("g AIza" + "B" * 35, None)
    assert "[REDACTED]" in redact("slack xoxb-123456789012-abc", None)
    assert "[REDACTED]" in redact(
        "jwt eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.c2lnbmF0dXJlLXNpZ25hdHVyZQ", None
    )
    # Prose that the removed generic rule used to mangle stays intact.
    assert redact(_PROSE, None) == _PROSE


@pytest.mark.skipif(os.name != "posix", reason="POSIX permission bits")
async def test_ledger_chmod_0600_dir_0700(tmp_path: Path) -> None:
    dirpath = tmp_path / "tidegap-home"
    dirpath.mkdir()
    db = dirpath / "queue.sqlite"
    async with Scheduler(feed=mock_grid_feed(), db_path=str(db)):
        pass
    assert stat.S_IMODE(os.stat(db).st_mode) == 0o600
    assert stat.S_IMODE(os.stat(dirpath).st_mode) == 0o700


# --------------------------------------------------------------------- #
# Task 13 — fire-and-forget scheduling failures route to _fail (§1.5)


async def test_scheduling_crash_fails_task_and_rejects_awaiter(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    async with Scheduler(feed=mock_grid_feed()) as s:
        async def exploding_schedule(task_id: str, deadline: datetime) -> None:
            raise RuntimeError("scheduler internals blew up")

        monkeypatch.setattr(s, "_schedule", exploding_schedule)
        with pytest.raises(RuntimeError, match="internals blew up"):
            await asyncio.wait_for(
                s.defer(
                    lambda: "never",
                    DeferOptions(deadline=_in_hours(1), task_id="fnf:1"),
                ),
                timeout=2,
            )
        rec = s.get_task("fnf:1")
        assert rec is not None and rec.status == "failed"


async def test_provider_scheduling_failure_no_stranded_queued_row(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    db = tmp_path / "queue.sqlite"
    async with Scheduler(feed=mock_grid_feed(), db_path=str(db)) as s:
        async def exploding(task_id: str, deadline: datetime) -> None:
            raise RuntimeError("window scoring blew up")

        monkeypatch.setattr(s, "_schedule_provider_call", exploding)
        with pytest.raises(RuntimeError, match="scoring blew up"):
            await s.enqueue_provider_call(
                ProviderCallSpec(provider="anthropic", model="m", prompt="p"),
                DeferOptions(deadline=_in_hours(1), task_id="fnf:2"),
            )
        loaded = await s.load_persisted_task("fnf:2")
        assert loaded is not None
        assert loaded.status == "failed"  # not a stranded "queued" row


# --------------------------------------------------------------------- #
# Task 14 — OpenAI o-series / gpt-5 parameter mapping


class _CapturingCompletions:
    def __init__(self) -> None:
        self.kwargs: dict[str, Any] | None = None

    async def create(self, **kwargs: Any) -> Any:
        self.kwargs = kwargs
        return SimpleNamespace(
            choices=[SimpleNamespace(message=SimpleNamespace(content="hi"))],
            usage=SimpleNamespace(
                prompt_tokens=1, completion_tokens=1, total_tokens=2
            ),
            model=kwargs["model"],
        )


def _capturing_client() -> tuple[Any, _CapturingCompletions]:
    completions = _CapturingCompletions()
    client = SimpleNamespace(chat=SimpleNamespace(completions=completions))
    return client, completions


async def test_openai_o_series_uses_max_completion_tokens_no_temperature() -> None:
    client, completions = _capturing_client()
    adapter = OpenAIAdapter(client=client)
    await adapter.dispatch(
        "o3-mini",
        "p",
        DispatchOptions(max_tokens=99, extra={"temperature": 0.5}),
    )
    assert completions.kwargs is not None
    assert completions.kwargs["max_completion_tokens"] == 99
    assert "max_tokens" not in completions.kwargs
    assert "temperature" not in completions.kwargs


async def test_openai_gpt5_uses_max_completion_tokens_keeps_temperature() -> None:
    client, completions = _capturing_client()
    adapter = OpenAIAdapter(client=client)
    await adapter.dispatch(
        "gpt-5-mini",
        "p",
        DispatchOptions(max_tokens=42, extra={"temperature": 0.7}),
    )
    assert completions.kwargs is not None
    assert completions.kwargs["max_completion_tokens"] == 42
    assert "max_tokens" not in completions.kwargs
    assert completions.kwargs["temperature"] == 0.7


async def test_openai_legacy_models_keep_max_tokens() -> None:
    client, completions = _capturing_client()
    adapter = OpenAIAdapter(client=client)
    await adapter.dispatch(
        "gpt-4o",
        "p",
        DispatchOptions(max_tokens=64, extra={"temperature": 0.2}),
    )
    assert completions.kwargs is not None
    assert completions.kwargs["max_tokens"] == 64
    assert "max_completion_tokens" not in completions.kwargs
    assert completions.kwargs["temperature"] == 0.2
